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
  type ChatAttachmentInput,
  type ProactivitySuggestion,
  type RoutingBindingInput,
  type TemplateCatalogEntry,
} from "./lib/coreBridge";
import { useSetting } from "./lib/settingsStore";
import { showSystemNotification, notificationPermission } from "./lib/systemNotifications";
import { reconcileChatMessages, reconcileChatThreads } from "./lib/uiSnapshot";
import {
  currentTimestampSeconds,
  mapCoreChatMessage,
  mapCoreChatThread,
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
import { projectBusyThreadIds } from "./lib/busyThreadProjection";
import { buildProactivityChatSeed } from "./lib/proactivityChatSeed";
import { useAutomationController } from "./lib/useAutomationController";
import { useCapabilityController } from "./lib/useCapabilityController";
import { useOnboardingSetupGate } from "./lib/useOnboardingSetupGate";
import { usePluginController } from "./lib/usePluginController";
import { useResponsiveDrawer } from "./lib/useResponsiveDrawer";
import { useTaskQueueController } from "./lib/useTaskQueueController";
import { useBackgroundStreams } from "./lib/useBackgroundStreams";
import { useAppNavigation } from "./lib/useAppNavigation";
import { useThreadAttentionController } from "./lib/useThreadAttentionController";
import { useOperationalReadModelPoller } from "./lib/useOperationalReadModelPoller";
import {
  useAppEventSubscription,
  type IncomingBackgroundTurn,
} from "./lib/useAppEventSubscription";
import { useInitialChatThreadsLoader } from "./lib/useInitialChatThreadsLoader";
import { useChatThreadMutations } from "./lib/useChatThreadMutations";
import type {
  ChatAttachment,
  ChatMessage,
  ChatThread,
  NavItem,
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
  const {
    activeView,
    settingsSection,
    settingsSub,
    searchOpen,
    setActiveView,
    setSettingsSection,
    setSettingsSub,
    handleNavigate,
    backFromSettings,
    openUsageSettings,
    openSearch,
    closeSearch,
  } = useAppNavigation();
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
  const [incomingBackgroundTurn, setIncomingBackgroundTurn] =
    useState<IncomingBackgroundTurn | null>(null);
  const pendingLocalMessageThreadIdsRef = useRef<Set<string>>(new Set());
  const busyThreadIdsRef = useRef<Set<string>>(new Set());
  const notifiedAttentionThreadIdsRef = useRef<Set<string> | null>(null);
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
  const {
    threadAttention,
    pendingAttentionThreadIds,
    attentionByThread,
    applyThreadAttentionRows,
    markSelectedThreadSeen,
    selectThreadAttention,
  } = useThreadAttentionController({
    initialThreadId: defaultChatThread.threadId,
    chatThreads,
    approvalItems,
    uncertainEffectItems,
    busyThreadIds,
  });
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

  useAppEventSubscription({
    activeThreadId,
    systemNotifEnabled,
    labels: {
      newActivity: t("notifications.newActivity"),
      scheduledReady: t("notifications.scheduledReady"),
      newMessage: t("notifications.newMessage"),
    },
    onSelectThread: handleSelectThread,
    refreshThreadInBackground,
    setIncomingBackgroundTurn,
    bumpIslandRefreshNonce: () => setIslandRefreshNonce((n) => n + 1),
  });

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
  const {
    handleSetChatThreadPinned,
    handleRenameChatThread,
    handleArchiveChatThread,
    handleUnarchiveChatThread,
    handleDeleteChatThread,
  } = useChatThreadMutations({
    activeThreadId,
    activeWorkspaceId: activeThread.workspaceId ?? undefined,
    chatThreads,
    threadMessages,
    defaultThread: defaultChatThread,
    personalWorkspaceId: PERSONAL_WORKSPACE_ID,
    setChatThreads,
    setActiveThreadId,
    setThreadMessages,
  });

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

  useOperationalReadModelPoller({
    activeThreadId,
    refreshRuntimeReadModels,
    refreshChatReadModels,
  });

  useInitialChatThreadsLoader({
    defaultThread: defaultChatThread,
    setChatThreads,
    setActiveThreadId,
    setThreadMessagesFromBackend,
    selectThreadAttention,
    applyThreadAttentionRows,
    markSelectedThreadSeen,
  });

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
      onBackFromSettings={backFromSettings}
      onDeleteChatThread={handleDeleteChatThread}
      navItems={composedNavItems}
      onNavigate={handleNavigate}
      onSelectThread={handleSelectThread}
      onThreadAttention={applyThreadAttentionRows}
      onSetChatThreadPinned={handleSetChatThreadPinned}
      onToggleDrawer={toggleDrawer}
      onSearchChat={openSearch}
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
        onOpenSearch={openSearch}
        onOpenUsageSettings={openUsageSettings}
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
          onClose={closeSearch}
          onSelectThread={(threadId) => {
            closeSearch();
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
