import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { ChatView } from "./components/ChatView";
import { Shell } from "./components/Shell";
import { ChatSearchModal } from "./components/Sidebar";
import { LoginGate } from "./components/LoginGate";
import { ShallowView } from "./components/ShallowView";
import {
  approvals,
  brainRun,
  chatMessages,
  connections,
  automationProposals,
  learningInsights,
  memorySummary,
  navItems as staticNavItems,
  runtimeHealth,
  tasks,
} from "./data/mockData";
import { pluginRegistry, type PluginHost } from "./plugins/registry";
import {
  coreBridge,
  type AppEvent,
  type AutomationCreateteInput,
  type ChatAttachmentInput,
  type ManagedAutomation,
  type CoreChatThreadSnapshot,
  type CoreThreadAttention,
  type CoreTaskQueueSnapshot,
  type CoreUncertainEffectOutcome,
  type ProactivitySuggestion,
  type PluginState,
  type RoutingBindingInput,
  type TemplateCatalogEntry,
} from "./lib/coreBridge";
import { wsSubscription } from "./lib/wsSubscription";
import { useSetting } from "./lib/settingsStore";
import { showSystemNotification, notificationPermission } from "./lib/systemNotifications";
import { reconcileChatMessages, reconcileChatThreads } from "./lib/uiSnapshot";
import {
  createThreadAttentionState,
  hydrateThreadAttentionState,
  selectThread,
  type ThreadAttentionSnapshot,
  type ThreadAttentionState,
  type ThreadAttentionStatus,
} from "./lib/threadAttentionState";
import {
  attentionRequiredThreadIds,
  mergeConversationAttention,
} from "./lib/conversationAttention";
import { sidebarWorkspaceIsActive } from "./lib/sidebarFilterState";
import {
  currentTimestampSeconds,
  mapCoreApprovel,
  mapCoreCapabilitySnapshot,
  mapCoreChatMessage,
  mapCoreChatThread,
  mapCoreMemoryDashboard,
  mapCoreTask,
  mapCoreThreadAttention,
  mapCoreUncertainEffect,
  pendingChatAttachmentFromInput,
  starterMessages,
  summarizeThreadTitle,
  updateThreadPreview,
} from "./lib/appCoreMappers";
import type {
  ApprovelItem,
  ChatAttachment,
  ChatEventPart,
  ChatMessage,
  ChatThread,
  ConnectionItem,
  MemorySummary,
  NavItem,
  RuntimeHealth,
  SettingsSectionId,
  TaskItem,
  UncertainEffectItem,
  ViewId,
} from "./types";

// Secondary views are not on the path to the first chat paint; keeping them in
// the eager chunk cost ~1MB of parse before anything was interactive. ChatView
// and Shell stay static imports on purpose — they *are* the first paint, and
// deferring them would only move the wait, not remove it.
const AutomationsView = lazy(() =>
  import("./components/AutomationsView").then((m) => ({ default: m.AutomationsView })),
);
const ContainedComputerView = lazy(() =>
  import("./components/ContainedComputerView").then((m) => ({
    default: m.ContainedComputerView,
  })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const LearningView = lazy(() =>
  import("./components/LearningView").then((m) => ({ default: m.LearningView })),
);

const defaultChatThread: ChatThread = {
  threadId: "thread_active_prompt",
  title: "New task",
  subtitle: "Local session ready",
  status: "active",
  pinned: false,
  computerSessionId: "computer_active_prompt",
  taskId: "task_prompt_session",
  updatedAt: currentTimestampSeconds(),
  messageCount: chatMessages.length,
};

const PERSONAL_WORKSPACE_ID = "local-workspace";

function AuthenticatedApp() {
  const { t } = useTranslation();
  // System notifications opt-in (the SettingsView General pane wires permission).
  const [systemNotifEnabled] = useSetting<boolean>("general.systemNotifications", false);
  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [previousView, setPreviousView] = useState<ViewId>("chat");
  // Onboarding wizard: shown on first launch when no provider is configured.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Addons/plugin enabled-state (ADR 0011 §10-A): drives which registry plugins
  // contribute a nav entry + panel. Default-on until the backend answers.
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("account");
  // Active sub-item within a section that has an inline expandable submenu (e.g.
  // Model & Runtime → routing|decisions|providers). A single free-form string
  // keeps this generic for future sections (Connectors, etc.).
  const [settingsSub, setSettingsSub] = useState<string>("");
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
  const [approvalItems, setApprovelItems] = useState<ApprovelItem[]>(approvals);
  const [uncertainEffectItems, setUncertainEffectItems] = useState<
    UncertainEffectItem[]
  >([]);
  const [automationItems, setAutomationItems] = useState<ManagedAutomation[]>([]);
  const [runtimeItems] = useState<RuntimeHealth[]>(runtimeHealth);
  const [memoryDashboard, setMemoryDashboard] =
    useState<MemorySummary>(memorySummary);
  const [connectionItems, setConnectionItems] =
    useState<ConnectionItem[]>(connections);
  const [approvalBusyId, setApprovelBusyId] = useState<string | null>(null);
  const [effectResolutionBusyId, setEffectResolutionBusyId] = useState<string | null>(
    null,
  );
  const [effectResolutionError, setEffectResolutionError] = useState<{
    receiptId: string;
    message: string;
  } | null>(null);
  const [pendingTemplateAutoSubmit, setPendingTemplateAutoSubmit] = useState<{
    id: string;
    threadId: string;
    prompt: string;
    visibleText: string;
    attachments: ChatAttachmentInput[];
    visibleAttachments?: ChatAttachment[];
    mode?: string;
    // S2: deterministic routing binding for this template launch — carried only on
    // the first auto-submitted turn (see handleStartTemplateWorkflow).
    routingBinding?: RoutingBindingInput;
  } | null>(null);
  // The thread currently generating a chat answer (real-time signal from ChatView,
  // sub-polling cadence). Used to mark the thread busy in the sidebar immediately,
  // before the 2.5s taskQueue polling catches up.
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  // Bumped on a `thread.updated` for the open thread → ChatView re-fetches its island
  // projection, so a BACKGROUND channel turn's finished activity folds in (it isn't streamed).
  const [islandRefreshNonce, setIslandRefreshNonce] = useState(0);
  // Set on a `thread.turn_started` for the open thread → ChatView attaches to that turn's live
  // stream (island + transcript update in real time), for turns THIS client didn't launch —
  // e.g. a Telegram/WhatsApp/scheduled reply, or a turn started from another window.
  const [incomingBackgroundTurn, setIncomingBackgroundTurn] = useState<{
    turnId: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null>(null);
  const pendingLocalMessageThreadIdsRef = useRef<Set<string>>(new Set());
  const busyThreadIdsRef = useRef<Set<string>>(new Set());
  const notifiedAttentionThreadIdsRef = useRef<Set<string> | null>(null);
  // Thread ids generating in the BACKGROUND (a chat left mid-answer while another is
  // on screen). Polled from the gateway's resume registry so the sidebar dots light
  // up on every working chat, not only the active one.
  const [backgroundStreamIds, setBackgroundStreamIds] = useState<Set<string>>(new Set());
  const [threadAttention, setThreadAttention] = useState<ThreadAttentionState>(() =>
    createThreadAttentionState(defaultChatThread.threadId),
  );
  const threadAttentionRef = useRef(threadAttention);
  const [selectedTaskId, setSelectedTaskId] = useState("task_prompt_session");
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth > 1024);
  // Search modal lifted here (was in Shell) so BOTH the sidebar and the collapsed in-header
  // controls can open it via one owner.
  const [searchOpen, setSearchOpen] = useState(false);
  const activeThread = useMemo(
    () =>
      chatThreads.find((thread) => thread.threadId === activeThreadId) ??
      chatThreads[0] ??
      defaultChatThread,
    [activeThreadId, chatThreads],
  );
  const activeUncertainEffects = useMemo(
    () => uncertainEffectItems.filter((effect) => effect.threadId === activeThread.threadId),
    [activeThread.threadId, uncertainEffectItems],
  );
  const automationWorkspaceId = activeThread.workspaceId ?? undefined;
  // Threads "busy": a real-time streaming signal (from ChatView, sub-poll) UNION
  // the taskQueue snapshot (running/queued tasks linked to a thread). The union
  // covers both the chat-stream case and the durable-background-task case.
  const busyThreadIds = useMemo(() => {
    const ids = new Set<string>(backgroundStreamIds);
    if (streamingThreadId) ids.add(streamingThreadId);
    for (const thread of chatThreads) {
      const task = taskItems.find((item) => item.id === thread.taskId);
      if (task && (task.status === "running" || task.status === "queued")) {
        ids.add(thread.threadId);
      }
    }
    return ids;
  }, [streamingThreadId, backgroundStreamIds, chatThreads, taskItems]);
  useEffect(() => {
    busyThreadIdsRef.current = busyThreadIds;
  }, [busyThreadIds]);
  const pendingAttentionThreadIds = useMemo(
    () => attentionRequiredThreadIds(chatThreads, approvalItems, uncertainEffectItems),
    [approvalItems, chatThreads, uncertainEffectItems],
  );
  const attentionByThread = useMemo(() => {
    const attention: Record<string, ThreadAttentionStatus> = {
      ...threadAttention.byThread,
    };
    for (const threadId of busyThreadIds) {
      if (!attention[threadId] || attention[threadId] === "idle") {
        attention[threadId] = "working";
      }
    }
    return mergeConversationAttention(attention, pendingAttentionThreadIds);
  }, [busyThreadIds, pendingAttentionThreadIds, threadAttention.byThread]);
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

  function hasPendingLocalMessages(messages: ChatMessage[]): boolean {
    return messages.some((message) => message.id.startsWith("local_"));
  }

  function shouldPreserveLocalMessages(
    threadId: string,
    currentMessages: ChatMessage[] | undefined,
    incomingMessages: ChatMessage[],
  ): boolean {
    if (!currentMessages?.length) return false;
    const isProtected =
      pendingLocalMessageThreadIdsRef.current.has(threadId) ||
      busyThreadIdsRef.current.has(threadId);
    if (!isProtected) return false;
    const incomingIds = new Set(incomingMessages.map((message) => message.id));
    return currentMessages.some(
      (message) => message.id.startsWith("local_") && !incomingIds.has(message.id),
    );
  }

  function setThreadMessagesFromBackend(
    threadId: string,
    incomingMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ) {
    setThreadMessages((current) => {
      const currentMessages = current[threadId];
      if (
        options.force !== true &&
        shouldPreserveLocalMessages(threadId, currentMessages, incomingMessages)
      ) {
        return current;
      }
      pendingLocalMessageThreadIdsRef.current.delete(threadId);
      const reconciled = reconcileChatMessages(currentMessages, incomingMessages);
      if (reconciled === currentMessages) return current;
      return {
        ...current,
        [threadId]: reconciled,
      };
    });
  }

  function applyThreadAttentionRows(rows: CoreThreadAttention[]) {
    const current = threadAttentionRef.current;
    const next = hydrateThreadAttentionState(
      current,
      rows.map(mapCoreThreadAttention),
    );
    threadAttentionRef.current = next;
    setThreadAttention(next);
    const selectedThreadId = next.selectedThreadId;
    const seenTerminalEventId = next.seenTerminalEventIds[selectedThreadId] ?? 0;
    if (seenTerminalEventId > (current.seenTerminalEventIds[selectedThreadId] ?? 0)) {
      void coreBridge
        .markThreadSeen(selectedThreadId, seenTerminalEventId)
        .then((row) => applyThreadAttentionRows([row]))
        .catch((error) => console.warn("mark_thread_seen unavailable", error));
    }
  }

  function markSelectedThreadSeen(threadId: string) {
    const current = threadAttentionRef.current;
    const next = selectThread(current, threadId);
    threadAttentionRef.current = next;
    setThreadAttention(next);
    const terminalEventId = next.seenTerminalEventIds[threadId] ?? 0;
    if (terminalEventId > (current.seenTerminalEventIds[threadId] ?? 0)) {
      void coreBridge
        .markThreadSeen(threadId, terminalEventId)
        .then((row) => applyThreadAttentionRows([row]))
        .catch((error) => console.warn("mark_thread_seen unavailable", error));
    }
  }

  function handleNavigate(view: ViewId) {
    if (view === "settings" && activeView !== "settings") {
      setPreviousView(activeView);
    }
    setActiveView(view);
  }

  async function handleSelectThread(threadId: string) {
    const fallback = chatThreads.find((item) => item.threadId === threadId);
    // Optimistic + instant: switch the center to the thread NOW, before any network. If its
    // messages are already in memory the switch is truly immediate (no spinner, no refetch).
    setActiveThreadId(threadId);
    markSelectedThreadSeen(threadId);
    if (fallback) setSelectedTaskId(fallback.taskId);
    setActiveView("chat");
    try {
      // `select_chat_thread` is workspace-aware (returns the target thread's workspace snapshot),
      // so a cross-workspace thread switches context here with no full page reload.
      const snapshot = await coreBridge.selectChatThread(threadId);
      const mappedThreads = snapshot.threads.map(mapCoreChatThread);
      const selectedThread = mappedThreads.find((item) => item.threadId === threadId) ?? fallback;
      // Functional form: the snapshot lands after an await, so `chatThreads` from
      // the render closure is already stale — and reconciling keeps the array
      // identity when the selection changed nothing in the list itself.
      setChatThreads((current) =>
        mappedThreads.length ? reconcileChatThreads(current, mappedThreads) : current,
      );
      if (selectedThread) setSelectedTaskId(selectedThread.taskId);
      const attention = await coreBridge.threadAttentions(selectedThread?.workspaceId ?? undefined);
      applyThreadAttentionRows(attention);
      markSelectedThreadSeen(threadId);
      // Fetch messages only when we don't already have them — re-selecting a thread is instant.
      if (!threadMessages[threadId]) {
        const messages = await coreBridge.chatMessages(threadId);
        setThreadMessagesFromBackend(threadId, messages.messages.map(mapCoreChatMessage));
      }
    } catch (error) {
      console.warn("select_chat_thread unavailable", error);
    }
  }

  useEffect(() => {
    const previous = notifiedAttentionThreadIdsRef.current;
    notifiedAttentionThreadIdsRef.current = new Set(pendingAttentionThreadIds);
    // Seed from persisted state without replaying old notifications on every launch.
    if (previous === null) return;
    if (!systemNotifEnabled || !document.hidden || notificationPermission() !== "granted") {
      return;
    }
    for (const threadId of pendingAttentionThreadIds) {
      if (previous.has(threadId)) continue;
      const owner = chatThreads.find((thread) => thread.threadId === threadId);
      void showSystemNotification({
        title: t("notifications.requiresAttention"),
        body: owner?.title ?? t("notifications.openConversation"),
        tag: `attention:${threadId}`,
        onClick: () => void handleSelectThread(threadId),
      });
    }
  }, [chatThreads, pendingAttentionThreadIds, systemNotifEnabled, t]);

  async function refreshThreadInBackground(
    threadId: string,
    workspaceId?: string,
    options: { forceMessages?: boolean } = {},
  ) {
    try {
      const [snapshot, messages, attention] = await Promise.all([
        coreBridge.chatThreads(workspaceId),
        coreBridge.chatMessages(threadId),
        coreBridge.threadAttentions(workspaceId),
      ]);
      const mappedThreads = snapshot.threads.map(mapCoreChatThread);
      // Keep App's active-workspace list scoped. Cross-workspace rows are owned
      // by ProjectsNav and refresh on its next visible load; their attention is
      // still updated immediately here.
      if (
        mappedThreads.some((thread) => thread.threadId === activeThreadId) ||
        workspaceId === activeThread.workspaceId
      ) {
        // Fires on every turn/thread.updated stream event, so it is even hotter
        // than the 2.5s poll: reconcile instead of re-creating the whole list.
        setChatThreads((current) =>
          mappedThreads.length ? reconcileChatThreads(current, mappedThreads) : current,
        );
      }
      setThreadMessagesFromBackend(
        threadId,
        messages.messages.map(mapCoreChatMessage),
        { force: options.forceMessages === true },
      );
      applyThreadAttentionRows(attention);
    } catch (error) {
      console.warn("refresh_thread_in_background unavailable", error);
    }
  }

  // Real-time channel events update the owning thread's durable cache and
  // attention indicator. Selection remains exclusively user-owned. A ref keeps
  // the handler fresh without re-subscribing on every render.
  const appEventHandlerRef = useRef<(event: AppEvent) => void>(() => {});
  appEventHandlerRef.current = (event: AppEvent) => {
    if (!event.thread_id) return;
    // The "homun" thread is retired as a proactive surface (its curiosities/onboarding
    // now flow as proactivity cards) — ignore its events; it has no nav entry to update.
    if (event.thread_id === "homun") {
      return;
    }
    const eventThreadId = event.thread_id;
    const isVisibleTurn = event.type === "thread.turn_started";
    const isThreadCreated = event.type === "thread.upserted";
    if (isVisibleTurn || isThreadCreated) {
      // Alert the user when something arrived/finished while the app wasn't in
      // front (a channel message, or a scheduled task that produced a result).
      // Skip when focused — the thread list + bell already surface it there.
      if (
        systemNotifEnabled &&
        document.hidden &&
        notificationPermission() === "granted"
      ) {
        const threadId = event.thread_id;
        void showSystemNotification({
          title: event.title || t("notifications.newActivity"),
          body:
            event.channel === "scheduled"
              ? t("notifications.scheduledReady")
              : t("notifications.newMessage"),
          tag: threadId,
          onClick: () => void handleSelectThread(threadId),
        });
      }
      if (isVisibleTurn) {
        // Attach only when this is already the user-selected task. A background
        // turn updates its cache and sidebar state without touching the view.
        if (
          eventThreadId === activeThreadId &&
          event.turn_id &&
          event.user_message_id &&
          event.assistant_message_id
        ) {
          setIncomingBackgroundTurn({
            turnId: event.turn_id,
            threadId: eventThreadId,
            userMessageId: event.user_message_id,
            assistantMessageId: event.assistant_message_id,
          });
        }
      }
      void refreshThreadInBackground(eventThreadId, event.workspace, {
        forceMessages: isVisibleTurn,
      });
    } else if (event.type === "thread.updated") {
      if (event.workspace) {
        void refreshThreadInBackground(eventThreadId, event.workspace);
      } else {
        void refreshThreadInBackground(eventThreadId);
      }
      if (eventThreadId === activeThreadId) {
        setIslandRefreshNonce((n) => n + 1);
      }
    }
  };
  useEffect(() => {
    // Unified WebSocket: persistent channel for ALL server→client events.
    // Replaces subscribeAppEvents (NDJSON /api/events) + listenChatStreamEvent.
    wsSubscription.connect();
    const unsub = wsSubscription.subscribe((msg) => {
      // Dispatch app events (thread.updated, thread.turn_started, project_graph.ready)
      if (msg.type === "app.event") {
        const event = msg.event as Record<string, unknown>;
        appEventHandlerRef.current(event as unknown as Parameters<typeof appEventHandlerRef.current>[0]);
      }
    });
    return () => {
      // Drop only this component's handler. The WS is a process-lifetime
      // singleton ("connect at boot / disconnect at shutdown"): a React unmount
      // is NOT app shutdown. Under StrictMode's mount→unmount→remount, calling
      // disconnect() here closed a still-CONNECTING socket and left the singleton
      // wedged (isConnecting stuck true), permanently dead-locking connect().
      unsub();
    };
  }, []);

  // Onboarding check: if setup isn't complete and no provider is configured,
  // show the wizard overlay on first launch.
  useEffect(() => {
    void (async () => {
      try {
        const status = await coreBridge.setupStatus();
        if (status.needs_setup) setShowOnboarding(true);
      } catch {
        /* gateway not ready — will retry on next interaction */
      }
    })();
  }, []);

  async function handleCreateteChatThread(workspaceId?: string) {
    try {
      const targetWorkspace = workspaceId?.trim();
      if (targetWorkspace) {
        await coreBridge.selectWorkspace(targetWorkspace);
        const created = mapCoreChatThread(
          await coreBridge.createChatThread(targetWorkspace),
        );
        await coreBridge.selectChatThread(created.threadId);
        window.location.reload();
        return;
      }
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      const messages = await coreBridge.chatMessages(created.threadId);
      setChatThreads((current) => [
        created,
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessages((current) => ({
        ...current,
        [created.threadId]: messages.messages.map(mapCoreChatMessage),
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
        subtitle: "Electron with local gateway in extraction",
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

  // Engage a proactivity card (ADR 0011 §7): open a fresh chat in the card's scope,
  // pre-seeded with its context. This is what dissolves the proactive-task workspace
  // problem — the supervisor runs centrally and tags scope; the heavy chat
  // materializes on demand in the right place. Personal cards map to the base
  // ("local-workspace") which IS the memory "__personal__" scope; projects pass through.
  async function handleOpenSuggestion(suggestion: ProactivitySuggestion) {
    const workspaceId =
      suggestion.scope === "__personal__" ? "local-workspace" : suggestion.scope;
    // Open the chat with Homun's question already posted as an assistant message,
    // so the conversation starts with the assistant asking (not a composer draft /
    // generic empty-state). The follow-up is grounded by the auto-injected memory.
    const question = (suggestion.body ?? "").trim() || suggestion.title;
    // Question cards carry quick-reply options as structured event parts; marker
    // parsing stays only as historical fallback in ChatView.
    const options = (suggestion.choices ?? []).filter((o) => o.trim().length > 0);
    const seedEventParts: ChatEventPart[] =
      options.length > 0
        ? [{
            type: "choice_prompt",
            payload: {
              question: "",
              multi: false,
              options,
              // Marks this as a PROACTIVITY question (onboarding, follow-up, …). Answering
              // it captures the pick as memory instead of running an agent turn — see the
              // `purpose` branch in ChatView's onChoose. Carries the card kind for context.
              purpose: suggestion.kind,
            },
          }]
        : [];
    try {
      await coreBridge.selectWorkspace(workspaceId);
      const created = mapCoreChatThread(await coreBridge.createChatThread(workspaceId));
      const seeded = await coreBridge.seedAssistantMessage(created.threadId, question, seedEventParts);
      setChatThreads((current) => [
        created,
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessages((current) => ({
        ...current,
        [created.threadId]: seeded.messages.map(mapCoreChatMessage),
      }));
      setActiveThreadId(created.threadId);
      setSelectedTaskId(created.taskId);
      setActiveView("chat");
    } catch (error) {
      console.warn("open_suggestion unavailable", error);
    }
  }

  async function handleStartTemplateWorkflow(input: {
    template: TemplateCatalogEntry;
    attachment?: ChatAttachmentInput;
  }) {
    // Document packs must route to the document-generation tool, not the
    // deck one — the only branch point below is `isDocument`; every other
    // line stays byte-identical to the presentation wording so this
    // refactor changes nothing for decks.
    const isDocument = input.template.kind === "document";
    const artifactNoun = isDocument ? "document" : "presentation";
    const makeTool = isDocument ? "make_document" : "make_deck";
    const visiblePrompt = `Help me create a ${artifactNoun} using the selected template "${input.template.name}".`;
    const operativePrompt = [
      `The user selected a template from the Presentations catalog and wants to use it to create a new ${artifactNoun}.`,
      `template_ref=${input.template.id}`,
      `template_name=${input.template.name}`,
      `source_provider=${input.template.source_provider ?? "user_upload"}`,
      input.attachment
        ? `attached_file=${input.attachment.displayName}`
        : "attached_file=none; use the catalog template_ref and metadata as the style constraint.",
      "",
      isDocument ? "Do not generate the document yet." : "Do not generate the deck yet.",
      "Analyze the selected template as a constraint for style, layout and visual tone.",
      isDocument
        ? "First ask 2-4 essential questions to understand objective, audience, available content and tone."
        : "First ask 2-4 essential questions to understand objective, audience, available content, slide count and tone.",
      ...(input.template.intake_questions.length > 0
        ? [
            `Ask these template-specific questions first (one message): ${input.template.intake_questions
              .map((question, index) => `${index + 1}. ${question}`)
              .join(" ")}`,
          ]
        : []),
      // Final-review fix (I1): this used to say "propose a concise plan and wait for
      // confirmation before using ${makeTool}" — but the harness now forces the
      // tool_choice to `makeTool` on the FIRST post-intake reply (S2 T5), so a
      // plan-confirmation step is impossible/contradictory for a bound flow. Reworded to
      // match reality: go straight from the intake answers to the call, no ceremony.
      `Once you have the answers above, call ${makeTool} directly — no plan and no confirmation step needed.`,
    ].join("\n");
    // S2 (plugin-owned deterministic routing): weak local managers used to wander to
    // generic skills + shell file-writing (observed: a model hand-wrote a .md via `cat`
    // heredoc through a "Create Documents" skill, bypassing the template entirely). The
    // fix used to be pleading in the prompt (IMPORTANT/MUST text); that's now enforced
    // deterministically by the gateway off this binding (S2 T3-T5: forces tool_choice to
    // the routed make tool and denies skill/shell tools once intake is past its first
    // round), so the operative prompt above stays brief + intake only.
    const routingBinding: RoutingBindingInput = {
      plugin_id: "presentations",
      route_id: isDocument ? "presentations.template_document" : "presentations.template_deck",
      args: { template_ref: input.template.id },
    };
    try {
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      const messages = await coreBridge.chatMessages(created.threadId);
      const timestamp = currentTimestampSeconds();
      setChatThreads((current) => [
        {
          ...created,
          title: summarizeThreadTitle(visiblePrompt),
          messageCount: Math.max(created.messageCount, messages.messages.length),
          updatedAt: timestamp,
        },
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessagesFromBackend(created.threadId, messages.messages.map(mapCoreChatMessage));
      setActiveThreadId(created.threadId);
      setSelectedTaskId(created.taskId);
      setActiveView("chat");
      setPendingTemplateAutoSubmit({
        id: `template_auto_submit_${created.threadId}_${Date.now()}`,
        threadId: created.threadId,
        prompt: operativePrompt,
        visibleText: visiblePrompt,
        attachments: input.attachment ? [input.attachment] : [],
        visibleAttachments: input.attachment
          ? [pendingChatAttachmentFromInput(input.attachment)]
          : undefined,
        mode: "plan",
        routingBinding,
      });
    } catch (error) {
      console.warn("start_template_workflow unavailable", error);
    }
  }

  async function reloadPlugins() {
    setPluginStates(await coreBridge.plugins());
  }
  useEffect(() => {
    void reloadPlugins();
  }, []);

  // A registry plugin is shown unless the backend says it's disabled (default-on).
  const enabledPlugins = pluginRegistry.filter(
    (p) => pluginStates.find((s) => s.id === p.id)?.enabled !== false,
  );
  const composedNavItems: NavItem[] = [
    ...staticNavItems,
    ...enabledPlugins.map((p) => ({
      id: p.id as ViewId,
      label: p.navLabel,
      icon: p.navIcon,
      navSection: p.navSection ?? "more",
      promoted: p.promoted === true,
      order: p.navOrder,
    })),
  ];
  // The host capability surface handed to each plugin panel (ADR 0011 §6).
  const pluginHost: PluginHost = {
    openChat: handleOpenSuggestion,
    startTemplateWorkflow: handleStartTemplateWorkflow,
  };

  async function applyThreadSnapshot(snapshot: CoreChatThreadSnapshot) {
    const mappedThreads = snapshot.threads.map(mapCoreChatThread);
    const preservedThread = mappedThreads.find((thread) => thread.threadId === activeThreadId
      && thread.status === "active");
    const selectedThread =
      preservedThread ??
      mappedThreads.find((thread) => thread.threadId === snapshot.active_thread_id
        && thread.status === "active") ??
      mappedThreads.find((thread) => thread.status === "active") ??
      defaultChatThread;
    const desired = mappedThreads.length ? mappedThreads : [defaultChatThread];
    setChatThreads((current) => reconcileChatThreads(current, desired));
    if (!preservedThread) {
      setActiveThreadId(selectedThread.threadId);
      setSelectedTaskId(selectedThread.taskId);
    }
    if (!threadMessages[selectedThread.threadId]) {
      try {
        const messages = await coreBridge.chatMessages(selectedThread.threadId);
        setThreadMessages((current) => ({
          ...current,
          [selectedThread.threadId]: messages.messages.map(mapCoreChatMessage),
        }));
      } catch (error) {
        console.warn("chat_messages unavailable after thread action", error);
      }
    }
  }

  async function handleSetChatThreadPinned(threadId: string, pinned: boolean) {
    try {
      await applyThreadSnapshot(await coreBridge.setChatThreadPinned(threadId, pinned));
    } catch (error) {
      setChatThreads((current) =>
        [...current]
          .map((thread) =>
            thread.threadId === threadId ? { ...thread, pinned } : thread,
          )
          .sort((left, right) => Number(right.pinned) - Number(left.pinned)),
      );
      console.warn("chat_thread_set_pinned unavailable", error);
    }
  }

  async function handleRenameChatThread(threadId: string, title: string) {
    // Optimistic: rename in place immediately (no snapshot round-trip / no active-thread reset),
    // then persist in the background — the next load reconciles if it ever fails.
    setChatThreads((current) =>
      current.map((thread) => (thread.threadId === threadId ? { ...thread, title } : thread)),
    );
    try {
      await coreBridge.renameChatThread(threadId, title);
    } catch (error) {
      console.warn("chat_thread_rename unavailable", error);
    }
  }

  async function handleArchiveChatThread(threadId: string) {
    try {
      await applyThreadSnapshot(await coreBridge.archiveChatThread(threadId));
    } catch (error) {
      const nextThreads = chatThreads.map((thread) =>
        thread.threadId === threadId
          ? { ...thread, status: "archived" as const, pinned: false }
          : thread,
      );
      setChatThreads(nextThreads);
      if (activeThreadId === threadId) {
        const nextThread = nextThreads.find((thread) => thread.status === "active");
        if (nextThread) {
          setActiveThreadId(nextThread.threadId);
          setSelectedTaskId(nextThread.taskId);
        }
      }
      console.warn("chat_thread_archive unavailable", error);
    }
  }

  async function handleUnarchiveChatThread(threadId: string, workspaceId: string) {
    const ownerIsActive = sidebarWorkspaceIsActive(
      workspaceId,
      activeThread.workspaceId,
      PERSONAL_WORKSPACE_ID,
    );
    try {
      const snapshot = await coreBridge.unarchiveChatThread(threadId);
      if (ownerIsActive) {
        await applyThreadSnapshot(snapshot);
      }
      return {
        threads: snapshot.threads.map(mapCoreChatThread),
        appliedToActive: ownerIsActive,
      };
    } catch (error) {
      if (ownerIsActive) {
        setChatThreads((current) =>
          current.map((thread) =>
            thread.threadId === threadId
              ? { ...thread, status: "active" as const }
              : thread,
          ),
        );
        setActiveThreadId(threadId);
        const restoredThread = chatThreads.find((thread) => thread.threadId === threadId);
        if (restoredThread) {
          setSelectedTaskId(restoredThread.taskId);
        }
      }
      console.warn("chat_thread_unarchive unavailable", error);
      return { threads: null, appliedToActive: ownerIsActive };
    }
  }

  async function handleDeleteChatThread(threadId: string) {
    // Optimistic: drop it from the list + messages immediately (and reselect if it was active),
    // then persist in the background.
    setChatThreads((current) => current.filter((thread) => thread.threadId !== threadId));
    setThreadMessages((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    if (activeThreadId === threadId) {
      const nextThread = chatThreads.find((thread) => thread.threadId !== threadId);
      if (nextThread) {
        setActiveThreadId(nextThread.threadId);
        setSelectedTaskId(nextThread.taskId);
      }
    }
    try {
      await coreBridge.deleteChatThread(threadId);
    } catch (error) {
      console.warn("chat_thread_delete unavailable", error);
    }
  }

  function handleMessagesChange(
    threadId: string,
    messages: ChatMessage[],
    options: { advanceActivity?: boolean } = {},
  ) {
    if (options.advanceActivity === true) {
      pendingLocalMessageThreadIdsRef.current.delete(threadId);
    } else if (hasPendingLocalMessages(messages)) {
      pendingLocalMessageThreadIdsRef.current.add(threadId);
    }
    setThreadMessages((current) => ({
      ...current,
      [threadId]: messages,
    }));
    setChatThreads((current) =>
      current.map((thread) =>
        thread.threadId === threadId
          ? updateThreadPreview(thread, messages, options)
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
    setApprovelItems(
      snapshot.waiting_approvals.length
        ? snapshot.waiting_approvals.map(mapCoreApprovel)
        : [],
    );
    const nextUncertainEffects = (snapshot.uncertain_effects ?? []).map(
      mapCoreUncertainEffect,
    );
    setUncertainEffectItems(nextUncertainEffects);
    setEffectResolutionError((current) =>
      current && nextUncertainEffects.some((effect) => effect.id === current.receiptId)
        ? current
        : null,
    );
  }

  async function loadTaskQueue() {
    try {
      applyTaskQueueSnapshot(await coreBridge.taskQueue());
    } catch (error) {
      console.warn("task_queue_snapshot unavailable", error);
    }
  }

  async function loadAutomations() {
    try {
      setAutomationItems(await coreBridge.automations(automationWorkspaceId));
    } catch (error) {
      console.warn("automations unavailable", error);
    }
  }

  async function handleCreateteAutomation(input: AutomationCreateteInput) {
    try {
      await coreBridge.createAutomation({
        ...input,
        workspace_id: input.workspace_id ?? automationWorkspaceId,
      });
      await loadAutomations();
    } catch (error) {
      console.warn("create automation failed", error);
    }
  }

  async function handleUpdateAutomation(id: string, input: Partial<AutomationCreateteInput>) {
    try {
      await coreBridge.updateAutomation(id, input, automationWorkspaceId);
      await loadAutomations();
    } catch (error) {
      console.warn("update automation failed", error);
    }
  }

  async function handleToggleAutomation(id: string) {
    try {
      await coreBridge.toggleAutomation(id, automationWorkspaceId);
      await loadAutomations();
    } catch (error) {
      console.warn("toggle automation failed", error);
    }
  }

  async function handleDeleteAutomation(id: string) {
    try {
      await coreBridge.deleteAutomation(id, automationWorkspaceId);
      await loadAutomations();
    } catch (error) {
      console.warn("delete automation failed", error);
    }
  }

  async function loadMemoryAndCapabilities() {
    try {
      setMemoryDashboard(
        mapCoreMemoryDashboard(await coreBridge.memoryDashboard()),
      );
    } catch (error) {
      console.warn("memory_dashboard unavailable", error);
    }
    try {
      const nextConnections = mapCoreCapabilitySnapshot(
        await coreBridge.capabilities(),
      );
      setConnectionItems(nextConnections.length ? nextConnections : connections);
    } catch (error) {
      console.warn("capability_snapshot unavailable", error);
    }
  }

  async function refreshRuntimeReadModels() {
    await loadTaskQueue();
  }

  async function refreshChatReadModels(preferredThreadId = activeThreadId) {
    const snapshot = await coreBridge.chatThreads();
    const mappedThreads = snapshot.threads.map(mapCoreChatThread);
    // This runs on the 2.5s operational poll: hand React the previous array back
    // when nothing changed, or App/Sidebar/Shell/ChatView re-render every tick.
    const desired = mappedThreads.length ? mappedThreads : [defaultChatThread];
    setChatThreads((current) => reconcileChatThreads(current, desired));
    const preferred = mappedThreads.find((thread) => thread.threadId === preferredThreadId);
    if (!preferred) return;
    const messages = await coreBridge.chatMessages(preferred.threadId);
    setThreadMessagesFromBackend(
      preferred.threadId,
      messages.messages.map(mapCoreChatMessage),
    );
    applyThreadAttentionRows(await coreBridge.threadAttentions());
  }

  async function handleApproveApprovel(
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) {
    setApprovelBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(await coreBridge.approveApprovel(approvalId, options));
      await refreshRuntimeReadModels();
      await refreshChatReadModels(activeThread.threadId);
    } catch (error) {
      console.warn("approval_approve unavailable", error);
    } finally {
      setApprovelBusyId(null);
    }
  }

  async function handleRejectApprovel(approvalId: string) {
    setApprovelBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(
        await coreBridge.rejectApprovel(
          approvalId,
          "Rejected by the user from the desktop UI.",
        ),
      );
    } catch (error) {
      console.warn("approval_reject unavailable", error);
    } finally {
      setApprovelBusyId(null);
    }
  }

  async function handleResolveUncertainEffect(
    effect: UncertainEffectItem,
    outcome: CoreUncertainEffectOutcome,
  ) {
    setEffectResolutionBusyId(effect.id);
    setEffectResolutionError(null);
    try {
      await coreBridge.resolveUncertainEffect(effect.core, outcome);
      await loadTaskQueue();
      if (effect.threadId) {
        await refreshChatReadModels(effect.threadId);
      }
    } catch (error) {
      setEffectResolutionError({
        receiptId: effect.id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setEffectResolutionBusyId(null);
    }
  }

  useEffect(() => {
    function syncDrawerWithViewport() {
      setDrawerOpen(window.innerWidth > 1024);
    }

    syncDrawerWithViewport();
    window.addEventListener("resize", syncDrawerWithViewport);
    return () => window.removeEventListener("resize", syncDrawerWithViewport);
  }, []);

  useEffect(() => {
    const pollActiveStreams = () =>
      void coreBridge.activeStreams().then((ids) => setBackgroundStreamIds(new Set(ids)));
    void loadMemoryAndCapabilities();
    void loadTaskQueue();
    void loadAutomations();
    pollActiveStreams();
    const interval = window.setInterval(() => {
      void loadTaskQueue();
      pollActiveStreams();
    }, 4_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeView === "automations") void loadAutomations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, automationWorkspaceId]);

  useEffect(() => {
    let cancelled = false;

    async function refreshOperationalReadModels() {
      if (!activeThreadId) return;
      try {
        await loadTaskQueue();
        if (!cancelled) {
          await refreshChatReadModels(activeThreadId);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("operational_read_models_poll unavailable", error);
        }
      }
    }

    const interval = window.setInterval(refreshOperationalReadModels, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeThreadId]);

  useEffect(() => {
    let cancelled = false;

    async function loadChatThreads() {
      try {
        const snapshot = await coreBridge.chatThreads();
        if (cancelled) return;
        const mapped = snapshot.threads.map(mapCoreChatThread);
        const selectedThread =
          mapped.find((thread) => thread.threadId === snapshot.active_thread_id) ??
          mapped[0] ??
          defaultChatThread;
        let selectedMessages = starterMessages(selectedThread);
        let attention: CoreThreadAttention[] = [];
        try {
          const [messages, attentionRows] = await Promise.all([
            coreBridge.chatMessages(selectedThread.threadId),
            coreBridge.threadAttentions(selectedThread.workspaceId ?? undefined),
          ]);
          selectedMessages = messages.messages.map(mapCoreChatMessage);
          attention = attentionRows;
        } catch (error) {
          console.warn("active chat_messages unavailable", error);
        }
        if (cancelled) return;
        setChatThreads(mapped.length ? mapped : [defaultChatThread]);
        setActiveThreadId(selectedThread.threadId);
        setSelectedTaskId(selectedThread.taskId);
        setThreadMessagesFromBackend(selectedThread.threadId, selectedMessages);
        const selectedAttention = selectThread(
          threadAttentionRef.current,
          selectedThread.threadId,
        );
        threadAttentionRef.current = selectedAttention;
        setThreadAttention(selectedAttention);
        applyThreadAttentionRows(attention);
        markSelectedThreadSeen(selectedThread.threadId);
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
    <>
      <Shell
      activeView={activeView}
      activeThreadId={activeThread.threadId}
      threadAttention={attentionByThread}
      chatThreads={chatThreads}
      drawerOpen={drawerOpen}
      onCreateteChatThread={handleCreateteChatThread}
      onArchiveChatThread={handleArchiveChatThread}
      onRenameChatThread={handleRenameChatThread}
      onBackFromSettings={() => setActiveView(previousView)}
      onDeleteChatThread={handleDeleteChatThread}
      navItems={composedNavItems}
      onNavigate={handleNavigate}
      onSelectThread={handleSelectThread}
      onThreadAttention={applyThreadAttentionRows}
      onSetChatThreadPinned={handleSetChatThreadPinned}
      onToggleDrawer={() => setDrawerOpen((value) => !value)}
      onSearchChat={() => setSearchOpen(true)}
      onUnarchiveChatThread={handleUnarchiveChatThread}
      onSelectSettingsSection={setSettingsSection}
      settingsSection={settingsSection}
      settingsSub={settingsSub}
      onSelectSettingsSub={setSettingsSub}
      hideChrome={showOnboarding}
    >
      <main
        className={`workspace ${isSettings ? "settings-workspace" : ""}`}
        aria-label={t("app.mainWorkspace")}
      >
        {/* The boundary sits INSIDE <main> so a lazy chunk fetch blanks only
            the workspace pane: Shell (sidebar, nav, topbar) and the overlays
            rendered as its siblings stay mounted instead of flashing away. */}
        <Suspense fallback={null}>
          {activeView === "chat" && (
            <ChatView
              key={activeThread.threadId}
              sidebarCollapsed={!drawerOpen}
              onExpandSidebar={() => setDrawerOpen(true)}
              onOpenSearch={() => setSearchOpen(true)}
              onOpenUsageSettings={() => {
                setPreviousView("chat");
                setSettingsSection("usage");
                setSettingsSub("");
                setActiveView("settings");
              }}
              approvals={approvalItems}
              approvalBusyId={approvalBusyId}
              uncertainEffects={activeUncertainEffects}
              effectResolutionBusyId={effectResolutionBusyId}
              effectResolutionError={
                effectResolutionError &&
                activeUncertainEffects.some(
                  (effect) => effect.id === effectResolutionError.receiptId,
                )
                  ? effectResolutionError.message
                  : null
              }
              computerSessionId={activeThread.computerSessionId}
              messages={activeMessages}
              thread={activeThread}
              onMessagesChange={(messages) =>
                handleMessagesChange(activeThread.threadId, messages)
              }
              islandRefreshNonce={islandRefreshNonce}
              runtimeContextRevision={
                threadAttention.terminalEventIds[activeThread.threadId] ?? 0
              }
              incomingBackgroundTurn={incomingBackgroundTurn}
              autoSubmit={
                pendingTemplateAutoSubmit?.threadId === activeThread.threadId
                  ? pendingTemplateAutoSubmit
                  : null
              }
              onAutoSubmitConsumed={(id) =>
                setPendingTemplateAutoSubmit((current) =>
                  current?.id === id ? null : current,
                )
              }
              onResolveEffect={handleResolveUncertainEffect}
              onApproveApprovel={handleApproveApprovel}
              onRejectApprovel={handleRejectApprovel}
              onRuntimeChanged={refreshRuntimeReadModels}
              onThreadChanged={() => refreshChatReadModels(activeThread.threadId)}
              onStreamingChange={(busy) =>
                setStreamingThreadId(busy ? activeThread.threadId : null)
              }
            />
          )}
          {activeView === "learning" && (
            <LearningView
              insights={learningInsights}
              proposals={automationProposals}
            />
          )}
          {/* Memory has no top-level view: it lives in Settings → Memory only
              (SettingsView renders <MemoryView embedded />). */}
          {activeView === "settings" && (
            <SettingsView
              connections={connectionItems}
              section={settingsSection}
              sub={settingsSub}
              onPluginsChanged={reloadPlugins}
            />
          )}
          {activeView === "automations" && (
            <AutomationsView
              automations={automationItems}
              onCreatete={handleCreateteAutomation}
              onUpdate={handleUpdateAutomation}
              onToggle={handleToggleAutomation}
              onDelete={handleDeleteAutomation}
            />
          )}
          {enabledPlugins.map(
            (plugin) =>
              activeView === plugin.id && <plugin.Panel key={plugin.id} host={pluginHost} />,
          )}
          {activeView === "browser" && <ContainedComputerView />}
          {activeView === "brain" && (
            <ShallowView
              title="Brain Audit"
              eyebrow={t("app.explainablePlans")}
              description={`Route, loaded tools, memory refs and subagent steps are persisted without raw payload. ${contextBudgetSummary(brainRun.contextBudget)}`}
              stats={[
                { label: "Route", value: brainRun.route },
                { label: "Rounds", value: String(brainRun.plannerRounds) },
                { label: "Tools", value: String(brainRun.loadedTools) },
                {
                  label: "Context",
                  value: `${Math.round(contextBudgetCompressionRatio(brainRun.contextBudget) * 100)}%`,
                },
              ]}
            />
          )}
        </Suspense>
      </main>
    </Shell>
      {searchOpen && (
        <ChatSearchModal
          chatThreads={chatThreads}
          onClose={() => setSearchOpen(false)}
          onSelectThread={(threadId) => {
            setSearchOpen(false);
            void handleSelectThread(threadId);
          }}
        />
      )}
      {/* Rendered AFTER Shell so the overlay's `-webkit-app-region: no-drag`
          regions are processed last and win over the main app's drag zones
          (e.g. .task-topbar), which otherwise swallow clicks on the onboarding's
          top-placed controls (provider slide-over close). */}
      {showOnboarding && (
        <OnboardingWizard onComplete={() => setShowOnboarding(false)} />
      )}
    </>
  );
}

export default function App() {
  return (
    <LoginGate>
      <AuthenticatedApp />
    </LoginGate>
  );
}

function contextBudgetCompressionRatio(
  budget: Array<{ inputChars: number; outputChars: number }>,
) {
  const input = budget.reduce((total, item) => total + item.inputChars, 0);
  const output = budget.reduce((total, item) => total + item.outputChars, 0);
  if (input === 0) return 100;
  return output / input;
}

function contextBudgetSummary(
  budget: Array<{
    compressed: boolean;
    redacted: boolean;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    redactionCount: number;
  }>,
) {
  const compressed = budget.filter((item) => item.compressed).length;
  const redacted = budget.reduce((total, item) => total + item.redactionCount, 0);
  const inputTokens = budget.reduce(
    (total, item) => total + item.estimatedInputTokens,
    0,
  );
  const outputTokens = budget.reduce(
    (total, item) => total + item.estimatedOutputTokens,
    0,
  );
  if (budget.length === 0) return "No compression applied.";
  return `Compressed ${compressed}/${budget.length} contexts, ${inputTokens} -> ${outputTokens} estimated tokens, ${redacted} redactions.`;
}
