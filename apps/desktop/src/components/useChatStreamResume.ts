import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { coreBridge } from "../lib/coreBridge";
import { createTurnReplayState, type TurnReplayState } from "../lib/turnReplayState";
import {
  clearResumeMarker,
  type ResumeMarker,
} from "../lib/chatResumeMarkers";
import {
  clearStreamStatusForRequest,
  createLocalTurnId,
  createRequestId,
} from "../lib/chat-runtime/turnStateMachine";
import {
  chatMessageFromAssistantResult,
  currentTimestampSeconds,
  describeBridgeError,
  isPlaceholderThreadTitle,
} from "../lib/chatViewMessages";
import { normalizeChatEventParts } from "../lib/chatEventParts";
import { projectChatStreamEvent } from "./chatStreamEventProjection";
import type { ChatStreamStatus } from "./AssistantThinkingState";
import type { ChatEventPart, ChatMessage, ChatThread } from "../types";

export interface UseChatStreamResumeParams {
  thread: ChatThread;
  messages: ChatMessage[];
  onMessagesChange: (messages: ChatMessage[], options?: { advanceActivity?: boolean }) => void;
  computerSessionId: string;
  translate: (key: string, options?: Record<string, unknown>) => string;

  // From useChatTurnStateMachine
  promptSubmitting: boolean;
  streamingAssistantId: string | null;
  setPromptSubmitting: Dispatch<SetStateAction<boolean>>;
  setPromptError: Dispatch<SetStateAction<string | null>>;
  setOptimisticMessages: Dispatch<SetStateAction<ChatMessage[] | null>>;
  setStreamingAssistantId: Dispatch<SetStateAction<string | null>>;
  setStreamStatus: Dispatch<SetStateAction<ChatStreamStatus | null>>;
  activeTurnIdRef: MutableRefObject<string | null>;
  streamOwnerTurnRef: MutableRefObject<string | null>;
  turnReplayRef: MutableRefObject<TurnReplayState | null>;
  refreshAfterChatSubmit: () => Promise<void>;

  // From useChatStreamingNotifier
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
  cancelScheduledStreamingFrame: () => void;

  // From useChatStreamLifecycle
  resetStreamingState: (initialText?: string) => void;
  markStreamHasVisibleText: () => void;
  markStreamCancelled: (requestId: string) => void;
  isStreamCancelled: (requestId: string) => boolean;
  clearStreamCancelled: (requestId: string) => void;
  setActiveStreamingCancel: (cancel: () => void) => void;
  clearActiveStreamingCancel: (cancel: () => void) => void;

  // From useChatBrowserActivityLifecycle
  // Bumps the island projection refresh nonce (owned by App) after the cancel
  // DELETE settles so the activity projection re-fetches. It never opens the
  // island — that's the activity nonce's job.
  bumpIslandRefreshNonce: () => void;
}

/**
 * Reattach to an answer that was streaming when the app was reloaded: replays
 * the buffered events from the gateway and continues live, then persists.
 */
export function useChatStreamResume({
  thread, messages, onMessagesChange, computerSessionId, translate: t,
  promptSubmitting, streamingAssistantId,
  setPromptSubmitting, setPromptError, setOptimisticMessages, setStreamingAssistantId, setStreamStatus,
  activeTurnIdRef, streamOwnerTurnRef, turnReplayRef, refreshAfterChatSubmit,
  notifyStreaming,
  persistAutoTitleForCompletedTurn,
  clearStreamingFrame, afterStreamingFramePaint, requestStreamingFrame,
  clearStreamingPin, forceStreamingPin, cancelScheduledStreamingFrame,
  resetStreamingState,
  markStreamHasVisibleText,
  markStreamCancelled,
  isStreamCancelled,
  clearStreamCancelled,
  setActiveStreamingCancel,
  clearActiveStreamingCancel,
  bumpIslandRefreshNonce,
}: UseChatStreamResumeParams) {
  async function resumeActiveStream(
    marker: ResumeMarker,
    options?: { commitResult?: boolean; replaceIds?: string[] },
  ) {
    if (promptSubmitting || streamingAssistantId) return;
    const shouldAutoTitleAfterResume = isPlaceholderThreadTitle(thread.title);
    const requestId = marker.requestId;
    const resumedTurnId = createLocalTurnId(requestId);
    if (streamOwnerTurnRef.current) return;
    streamOwnerTurnRef.current = resumedTurnId;
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
    const replaceIds = options?.replaceIds;
    const seedMessages = replaceIds?.length
      ? messages.filter((message) => !replaceIds.includes(message.id))
      : messages;
    const promptMessages = [...seedMessages, userMessage];
    let streamedText = "";
    let streamEventParts: ChatEventPart[] = [];
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
    // Intentional divergence from the submitPrompt cancel closure: it commits
    // the interrupted partial text, but a resumed stream's partial text is
    // already persisted by the live stream updates, so there is nothing to
    // commit here — the DB replay re-supplies it on the next load. Without
    // this registration the composer Stop is a no-op during a resumed stream,
    // leaving the "assistant is thinking" state (and its timer) running forever.
    const cancelStreamingRequest = () => {
      cancelledLocally = true;
      markStreamCancelled(requestId);
      // Bump the island projection refresh nonce once the gateway has processed
      // the cancel DELETE so the activity projection reconciles with the
      // gateway state. Note: this is the projection refresh nonce, NOT the
      // activity nonce — it never auto-opens the island section.
      void coreBridge.cancelChatPromptStream(requestId)
        .catch(() => undefined)
        .then(() => bumpIslandRefreshNonce());
      // Drop the synthetic optimistic layer (resume_user_* bubble + partial
      // text); the persisted text comes back from the DB replay.
      setOptimisticMessages(null);
      unlistenStream?.();
      cancelScheduledStreamingFrame();
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) => clearStreamStatusForRequest(current, requestId));
      setPromptSubmitting(false);
    };

    setPromptSubmitting(true);
    setOptimisticMessages([...promptMessages, streamingMessage]);
    resetStreamingState("");
    setStreamingAssistantId(streamingMessage.id);
    notifyStreaming(true);
    forceStreamingPin();
    setActiveStreamingCancel(cancelStreamingRequest);
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: t("chat.resumingResponse"),
      detail: t("chat.reattachingGeneration"),
    });
    try {
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
      if (isStreamCancelled(requestId)) return;
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
    } catch (error) {
      if (cancelledLocally || isStreamCancelled(requestId)) {
        setOptimisticMessages(null);
        return;
      }
      setPromptError(describeBridgeError(error));
      setOptimisticMessages(null);
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      clearStreamingPin();
      if (!cancelledLocally) {
        setStreamingAssistantId(null);
        resetStreamingState("");
        setStreamStatus((current) => clearStreamStatusForRequest(current, requestId));
        setPromptSubmitting(false);
      }
      notifyStreaming(false);
      clearActiveStreamingCancel(cancelStreamingRequest);
      clearStreamCancelled(requestId);
      if (activeTurnIdRef.current === createLocalTurnId(requestId)) {
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

  return { resumeActiveStream };
}
