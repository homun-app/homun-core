import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeContext } from "../lib/useRuntimeContext";
import { IS_DESKTOP } from "../lib/gatewayConfig";
import {
  latestAssistantEffectiveModel,
} from "../lib/composerTurnContract";
import { shortModelName } from "../lib/chatViewMessages";
import {
  buildBranchIndex,
  buildPreviousUserMessageIndex,
} from "../lib/messageIndex";
import {
  buildConversationArtifacts,
  buildIslandSources,
  buildUploadedFiles,
  buildWorkbenchArtifacts,
} from "./ChatWorkspaceProjections";
import { projectWorkspaceSections } from "../lib/workspaceIslandSections";
import { deriveBrowserStatus } from "../lib/chat-runtime/browserActivityLifecycle";
import {
  PANEL_VIEWS,
  type IslandSource,
} from "./InspectorView";
import { ChatComposerDock } from "./ChatComposerDock";
import { ChatInspectorDock } from "./ChatInspectorDock";
import { ChatWorkspaceDock } from "./ChatWorkspaceDock";
import { ChatTopbar } from "./ChatTopbar";
import { ChatTranscript } from "./ChatTranscript";
import type { ChatViewProps } from "./ChatViewTypes";
import { useChatAutoTitle } from "./useChatAutoTitle";
import { useChatBranches } from "./useChatBranches";
import { useChatBrowserActivityLifecycle } from "./useChatBrowserActivityLifecycle";
import { useChatConversationScroll } from "./useChatConversationScroll";
import { useChatFollowUps } from "./useChatFollowUps";
import { useChatInspectorWorkspace } from "./useChatInspectorWorkspace";
import { useChatMemoryArtifacts } from "./useChatMemoryArtifacts";
import { useChatMessageActions } from "./useChatMessageActions";
import { useChatMessageEditing } from "./useChatMessageEditing";
import { useChatProjectContext } from "./useChatProjectContext";
import { useChatApprovalFlow } from "./useChatApprovalFlow";
import { useChatStreamLifecycle } from "./useChatStreamLifecycle";
import { useChatStreamingNotifier } from "./useChatStreamingNotifier";
import { useChatTurnStateMachine } from "./useChatTurnStateMachine";
import { useChatTurnSubmission } from "./useChatTurnSubmission";
import { useChatStreamResume } from "./useChatStreamResume";
import { useChatTurnStatus } from "./useChatTurnStatus";
import { usePlanStepPulse } from "./usePlanStepPulse";
import type { ChatMessage } from "../types";

const CHAT_VIEW_SESSION_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat_view_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export function ChatView({
  sidebarCollapsed,
  onExpandSidebar,
  onOpenSearch,
  onOpenUsageSettings,
  approvals,
  approvalBusyId,
  uncertainEffects,
  effectResolutionBusyId,
  effectResolutionError,
  computerSessionId,
  messages,
  thread,
  onMessagesChange,
  islandRefreshNonce,
  bumpIslandRefreshNonce,
  runtimeContextRevision,
  incomingBackgroundTurn,
  onResolveEffect,
  onApproveApprovel,
  onRejectApprovel,
  onRuntimeChanged,
  onThreadChanged,
  onStreamingChange,
  seed,
  autoSubmit,
  onAutoSubmitConsumed,
}: ChatViewProps) {
  const { t } = useTranslation();

  // ── Turn state machine (state atoms, refs, effects) ───────────────────
  const {
    promptSubmitting,
    promptError,
    streamingAssistantId,
    streamStatus,
    liveActivitySteps,
    livePlanMarkdown,
    optimisticMessages,
    autoContinueMessageId,
    replyContext,
    setPromptSubmitting,
    setPromptError,
    setStreamingAssistantId,
    setStreamStatus,
    setLiveActivitySteps,
    setLivePlanMarkdown,
    setOptimisticMessages,
    setAutoContinueMessageId,
    setReplyContext,
    activeTurnIdRef,
    turnReplayRef,
    streamOwnerTurnRef,
    handledBackgroundTurnsRef,
    resumedThreadsRef,
    consumedAutoSubmitIdsRef,
    externalRef,
    threadMessages,
    activeStreamInProgress,
    refreshAfterChatSubmit,
  } = useChatTurnStateMachine({
    thread,
    messages,
    onStreamingChange,
    onThreadChanged,
    onRuntimeChanged,
    autoSubmit,
    onAutoSubmitConsumed,
    incomingBackgroundTurn,
    sessionId: CHAT_VIEW_SESSION_ID,
  });

  // ── Runtime context ────────────────────────────────────────────────────
  const {
    runtimeContext,
    runtimeContextLoading,
    runtimeContextError,
    refreshRuntimeContext,
  } = useRuntimeContext({
    threadId: thread.threadId,
    runtimeContextRevision,
  });

  // ── Memory artifacts ───────────────────────────────────────────────────
  const {
    memoryArtifacts,
    memoryArtifactsLoaded,
    memoryArtifactsLoadError,
    retryMemoryArtifacts,
  } = useChatMemoryArtifacts(thread.threadId, messages);

  // ── Project context ────────────────────────────────────────────────────
  const {
    goalSeed,
    projectGoalCount,
    projectMemoryCount,
    projectObjective,
    setGoalSeed,
    threadIsProject,
  } = useChatProjectContext(thread.threadId);

  // ── Layout ref + streaming notifier ────────────────────────────────────
  const layoutRef = useRef<HTMLElement>(null);
  const { isMountedRef, notifyStreaming } = useChatStreamingNotifier(onStreamingChange);

  // ── Branches ───────────────────────────────────────────────────────────
  const {
    branchBusy,
    branches,
    refreshBranches,
    renameBranch,
    switchBranch,
  } = useChatBranches({
    branchLabelPrompt: t("chat.branchLabelPrompt"),
    isMountedRef,
    messages,
    onThreadChanged,
    promptSubmitting,
    setOptimisticMessages,
    setPromptError,
    streamingAssistantId,
    threadId: thread.threadId,
  });

  // ── Auto title ─────────────────────────────────────────────────────────
  const { persistAutoTitleForCompletedTurn } = useChatAutoTitle({
    threadId: thread.threadId,
  });

  // ── Conversation scroll ────────────────────────────────────────────────
  const {
    afterStreamingFramePaint,
    cancelScheduledStreamingFrame,
    clearStreamingFrame,
    clearStreamingPin,
    conversationRef,
    forceStreamingPin,
    jumpToBottom,
    markStreamingPinnedFromCurrentPosition,
    requestStreamingFrame,
    scrollConversationToBottomIfPinned,
    showJumpToBottom,
  } = useChatConversationScroll({
    threadId: thread.threadId,
    threadMessages,
    streamingAssistantId,
  });

  // ── Stream lifecycle ───────────────────────────────────────────────────
  const {
    cancelActiveStreaming,
    clearActiveStreamingCancel,
    clearStreamCancelled,
    hasActiveStreamingCancel,
    isStreamCancelled,
    markStreamCancelled,
    markStreamHasVisibleText,
    resetStreamingState,
    setActiveStreamingCancel,
    streamHasVisibleText,
  } = useChatStreamLifecycle({
    cancelScheduledStreamingFrame,
  });

  // ── Transcript indexes and artifact memos ──────────────────────────────
  const previousUserMessageIndex = useMemo(
    () => buildPreviousUserMessageIndex(threadMessages),
    [threadMessages],
  );
  const branchIndex = useMemo(() => buildBranchIndex(branches), [branches]);
  const conversationArtifacts = useMemo(() => buildConversationArtifacts(messages), [messages]);
  const workbenchArtifacts = useMemo(
    () => buildWorkbenchArtifacts(conversationArtifacts, memoryArtifacts, thread.threadId),
    [conversationArtifacts, memoryArtifacts, thread.threadId],
  );

  // ── Follow-ups (before submission — selectFollowUp calls clearFollowUps) ─
  const {
    clearFollowUps,
    followUps,
    followUpsFor,
  } = useChatFollowUps({
    previousUserMessageIndex,
    streamingAssistantId,
    threadMessages,
  });

  // ── Inspector workspace ────────────────────────────────────────────────
  const {
    inspector,
    inspectorRatio,
    inspectorResourcesReady,
    activateInspectorTab,
    closeInspectorTab,
    commitInspectorRatio,
    hideInspector,
    moveInspectorTab,
    openArtifactTab,
    openFileTab,
    openUtilityTab,
    toggleInspectorFocus,
  } = useChatInspectorWorkspace({
    artifactCatalogLoaded: memoryArtifactsLoaded,
    artifactCatalogLoadError: memoryArtifactsLoadError,
    threadId: thread.threadId,
    translate: t,
    workbenchArtifacts,
    workspaceId: thread.workspaceId,
  });

  // ── Message actions ─────────────────────────────────────────────────────
  const {
    captureScreenshot,
    copiedMessageId,
    copyMessageText,
    saveMessageAsGoal,
    saveMessageToMemory,
    setMessageFeedback,
  } = useChatMessageActions({
    onMessagesChange,
    onRuntimeChanged,
    onThreadChanged,
    openGoalsTab: () => openUtilityTab("goals"),
    setGoalSeed,
    setPromptError,
    threadId: thread.threadId,
    threadMessages,
  });

  // ── Browser / activity lifecycle (computer session + activity projection) ──
  const {
    activeSurface,
    activityNonce,
    applyComputerSessionSnapshot,
    browserBudgetAssistantId,
    browserBudgetMessage,
    bumpActivityNonce,
    clearProjectedActiveTurn,
    computerControlBusy,
    computerControlError,
    computerLiveStatus,
    computerSession,
    conversationActivity,
    conversationPlan,
    markProjectedTurnStatus,
    pauseComputer,
    previewDataUrl,
    projectedSubagents,
    resumeComputer,
    runtimeViewModel,
    setActiveSurface,
    setComputerLiveStatus,
    takeoverComputer,
    visibleComputerSession,
    workspacePlanGoal,
    workspacePlanSteps,
  } = useChatBrowserActivityLifecycle({
    computerSessionId,
    threadId: thread.threadId,
    threadMessages,
    islandRefreshNonce,
    activeStreamInProgress,
    liveActivitySteps,
    livePlanMarkdown,
    activeTurnIdRef,
    streamOwnerTurnRef,
    turnReplayRef,
    translate: t,
  });

  // Brief highlight of the plan step a kernel `step_advance` event touched.
  const planStepPulseId = usePlanStepPulse();

  // ── Turn lifecycle derivation ──────────────────────────────────────────
  const turnStatus = runtimeViewModel.turnUiState.status;
  const {
    isStreaming,
    turnAwaitingUser,
    hasActiveTurn,
    workInProgress,
    terminalTurnAtRest,
  } = runtimeViewModel.turnUiState;

  // ── Approval flow ──────────────────────────────────────────────────────
  const {
    pendingSteering,
    applyPendingSteeringChange,
    deletePendingSteering,
    editPendingSteering,
    refreshPendingSteering,
    sendPendingSteeringNow,
    visiblePendingSteeringRowsForTurn,
    activeApprovels,
  } = useChatApprovalFlow({
    threadId: thread.threadId,
    isMountedRef,
    onThreadChanged,
    setPromptError,
    approvals,
    computerSessionId,
    terminalTurnAtRest,
    activeTurnId: runtimeViewModel.activeTurn?.turn_id ?? null,
  });

  // Durable wait (approval/CHOICES hold) must not keep a live "writing" owner.
  useEffect(() => {
    if (!turnAwaitingUser || !streamingAssistantId) return;
    setStreamingAssistantId(null);
    setStreamStatus(null);
  }, [turnAwaitingUser, streamingAssistantId]);

  // ── Turn submission (streaming functions + composer state) ────────────
  const {
    submitPrompt,
    submitComposerPrompt,
    stopActiveTurn,
    openActivityIsland,
    handleProactiveAnswer,
    submitChoiceAnswer,
    selectFollowUp,
    regenerateAnswer,
    replyToMessage,
    continueAssistantResponse,
    expandAssistantResponse,
    askAboutAssistantResponse,
    composerSeed,
    usageSuggestedModel,
    setUsageSuggestedModel,
  } = useChatTurnSubmission({
    thread,
    messages,
    onMessagesChange,
    computerSessionId,
    onThreadChanged,
    bumpIslandRefreshNonce: bumpIslandRefreshNonce ?? (() => undefined),
    seed,
    sessionId: CHAT_VIEW_SESSION_ID,
    translate: t,
    promptSubmitting,
    streamingAssistantId,
    threadMessages,
    replyContext,
    runtimeViewModel,
    setPromptSubmitting,
    setPromptError,
    setStreamingAssistantId,
    setStreamStatus,
    setLiveActivitySteps,
    setLivePlanMarkdown,
    setOptimisticMessages,
    setAutoContinueMessageId,
    setReplyContext,
    activeTurnIdRef,
    streamOwnerTurnRef,
    handledBackgroundTurnsRef,
    turnReplayRef,
    refreshAfterChatSubmit,
    isMountedRef,
    notifyStreaming,
    persistAutoTitleForCompletedTurn,
    clearStreamingFrame,
    afterStreamingFramePaint,
    requestStreamingFrame,
    clearStreamingPin,
    forceStreamingPin,
    markStreamingPinnedFromCurrentPosition,
    scrollConversationToBottomIfPinned,
    cancelScheduledStreamingFrame,
    resetStreamingState,
    markStreamCancelled,
    isStreamCancelled,
    markStreamHasVisibleText,
    setActiveStreamingCancel,
    clearActiveStreamingCancel,
    clearStreamCancelled,
    hasActiveStreamingCancel,
    cancelActiveStreaming,
    applyComputerSessionSnapshot,
    clearProjectedActiveTurn,
    bumpActivityNonce,
    hideInspector,
    applyPendingSteeringChange,
    refreshPendingSteering,
    refreshBranches,
    clearFollowUps,
    previousUserMessageIndex,
  });

  // ── Stream resume (reattach to a stream after reload) ─────────────────
  const { resumeActiveStream } = useChatStreamResume({
    thread,
    messages,
    onMessagesChange,
    computerSessionId,
    translate: t,
    promptSubmitting,
    streamingAssistantId,
    setPromptSubmitting,
    setPromptError,
    setOptimisticMessages,
    setStreamingAssistantId,
    setStreamStatus,
    activeTurnIdRef,
    streamOwnerTurnRef,
    turnReplayRef,
    refreshAfterChatSubmit,
    notifyStreaming,
    persistAutoTitleForCompletedTurn,
    clearStreamingFrame,
    afterStreamingFramePaint,
    requestStreamingFrame,
    clearStreamingPin,
    forceStreamingPin,
    cancelScheduledStreamingFrame,
    resetStreamingState,
    markStreamHasVisibleText,
    markStreamCancelled,
    isStreamCancelled,
    clearStreamCancelled,
    setActiveStreamingCancel,
    clearActiveStreamingCancel,
    bumpIslandRefreshNonce: bumpIslandRefreshNonce ?? (() => undefined),
  });

  // Wire external callbacks for the turn state machine's effects (WS subscription,
  // auto-submit, resume, background turn). The ref ensures effects always call
  // the latest version at runtime.
  externalRef.current = {
    submitPrompt,
    resumeActiveStream,
    markProjectedTurnStatus,
  };

  // ── Message editing (after submission — needs submitPrompt) ────────────
  const {
    cancelEditMessage,
    editingMessageId,
    editingText,
    saveEditedMessage,
    setEditingText,
    startEditMessage,
  } = useChatMessageEditing({
    promptSubmitting,
    setOptimisticMessages,
    submitEditedPrompt: submitPrompt,
    threadMessages,
  });

  // ── Derived chat turn state for the composer dock ─────────────────────
  const chatTurnState = useChatTurnStatus({
    runtimeViewModel,
    streamStatus,
    conversationActivityCount: conversationActivity.length,
    translate: t,
  });

  // ── Workspace projections ─────────────────────────────────────────────
  const uploadedFiles = useMemo(() => buildUploadedFiles(messages), [messages]);
  const islandSources = useMemo(
    () => buildIslandSources(workbenchArtifacts, uploadedFiles),
    [workbenchArtifacts, uploadedFiles],
  );
  const availableInspectorViews = useMemo(
    () =>
      PANEL_VIEWS.filter((view) => {
        if (view.key === "artifact") return workbenchArtifacts.length > 0;
        if (view.key === "file") return uploadedFiles.length > 0 || threadIsProject;
        if (view.key === "activity") return conversationActivity.length > 0 || activeApprovels.length > 0;
        if (view.key === "plan") return workspacePlanSteps.length > 0;
        if (view.key === "goals") return projectGoalCount > 0 || Boolean(goalSeed);
        if (view.key === "graph") return projectMemoryCount > 0;
        if (view.key === "sources") return islandSources.length > 0;
        if (view.key === "subagents") return projectedSubagents.length > 0;
        if (view.key === "computer") {
          return computerLiveStatus.active || activeApprovels.length > 0;
        }
        if (view.key === "execution") return true;
        return false;
      }),
    [
      activeApprovels.length,
      conversationActivity.length,
      uploadedFiles.length,
      workbenchArtifacts.length,
      workspacePlanSteps.length,
      goalSeed,
      projectGoalCount,
      projectMemoryCount,
      threadIsProject,
      islandSources.length,
      projectedSubagents.length,
      computerLiveStatus.active,
    ],
  );

  const lastAssistantEffectiveModel = useMemo(() => {
    const model = latestAssistantEffectiveModel(threadMessages);
    return model ? shortModelName(model) : t("composer.runtime.unavailable");
  }, [t, threadMessages]);

  const islandArtifacts = useMemo(
    () => islandSources.filter((source) => source.action === "artifact"),
    [islandSources],
  );
  const islandFileSources = useMemo(
    () => islandSources.filter((source) => source.action === "files"),
    [islandSources],
  );
  const workspaceSections = useMemo(
    () => projectWorkspaceSections({
      planSteps: workspacePlanSteps,
      activity: [
        ...conversationActivity,
        ...projectedSubagents.map((subagent) => `${subagent.name}:${subagent.status}`),
      ],
      streaming: workInProgress,
      executionStatus: turnAwaitingUser ? "waiting_user" : turnStatus,
      browser: deriveBrowserStatus(computerLiveStatus, previewDataUrl, computerControlError),
      artifacts: islandArtifacts.map((source) => ({
        id: `${source.artifactThread ?? thread.threadId}:${source.artifactName ?? source.name}`,
      })),
      sources: islandFileSources.map((source) => ({ id: source.name })),
    }),
    [
      workspacePlanSteps,
      conversationActivity,
      projectedSubagents,
      workInProgress,
      turnAwaitingUser,
      turnStatus,
      computerLiveStatus,
      previewDataUrl,
      computerControlError,
      islandArtifacts,
      islandFileSources,
      thread.threadId,
    ],
  );
  const activeAssistantMessageId = streamingAssistantId ?? (
    !isStreaming && runtimeViewModel.activeTurn
      ? [...threadMessages].reverse().find((message) => message.role === "assistant")?.id ?? null
      : null
  );

  return (
    <section
      ref={layoutRef}
      className={`chat-view active-task-layout${inspector.open ? " inspector-open" : ""}${
        inspector.focused ? " inspector-focused" : ""
      }${
        threadMessages.length === 0 ? " is-empty" : ""
      }`}
      aria-labelledby="chat-title"
    >
      <ChatTopbar
        title={thread.title}
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={onExpandSidebar}
        onOpenSearch={onOpenSearch}
        onOpenInspector={openUtilityTab}
        onCaptureScreenshot={IS_DESKTOP ? () => void captureScreenshot() : undefined}
      />

      <ChatWorkspaceDock
        threadId={thread.threadId}
        sections={workspaceSections}
        disabled={inspector.open}
        openActivityNonce={activityNonce}
        projectObjective={projectObjective}
        planGoal={workspacePlanGoal}
        planStepPulseId={planStepPulseId}
        planSteps={workspacePlanSteps}
        subagents={projectedSubagents}
        activity={conversationActivity}
        workInProgress={workInProgress}
        browserBudgetMessage={browserBudgetMessage}
        browserBudgetAssistantId={browserBudgetAssistantId}
        previewDataUrl={previewDataUrl}
        previewTitle={computerSession.previewTitle}
        artifactSources={islandArtifacts}
        fileSources={islandFileSources}
        onRetryBrowserBudget={regenerateAnswer}
        onOpenBrowserDock={hideInspector}
        onOpenSource={(source) =>
          openUtilityTab(source.action === "artifact" ? "artifact" : "file")
        }
        onComputerLiveChange={setComputerLiveStatus}
      />

      <ChatTranscript
        conversationRef={conversationRef}
        thread={thread}
        threadMessages={threadMessages}
        sessionSeed={CHAT_VIEW_SESSION_ID}
        promptSubmitting={promptSubmitting}
        showPendingAssistant={promptSubmitting && !streamingAssistantId && !chatTurnState}
        streamingAssistantId={streamingAssistantId}
        editingMessageId={editingMessageId}
        editingText={editingText}
        streamHasVisibleText={streamHasVisibleText}
        hasActiveTurnState={Boolean(chatTurnState)}
        streamStatus={streamStatus}
        autoContinueMessageId={autoContinueMessageId}
        branchIndex={branchIndex}
        branchBusy={branchBusy}
        followUps={followUps}
        followUpsFor={followUpsFor}
        copiedMessageId={copiedMessageId}
        previousUserMessageIndex={previousUserMessageIndex}
        threadIsProject={threadIsProject}
        activeApprovels={activeApprovels}
        approvalBusyId={approvalBusyId}
        visibleComputerSession={visibleComputerSession}
        uncertainEffects={uncertainEffects}
        effectResolutionBusyId={effectResolutionBusyId}
        effectResolutionError={effectResolutionError}
        showJumpToBottom={showJumpToBottom}
        onOpenUsageSettings={onOpenUsageSettings}
        onUseForTask={(providerId, modelId) => setUsageSuggestedModel({
          value: `${providerId}::${modelId}`,
          nonce: Date.now(),
        })}
        onEditingTextChange={setEditingText}
        onCancelEdit={cancelEditMessage}
        onSaveEdit={saveEditedMessage}
        onOpenArtifact={openArtifactTab}
        onSubmitChoiceAnswer={submitChoiceAnswer}
        onHandleProactiveAnswer={handleProactiveAnswer}
        onSwitchBranch={switchBranch}
        onRenameBranch={renameBranch}
        onSelectFollowUp={selectFollowUp}
        onCopy={copyMessageText}
        onContinue={continueAssistantResponse}
        onExpand={expandAssistantResponse}
        onAskAboutAssistantResponse={askAboutAssistantResponse}
        onFeedback={setMessageFeedback}
        onReply={replyToMessage}
        onEdit={startEditMessage}
        onRegenerate={regenerateAnswer}
        onSaveToMemory={saveMessageToMemory}
        onSaveAsGoal={saveMessageAsGoal}
        onMemoryPublicationApproved={refreshAfterChatSubmit}
        onApproveApprovel={onApproveApprovel}
        onRejectApprovel={onRejectApprovel}
        onResolveEffect={onResolveEffect}
        onJumpToBottom={jumpToBottom}
      />

      <ChatInspectorDock
        layoutRef={layoutRef}
        state={inspector}
        ratio={inspectorRatio}
        availableViews={availableInspectorViews}
        artifacts={workbenchArtifacts}
        artifactCatalogError={memoryArtifactsLoadError}
        uploadedFiles={uploadedFiles}
        threadId={thread.threadId}
        goalSeed={goalSeed}
        operationalPlanMarkdown={conversationPlan ?? visibleComputerSession.operationalPlanMarkdown}
        sources={islandSources}
        subagents={projectedSubagents}
        activeSurface={activeSurface}
        controlBusy={computerControlBusy}
        controlError={computerControlError}
        previewDataUrl={previewDataUrl}
        computerSession={computerSession}
        inspectorResourcesReady={inspectorResourcesReady}
        onActivate={activateInspectorTab}
        onCloseTab={closeInspectorTab}
        onMoveTab={moveInspectorTab}
        onAdd={openUtilityTab}
        onHide={hideInspector}
        onToggleFocus={toggleInspectorFocus}
        onRatioCommit={commitInspectorRatio}
        onGoalSeedConsumed={() => setGoalSeed(null)}
        onOpenFile={openFileTab}
        onOpenFilesIndex={() => openUtilityTab("file")}
        onOpenArtifact={openArtifactTab}
        onRetryArtifactCatalog={retryMemoryArtifacts}
        onPauseComputer={pauseComputer}
        onResumeComputer={resumeComputer}
        onSelectSurface={setActiveSurface}
        onTakeoverComputer={takeoverComputer}
      />

      <ChatComposerDock
        activeWork={workInProgress}
        chatTurnState={chatTurnState}
        effectiveModelLabel={lastAssistantEffectiveModel}
        runtimeContext={runtimeContext}
        runtimeContextLoading={runtimeContextLoading}
        runtimeContextError={runtimeContextError}
        error={promptError}
        replyContext={replyContext}
        seed={composerSeed}
        suggestedModel={usageSuggestedModel}
        streaming={promptSubmitting}
        threadId={thread.threadId}
        visiblePendingSteeringRows={visiblePendingSteeringRowsForTurn}
        onCancelStreaming={cancelActiveStreaming}
        onClearReply={() => setReplyContext(null)}
        onDeletePendingSteering={deletePendingSteering}
        onEditPendingSteering={editPendingSteering}
        onManualModelSelection={() => setUsageSuggestedModel(null)}
        onOpenActivity={openActivityIsland}
        onRefreshRuntimeContext={refreshRuntimeContext}
        onSendPendingSteeringNow={sendPendingSteeringNow}
        onStopActiveTurn={() => void stopActiveTurn()}
        onSuggestedModelConsumed={() => setUsageSuggestedModel(null)}
        onSubmit={submitComposerPrompt}
      />
    </section>
  );
}
