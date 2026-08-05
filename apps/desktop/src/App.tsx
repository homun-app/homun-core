import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { Shell } from "./components/Shell";
import { ChatSearchModal } from "./components/Sidebar";
import { LoginGate } from "./components/LoginGate";
import { AppWorkspace } from "./components/AppWorkspace";
import {
  chatMessages,
  navItems as staticNavItems,
} from "./data/mockData";
import { pluginRegistry, type PluginHost } from "./plugins/registry";
import {
  coreBridge,
  type AppEvent,
  type ChatAttachmentInput,
  type CoreChatThreadSnapshot,
  type CoreThreadAttention,
  type ProactivitySuggestion,
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
  type ThreadAttentionState,
} from "./lib/threadAttentionState";
import {
  attentionRequiredThreadIds,
  projectConversationAttention,
} from "./lib/conversationAttention";
import { sidebarWorkspaceIsActive } from "./lib/sidebarFilterState";
import {
  currentTimestampSeconds,
  mapCoreChatMessage,
  mapCoreChatThread,
  mapCoreThreadAttention,
  pendingChatAttachmentFromInput,
  starterMessages,
  summarizeThreadTitle,
  updateThreadPreview,
} from "./lib/appCoreMappers";
import { buildTemplateWorkflowAutoSubmit } from "./lib/templateWorkflowPrompt";
import {
  hasPendingLocalMessages,
  shouldPreserveLocalMessages,
} from "./lib/chatMessagePreservation";
import {
  composePluginNavItems,
  enabledRegistryPlugins,
} from "./lib/appPluginNavigation";
import { projectThreadSnapshotSelection } from "./lib/threadSnapshotProjection";
import { projectBusyThreadIds } from "./lib/busyThreadProjection";
import { buildProactivityChatSeed } from "./lib/proactivityChatSeed";
import { selectInitialThreadFromSnapshot } from "./lib/initialThreadSelection";
import { useAutomationController } from "./lib/useAutomationController";
import { useCapabilityController } from "./lib/useCapabilityController";
import { useOnboardingSetupGate } from "./lib/useOnboardingSetupGate";
import { usePluginController } from "./lib/usePluginController";
import { useResponsiveDrawer } from "./lib/useResponsiveDrawer";
import { useTaskQueueController } from "./lib/useTaskQueueController";
import { useBackgroundStreams } from "./lib/useBackgroundStreams";
import type {
  ChatAttachment,
  ChatMessage,
  ChatThread,
  NavItem,
  SettingsSectionId,
  ViewId,
} from "./types";

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
  const [threadAttention, setThreadAttention] = useState<ThreadAttentionState>(() =>
    createThreadAttentionState(defaultChatThread.threadId),
  );
  const threadAttentionRef = useRef(threadAttention);
  // Search modal lifted here (was in Shell) so BOTH the sidebar and the collapsed in-header
  // controls can open it via one owner.
  const [searchOpen, setSearchOpen] = useState(false);
  const { showOnboarding, completeOnboarding } = useOnboardingSetupGate();
  const { pluginStates, reloadPlugins } = usePluginController();
  const { drawerOpen, expandDrawer, toggleDrawer } = useResponsiveDrawer();
  const { backgroundStreamIds, streamingThreadId, setStreamingThreadId } =
    useBackgroundStreams();
  const activeThread = useMemo(
    () =>
      chatThreads.find((thread) => thread.threadId === activeThreadId) ??
      chatThreads[0] ??
      defaultChatThread,
    [activeThreadId, chatThreads],
  );
  const automationWorkspaceId = activeThread.workspaceId ?? undefined;
  const {
    automationItems,
    handleCreateteAutomation,
    handleUpdateAutomation,
    handleToggleAutomation,
    handleDeleteAutomation,
  } = useAutomationController({
    workspaceId: automationWorkspaceId,
    enabled: activeView === "automations",
  });
  const { connectionItems } = useCapabilityController();
  const {
    taskItems,
    approvalItems,
    uncertainEffectItems,
    approvalBusyId,
    effectResolutionBusyId,
    effectResolutionError,
    refreshRuntimeReadModels,
    handleApproveApprovel,
    handleRejectApprovel,
    handleResolveUncertainEffect,
  } = useTaskQueueController({
    activeThreadId: activeThread.threadId,
    refreshChatReadModels,
  });
  const activeUncertainEffects = useMemo(
    () => uncertainEffectItems.filter((effect) => effect.threadId === activeThread.threadId),
    [activeThread.threadId, uncertainEffectItems],
  );
  // Threads "busy": a real-time streaming signal (from ChatView, sub-poll) UNION
  // the taskQueue snapshot (running/queued tasks linked to a thread). The union
  // covers both the chat-stream case and the durable-background-task case.
  const busyThreadIds = useMemo(
    () =>
      projectBusyThreadIds({
        backgroundStreamIds, streamingThreadId, chatThreads, taskItems,
      }),
    [streamingThreadId, backgroundStreamIds, chatThreads, taskItems],
  );
  useEffect(() => {
    busyThreadIdsRef.current = busyThreadIds;
  }, [busyThreadIds]);
  const pendingAttentionThreadIds = useMemo(
    () => attentionRequiredThreadIds(chatThreads, approvalItems, uncertainEffectItems),
    [approvalItems, chatThreads, uncertainEffectItems],
  );
  const attentionByThread = useMemo(
    () =>
      projectConversationAttention(
        threadAttention.byThread,
        busyThreadIds,
        pendingAttentionThreadIds,
      ),
    [busyThreadIds, pendingAttentionThreadIds, threadAttention.byThread],
  );
  const activeMessages =
    threadMessages[activeThread.threadId] ?? starterMessages(activeThread);
  const isSettings = activeView === "settings";

  function setThreadMessagesFromBackend(
    threadId: string,
    incomingMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ) {
    setThreadMessages((current) => {
      const currentMessages = current[threadId];
      if (
        options.force !== true &&
        shouldPreserveLocalMessages({
          currentMessages,
          incomingMessages,
          isProtected:
            pendingLocalMessageThreadIdsRef.current.has(threadId) ||
            busyThreadIdsRef.current.has(threadId),
        })
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
    const { workspaceId, question, seedEventParts } = buildProactivityChatSeed(
      suggestion,
      PERSONAL_WORKSPACE_ID,
    );
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
      setActiveView("chat");
    } catch (error) {
      console.warn("open_suggestion unavailable", error);
    }
  }

  async function handleStartTemplateWorkflow(input: {
    template: TemplateCatalogEntry;
    attachment?: ChatAttachmentInput;
  }) {
    const workflow = buildTemplateWorkflowAutoSubmit(input);
    try {
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      const messages = await coreBridge.chatMessages(created.threadId);
      const timestamp = currentTimestampSeconds();
      setChatThreads((current) => [
        {
          ...created,
          title: summarizeThreadTitle(workflow.visiblePrompt),
          messageCount: Math.max(created.messageCount, messages.messages.length),
          updatedAt: timestamp,
        },
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessagesFromBackend(created.threadId, messages.messages.map(mapCoreChatMessage));
      setActiveThreadId(created.threadId);
      setActiveView("chat");
      setPendingTemplateAutoSubmit({
        id: `template_auto_submit_${created.threadId}_${Date.now()}`,
        threadId: created.threadId,
        prompt: workflow.operativePrompt,
        visibleText: workflow.visiblePrompt,
        attachments: input.attachment ? [input.attachment] : [],
        visibleAttachments: input.attachment
          ? [pendingChatAttachmentFromInput(input.attachment)]
          : undefined,
        mode: "plan",
        routingBinding: workflow.routingBinding,
      });
    } catch (error) {
      console.warn("start_template_workflow unavailable", error);
    }
  }

  // A registry plugin is shown unless the backend says it's disabled (default-on).
  const enabledPlugins = enabledRegistryPlugins(pluginRegistry, pluginStates);
  const composedNavItems: NavItem[] = composePluginNavItems(
    staticNavItems,
    enabledPlugins,
  );
  // The host capability surface handed to each plugin panel (ADR 0011 §6).
  const pluginHost: PluginHost = {
    openChat: handleOpenSuggestion,
    startTemplateWorkflow: handleStartTemplateWorkflow,
  };

  async function applyThreadSnapshot(snapshot: CoreChatThreadSnapshot) {
    const mappedThreads = snapshot.threads.map(mapCoreChatThread);
    const selection = projectThreadSnapshotSelection({
      mappedThreads,
      activeThreadId,
      snapshotActiveThreadId: snapshot.active_thread_id,
      defaultThread: defaultChatThread,
    });
    setChatThreads((current) => reconcileChatThreads(current, selection.desiredThreads));
    if (!selection.preservedThread) {
      const selectedThread = selection.selectedThread;
      setActiveThreadId(selectedThread.threadId);
    }
    if (!threadMessages[selection.selectedThread.threadId]) {
      try {
        const messages = await coreBridge.chatMessages(selection.selectedThread.threadId);
        setThreadMessages((current) => ({
          ...current,
          [selection.selectedThread.threadId]: messages.messages.map(mapCoreChatMessage),
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

  useEffect(() => {
    let cancelled = false;

    async function refreshOperationalReadModels() {
      if (!activeThreadId) return;
      try {
        await refreshRuntimeReadModels();
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
        const { desiredThreads, selectedThread } = selectInitialThreadFromSnapshot({
          mappedThreads: mapped,
          snapshotActiveThreadId: snapshot.active_thread_id,
          defaultThread: defaultChatThread,
        });
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
        setChatThreads(desiredThreads);
        setActiveThreadId(selectedThread.threadId);
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
      onToggleDrawer={toggleDrawer}
      onSearchChat={() => setSearchOpen(true)}
      onUnarchiveChatThread={handleUnarchiveChatThread}
      onSelectSettingsSection={setSettingsSection}
      settingsSection={settingsSection}
      settingsSub={settingsSub}
      onSelectSettingsSub={setSettingsSub}
      hideChrome={showOnboarding}
    >
      <AppWorkspace
        activeView={activeView}
        isSettings={isSettings}
        sidebarCollapsed={!drawerOpen}
        activeThread={activeThread}
        activeMessages={activeMessages}
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
        settingsSection={settingsSection}
        settingsSub={settingsSub}
        connections={connectionItems}
        automations={automationItems}
        enabledPlugins={enabledPlugins}
        pluginHost={pluginHost}
        onExpandSidebar={expandDrawer}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenUsageSettings={() => {
          setPreviousView("chat");
          setSettingsSection("usage");
          setSettingsSub("");
          setActiveView("settings");
        }}
        onMessagesChange={(messages) =>
          handleMessagesChange(activeThread.threadId, messages)
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
        onPluginsChanged={reloadPlugins}
        onCreateteAutomation={handleCreateteAutomation}
        onUpdateAutomation={handleUpdateAutomation}
        onToggleAutomation={handleToggleAutomation}
        onDeleteAutomation={handleDeleteAutomation}
      />
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
        <OnboardingWizard onComplete={completeOnboarding} />
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
