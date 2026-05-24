import { useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import { ConnectionsView } from "./components/ConnectionsView";
import { LearningView } from "./components/LearningView";
import { Shell } from "./components/Shell";
import { ShallowView } from "./components/ShallowView";
import { SettingsView } from "./components/SettingsView";
import { TasksView } from "./components/TasksView";
import {
  approvals,
  brainRun,
  chatMessages,
  connections,
  automationProposals,
  learningInsights,
  memorySummary,
  runtimeHealth,
  tasks,
} from "./data/mockData";
import { coreBridge, type CoreChatThread } from "./lib/coreBridge";
import type { ChatMessage, ChatThread, SettingsSectionId, ViewId } from "./types";

const defaultChatThread: ChatThread = {
  threadId: "thread_active_prompt",
  title: "Nuovo compito",
  subtitle: "Sessione locale pronta",
  status: "active",
  computerSessionId: "computer_active_prompt",
  taskId: "task_prompt_session",
  updatedAt: "ora",
  messageCount: chatMessages.length,
};

function mapCoreChatThread(thread: CoreChatThread): ChatThread {
  return {
    threadId: thread.thread_id,
    title: thread.title,
    subtitle: thread.subtitle,
    status: thread.status === "archived" ? "archived" : "active",
    computerSessionId: thread.computer_session_id,
    taskId: thread.task_id,
    updatedAt: thread.updated_at,
    messageCount: thread.message_count,
  };
}

function starterMessages(thread: ChatThread): ChatMessage[] {
  return [
    {
      id: `${thread.threadId}_ready`,
      role: "assistant",
      text: "Sono pronto. Questa chat ha una sessione Computer locale separata: puoi scrivere una richiesta senza sporcare i thread precedenti.",
      timestamp: "ora",
      metadata: "Thread locale isolato",
    },
  ];
}

function updateThreadPreview(
  thread: ChatThread,
  messages: ChatMessage[],
): ChatThread {
  const lastMessage = messages.at(-1);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const userTitle = firstUserMessage?.text.trim().slice(0, 44);
  return {
    ...thread,
    title:
      thread.title === "Nuovo compito" && userTitle ? userTitle : thread.title,
    messageCount: messages.length,
    subtitle: lastMessage?.text.slice(0, 72) || "Chat locale pronta",
    updatedAt: "ora",
  };
}

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [previousView, setPreviousView] = useState<ViewId>("chat");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("privacy");
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([
    defaultChatThread,
  ]);
  const [activeThreadId, setActiveThreadId] = useState(
    defaultChatThread.threadId,
  );
  const [threadMessages, setThreadMessages] = useState<
    Record<string, ChatMessage[]>
  >({
    [defaultChatThread.threadId]: chatMessages,
  });
  const [selectedTaskId, setSelectedTaskId] = useState("task_prompt_session");
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth > 860);
  const activeThread = useMemo(
    () =>
      chatThreads.find((thread) => thread.threadId === activeThreadId) ??
      chatThreads[0] ??
      defaultChatThread,
    [activeThreadId, chatThreads],
  );
  const selectedTask = useMemo(
    () =>
      tasks.find((task) => task.id === selectedTaskId) ?? {
        ...tasks[0],
        id: activeThread.taskId,
        title: activeThread.title,
        kind: "prompt_session",
        status: "queued" as const,
      },
    [activeThread.taskId, activeThread.title, selectedTaskId],
  );
  const activeMessages =
    threadMessages[activeThread.threadId] ?? starterMessages(activeThread);
  const isSettings = activeView === "settings";

  function handleNavigate(view: ViewId) {
    if (view === "settings" && activeView !== "settings") {
      setPreviousView(activeView);
    }
    setActiveView(view);
  }

  function handleSelectThread(threadId: string) {
    const thread = chatThreads.find((item) => item.threadId === threadId);
    if (!thread) return;
    setActiveThreadId(threadId);
    setSelectedTaskId(thread.taskId);
    setActiveView("chat");
  }

  async function handleCreateChatThread() {
    try {
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      setChatThreads((current) => [
        created,
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessages((current) => ({
        ...current,
        [created.threadId]: starterMessages(created),
      }));
      setActiveThreadId(created.threadId);
      setSelectedTaskId(created.taskId);
      setActiveView("chat");
    } catch (error) {
      const fallback: ChatThread = {
        ...defaultChatThread,
        threadId: `thread_preview_${Date.now()}`,
        computerSessionId: "computer_active_prompt",
        taskId: "task_prompt_session",
        subtitle: "Anteprima web senza bridge Tauri",
        updatedAt: "ora",
        messageCount: 1,
      };
      setChatThreads((current) => [fallback, ...current]);
      setThreadMessages((current) => ({
        ...current,
        [fallback.threadId]: starterMessages(fallback),
      }));
      setActiveThreadId(fallback.threadId);
      setSelectedTaskId(fallback.taskId);
      setActiveView("chat");
      console.warn("create_chat_thread unavailable", error);
    }
  }

  function handleMessagesChange(threadId: string, messages: ChatMessage[]) {
    setThreadMessages((current) => ({
      ...current,
      [threadId]: messages,
    }));
    setChatThreads((current) =>
      current.map((thread) =>
        thread.threadId === threadId
          ? updateThreadPreview(thread, messages)
          : thread,
      ),
    );
  }

  useEffect(() => {
    function syncDrawerWithViewport() {
      setDrawerOpen(window.innerWidth > 860);
    }

    syncDrawerWithViewport();
    window.addEventListener("resize", syncDrawerWithViewport);
    return () => window.removeEventListener("resize", syncDrawerWithViewport);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadChatThreads() {
      try {
        const snapshot = await coreBridge.chatThreads();
        if (cancelled) return;
        const mapped = snapshot.threads.map(mapCoreChatThread);
        setChatThreads(mapped.length ? mapped : [defaultChatThread]);
        setActiveThreadId(snapshot.active_thread_id || defaultChatThread.threadId);
        setThreadMessages((current) => {
          const next = { ...current };
          for (const thread of mapped) {
            if (!next[thread.threadId]) {
              next[thread.threadId] =
                thread.threadId === defaultChatThread.threadId
                  ? chatMessages
                  : starterMessages(thread);
            }
          }
          return next;
        });
      } catch (error) {
        console.warn("chat_thread_snapshot unavailable", error);
      }
    }

    void loadChatThreads();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Shell
      activeView={activeView}
      activeThreadId={activeThread.threadId}
      chatThreads={chatThreads}
      drawerOpen={drawerOpen}
      onCreateChatThread={handleCreateChatThread}
      onBackFromSettings={() => setActiveView(previousView)}
      onNavigate={handleNavigate}
      onSelectThread={handleSelectThread}
      onToggleDrawer={() => setDrawerOpen((value) => !value)}
      onSelectSettingsSection={setSettingsSection}
      settingsSection={settingsSection}
    >
      <main
        className={`workspace ${isSettings ? "settings-workspace" : ""}`}
        aria-label="Area di lavoro principale"
      >
        {activeView === "chat" && (
          <ChatView
            approvalsCount={approvals.length}
            computerSessionId={activeThread.computerSessionId}
            messages={activeMessages}
            health={runtimeHealth}
            task={selectedTask}
            thread={activeThread}
            onMessagesChange={(messages) =>
              handleMessagesChange(activeThread.threadId, messages)
            }
          />
        )}
        {activeView === "tasks" && (
          <TasksView
            tasks={tasks}
            approvals={approvals}
            selectedTaskId={selectedTask.id}
            onSelectTask={setSelectedTaskId}
          />
        )}
        {activeView === "learning" && (
          <LearningView
            insights={learningInsights}
            proposals={automationProposals}
          />
        )}
        {activeView === "settings" && (
          <SettingsView
            health={runtimeHealth}
            connections={connections}
            section={settingsSection}
          />
        )}
        {activeView === "memory" && (
          <ShallowView
            title="Memoria"
            eyebrow="UI-safe read model"
            description="Stato sintetico della memoria locale, pronto per essere collegato al MemoryUiReadModel."
            stats={[
              { label: "Confermate", value: String(memorySummary.confirmed) },
              { label: "Candidate", value: String(memorySummary.candidates) },
              { label: "Domini", value: String(memorySummary.domains.length) },
            ]}
          />
        )}
        {activeView === "connections" && (
          <ConnectionsView connections={connections} />
        )}
        {activeView === "automations" && (
          <ShallowView
            title="Automazioni"
            eyebrow="Proposte e pianificate"
            description="Le routine diventano task durevoli con approvazioni e policy, non job nascosti."
            stats={[
              { label: "Attive", value: "3" },
              { label: "In revisione", value: "1" },
              { label: "Sospese", value: "0" },
            ]}
          />
        )}
        {activeView === "browser" && (
          <ShallowView
            title="Browser"
            eyebrow="Runtime locale"
            description="Sessioni Playwright/CDP, artifact redatti e manual blockers controllati dal task runtime."
            stats={[
              { label: "Sessione", value: "1" },
              { label: "Artifact", value: "4" },
              { label: "Approval", value: "1" },
            ]}
          />
        )}
        {activeView === "brain" && (
          <ShallowView
            title="Brain Audit"
            eyebrow="Piani spiegabili"
            description="Route, tool caricati, memory refs e step subagent sono persistiti senza raw payload."
            stats={[
              { label: "Route", value: brainRun.route },
              { label: "Round", value: String(brainRun.plannerRounds) },
              { label: "Tool", value: String(brainRun.loadedTools) },
            ]}
          />
        )}
      </main>
    </Shell>
  );
}
