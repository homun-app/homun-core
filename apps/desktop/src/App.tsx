import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { Shell } from "./components/Shell";
import { ChatSearchModal } from "./components/Sidebar";
import { LoginGate } from "./components/LoginGate";
import { AppWorkspace } from "./components/AppWorkspace";
import { chatMessages } from "./data/mockData";
import { useSetting } from "./lib/settingsStore";
import { currentTimestampSeconds } from "./lib/appCoreMappers";
import { projectBusyThreadIds } from "./lib/busyThreadProjection";
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
import {
  useChatThreadCreation,
  type PendingTemplateAutoSubmit,
} from "./lib/useChatThreadCreation";
import { useThreadAttentionNotifications } from "./lib/useThreadAttentionNotifications";
import { useChatReadModelController } from "./lib/useChatReadModelController";
import { usePluginHostController } from "./lib/usePluginHostController";
import type {
  ChatMessage,
  ChatThread,
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
  const [pendingTemplateAutoSubmit, setPendingTemplateAutoSubmit] =
    useState<PendingTemplateAutoSubmit | null>(null);
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
  const refreshChatReadModelsRef = useRef<
    (preferredThreadId?: string) => Promise<void>
  >(async () => {});
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
  function refreshChatReadModels(preferredThreadId?: string) {
    return refreshChatReadModelsRef.current(preferredThreadId);
  }
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
  const isSettings = activeView === "settings";

  const {
    activeMessages,
    setThreadMessagesFromBackend,
    handleSelectThread,
    refreshThreadInBackground,
    handleMessagesChange,
    refreshChatReadModels: refreshChatReadModelsFromController,
  } = useChatReadModelController({
    activeThread,
    activeThreadId,
    chatThreads,
    threadMessages,
    defaultThread: defaultChatThread,
    pendingLocalMessageThreadIdsRef,
    busyThreadIdsRef,
    setChatThreads,
    setThreadMessages,
    setActiveThreadId,
    setActiveView,
    applyThreadAttentionRows,
    markSelectedThreadSeen,
  });
  refreshChatReadModelsRef.current = refreshChatReadModelsFromController;

  useThreadAttentionNotifications({
    chatThreads,
    pendingAttentionThreadIds,
    systemNotifEnabled,
    labels: {
      requiresAttention: t("notifications.requiresAttention"),
      openConversation: t("notifications.openConversation"),
    },
    onSelectThread: handleSelectThread,
  });

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

  const {
    handleCreateteChatThread,
    handleOpenSuggestion,
    handleStartTemplateWorkflow,
  } = useChatThreadCreation({
    defaultThread: defaultChatThread,
    personalWorkspaceId: PERSONAL_WORKSPACE_ID,
    setChatThreads,
    setThreadMessages,
    setActiveThreadId,
    setActiveView,
    setThreadMessagesFromBackend,
    setPendingTemplateAutoSubmit,
  });

  const { enabledPlugins, composedNavItems, pluginHost } = usePluginHostController({
    pluginStates,
    openChat: handleOpenSuggestion,
    startTemplateWorkflow: handleStartTemplateWorkflow,
  });
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
