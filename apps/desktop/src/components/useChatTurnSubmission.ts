import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { coreBridge, SteeringQueuedDuringSubmissionError, type ChatAttachmentInput, type RoutingBindingInput, type CoreComputerSessionSnapshot } from "../lib/coreBridge";
import { cancelTurn, enqueueTurn, SteeringConflictError, type TurnSteeringRecord } from "../lib/chatApi";
import {
  CONTINUE_RESPONSE_PROMPT,
  buildAssistantFollowUpPrompt,
  buildComposerPromptDecorators,
  buildReplyContextPrompt,
  buildSteeringPrompt,
} from "../lib/chatPromptAssembly";
import { createTurnReplayState, prepareHitlResumeMessages, type TurnReplayState } from "../lib/turnReplayState";
import { routeComposerSubmission } from "../lib/chat-runtime/submissionRouting";
import { clearStreamStatusForRequest, createLocalTurnId, createRequestId, requestIdFromTurnId } from "../lib/chat-runtime/turnStateMachine";
import {
  chatMessageFromAssistantResult,
  createReplyPreview,
  currentTimestampSeconds,
  describeBridgeError,
  isLikelyIncompleteMessage,
  isPlaceholderThreadTitle,
  messageRoleLabel,
  toMessageAttachment,
  withChatMetrics,
} from "../lib/chatViewMessages";
import { writeResumeMarker, clearResumeMarker } from "../lib/chatResumeMarkers";
import { effectiveModelFromGateway } from "../lib/composerTurnContract";
import { normalizeChatEventParts, type ActiveTurnProjection } from "../lib/chatEventParts";
import { projectChatStreamEvent } from "./chatStreamEventProjection";
import type { ChatStreamStatus } from "./AssistantThinkingState";
import type { ReplyContext } from "./ChatViewTypes";
import type { ChatAttachment, ChatEventPart, ChatMessage, ChatThread } from "../types";

export interface ComposerSeed {
  text: string;
  nonce: number;
}

export interface UsageSuggestedModel {
  value: string;
  nonce: number;
}

export interface UseChatTurnSubmissionParams {
  // Props
  thread: ChatThread;
  messages: ChatMessage[];
  onMessagesChange: (messages: ChatMessage[], options?: { advanceActivity?: boolean }) => void;
  computerSessionId: string;
  onThreadChanged: () => void | Promise<void>;
  // Bumps the island projection refresh nonce (owned by App): the cancel
  // closures use it after the cancel DELETE settles so the activity
  // projection re-fetches. It never opens the island — that's activityNonce.
  bumpIslandRefreshNonce: () => void;
  seed?: { text: string; nonce: number } | null;
  sessionId: string;
  translate: (key: string, options?: Record<string, unknown>) => string;

  // From useChatTurnStateMachine
  promptSubmitting: boolean;
  streamingAssistantId: string | null;
  threadMessages: ChatMessage[];
  replyContext: ReplyContext | null;
  composerMode: string;
  setPromptSubmitting: Dispatch<SetStateAction<boolean>>;
  setPromptError: Dispatch<SetStateAction<string | null>>;
  setStreamingAssistantId: Dispatch<SetStateAction<string | null>>;
  setStreamStatus: Dispatch<SetStateAction<ChatStreamStatus | null>>;
  setLiveActivitySteps: Dispatch<SetStateAction<string[]>>;
  setLivePlanMarkdown: Dispatch<SetStateAction<string | null>>;
  setOptimisticMessages: Dispatch<SetStateAction<ChatMessage[] | null>>;
  setAutoContinueMessageId: Dispatch<SetStateAction<string | null>>;
  setReplyContext: Dispatch<SetStateAction<ReplyContext | null>>;
  activeTurnIdRef: MutableRefObject<string | null>;
  streamOwnerTurnRef: MutableRefObject<string | null>;
  handledBackgroundTurnsRef: MutableRefObject<Set<string>>;
  turnReplayRef: MutableRefObject<TurnReplayState | null>;
  refreshAfterChatSubmit: () => Promise<void>;

  // From useChatStreamingNotifier
  isMountedRef: MutableRefObject<boolean>;
  notifyStreaming: (busy: boolean) => void;

  // From useChatAutoTitle
  persistAutoTitleForCompletedTurn: (
    promptMessages: ChatMessage[],
    assistantText: string,
    shouldAutoTitle: boolean,
  ) => Promise<void>;

  // From useChatConversationScroll
  clearStreamingFrame: () => void;
  afterStreamingFramePaint: () => void;
  requestStreamingFrame: (callback: () => void) => void;
  clearStreamingPin: () => void;
  forceStreamingPin: () => void;
  markStreamingPinnedFromCurrentPosition: () => void;
  scrollConversationToBottomIfPinned: (behavior: ScrollBehavior) => void;
  cancelScheduledStreamingFrame: () => void;

  // From useChatStreamLifecycle
  resetStreamingState: (initialText?: string) => void;
  markStreamCancelled: (requestId: string) => void;
  isStreamCancelled: (requestId: string) => boolean;
  markStreamHasVisibleText: () => void;
  setActiveStreamingCancel: (cancel: () => void) => void;
  clearActiveStreamingCancel: (cancel: () => void) => void;
  clearStreamCancelled: (requestId: string) => void;
  hasActiveStreamingCancel: () => boolean;
  cancelActiveStreaming: () => void;

  // From useChatBrowserActivityLifecycle
  applyComputerSessionSnapshot: (snapshot: CoreComputerSessionSnapshot) => void;
  clearProjectedActiveTurn: () => void;
  bumpActivityNonce: () => void;
  projectedActiveTurn: ActiveTurnProjection | null;
  projectedTurnStatus: string | null;
  projectionLoaded: boolean;

  // From useChatInspectorWorkspace
  hideInspector: () => void;

  // From useChatApprovalFlow
  applyPendingSteeringChange: (record: TurnSteeringRecord) => void;
  refreshPendingSteering: () => Promise<void>;

  // From useChatBranches
  refreshBranches: () => Promise<void>;

  // From useChatFollowUps
  clearFollowUps: () => void;

  // Memos
  previousUserMessageIndex: Map<string, ChatMessage | null>;
}

/**
 * Owns all streaming turn submission logic: submitPrompt (the core streaming
 * submission), submitComposerPrompt (the main composer entry point), and all
 * derived streaming actions (regenerate, continue, auto-continue, expand,
 * reply, follow-up, proactive answer, choice answer, stop, open activity).
 *
 * Also owns the composer seed + usage-suggested-model state that the composer
 * dock consumes, and the external-seed effect that prefills the composer.
 */
export function useChatTurnSubmission({
  thread, messages, onMessagesChange, computerSessionId, onThreadChanged,
  bumpIslandRefreshNonce,
  seed, sessionId, translate: t,
  promptSubmitting, streamingAssistantId, threadMessages, replyContext,
  composerMode,
  setPromptSubmitting, setPromptError, setStreamingAssistantId, setStreamStatus,
  setLiveActivitySteps, setLivePlanMarkdown, setOptimisticMessages,
  setAutoContinueMessageId, setReplyContext,
  activeTurnIdRef, streamOwnerTurnRef, handledBackgroundTurnsRef, turnReplayRef,
  refreshAfterChatSubmit,
  isMountedRef, notifyStreaming,
  persistAutoTitleForCompletedTurn,
  clearStreamingFrame, afterStreamingFramePaint, requestStreamingFrame,
  clearStreamingPin, forceStreamingPin, markStreamingPinnedFromCurrentPosition,
  scrollConversationToBottomIfPinned, cancelScheduledStreamingFrame,
  resetStreamingState, markStreamCancelled, isStreamCancelled,
  markStreamHasVisibleText, setActiveStreamingCancel, clearActiveStreamingCancel,
  clearStreamCancelled, hasActiveStreamingCancel, cancelActiveStreaming,
  applyComputerSessionSnapshot, clearProjectedActiveTurn, bumpActivityNonce,
  projectedActiveTurn, projectedTurnStatus, projectionLoaded,
  hideInspector,
  applyPendingSteeringChange, refreshPendingSteering,
  refreshBranches,
  clearFollowUps,
  previousUserMessageIndex,
}: UseChatTurnSubmissionParams) {
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const [usageSuggestedModel, setUsageSuggestedModel] = useState<UsageSuggestedModel | null>(null);

  // External seed (e.g. a proactivity card engaged from the dashboard) → prefill
  // the composer. Keyed by nonce so re-engaging the same card re-applies.
  useEffect(() => {
    if (seed && seed.text.trim()) {
      setComposerSeed({ text: seed.text, nonce: seed.nonce });
    }
  }, [seed?.nonce]);

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
    const requestId = createRequestId("chat_stream");
    const localTurnId = createLocalTurnId(requestId);
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
        { ...streamingMessage, text: streamedText, eventParts: streamEventParts },
      ]);
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      requestStreamingFrame(flushStreamingMessage);
    };
    const debugStream = (stage: string, detail?: string) => {
      void coreBridge.debugChatStream(requestId, {
        stage, chunks: streamChunks, chars: streamedText.length,
        elapsed_ms: performance.now() - streamStartedAt, detail,
      });
    };
    const cancelStreamingRequest = () => {
      cancelledLocally = true;
      markStreamCancelled(requestId);
      debugStream("paint_cancelled");
      // Bump the island projection refresh nonce once the gateway has
      // processed the cancel DELETE, so the activity projection re-fetches and
      // reconciles with the gateway instead of re-populating a still-active
      // turn (fetch-vs-DELETE race). Note: this is the projection refresh
      // nonce, NOT the activity nonce — it never auto-opens the island
      // section. The `then` runs after the `catch` so it also fires on failure.
      void coreBridge.cancelChatPromptStream(requestId)
        .catch(() => undefined)
        .then(() => bumpIslandRefreshNonce());
      unlistenStream?.();
      cancelScheduledStreamingFrame();
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) => clearStreamStatusForRequest(current, requestId));
      setPromptSubmitting(false);
      const cancelledMessages = [
        ...promptMessages,
        { ...streamingMessage, text: streamedText || "Answer interrupted.",
          eventParts: streamEventParts, metadata: "Interrotta localmente" },
      ];
      setOptimisticMessages(cancelledMessages);
      onMessagesChange(cancelledMessages);
    };

    try {
      setOptimisticMessages([...promptMessages, streamingMessage]);
      resetStreamingState("");
      setLiveActivitySteps([]);
      setLivePlanMarkdown(null);
      setStreamingAssistantId(streamingMessage.id);
      notifyStreaming(true);
      markStreamingPinnedFromCurrentPosition();
      window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
      setActiveStreamingCancel(cancelStreamingRequest);
      writeResumeMarker(thread.threadId, {
        requestId, userText: userVisibleText, assistantMessageId: streamingMessage.id,
      }, sessionId);
      unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
        if (payload.request_id !== requestId) return;
        if (isStreamCancelled(requestId)) return;
        if (payload.type === "retry" || payload.type === "queued") {
          setStreamStatus({
            requestId, phase: "thinking",
            title: payload.type === "retry" ? t("chat.retrying", { defaultValue: "Riprovo…" }) : t("chat.promptReceived"),
            detail: String(payload.payload.reason ?? payload.payload.detail ?? ""),
          });
          return;
        }
        const projectedStream = projectChatStreamEvent(
          { text: streamedText, eventParts: streamEventParts }, payload, { acceptControlEvents: true },
        );
        if (projectedStream.kind === "ignored") return;
        streamedText = projectedStream.draft.text;
        streamEventParts = projectedStream.draft.eventParts;
        if (projectedStream.kind === "aborted") {
          setStreamStatus({
            requestId, phase: "thinking",
            title: t("chat.resumingResponse"), detail: t("chat.reattachingGeneration"),
          });
          scheduleStreamingMessage();
          return;
        }
        if (projectedStream.kind === "done") {
          scheduleStreamingMessage();
          return;
        }
        if (projectedStream.kind === "part") {
          if (projectedStream.part.type === "recall") {
            const count = projectedStream.part.payload?.hits?.length ?? 0;
            const memoryStatus = projectedStream.part.payload?.status ?? (count > 0 ? "ready" : "empty");
            const detail =
              memoryStatus === "unavailable" ? t("chat.recallingUnavailable")
              : memoryStatus === "degraded" ? t("chat.recallingDegraded")
              : memoryStatus === "denied" ? t("chat.recallingDenied")
              : count > 0 ? t("chat.recallingHits", { count })
              : t("chat.recallingNoHits");
            setStreamStatus({ requestId, phase: "recalling", title: t("chat.recalling"), detail });
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
          setStreamStatus({ requestId, phase: "writing", title: t("chat.writing"), detail: t("chat.streamingArriving") });
        }
        if (firstDelta) { debugStream("paint_first_delta"); }
        markStreamHasVisibleText();
        scheduleStreamingMessage();
      });
      setStreamStatus({ requestId, phase: "thinking", title: t("chat.thinking"), detail: t("chat.buildingLocalContext") });
      const result = await coreBridge.submitChatPromptStream(
        requestId, thread.threadId, computerSessionId, text, attachments,
        visiblePrompt, model, images, mode, branchFromId, routingBinding,
      );
      if (isStreamCancelled(requestId)) return;
      streamedText = result.assistant_message.text || streamedText;
      streamEventParts = [];
      await persistAutoTitleForCompletedTurn(promptMessages, streamedText, shouldAutoTitleAfterSubmit);
      if (!isMountedRef.current) return;
      cancelScheduledStreamingFrame();
      debugStream("paint_done_before_commit");
      if (isStreamCancelled(requestId)) return;
      applyComputerSessionSnapshot(result.computer_session);
      const turnModel = effectiveModelFromGateway(result.effective_model) ?? undefined;
      const finalAssistantMessage: ChatMessage = {
        ...withChatMetrics(
          chatMessageFromAssistantResult(result, result.assistant_message.text || streamedText, normalizeChatEventParts(result.assistant_message.event_parts)),
          (performance.now() - streamStartedAt) / 1000,
        ),
        model: turnModel,
      };
      let finalMessages = [...promptMessages, finalAssistantMessage];
      setOptimisticMessages(finalMessages);
      onMessagesChange(finalMessages, { advanceActivity: true });
      if (isLikelyIncompleteMessage(finalAssistantMessage)) {
        finalMessages = await autoContinueAssistantResponse(finalAssistantMessage, finalMessages);
      }
      setOptimisticMessages(finalMessages);
      onMessagesChange(finalMessages, { advanceActivity: true });
      await refreshAfterChatSubmit();
      setOptimisticMessages(null);
    } catch (error) {
      cancelScheduledStreamingFrame();
      if (cancelledLocally || isStreamCancelled(requestId)) return;
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
      setStreamStatus((current) => clearStreamStatusForRequest(current, requestId));
      const errorMessages: ChatMessage[] = [
        ...promptMessages,
        { id: `local_error_${Date.now()}`, role: "system" as const, text: message, timestamp: currentTimestampSeconds() },
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
        setStreamStatus((current) => clearStreamStatusForRequest(current, requestId));
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

  async function stopActiveTurn() {
    if (hasActiveStreamingCancel()) {
      // Clear the projected active turn immediately so the "assistant is
      // thinking" indicator (and its timer) stop right away; the local cancel
      // closure issues the DELETE and bumps the island projection refresh
      // nonce afterwards so the projection re-syncs with the gateway state.
      clearProjectedActiveTurn();
      cancelActiveStreaming();
      return;
    }
    const turnId = projectedActiveTurn?.turn_id ?? activeTurnIdRef.current;
    if (!turnId) return;
    try {
      await cancelTurn(turnId);
      clearProjectedActiveTurn();
      // When the cancelled turn is the one a local stream (e.g. a resumed
      // stream) is awaiting, reset the composer streaming state immediately
      // instead of waiting for that await to settle on the cancel event.
      if (streamOwnerTurnRef.current === turnId || activeTurnIdRef.current === turnId) {
        setStreamingAssistantId(null);
        resetStreamingState("");
        // Clear only the status owned by this turn's request — a blanket
        // `setStreamStatus(null)` could wipe another request's status.
        const cancelledRequestId = requestIdFromTurnId(turnId);
        setStreamStatus((current) => clearStreamStatusForRequest(current, cancelledRequestId));
        setPromptSubmitting(false);
      }
      await refreshPendingSteering().catch(() => undefined);
    } catch (error) {
      setPromptError(describeBridgeError(error));
    }
  }

  function openActivityIsland() {
    hideInspector();
    bumpActivityNonce();
  }

  async function handleProactiveAnswer(question: string, answer: string) {
    try {
      await coreBridge.captureProactiveAnswer(thread.threadId, {
        answer, question, ack: t("chat.proactiveAnswerThanks"),
      });
      await refreshAfterChatSubmit();
    } catch (error) {
      setPromptError(describeBridgeError(error));
    }
  }

  async function submitChoiceAnswer(answer: string, assistantMessageId: string): Promise<boolean> {
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
      model?: string; mode?: string; forcedSkillsId?: string; contextText?: string;
      images?: string[]; forceNewTurn?: boolean; resumeAssistantMessageId?: string;
    },
  ): Promise<boolean> {
    const activeReplyContext = replyContext;
    const images = options?.images;
    const mode = options?.mode;
    const { skillPrefix, contextPrefix, augmented } = buildComposerPromptDecorators({
      forcedSkillsId: options?.forcedSkillsId, contextText: options?.contextText,
    });
    const model = options?.model;
    const submissionRoute = routeComposerSubmission({
      promptSubmitting, streamingAssistantId, projectedActiveTurn, projectedTurnStatus,
      projectionLoaded, composerMode,
      explicitForceNewTurn: options?.forceNewTurn,
    });
    const forceNewTurn = submissionRoute.forceNewTurn;
    if (forceNewTurn) {
      setStreamingAssistantId(null);
      setStreamStatus(null);
      clearProjectedActiveTurn();
    }
    if (submissionRoute.routesToSteering) {
      const promptWithReplyContext = buildSteeringPrompt({
        skillPrefix, contextPrefix, prompt,
        replyRoleLabel: activeReplyContext ? messageRoleLabel(activeReplyContext.role) : undefined,
        replyPreview: activeReplyContext?.preview,
      });
      const requestId = createRequestId("chat_steering");
      try {
        const result = await enqueueTurn(thread.threadId, requestId, promptWithReplyContext, {
          visiblePrompt: prompt, images, attachments: attachments.length ? attachments : undefined, mode, model,
        });
        if (result.status === "queued") {
          setReplyContext(null);
          setPromptError(null);
          clearProjectedActiveTurn();
          try { await onThreadChanged(); } catch (error) { console.warn("queued turn refresh unavailable", error); }
          return true;
        }
        const returnedRecord = (result as typeof result & { steering?: TurnSteeringRecord }).steering;
        if (returnedRecord) {
          applyPendingSteeringChange(returnedRecord);
        } else {
          await refreshPendingSteering().catch(() => undefined);
        }
        setReplyContext(null);
        setPromptError(null);
        setStreamStatus((current) => current ? { ...current, detail: t("chat.steeringQueued") } : current);
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
        void submitPrompt(`${skillPrefix}${contextPrefix}${prompt}`, attachments, undefined, prompt, model, images, undefined, mode, undefined, undefined, options?.resumeAssistantMessageId);
      } else {
        void submitPrompt(prompt, attachments, undefined, undefined, model, images, undefined, mode, undefined, undefined, options?.resumeAssistantMessageId);
      }
      return true;
    }
    const promptWithReplyContext = buildReplyContextPrompt({
      skillPrefix, contextPrefix, prompt,
      replyRoleLabel: messageRoleLabel(activeReplyContext.role), replyPreview: activeReplyContext.preview,
    });
    void submitPrompt(promptWithReplyContext, attachments, undefined, prompt, model, images, undefined, mode, undefined, undefined, options?.resumeAssistantMessageId);
    return true;
  }

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
    message: ChatMessage, userMessage: ChatMessage, baseMessages: ChatMessage[],
  ) {
    const requestId = createRequestId("chat_stream_regen");
    activeTurnIdRef.current = createLocalTurnId(requestId);
    let streamedText = "";
    let streamEventParts: ChatEventPart[] = [];
    let unlistenStream: (() => void) | undefined;
    const flushStreamingMessage = () => {
      clearStreamingFrame();
      setOptimisticMessages(baseMessages.map((item) =>
        item.id === message.id ? { ...item, text: streamedText, eventParts: streamEventParts } : item,
      ));
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => { requestStreamingFrame(flushStreamingMessage); };
    const cancelStreamingRequest = () => {
      markStreamCancelled(requestId);
      // Bump the island projection refresh nonce (not the activity nonce, so
      // the island does not auto-open) after the cancel DELETE settles.
      void coreBridge.cancelChatPromptStream(requestId)
        .catch(() => undefined)
        .then(() => bumpIslandRefreshNonce());
      unlistenStream?.();
      cancelScheduledStreamingFrame();
    };
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
    setStreamStatus({ requestId, phase: "thinking", title: t("chat.regeneratingResponse"), detail: t("chat.generatingAlternativeVariant") });
    setActiveStreamingCancel(cancelStreamingRequest);
    unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
      if (payload.request_id !== requestId) return;
      if (isStreamCancelled(requestId)) return;
      const projectedStream = projectChatStreamEvent({ text: streamedText, eventParts: streamEventParts }, payload);
      if (projectedStream.kind === "ignored") return;
      streamedText = projectedStream.draft.text;
      streamEventParts = projectedStream.draft.eventParts;
      if (projectedStream.kind === "aborted" || projectedStream.kind === "done") return;
      if (projectedStream.kind === "part") { scheduleStreamingMessage(); return; }
      markStreamHasVisibleText();
      scheduleStreamingMessage();
    });
    try {
      const result = await coreBridge.regenerateChatPromptStream(
        requestId, thread.threadId, computerSessionId, userMessage.text, userMessage.id, context,
      );
      if (isStreamCancelled(requestId)) return;
      cancelScheduledStreamingFrame();
      applyComputerSessionSnapshot(result.computer_session);
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
      setStreamStatus((current) => clearStreamStatusForRequest(current, requestId));
      notifyStreaming(false);
      clearActiveStreamingCancel(cancelStreamingRequest);
      clearStreamCancelled(requestId);
    }
  }

  function replyToMessage(message: ChatMessage) {
    if (!message.text) return;
    setReplyContext({
      messageId: message.id, role: message.role, preview: createReplyPreview(message.text),
    });
  }

  function continueAssistantResponse(messageId: string) {
    if (promptSubmitting) return;
    const message = threadMessages.find((item) => item.id === messageId);
    if (!message?.text) { setPromptError(t("chat.noResponseToContinue")); return; }
    void submitPrompt(CONTINUE_RESPONSE_PROMPT, [], [], "Continue");
  }

  async function autoContinueAssistantResponse(
    assistantMessage: ChatMessage, baseMessages: ChatMessage[],
  ) {
    const maxAutoContinuetions = 2;
    let currentMessages = baseMessages;
    let currentMessage = assistantMessage;
    for (let attempt = 0; attempt < maxAutoContinuetions && isLikelyIncompleteMessage(currentMessage); attempt += 1) {
      setAutoContinueMessageId(currentMessage.id);
      try {
        currentMessages = await streamContinuetionIntoMessage(currentMessage, currentMessages, attempt + 1);
        const updatedMessage = currentMessages.find((message) => message.id === currentMessage.id);
        if (!updatedMessage || updatedMessage.text === currentMessage.text) break;
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
    message: ChatMessage, baseMessages: ChatMessage[], attempt: number,
  ) {
    const requestId = createRequestId("chat_stream_continue");
    activeTurnIdRef.current = createLocalTurnId(requestId);
    let streamedText = message.text;
    let streamEventParts: ChatEventPart[] = message.eventParts ?? [];
    let unlistenStream: (() => void) | undefined;
    let cancelledLocally = false;
    const flushStreamingMessage = () => {
      clearStreamingFrame();
      setOptimisticMessages(baseMessages.map((item) =>
        item.id === message.id ? { ...item, text: streamedText, eventParts: streamEventParts } : item,
      ));
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => { requestStreamingFrame(flushStreamingMessage); };
    const cancelStreamingRequest = () => {
      cancelledLocally = true;
      markStreamCancelled(requestId);
      // Bump the island projection refresh nonce (not the activity nonce, so
      // the island does not auto-open) after the cancel DELETE settles.
      void coreBridge.cancelChatPromptStream(requestId)
        .catch(() => undefined)
        .then(() => bumpIslandRefreshNonce());
      unlistenStream?.();
      cancelScheduledStreamingFrame();
    };
    setStreamingAssistantId(message.id);
    notifyStreaming(true);
    resetStreamingState(message.text);
    markStreamingPinnedFromCurrentPosition();
    window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
    setStreamStatus({ requestId, phase: "thinking", title: t("chat.continuingResponse"), detail: t("chat.generationLimitReached", { attempt }) });
    setActiveStreamingCancel(cancelStreamingRequest);
    unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
      if (payload.request_id !== requestId) return;
      if (isStreamCancelled(requestId)) return;
      const projectedStream = projectChatStreamEvent(
        { text: streamedText, eventParts: streamEventParts }, payload, { initialTextLength: message.text.length },
      );
      if (projectedStream.kind === "ignored") return;
      streamedText = projectedStream.draft.text;
      streamEventParts = projectedStream.draft.eventParts;
      if (projectedStream.kind === "aborted" || projectedStream.kind === "done") return;
      if (projectedStream.kind === "part") { scheduleStreamingMessage(); return; }
      const firstDelta = projectedStream.firstDelta;
      if (firstDelta) {
        setStreamStatus({ requestId, phase: "writing", title: t("chat.assistantContinuing"), detail: t("chat.completingInSameMessage") });
      }
      markStreamHasVisibleText();
      scheduleStreamingMessage();
    });
    try {
      const result = await coreBridge.continueChatMessageStream(
        requestId, thread.threadId, message.id, computerSessionId, message.text, message.model,
      );
      if (isStreamCancelled(requestId)) return baseMessages;
      streamedText = result.assistant_message.text || streamedText;
      streamEventParts = [];
      cancelScheduledStreamingFrame();
      const updatedMessage = chatMessageFromAssistantResult(
        result, streamedText, normalizeChatEventParts(result.assistant_message.event_parts),
      );
      const nextMessages = baseMessages.map((item) => item.id === message.id ? updatedMessage : item);
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
      setStreamStatus((current) => clearStreamStatusForRequest(current, requestId));
      notifyStreaming(false);
      clearActiveStreamingCancel(cancelStreamingRequest);
      clearStreamCancelled(requestId);
    }
  }

  function expandAssistantResponse(messageId: string) {
    askAboutAssistantResponse(messageId, "Expand", "Expand the previous response with useful details, without repeating the entire response.");
  }

  function askAboutAssistantResponse(messageId: string, visibleText: string, instruction: string) {
    if (promptSubmitting) return;
    const message = threadMessages.find((item) => item.id === messageId);
    if (!message?.text) { setPromptError(t("chat.noPreviousResponse")); return; }
    const followUpPrompt = buildAssistantFollowUpPrompt({ instruction, previousResponse: message.text });
    void submitPrompt(followUpPrompt, [], [], visibleText);
  }

  return {
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
  };
}
