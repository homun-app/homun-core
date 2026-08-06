import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeContext } from "../lib/useRuntimeContext";
import {
  coreBridge,
  SteeringQueuedDuringSubmissionError,
  type ChatAttachmentInput,
  type RoutingBindingInput,
} from "../lib/coreBridge";
import { wsSubscription } from "../lib/wsSubscription";
import {
  cancelTurn,
  enqueueTurn,
  SteeringConflictError,
  type TurnSteeringRecord,
} from "../lib/chatApi";
import {
  CONTINUE_RESPONSE_PROMPT,
  buildAssistantFollowUpPrompt,
  buildComposerPromptDecorators,
  buildReplyContextPrompt,
  buildSteeringPrompt,
} from "../lib/chatPromptAssembly";
import {
  applyTurnEvent,
  createTurnReplayState,
  prepareHitlResumeMessages,
  type TurnReplayState,
} from "../lib/turnReplayState";
import { deriveTurnLifecycle } from "../lib/chat-runtime/lifecycle";
import { deriveComposerMode } from "../lib/chat-runtime/composerMode";
import { visiblePendingSteeringRows } from "../lib/chat-runtime/steering";
import { captureAppScreenshot, IS_DESKTOP } from "../lib/gatewayConfig";
import { copyText } from "../lib/clipboard";
import {
  effectiveModelFromGateway,
  latestAssistantEffectiveModel,
} from "../lib/composerTurnContract";
import { buildChatMarkdown } from "../lib/chatExportMarkdown";
import {
  chatMessageFromAssistantResult,
  createReplyPreview,
  currentTimestampSeconds,
  describeBridgeError,
  isLikelyIncompleteMessage,
  isPlaceholderThreadTitle,
  messageRoleLabel,
  shortModelName,
  toMessageAttachment,
  withChatMetrics,
} from "../lib/chatViewMessages";
import {
  clearResumeMarker,
  isOwnResumeMarker,
  readResumeMarker,
  writeResumeMarker,
  type ResumeMarker,
} from "../lib/chatResumeMarkers";
import {
  normalizeChatEventParts,
  threadTailAwaitsUser,
} from "../lib/chatEventParts";
import {
  buildBranchIndex,
  buildPreviousUserMessageIndex,
} from "../lib/messageIndex";
import { ChatComposerDock, type ChatTurnState } from "./ChatComposerDock";
import { ChatInspectorDock } from "./ChatInspectorDock";
import { ChatWorkspaceDock } from "./ChatWorkspaceDock";
import {
  PANEL_VIEWS,
  type IslandSource,
} from "./InspectorView";
import { ChatTopbar } from "./ChatTopbar";
import { ChatTranscript } from "./ChatTranscript";
import { type ChatStreamStatus } from "./AssistantThinkingState";
import type {
  ChatViewProps,
  MessageFeedback,
  ReplyContext,
} from "./ChatViewTypes";
import { useChatActiveTurnElapsed } from "./useChatActiveTurnElapsed";
import { useChatBranches } from "./useChatBranches";
import { useChatActivityProjection } from "./useChatActivityProjection";
import { projectChatStreamEvent } from "./chatStreamEventProjection";
import { useChatComputerSession } from "./useChatComputerSession";
import { useChatConversationScroll } from "./useChatConversationScroll";
import { useChatFollowUps } from "./useChatFollowUps";
import { useChatInspectorWorkspace } from "./useChatInspectorWorkspace";
import { useChatMemoryArtifacts } from "./useChatMemoryArtifacts";
import { useChatProjectContext } from "./useChatProjectContext";
import { useChatSteeringQueue } from "./useChatSteeringQueue";
import { useChatStreamLifecycle } from "./useChatStreamLifecycle";
import { useChatStreamingNotifier } from "./useChatStreamingNotifier";
import {
  projectWorkspaceSections,
} from "../lib/workspaceIslandSections";
import {
  buildConversationArtifacts,
  buildIslandSources,
  buildUploadedFiles,
  buildWorkbenchArtifacts,
} from "./ChatWorkspaceProjections";
import type {
  ChatMessage,
  ChatEventPart,
  ChatAttachment,
  ChatThread,
} from "../types";

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
  const {
    activeSurface,
    applyComputerSessionSnapshot,
    computerControlBusy,
    computerControlError,
    computerLiveStatus,
    computerSession,
    pauseComputer,
    previewDataUrl,
    resumeComputer,
    setActiveSurface,
    setComputerLiveStatus,
    takeoverComputer,
    visibleComputerSession,
  } = useChatComputerSession({
    computerSessionId,
    unavailableMessage: t("chat.noComputerSessionFound"),
  });
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<ChatStreamStatus | null>(null);
  // Live workspace state: accumulates activity/plan events DURING streaming so
  // the island shows them in real-time (not just after the persisted text arrives).
  // Cleared on submit; superseded by the persisted values when streaming ends.
  const [liveActivitySteps, setLiveActivitySteps] = useState<string[]>([]);
  const [livePlanMarkdown, setLivePlanMarkdown] = useState<string | null>(null);
  const {
    runtimeContext,
    runtimeContextLoading,
    runtimeContextError,
    refreshRuntimeContext,
  } = useRuntimeContext({
    threadId: thread.threadId,
    runtimeContextRevision,
  });
  // Track the active turn_id for WS event filtering. Set when a turn starts,
  // cleared when it ends. Used by the wsSubscription subscriber to route events.
  const activeTurnIdRef = useRef<string | null>(null);
  const turnReplayRef = useRef<TurnReplayState | null>(null);
  const streamOwnerTurnRef = useRef<string | null>(null);
  // Turn ids of background turns we've already attached to (via incomingBackgroundTurn), so a
  // re-fired `thread.turn_started` or a messages re-render never double-attaches the same turn.
  const handledBackgroundTurnsRef = useRef<Set<string>>(new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[] | null>(null);
  const [autoContinueMessageId, setAutoContinueMessageId] = useState<string | null>(null);
  // Bumped when the user asks for the activity list; the adaptive island opens that exact section.
  const [activityNonce, setActivityNonce] = useState(0);
  const {
    memoryArtifacts,
    memoryArtifactsLoaded,
    memoryArtifactsLoadError,
    retryMemoryArtifacts,
  } = useChatMemoryArtifacts(thread.threadId, messages);
  const {
    goalSeed,
    projectGoalCount,
    projectMemoryCount,
    projectObjective,
    setGoalSeed,
    threadIsProject,
  } = useChatProjectContext(thread.threadId);
  const titledThreadsRef = useRef<Set<string>>(new Set());
  const resumedThreadsRef = useRef<Set<string>>(new Set());
  const consumedAutoSubmitIdsRef = useRef<Set<string>>(new Set());
  const layoutRef = useRef<HTMLElement>(null);
  const { isMountedRef, notifyStreaming } = useChatStreamingNotifier(onStreamingChange);
  const {
    pendingSteering,
    applyPendingSteeringChange,
    deletePendingSteering,
    editPendingSteering,
    refreshPendingSteering,
    sendPendingSteeringNow,
  } = useChatSteeringQueue({
    isMountedRef,
    onThreadChanged,
    setPromptError,
    threadId: thread.threadId,
  });
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
  // The backend seeds a placeholder "ready" greeting on every new thread (id ends
  // "_ready"). The designed new-chat experience is the centered hero, so hide that
  // greeting: a thread whose only message is the greeting then renders as empty →
  // ChatEmptyHero shows; threads with real messages no longer carry a stray greeting
  // on top. It's a contentless placeholder, so dropping it from context too is fine.
  const threadMessages = useMemo(() => {
    const base = optimisticMessages ?? messages;
    return base.filter((m) => !(m.role === "assistant" && m.id.endsWith("_ready")));
  }, [optimisticMessages, messages]);
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
  // Transcript lookups, resolved ONCE per render instead of once per row. The
  // action bar asks "does this message have a user message before it?" and the
  // branch picker asks "is there a branch point on this node?" for every row of
  // the transcript, on every streaming frame: as linear scans that was O(N²) and
  // O(N·B) per frame. As indexes it is one pass plus O(1) lookups.
  const previousUserMessageIndex = useMemo(
    () => buildPreviousUserMessageIndex(threadMessages),
    [threadMessages],
  );
  const {
    clearFollowUps,
    followUps,
    followUpsFor,
  } = useChatFollowUps({
    previousUserMessageIndex,
    streamingAssistantId,
    threadMessages,
  });
  const branchIndex = useMemo(() => buildBranchIndex(branches), [branches]);
  // All artifacts generated in this conversation (from persisted ‹‹ARTIFACT››
  // markers) — drives the Artifacts workspace panel.
  // ADR 0022 (Piano UI C2): dipende dai messaggi PERSISTED (`messages`), NON da
  // `threadMessages` (che include optimisticMessages e cambia ogni frame di stream).
  // Così questo memo NON ricalcola durante lo streaming del messaggio corrente —
  // il vero riduttore di jank su thread lunghi. Gli artifact del messaggio streaming
  // si vedono quando viene persisted.
  const conversationArtifacts = useMemo(() => buildConversationArtifacts(messages), [messages]);
  const workbenchArtifacts = useMemo(
    () => buildWorkbenchArtifacts(conversationArtifacts, memoryArtifacts, thread.threadId),
    [conversationArtifacts, memoryArtifacts, thread.threadId],
  );
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
  const activeStreamInProgress = Boolean(promptSubmitting || streamingAssistantId);
  const {
    browserBudgetAssistantId,
    browserBudgetMessage,
    clearProjectedActiveTurn,
    conversationActivity,
    conversationPlan,
    markProjectedTurnStatus,
    projectedActiveTurn,
    projectedSubagents,
    projectedTurnStatus,
    projectionLoaded,
    workspacePlanSteps,
  } = useChatActivityProjection({
    activeTurnIdRef,
    islandRefreshNonce,
    isStreaming: activeStreamInProgress,
    liveActivitySteps,
    livePlanMarkdown,
    messages,
    streamOwnerTurnRef,
    threadId: thread.threadId,
    threadMessages,
    translate: t,
    turnReplayRef,
  });
  // The global WS provides a second observation of turn state. The monotonic
  // reducer makes it safe to overlap with the durable per-turn stream; content
  // rendering stays on that replayable stream, while WS terminal/abort state
  // keeps the cockpit current across windows.
  useEffect(() => {
    const unsub = wsSubscription.subscribe((msg) => {
      if (msg.type !== "turn.event") return;
      const turnId = msg.turn_id as string | undefined;
      if (!turnId || turnId !== activeTurnIdRef.current) return;
      const kind = msg.kind as string;
      const payload = msg.payload as Record<string, unknown> | undefined;
      const seq = Number(msg.seq);
      if (!Number.isFinite(seq)) return;
      const current = turnReplayRef.current?.turnId === turnId
        ? turnReplayRef.current
        : createTurnReplayState(turnId);
      const next = applyTurnEvent(current, {
        turn_id: turnId,
        seq,
        kind,
        payload,
      });
      if (next === current) return;
      turnReplayRef.current = next;
      if (kind === "aborted") {
        setLiveActivitySteps([]);
        setLivePlanMarkdown(null);
      }
      if (["completed", "failed", "cancelled"].includes(next.status)) {
        markProjectedTurnStatus(next.status);
      }
    });
    return unsub;
  }, [markProjectedTurnStatus]);
  // Free HITL (CHOICES / CLARIFY / AWAIT_USER) does not hold the thread busy (Always Contract),
  // so the projection often has no waiting_user_approval — detect the open wait from the chat tail.
  const threadTailAwaitsHitl = useMemo(
    () => threadTailAwaitsUser(threadMessages),
    [threadMessages],
  );
  const {
    isStreaming,
    turnAwaitingUser,
    hasActiveTurn,
    workInProgress,
    terminalTurnAtRest,
  } = deriveTurnLifecycle({
    promptSubmitting,
    streamingAssistantId,
    projectedActiveTurn,
    projectedTurnStatus,
    projectionLoaded,
    threadTailAwaitsHitl,
  });
  const visiblePendingSteeringRowsForTurn = useMemo(
    () => visiblePendingSteeringRows(pendingSteering.rows, {
      terminalTurnAtRest,
      activeTurnId: projectedActiveTurn?.turn_id ?? null,
    }),
    [pendingSteering.rows, projectedActiveTurn?.turn_id, terminalTurnAtRest],
  );
  const activeTurnKey = projectedActiveTurn?.turn_id ?? streamStatus?.requestId ?? null;
  const activeTurnElapsedSeconds = useChatActiveTurnElapsed({
    activeTurnKey,
    hasActiveTurn,
    projectedUpdatedAt: projectedActiveTurn?.updated_at,
  });
  // Durable wait (approval/CHOICES hold) must not keep a live "writing" owner: that hides
  // choice cards and makes the next composer send look like mid-turn steering.
  useEffect(() => {
    if (!turnAwaitingUser || !streamingAssistantId) return;
    setStreamingAssistantId(null);
    setStreamStatus(null);
  }, [turnAwaitingUser, streamingAssistantId]);
  const chatTurnState = useMemo<ChatTurnState | null>(() => {
    if (!hasActiveTurn) return null;
    return {
      phase: turnAwaitingUser
        ? t("chat.waitingForYou", {
            defaultValue: "Waiting for you",
          })
        : streamStatus?.title ?? t("chat.stillWorking"),
      detail: turnAwaitingUser
        ? streamStatus?.detail
        : streamStatus?.detail ?? projectedActiveTurn?.blocked_reason ?? undefined,
      elapsedSeconds: activeTurnElapsedSeconds,
      attempt: projectedActiveTurn?.attempt ?? 1,
      activityCount: conversationActivity.length,
    };
  }, [
    activeTurnElapsedSeconds,
    conversationActivity.length,
    hasActiveTurn,
    projectedActiveTurn?.attempt,
    projectedActiveTurn?.blocked_reason,
    streamStatus?.detail,
    streamStatus?.title,
    t,
    turnAwaitingUser,
  ]);
  // Files the user uploaded in THIS conversation (e.g. the patente PDF), derived
  // from message attachments — the chat-context "File" tab of the Workbench.
  const uploadedFiles = useMemo(() => buildUploadedFiles(messages), [messages]);
  // "Sources" projection for the island: generated artifacts + uploaded files, monochrome.
  // `kind` only picks the glyph (image vs document); `meta` is a one-word provenance hint.
  const islandSources = useMemo(
    () => buildIslandSources(workbenchArtifacts, uploadedFiles),
    [workbenchArtifacts, uploadedFiles],
  );
  const activeApprovels = approvals.filter((approval) =>
    approval.requestedBy.includes(computerSessionId),
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

  async function submitPrompt(
    prompt: string,
    attachments: ChatAttachmentInput[],
    visibleAttachments?: ChatAttachment[],
    visibleText?: string,
    model?: string,
    images?: string[],
    baseMessages?: ChatMessage[],
    mode?: string,
    branchFromId?: string,
    routingBinding?: RoutingBindingInput,
    resumeAssistantMessageId?: string,
  ) {
    const text = prompt.trim();
    if (!text) return;
    const conversationBase = baseMessages ?? threadMessages;
    const shouldAutoTitleAfterSubmit = isPlaceholderThreadTitle(thread.title);
    const userVisibleText = (visibleText ?? text).trim();
    if (!userVisibleText) return;
    const visiblePrompt = userVisibleText === text ? undefined : userVisibleText;

    setPromptSubmitting(true);
    setPromptError(null);
    const imageAttachments: ChatAttachment[] = (images ?? []).map((dataUrl, index) => ({
      artifactId: `img_${Date.now()}_${index}`,
      title: t("chat.imageN", { n: index + 1 }),
      kind: "image",
      sizeBytes: 0,
      previewAvailable: true,
      privacyDomain: "local_files",
      previewUrl: dataUrl,
    }));
    const userMessage: ChatMessage = {
      id: `local_user_${Date.now()}`,
      role: "user",
      text: userVisibleText,
      timestamp: currentTimestampSeconds(),
      attachments: [
        ...imageAttachments,
        ...(visibleAttachments ?? attachments.map(toMessageAttachment)),
      ],
    };
    const hitlResume = resumeAssistantMessageId
      ? prepareHitlResumeMessages(conversationBase, resumeAssistantMessageId, userMessage)
      : null;
    const promptMessages = hitlResume?.promptMessages ?? [...conversationBase, userMessage];
    const requestId = `chat_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const localTurnId = `turn_${requestId}`;
    activeTurnIdRef.current = localTurnId;
    streamOwnerTurnRef.current = localTurnId;
    handledBackgroundTurnsRef.current.add(localTurnId);
    turnReplayRef.current = createTurnReplayState(localTurnId);
    setStreamStatus({
      requestId,
      phase: "accepted",
      title: t("chat.promptReceived"),
      detail: "Preparing the request for the local model.",
    });
    setOptimisticMessages(promptMessages);
    onMessagesChange(promptMessages);
    const streamingMessage: ChatMessage = hitlResume?.streamingMessage ?? {
      id: `local_assistant_${Date.now()}`,
      role: "assistant",
      text: "",
      timestamp: currentTimestampSeconds(),
      metadata: "Local model",
    };
    let streamedText = "";
    let streamEventParts: ChatEventPart[] = [];
    let streamChunks = 0;
    const streamStartedAt = performance.now();
    let unlistenStream: (() => void) | undefined;
    let cancelledLocally = false;
    const flushStreamingMessage = () => {
      clearStreamingFrame();
      setOptimisticMessages([
        ...promptMessages,
        {
          ...streamingMessage,
          text: streamedText,
          eventParts: streamEventParts,
        },
      ]);
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      requestStreamingFrame(flushStreamingMessage);
    };
    const debugStream = (stage: string, detail?: string) => {
      void coreBridge.debugChatStream(requestId, {
        stage,
        chunks: streamChunks,
        chars: streamedText.length,
        elapsed_ms: performance.now() - streamStartedAt,
        detail,
      });
    };
    const cancelStreamingRequest = () => {
      cancelledLocally = true;
      markStreamCancelled(requestId);
      debugStream("paint_cancelled");
      void coreBridge.cancelChatPromptStream(requestId).catch(() => undefined);
      unlistenStream?.();
      cancelScheduledStreamingFrame();
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) =>
        current?.requestId === requestId ? null : current,
      );
      setPromptSubmitting(false);
      const cancelledMessages = [
        ...promptMessages,
        {
          ...streamingMessage,
          text: streamedText || "Answer interrupted.",
          eventParts: streamEventParts,
          metadata: "Interrotta localmente",
        },
      ];
      setOptimisticMessages(cancelledMessages);
      onMessagesChange(cancelledMessages);
    };

    try {
      // SOTA single agentic loop: every message goes through the model-driven
      // streaming tool-calling chat. No keyword pre-route to a parallel
      // operational/Brain path (that router was the de-gemma violation). The
      // model decides — answer, call a tool (browse_web), and (next) delegate a
      // durable multi-step task via a tool when it judges the work needs it.
      setOptimisticMessages([...promptMessages, streamingMessage]);
      resetStreamingState("");
      setLiveActivitySteps([]);
      setLivePlanMarkdown(null);
      setStreamingAssistantId(streamingMessage.id);
      notifyStreaming(true);
      markStreamingPinnedFromCurrentPosition();
      window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
      setActiveStreamingCancel(cancelStreamingRequest);
      // Record an active stream so a reload mid-answer can reattach (resume).
      writeResumeMarker(thread.threadId, {
        requestId,
        userText: userVisibleText,
        assistantMessageId: streamingMessage.id,
      }, CHAT_VIEW_SESSION_ID);
      unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
        if (payload.request_id !== requestId) return;
        if (isStreamCancelled(requestId)) return;
        if (payload.type === "retry" || payload.type === "queued") {
          setStreamStatus({
            requestId,
            phase: "thinking",
            title: payload.type === "retry"
              ? t("chat.retrying", { defaultValue: "Riprovo…" })
              : t("chat.promptReceived"),
            detail: String(payload.payload.reason ?? payload.payload.detail ?? ""),
          });
          return;
        }
        const projectedStream = projectChatStreamEvent(
          { text: streamedText, eventParts: streamEventParts },
          payload,
          { acceptControlEvents: true },
        );
        if (projectedStream.kind === "ignored") return;
        streamedText = projectedStream.draft.text;
        streamEventParts = projectedStream.draft.eventParts;
        if (projectedStream.kind === "aborted") {
          setStreamStatus({
            requestId,
            phase: "thinking",
            title: t("chat.resumingResponse"),
            detail: t("chat.reattachingGeneration"),
          });
          scheduleStreamingMessage();
          return;
        }
        if (projectedStream.kind === "done") {
          scheduleStreamingMessage();
          return;
        }
        if (projectedStream.kind === "part") {
          // ADR 0022 (Piano UI A2): quando arriva un evento recall, mostra la fase
          // "Sto controllando la memoria…" (precedenza su thinking/writing).
          if (projectedStream.part.type === "recall") {
            const count = projectedStream.part.payload?.hits?.length ?? 0;
            const memoryStatus = projectedStream.part.payload?.status ?? (count > 0 ? "ready" : "empty");
            const detail =
              memoryStatus === "unavailable"
                ? t("chat.recallingUnavailable")
                : memoryStatus === "degraded"
                  ? t("chat.recallingDegraded")
                  : memoryStatus === "denied"
                    ? t("chat.recallingDenied")
                    : count > 0
                      ? t("chat.recallingHits", { count })
                      : t("chat.recallingNoHits");
            setStreamStatus({
              requestId,
              phase: "recalling",
              title: t("chat.recalling"),
              detail,
            });
          }
          if (projectedStream.liveActivityText) {
            setLiveActivitySteps((prev) =>
              [...prev, projectedStream.liveActivityText!].filter((step) => step.length > 0),
            );
          } else if (projectedStream.livePlanMarkdown) {
            setLivePlanMarkdown(projectedStream.livePlanMarkdown);
          }
          scheduleStreamingMessage();
          return;
        }
        const firstDelta = projectedStream.firstDelta;
        streamChunks += 1;
        if (firstDelta) {
          setStreamStatus({
            requestId,
            phase: "writing",
            title: t("chat.writing"),
            detail: t("chat.streamingArriving"),
          });
        }
        if (firstDelta) {
          debugStream("paint_first_delta");
        }
        markStreamHasVisibleText();
        scheduleStreamingMessage();
      });
      setStreamStatus({
        requestId,
        phase: "thinking",
        title: t("chat.thinking"),
        detail: t("chat.buildingLocalContext"),
      });
      const result = await coreBridge.submitChatPromptStream(
        requestId,
        thread.threadId,
        computerSessionId,
        text,
        attachments,
        visiblePrompt,
        model,
        images,
        mode,
        branchFromId,
        routingBinding,
      );
      if (isStreamCancelled(requestId)) {
        return;
      }
      streamedText = result.assistant_message.text || streamedText;
      streamEventParts = [];
      console.log("[broker-debug] autotitle check", {
        streamedTextLen: streamedText.length,
        streamedTextPreview: streamedText.slice(0, 80),
        shouldAutoTitle: shouldAutoTitleAfterSubmit,
        threadTitle: thread.title,
        promptMessagesLen: promptMessages.length,
      });
      await persistAutoTitleForCompletedTurn(
        promptMessages,
        streamedText,
        shouldAutoTitleAfterSubmit,
      );
      // The user may have navigated to another thread while we awaited. The
      // gateway already persisted the answer (submitChatPromptStream commits
      // server-side), so we only need to stop touching THIS instance's UI — the
      // parent's polling will surface the finalized messages on thread A.
      if (!isMountedRef.current) {
        return;
      }
      cancelScheduledStreamingFrame();
      debugStream("paint_done_before_commit");
      if (isStreamCancelled(requestId)) {
        return;
      }
      applyComputerSessionSnapshot(result.computer_session);
      // Only gateway evidence may identify the model that produced this turn.
      // The requested override remains next-turn input, not execution provenance.
      const turnModel = effectiveModelFromGateway(result.effective_model) ?? undefined;
      const finalAssistantMessage: ChatMessage = {
        ...withChatMetrics(
          chatMessageFromAssistantResult(
            result,
            result.assistant_message.text || streamedText,
            normalizeChatEventParts(result.assistant_message.event_parts),
          ),
          (performance.now() - streamStartedAt) / 1000,
        ),
        model: turnModel,
      };
      let finalMessages = [
        ...promptMessages,
        finalAssistantMessage,
      ];
      setOptimisticMessages(finalMessages);
      onMessagesChange(finalMessages, { advanceActivity: true });
      if (isLikelyIncompleteMessage(finalAssistantMessage)) {
        finalMessages = await autoContinueAssistantResponse(
          finalAssistantMessage,
          finalMessages,
        );
      }
      setOptimisticMessages(finalMessages);
      onMessagesChange(finalMessages, { advanceActivity: true });
      await refreshAfterChatSubmit();
      setOptimisticMessages(null);
    } catch (error) {
      cancelScheduledStreamingFrame();
      if (cancelledLocally || isStreamCancelled(requestId)) {
        return;
      }
      if (error instanceof SteeringQueuedDuringSubmissionError) {
        setPromptError(null);
        setOptimisticMessages(null);
        clearProjectedActiveTurn();
        onMessagesChange(conversationBase);
        await Promise.all([
          refreshPendingSteering().catch(() => undefined),
          Promise.resolve().then(() => onThreadChanged()).catch(() => undefined),
        ]);
        return;
      }
      const message = describeBridgeError(error);
      setPromptError(message);
      setStreamStatus((current) =>
        current?.requestId === requestId ? null : current,
      );
      const errorMessages: ChatMessage[] = [
        ...promptMessages,
        {
          id: `local_error_${Date.now()}`,
          role: "system" as const,
          text: message,
          timestamp: currentTimestampSeconds(),
        },
      ];
      setOptimisticMessages(errorMessages);
      onMessagesChange(errorMessages);
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      if (!cancelledLocally) {
        clearStreamingPin();
        setStreamingAssistantId(null);
        resetStreamingState("");
        setLiveActivitySteps([]);
        setLivePlanMarkdown(null);
        setStreamStatus((current) =>
          current?.requestId === requestId ? null : current,
        );
        setPromptSubmitting(false);
      }
      notifyStreaming(false);
      clearActiveStreamingCancel(cancelStreamingRequest);
      clearStreamCancelled(requestId);
      activeTurnIdRef.current = null;
      if (streamOwnerTurnRef.current === localTurnId) {
        streamOwnerTurnRef.current = null;
      }
      clearResumeMarker(thread.threadId);
    }
  }

  useEffect(() => {
    if (!autoSubmit) return;
    if (autoSubmit.threadId !== thread.threadId) return;
    if (promptSubmitting || streamingAssistantId) return;
    if (consumedAutoSubmitIdsRef.current.has(autoSubmit.id)) return;
    consumedAutoSubmitIdsRef.current.add(autoSubmit.id);
    onAutoSubmitConsumed?.(autoSubmit.id);
    void submitPrompt(
      autoSubmit.prompt,
      autoSubmit.attachments,
      autoSubmit.visibleAttachments,
      autoSubmit.visibleText,
      undefined,
      undefined,
      undefined,
      autoSubmit.mode,
      undefined,
      autoSubmit.routingBinding,
    );
    // submitPrompt intentionally owns the live streaming lifecycle. This effect
    // only bridges externally-created threads into that canonical chat pipeline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit, promptSubmitting, streamingAssistantId, thread.threadId]);

  async function stopActiveTurn() {
    if (hasActiveStreamingCancel()) {
      cancelActiveStreaming();
      return;
    }
    const turnId = projectedActiveTurn?.turn_id ?? activeTurnIdRef.current;
    if (!turnId) return;
    try {
      await cancelTurn(turnId);
      clearProjectedActiveTurn();
      await refreshPendingSteering().catch(() => undefined);
    } catch (error) {
      setPromptError(describeBridgeError(error));
    }
  }

  function openActivityIsland() {
    hideInspector();
    setActivityNonce((n) => n + 1);
  }

  // Reattach to an answer that was streaming when the app was reloaded: replays
  // the buffered events from the gateway and continues live, then persists.
  async function resumeActiveStream(
    marker: ResumeMarker,
    options?: { commitResult?: boolean; replaceIds?: string[] },
  ) {
    if (promptSubmitting || streamingAssistantId) return;
    const shouldAutoTitleAfterResume = isPlaceholderThreadTitle(thread.title);
    const requestId = marker.requestId;
    const resumedTurnId = `turn_${requestId}`;
    if (streamOwnerTurnRef.current) return;
    streamOwnerTurnRef.current = resumedTurnId;
    // Point the island's live WS channel (the `turn.event` subscription) at THIS turn. The
    // broker fan-out keys on `turn_{request_id}`, which now also equals the id carried by
    // `thread.turn_started` (the visible turn adopts the broker id — see start_visible_
    // conversation_turn). Set BEFORE any await so the first replayed event is already accepted.
    activeTurnIdRef.current = resumedTurnId;
    turnReplayRef.current = createTurnReplayState(activeTurnIdRef.current);
    const userMessage: ChatMessage = {
      id: `resume_user_${Date.now()}`,
      role: "user",
      text: marker.userText,
      timestamp: currentTimestampSeconds(),
    };
    const streamingMessage: ChatMessage = {
      id: marker.assistantMessageId,
      role: "assistant",
      text: "",
      timestamp: currentTimestampSeconds(),
      metadata: "Local model",
    };
    // When re-attaching to a turn whose user bubble + assistant placeholder are ALREADY
    // persisted (a background channel/scheduled turn re-fetched into `messages`), drop those
    // rows from the optimistic seed so the fresh user/streaming bubbles don't duplicate them.
    const replaceIds = options?.replaceIds;
    const seedMessages = replaceIds?.length
      ? messages.filter((message) => !replaceIds.includes(message.id))
      : messages;
    const promptMessages = [...seedMessages, userMessage];
    let streamedText = "";
    let streamEventParts: ChatEventPart[] = [];
    let unlistenStream: (() => void) | undefined;
    const flushStreamingMessage = () => {
      clearStreamingFrame();
      setOptimisticMessages([
        ...promptMessages,
        {
          ...streamingMessage,
          text: streamedText,
          eventParts: streamEventParts,
        },
      ]);
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      requestStreamingFrame(flushStreamingMessage);
    };

    setPromptSubmitting(true);
    setOptimisticMessages([...promptMessages, streamingMessage]);
    resetStreamingState("");
    setStreamingAssistantId(streamingMessage.id);
    notifyStreaming(true);
    forceStreamingPin();
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: t("chat.resumingResponse"),
      detail: t("chat.reattachingGeneration"),
    });
    try {
      unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
        if (payload.request_id !== requestId) return;
        if (payload.type === "retry" || payload.type === "queued") {
          setStreamStatus({
            requestId,
            phase: "thinking",
            title: payload.type === "retry"
              ? t("chat.retrying", { defaultValue: "Riprovo…" })
              : t("chat.promptReceived"),
            detail: String(payload.payload.reason ?? payload.payload.detail ?? ""),
          });
          return;
        }
        const projectedStream = projectChatStreamEvent(
          { text: streamedText, eventParts: streamEventParts },
          payload,
          { acceptControlEvents: true },
        );
        if (projectedStream.kind === "ignored") return;
        streamedText = projectedStream.draft.text;
        streamEventParts = projectedStream.draft.eventParts;
        if (projectedStream.kind === "aborted" || projectedStream.kind === "done") {
          scheduleStreamingMessage();
          return;
        }
        if (projectedStream.kind === "part") {
          scheduleStreamingMessage();
          return;
        }
        markStreamHasVisibleText();
        scheduleStreamingMessage();
      });
      const result = await coreBridge.resumeChatPromptStream(
        requestId,
        thread.threadId,
        computerSessionId,
        marker.userText,
        marker.assistantMessageId,
        options?.commitResult ?? true,
      );
      streamedText = result.assistant_message.text || streamedText;
      streamEventParts = [];
      if (options?.commitResult !== false) {
        await persistAutoTitleForCompletedTurn(
          promptMessages,
          streamedText,
          shouldAutoTitleAfterResume,
        );
      }
      cancelScheduledStreamingFrame();
      const finalAssistant = chatMessageFromAssistantResult(
        result,
        streamedText,
        normalizeChatEventParts(result.assistant_message.event_parts),
      );
      const finalMessages = [...promptMessages, finalAssistant];
      setOptimisticMessages(finalMessages);
      if (options?.commitResult !== false) {
        onMessagesChange(finalMessages, { advanceActivity: true });
      }
      if (options?.commitResult === false) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      await refreshAfterChatSubmit();
      if (options?.commitResult !== false) {
        setOptimisticMessages(null);
      }
    } catch {
      // Stream gone (expired/evicted) → drop the optimistic pair, keep persisted.
      setOptimisticMessages(null);
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      clearStreamingPin();
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) => (current?.requestId === requestId ? null : current));
      setPromptSubmitting(false);
      notifyStreaming(false);
      // Release the island's live WS channel — but only if it still points at OUR turn, so a
      // newer turn that started meanwhile keeps its attachment.
      if (activeTurnIdRef.current === `turn_${requestId}`) {
        activeTurnIdRef.current = null;
      }
      if (streamOwnerTurnRef.current === resumedTurnId) {
        streamOwnerTurnRef.current = null;
      }
      if (options?.commitResult !== false) {
        clearResumeMarker(thread.threadId);
      }
    }
  }

  async function refreshAfterChatSubmit() {
    try {
      await onRuntimeChanged();
      await onThreadChanged();
    } catch (error) {
      console.warn("chat read model refresh unavailable", error);
    }
  }

  // A PROACTIVITY question (onboarding, follow-up, …) was answered from its choice card.
  // Capture the pick as memory + post a canned acknowledgment via the gateway — do NOT run
  // an agent turn. This is the fix for a weak model treating a one-word answer as licence to
  // invent and execute unrelated work (e.g. answering "Sviluppatore" spawning sandbox tasks).
  async function handleProactiveAnswer(question: string, answer: string) {
    try {
      await coreBridge.captureProactiveAnswer(thread.threadId, {
        answer,
        question,
        ack: t("chat.proactiveAnswerThanks"),
      });
      await refreshAfterChatSubmit();
    } catch (error) {
      setPromptError(describeBridgeError(error));
    }
  }

  async function persistAutoTitleForCompletedTurn(
    promptMessages: ChatMessage[],
    assistantText: string,
    shouldAutoTitle: boolean,
  ) {
    if (!shouldAutoTitle) return;
    if (titledThreadsRef.current.has(thread.threadId)) return;
    const firstUser = promptMessages.find(
      (message) => message.role === "user" && Boolean(message.text?.trim()),
    );
    if (!firstUser || !assistantText.trim()) return;
    titledThreadsRef.current.add(thread.threadId);
    try {
      await coreBridge.autoTitleThread(thread.threadId, firstUser.text, assistantText);
    } catch {
      /* keep existing title on failure */
    }
  }

  // External surfaces can seed text without taking ownership of the composer.
  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  const [usageSuggestedModel, setUsageSuggestedModel] = useState<{
    value: string;
    nonce: number;
  } | null>(null);

  // External seed (e.g. a proactivity card engaged from the dashboard) → prefill
  // the composer. Keyed by nonce so re-engaging the same card re-applies.
  useEffect(() => {
    if (seed && seed.text.trim()) {
      setComposerSeed({ text: seed.text, nonce: seed.nonce });
    }
  }, [seed?.nonce]);

  // HITL Free wait (CHOICES / CLARIFY): clear live "still working" state and force a real
  // next turn so the answer never becomes steering into a lagging projected active turn.
  async function submitChoiceAnswer(
    answer: string,
    assistantMessageId: string,
  ): Promise<boolean> {
    setStreamingAssistantId(null);
    setStreamStatus(null);
    clearProjectedActiveTurn();
    return submitComposerPrompt(answer, [], {
      forceNewTurn: true,
      resumeAssistantMessageId: assistantMessageId,
    });
  }

  function selectFollowUp(suggestion: string) {
    clearFollowUps();
    void submitPrompt(suggestion, []);
  }

  async function submitComposerPrompt(
    prompt: string,
    attachments: ChatAttachmentInput[],
    options?: {
      model?: string;
      mode?: string;
      forcedSkillsId?: string;
      contextText?: string;
      images?: string[];
      /** HITL Free resolutions (Choice/Clarify) must never become mid-turn steering. */
      forceNewTurn?: boolean;
      resumeAssistantMessageId?: string;
    },
  ): Promise<boolean> {
    const activeReplyContext = replyContext;
    const images = options?.images;
    const mode = options?.mode;

    const { skillPrefix, contextPrefix, augmented } = buildComposerPromptDecorators({
      forcedSkillsId: options?.forcedSkillsId,
      contextText: options?.contextText,
    });
    const model = options?.model;

    // Open HITL Free wait → always a new turn (ResumeBinding), never steer.
    const composerMode = deriveComposerMode({
      promptSubmitting,
      streamingAssistantId,
      turnAwaitingUser,
      terminalTurnAtRest,
      hasActiveTurn,
    });
    const forceNewTurn = Boolean(options?.forceNewTurn || composerMode.forceNewTurn);
    if (forceNewTurn) {
      setStreamingAssistantId(null);
      setStreamStatus(null);
      clearProjectedActiveTurn();
    }

    // A Choice/Clarify answer must start a real next turn even if the UI still thinks work is
    // in progress (streaming just ended / projected active turn lag) — otherwise the
    // answer becomes steering and the browser session context is mishandled.
    if (workInProgress && !forceNewTurn) {
      const promptWithReplyContext = buildSteeringPrompt({
        skillPrefix,
        contextPrefix,
        prompt,
        replyRoleLabel: activeReplyContext
          ? messageRoleLabel(activeReplyContext.role)
          : undefined,
        replyPreview: activeReplyContext?.preview,
      });
      const requestId = `chat_steering_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      try {
        const result = await enqueueTurn(thread.threadId, requestId, promptWithReplyContext, {
          visiblePrompt: prompt,
          images,
          attachments: attachments.length ? attachments : undefined,
          mode,
          model,
        });
        if (result.status === "queued") {
          setReplyContext(null);
          setPromptError(null);
          clearProjectedActiveTurn();
          try {
            await onThreadChanged();
          } catch (error) {
            console.warn("queued turn refresh unavailable", error);
          }
          return true;
        }
        const returnedRecord = (
          result as typeof result & { steering?: TurnSteeringRecord }
        ).steering;
        if (returnedRecord) {
          applyPendingSteeringChange(returnedRecord);
        } else {
          await refreshPendingSteering().catch(() => undefined);
        }
        setReplyContext(null);
        setPromptError(null);
        setStreamStatus((current) =>
          current ? { ...current, detail: t("chat.steeringQueued") } : current,
        );
        return true;
      } catch (error) {
        if (error instanceof SteeringConflictError) {
          applyPendingSteeringChange(error.steering);
        }
        setPromptError(describeBridgeError(error));
        return false;
      }
    }

    setReplyContext(null);
    if (!activeReplyContext) {
      if (augmented) {
        void submitPrompt(
          `${skillPrefix}${contextPrefix}${prompt}`,
          attachments,
          undefined,
          prompt,
          model,
          images,
          undefined,
          mode,
          undefined,
          undefined,
          options?.resumeAssistantMessageId,
        );
      } else {
        void submitPrompt(
          prompt,
          attachments,
          undefined,
          undefined,
          model,
          images,
          undefined,
          mode,
          undefined,
          undefined,
          options?.resumeAssistantMessageId,
        );
      }
      return true;
    }

    const promptWithReplyContext = buildReplyContextPrompt({
      skillPrefix,
      contextPrefix,
      prompt,
      replyRoleLabel: messageRoleLabel(activeReplyContext.role),
      replyPreview: activeReplyContext.preview,
    });
    void submitPrompt(
      promptWithReplyContext,
      attachments,
      undefined,
      prompt,
      model,
      images,
      undefined,
      mode,
      undefined,
      undefined,
      options?.resumeAssistantMessageId,
    );
    return true;
  }

  async function copyMessageText(message: ChatMessage) {
    if (!message.text) return;
    const ok = await copyText(message.text);
    if (!ok) return;
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1_400);
  }

  async function exportChatMarkdown() {
    await copyText(buildChatMarkdown(thread.title, threadMessages));
  }

  // Capture the whole app window to a PNG and reveal it in Finder — the user can then
  // share the image to show the actual UI / pagination / a broken state.
  async function captureScreenshot() {
    await captureAppScreenshot();
  }

  // Regenerate an assistant answer as a persisted SIBLING branch under its user
  // message — streamed into the same slot, then committed to the chat tree.
  function regenerateAnswer(messageId: string) {
    if (promptSubmitting || streamingAssistantId) return;
    const assistant = threadMessages.find((message) => message.id === messageId);
    const previousUser = previousUserMessageIndex.get(messageId);
    if (!assistant || !previousUser) {
      setPromptError(t("chat.noPreviousPromptToRegenerate"));
      return;
    }
    void streamRegeneratedAnswer(assistant, previousUser, threadMessages);
  }

  async function streamRegeneratedAnswer(
    message: ChatMessage,
    userMessage: ChatMessage,
    baseMessages: ChatMessage[],
  ) {
    const requestId = `chat_stream_regen_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    activeTurnIdRef.current = `turn_${requestId}`;
    let streamedText = "";
    let streamEventParts: ChatEventPart[] = [];
    let unlistenStream: (() => void) | undefined;
    const flushStreamingMessage = () => {
      clearStreamingFrame();
      setOptimisticMessages(
        baseMessages.map((item) =>
          item.id === message.id
            ? {
                ...item,
                text: streamedText,
                eventParts: streamEventParts,
              }
            : item,
        ),
      );
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      requestStreamingFrame(flushStreamingMessage);
    };
    const cancelStreamingRequest = () => {
      markStreamCancelled(requestId);
      void coreBridge.cancelChatPromptStream(requestId).catch(() => undefined);
      unlistenStream?.();
      cancelScheduledStreamingFrame();
    };

    // Context = history up to (and including) the prompting user message, excluding
    // the answer we're replacing, so the alternative is generated independently.
    const userIndex = baseMessages.findIndex((item) => item.id === userMessage.id);
    const context = baseMessages
      .slice(0, userIndex >= 0 ? userIndex : 0)
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({ role: item.role as "user" | "assistant", text: item.text }));

    setPromptSubmitting(true);
    setStreamingAssistantId(message.id);
    notifyStreaming(true);
    resetStreamingState("");
    markStreamingPinnedFromCurrentPosition();
    window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: t("chat.regeneratingResponse"),
      detail: t("chat.generatingAlternativeVariant"),
    });
    setActiveStreamingCancel(cancelStreamingRequest);
    unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
      if (payload.request_id !== requestId) return;
      if (isStreamCancelled(requestId)) return;
      const projectedStream = projectChatStreamEvent(
        { text: streamedText, eventParts: streamEventParts },
        payload,
      );
      if (projectedStream.kind === "ignored") return;
      streamedText = projectedStream.draft.text;
      streamEventParts = projectedStream.draft.eventParts;
      if (projectedStream.kind === "aborted" || projectedStream.kind === "done") return;
      if (projectedStream.kind === "part") {
        scheduleStreamingMessage();
        return;
      }
      markStreamHasVisibleText();
      scheduleStreamingMessage();
    });

    try {
      const result = await coreBridge.regenerateChatPromptStream(
        requestId,
        thread.threadId,
        computerSessionId,
        userMessage.text,
        userMessage.id,
        context,
      );
      if (isStreamCancelled(requestId)) return;
      cancelScheduledStreamingFrame();
      applyComputerSessionSnapshot(result.computer_session);
      // The new answer is now a sibling in the tree; resync the real path + switcher.
      await refreshAfterChatSubmit();
      setOptimisticMessages(null);
      await refreshBranches();
    } catch (error) {
      setPromptError(t("chat.regenerateFailed", { error: describeBridgeError(error) }));
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      clearStreamingPin();
      setStreamingAssistantId(null);
      resetStreamingState("");
      setPromptSubmitting(false);
      setStreamStatus((current) => (current?.requestId === requestId ? null : current));
      notifyStreaming(false);
      clearActiveStreamingCancel(cancelStreamingRequest);
      clearStreamCancelled(requestId);
    }
  }

  function replyToMessage(message: ChatMessage) {
    if (!message.text) return;
    setReplyContext({
      messageId: message.id,
      role: message.role,
      preview: createReplyPreview(message.text),
    });
  }

  function startEditMessage(message: ChatMessage) {
    if (promptSubmitting) return;
    setEditingMessageId(message.id);
    setEditingText(message.text);
  }

  function cancelEditMessage() {
    setEditingMessageId(null);
    setEditingText("");
  }

  // Edit a user message non-destructively: commit the edited turn as a SIBLING
  // branch. The original message and its answer stay in the tree, reachable via
  // the ‹ n/m › switcher — nothing is lost. The gateway resolves the original's
  // parent from `branchFromId`, so the new turn is a true sibling.
  function saveEditedMessage() {
    const id = editingMessageId;
    const text = editingText.trim();
    if (!id || !text || promptSubmitting) return;
    const index = threadMessages.findIndex((message) => message.id === id);
    if (index < 0) {
      cancelEditMessage();
      return;
    }
    const base = threadMessages.slice(0, index);
    const original = threadMessages[index];
    setEditingMessageId(null);
    setEditingText("");
    // Optimistically show the context BEFORE the edited turn; the new turn streams
    // in and the refetch swaps in the persisted branch. We don't push `base` to the
    // parent (no onMessagesChange) so the original branch is never dropped.
    setOptimisticMessages(base);
    void submitPrompt(
      text,
      [],
      original.attachments ?? [],
      undefined,
      undefined,
      undefined,
      base,
      undefined,
      id,
    );
  }

  async function setMessageFeedback(
    message: ChatMessage,
    feedback: MessageFeedback,
  ) {
    if (message.role !== "assistant") return;
    const nextFeedback = message.feedback === feedback ? undefined : feedback;
    const optimisticMessages = threadMessages.map((item) =>
      item.id === message.id ? { ...item, feedback: nextFeedback } : item,
    );
    onMessagesChange(optimisticMessages);
    setPromptError(null);
    try {
      await coreBridge.setChatMessageFeedback(
        thread.threadId,
        message.id,
        nextFeedback ?? null,
      );
      await onThreadChanged();
    } catch (error) {
      onMessagesChange(threadMessages);
      setPromptError(describeBridgeError(error));
    }
  }

  // Promote a chat message to a project objective: hand the text off to the Obiettivi
  // panel's compose (open Workbench → Obiettivi tab, pre-filled) so the user trims and
  // confirms with the polished UI — never auto-saving long prose verbatim.
  function saveMessageAsGoal(text?: string | null) {
    const seed = (text ?? "").trim();
    if (!seed) return;
    setGoalSeed(seed);
    openUtilityTab("goals");
  }

  async function saveMessageToMemory(message: ChatMessage) {
    if (message.role !== "assistant" || message.savedMemoryRef) return;
    const optimisticMessages = threadMessages.map((item) =>
      item.id === message.id ? { ...item, savedMemoryRef: "pending" } : item,
    );
    onMessagesChange(optimisticMessages);
    setPromptError(null);
    try {
      await coreBridge.saveChatMessageToMemory(thread.threadId, message.id);
      await onRuntimeChanged();
      await onThreadChanged();
    } catch (error) {
      onMessagesChange(threadMessages);
      setPromptError(describeBridgeError(error));
    }
  }

  function continueAssistantResponse(messageId: string) {
    if (promptSubmitting) return;
    const message = threadMessages.find((item) => item.id === messageId);
    if (!message?.text) {
      setPromptError(t("chat.noResponseToContinue"));
      return;
    }
    void submitPrompt(CONTINUE_RESPONSE_PROMPT, [], [], "Continue");
  }

  async function autoContinueAssistantResponse(
    assistantMessage: ChatMessage,
    baseMessages: ChatMessage[],
  ) {
    const maxAutoContinuetions = 2;
    let currentMessages = baseMessages;
    let currentMessage = assistantMessage;

    for (
      let attempt = 0;
      attempt < maxAutoContinuetions && isLikelyIncompleteMessage(currentMessage);
      attempt += 1
    ) {
      setAutoContinueMessageId(currentMessage.id);
      try {
        currentMessages = await streamContinuetionIntoMessage(
          currentMessage,
          currentMessages,
          attempt + 1,
        );
        const updatedMessage = currentMessages.find(
          (message) => message.id === currentMessage.id,
        );
        if (!updatedMessage || updatedMessage.text === currentMessage.text) {
          break;
        }
        currentMessage = updatedMessage;
      } catch (error) {
        setPromptError(t("chat.autoContinueFailed", { error: describeBridgeError(error) }));
        break;
      } finally {
        setAutoContinueMessageId(null);
      }
    }

    return currentMessages;
  }

  async function streamContinuetionIntoMessage(
    message: ChatMessage,
    baseMessages: ChatMessage[],
    attempt: number,
  ) {
    const requestId = `chat_stream_continue_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    activeTurnIdRef.current = `turn_${requestId}`;
    let streamedText = message.text;
    let streamEventParts: ChatEventPart[] = message.eventParts ?? [];
    let unlistenStream: (() => void) | undefined;
    let cancelledLocally = false;
    const flushStreamingMessage = () => {
      clearStreamingFrame();
      setOptimisticMessages(
        baseMessages.map((item) =>
          item.id === message.id
            ? {
                ...item,
                text: streamedText,
                eventParts: streamEventParts,
              }
            : item,
        ),
      );
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      requestStreamingFrame(flushStreamingMessage);
    };
    const cancelStreamingRequest = () => {
      cancelledLocally = true;
      markStreamCancelled(requestId);
      void coreBridge.cancelChatPromptStream(requestId).catch(() => undefined);
      unlistenStream?.();
      cancelScheduledStreamingFrame();
    };

    setStreamingAssistantId(message.id);
    notifyStreaming(true);
    resetStreamingState(message.text);
    markStreamingPinnedFromCurrentPosition();
    window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: t("chat.continuingResponse"),
      detail: t("chat.generationLimitReached", { attempt }),
    });
    setActiveStreamingCancel(cancelStreamingRequest);
    unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
      if (payload.request_id !== requestId) return;
      if (isStreamCancelled(requestId)) return;
      const projectedStream = projectChatStreamEvent(
        { text: streamedText, eventParts: streamEventParts },
        payload,
        { initialTextLength: message.text.length },
      );
      if (projectedStream.kind === "ignored") return;
      streamedText = projectedStream.draft.text;
      streamEventParts = projectedStream.draft.eventParts;
      if (projectedStream.kind === "aborted" || projectedStream.kind === "done") return;
      if (projectedStream.kind === "part") {
        scheduleStreamingMessage();
        return;
      }
      const firstDelta = projectedStream.firstDelta;
      if (firstDelta) {
        setStreamStatus({
          requestId,
          phase: "writing",
          title: t("chat.assistantContinuing"),
          detail: t("chat.completingInSameMessage"),
        });
      }
      markStreamHasVisibleText();
      scheduleStreamingMessage();
    });

    try {
      const result = await coreBridge.continueChatMessageStream(
        requestId,
        thread.threadId,
        message.id,
        computerSessionId,
        message.text,
        message.model,
      );
      if (isStreamCancelled(requestId)) {
        return baseMessages;
      }
      streamedText = result.assistant_message.text || streamedText;
      streamEventParts = [];
      cancelScheduledStreamingFrame();
      const updatedMessage = chatMessageFromAssistantResult(
        result,
        streamedText,
        normalizeChatEventParts(result.assistant_message.event_parts),
      );
      const nextMessages = baseMessages.map((item) =>
        item.id === message.id ? updatedMessage : item,
      );
      applyComputerSessionSnapshot(result.computer_session);
      setOptimisticMessages(nextMessages);
      onMessagesChange(nextMessages, { advanceActivity: true });
      return nextMessages;
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      clearStreamingPin();
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) =>
        current?.requestId === requestId ? null : current,
      );
      notifyStreaming(false);
      clearActiveStreamingCancel(cancelStreamingRequest);
      clearStreamCancelled(requestId);
    }
  }

  function expandAssistantResponse(messageId: string) {
    askAboutAssistantResponse(
      messageId,
      "Expand",
      "Expand the previous response with useful details, without repeating the entire response.",
    );
  }

  function askAboutAssistantResponse(
    messageId: string,
    visibleText: string,
    instruction: string,
  ) {
    if (promptSubmitting) return;
    const message = threadMessages.find((item) => item.id === messageId);
    if (!message?.text) {
      setPromptError(t("chat.noPreviousResponse"));
      return;
    }
    const followUpPrompt = buildAssistantFollowUpPrompt({
      instruction,
      previousResponse: message.text,
    });
    void submitPrompt(followUpPrompt, [], [], visibleText);
  }

  // After a reload, reattach to an answer that was still streaming (resume).
  useEffect(() => {
    if (resumedThreadsRef.current.has(thread.threadId)) return;
    if (promptSubmitting || streamingAssistantId) return;
    const marker = readResumeMarker(thread.threadId);
    if (!marker) return;
    const commitResult = !isOwnResumeMarker(marker, CHAT_VIEW_SESSION_ID);
    resumedThreadsRef.current.add(thread.threadId);
    void resumeActiveStream(marker, { commitResult });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.threadId]);

  // A background turn (a channel/scheduled reply, or a turn started from another window) began
  // on THIS open thread. We never launched it, so nothing here is streaming it → without this
  // the island would sit on the previous turn until the new one ended. Attach to its live
  // stream exactly like an in-app turn: `resumeActiveStream` flips isStreaming, points the
  // island's WS channel at the turn (activeTurnIdRef), and streams deltas into the transcript.
  // Guards: never re-attach a turn we started ourselves (promptSubmitting/streamingAssistantId
  // are set for those), never handle the same turn twice, and wait until the forceMessages
  // re-fetch has landed the persisted user bubble + assistant placeholder so we can seed the
  // transcript without duplicating them.
  useEffect(() => {
    const incoming = incomingBackgroundTurn;
    if (!incoming || incoming.threadId !== thread.threadId) return;
    if (handledBackgroundTurnsRef.current.has(incoming.turnId)) return;
    if (promptSubmitting || streamingAssistantId) return;
    const placeholder = messages.find((message) => message.id === incoming.assistantMessageId);
    if (!placeholder) return; // persisted rows not loaded yet → retry when `messages` updates
    const userText =
      messages.find((message) => message.id === incoming.userMessageId)?.text ?? "";
    const requestId = incoming.turnId.replace(/^turn_/, "");
    handledBackgroundTurnsRef.current.add(incoming.turnId);
    void resumeActiveStream(
      { requestId, userText, assistantMessageId: incoming.assistantMessageId },
      { commitResult: true, replaceIds: [incoming.userMessageId, incoming.assistantMessageId] },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingBackgroundTurn, messages, promptSubmitting, streamingAssistantId, thread.threadId]);

  const lastAssistantEffectiveModel = useMemo(() => {
    const model = latestAssistantEffectiveModel(threadMessages);
    return model ? shortModelName(model) : t("composer.runtime.unavailable");
  }, [t, threadMessages]);

  const islandArtifacts = islandSources.filter((source) => source.action === "artifact");
  const islandFileSources = islandSources.filter((source) => source.action === "files");
  const workspaceSections = projectWorkspaceSections({
    planSteps: workspacePlanSteps,
    activity: [
      ...conversationActivity,
      ...projectedSubagents.map((subagent) => `${subagent.name}:${subagent.status}`),
    ],
    streaming: workInProgress,
    executionStatus: turnAwaitingUser ? "waiting_user" : projectedTurnStatus,
    browser: {
      active: computerLiveStatus.active,
      snapshotVerified: Boolean(previewDataUrl),
      failed: computerControlError !== null,
    },
    artifacts: islandArtifacts.map((source) => ({
      id: `${source.artifactThread ?? thread.threadId}:${source.artifactName ?? source.name}`,
    })),
    sources: islandFileSources.map((source) => ({ id: source.name })),
  });
  const activeAssistantMessageId = streamingAssistantId ?? (
    !isStreaming && projectedActiveTurn
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
        onOpenComputer={() => openUtilityTab("computer")}
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
