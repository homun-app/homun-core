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
import {
  coreBridge,
  type CoreApprovalItem,
  type CoreChatThread,
  type CoreTaskDetail,
  type CoreTaskItem,
  type CoreTaskQueueSnapshot,
} from "./lib/coreBridge";
import type {
  ApprovalItem,
  ChatMessage,
  ChatThread,
  Priority,
  SettingsSectionId,
  TaskDetailItem,
  TaskItem,
  TaskResourceUsage,
  TaskStatus,
  ViewId,
} from "./types";

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

function mapCoreTaskStatus(status: string): TaskStatus {
  if (
    status === "queued" ||
    status === "running" ||
    status === "waiting_user_approval" ||
    status === "waiting_resource" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }
  return "queued";
}

function mapCoreTaskPriority(priority: string): Priority {
  if (
    priority === "critical" ||
    priority === "high" ||
    priority === "normal" ||
    priority === "low" ||
    priority === "background"
  ) {
    return priority;
  }
  return "normal";
}

function mapCoreTask(task: CoreTaskItem): TaskItem {
  return {
    id: task.task_id,
    title: task.goal,
    kind: task.kind,
    status: mapCoreTaskStatus(task.status),
    priority: mapCoreTaskPriority(task.priority),
    resource: "task_runtime",
    risk: "low",
    updated: "ora",
    blockedReason: task.blocked_reason ?? undefined,
  };
}

function mapCoreApproval(approval: CoreApprovalItem): ApprovalItem {
  const isBrowserAction = approval.action === "browser.manual_action";
  return {
    id: approval.approval_id,
    title: isBrowserAction ? "Azione browser in attesa" : approval.action,
    reason: isBrowserAction
      ? humanizeBrowserApprovalReason(approval.explanation)
      : approval.explanation,
    action: approval.action,
    boundary: approval.data_boundary,
    risk: approval.risk_level === "high" ? "high" : "medium",
    requestedBy: approval.task_id,
  };
}

function humanizeBrowserApprovalReason(reason: string): string {
  const match = reason.match(/before execution: ([a-z_]+)/i);
  const action = match?.[1] ?? "azione";
  if (action === "click") {
    return "Il browser vuole fare click su un elemento della pagina. Conferma solo se vuoi proseguire.";
  }
  if (action === "close") {
    return "Il browser vuole chiudere una pagina o una finestra. Conferma solo se non serve piu'.";
  }
  if (action === "type") {
    return "Il browser vuole inviare testo come submit. Conferma solo se il contenuto e' corretto.";
  }
  return "Il browser richiede una conferma prima di procedere.";
}

function summarizeSafeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Nessun dato redatto disponibile";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.toLowerCase().includes("redacted")
      ? "Payload redatto"
      : "Dato redatto disponibile";
  }
  if (Array.isArray(value)) {
    return `Lista redatta (${value.length})`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const approval = record.approval as Record<string, unknown> | undefined;
    if (approval?.decision) {
      return `Approval ${String(approval.decision)} · ${String(
        approval.action ?? "azione redatta",
      )}`;
    }
    const prompt = record.prompt as Record<string, unknown> | undefined;
    if (prompt?.state) {
      return `Prompt · ${String(prompt.state)}`;
    }
    const step = record.step as Record<string, unknown> | undefined;
    if (step?.title) {
      return `Step · ${String(step.title)}`;
    }
    const visibleKeys = Object.keys(record)
      .filter((key) => !/raw|payload|input|content|secret/i.test(key))
      .slice(0, 4);
    return visibleKeys.length
      ? `JSON redatto · ${visibleKeys.join(", ")}`
      : "JSON redatto disponibile";
  }
  return "Dato redatto disponibile";
}

function mapCoreTaskDetail(detail: CoreTaskDetail): TaskDetailItem {
  return {
    taskId: detail.task_id,
    kind: detail.kind,
    goal: detail.goal,
    status: mapCoreTaskStatus(detail.status),
    priority: mapCoreTaskPriority(detail.priority),
    blockedReason: detail.blocked_reason ?? undefined,
    checkpointSummary: summarizeSafeValue(detail.latest_checkpoint),
    metadataSummary: summarizeSafeValue(detail.runtime_metadata),
    exposesRawInput: detail.exposes_raw_input,
  };
}

function fallbackTaskDetail(task: TaskItem): TaskDetailItem {
  return {
    taskId: task.id,
    kind: task.kind,
    goal: task.title,
    status: task.status,
    priority: task.priority,
    blockedReason: task.blockedReason,
    checkpointSummary: "Anteprima web: read model Tauri non disponibile",
    metadataSummary: "Apri l'app desktop per il dettaglio core reale",
    exposesRawInput: false,
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
  const [taskItems, setTaskItems] = useState<TaskItem[]>(tasks);
  const [approvalItems, setApprovalItems] = useState<ApprovalItem[]>(approvals);
  const [resourceUsage, setResourceUsage] = useState<TaskResourceUsage[]>([]);
  const [selectedTaskDetail, setSelectedTaskDetail] =
    useState<TaskDetailItem | null>(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
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
      taskItems.find((task) => task.id === selectedTaskId) ?? {
        ...tasks[0],
        id: activeThread.taskId,
        title: activeThread.title,
        kind: "prompt_session",
        status: "queued" as const,
      },
    [activeThread.taskId, activeThread.title, selectedTaskId, taskItems],
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

  function applyTaskQueueSnapshot(snapshot: CoreTaskQueueSnapshot) {
    const nextTasks = [
      ...snapshot.active,
      ...snapshot.queued,
      ...snapshot.blocked,
      ...snapshot.recent_failures,
    ].map(mapCoreTask);
    setTaskItems(nextTasks.length ? nextTasks : tasks);
    setApprovalItems(
      snapshot.waiting_approvals.length
        ? snapshot.waiting_approvals.map(mapCoreApproval)
        : [],
    );
    setResourceUsage(
      snapshot.resource_usage
        .filter((usage) => usage.units > 0)
        .map((usage) => ({
          resourceClass: usage.resource_class,
          units: usage.units,
        })),
    );
  }

  async function loadTaskQueue() {
    try {
      applyTaskQueueSnapshot(await coreBridge.taskQueue());
    } catch (error) {
      console.warn("task_queue_snapshot unavailable", error);
    }
  }

  async function refreshSelectedTaskDetail(taskId: string) {
    const detail = await coreBridge.taskDetail(taskId);
    setSelectedTaskDetail(detail ? mapCoreTaskDetail(detail) : null);
  }

  async function handleApproveApproval(approvalId: string) {
    setApprovalBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(await coreBridge.approveApproval(approvalId));
      await refreshSelectedTaskDetail(selectedTaskId);
    } catch (error) {
      console.warn("approval_approve unavailable", error);
    } finally {
      setApprovalBusyId(null);
    }
  }

  async function handleRejectApproval(approvalId: string) {
    setApprovalBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(
        await coreBridge.rejectApproval(
          approvalId,
          "Rifiutato dall'utente dalla UI desktop.",
        ),
      );
      await refreshSelectedTaskDetail(selectedTaskId);
    } catch (error) {
      console.warn("approval_reject unavailable", error);
    } finally {
      setApprovalBusyId(null);
    }
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
    void loadTaskQueue();
    const interval = window.setInterval(loadTaskQueue, 4_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSelectedTaskDetail() {
      if (!selectedTaskId) {
        setSelectedTaskDetail(null);
        return;
      }
      setTaskDetailLoading(true);
      try {
        if (!cancelled) {
          await refreshSelectedTaskDetail(selectedTaskId);
        }
      } catch (error) {
        if (!cancelled) {
          setSelectedTaskDetail(fallbackTaskDetail(selectedTask));
        }
        console.warn("task_detail unavailable", error);
      } finally {
        if (!cancelled) {
          setTaskDetailLoading(false);
        }
      }
    }

    void loadSelectedTaskDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedTask, selectedTaskId]);

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
            approvalsCount={approvalItems.length}
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
            tasks={taskItems}
            approvals={approvalItems}
            resourceUsage={resourceUsage}
            selectedTaskDetail={selectedTaskDetail}
            taskDetailLoading={taskDetailLoading}
            approvalBusyId={approvalBusyId}
            selectedTaskId={selectedTask.id}
            onApproveApproval={handleApproveApproval}
            onRejectApproval={handleRejectApproval}
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
