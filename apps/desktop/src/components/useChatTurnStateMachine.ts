import { useEffect, useMemo, useRef, useState } from "react";
import { wsSubscription } from "../lib/wsSubscription";
import {
  applyTurnEvent,
  createTurnReplayState,
  type TurnReplayState,
} from "../lib/turnReplayState";
import {
  isOwnResumeMarker,
  readResumeMarker,
  type ResumeMarker,
} from "../lib/chatResumeMarkers";
import {
  clearStreamStatusForRequest,
  isTerminalWsTurnStatus,
  isTurnIdle,
  requestIdFromTurnId,
} from "../lib/chat-runtime/turnStateMachine";
import type { ChatStreamStatus } from "./AssistantThinkingState";
import type {
  ChatAutoSubmit,
  ReplyContext,
} from "./ChatViewTypes";
import type { ChatAttachmentInput, RoutingBindingInput } from "../lib/coreBridge";
import type { ChatAttachment, ChatMessage, ChatThread } from "../types";

/** Signature of the submitPrompt function defined in ChatView. */
export type SubmitPromptFn = (
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
) => void | Promise<void>;

export interface ResumeStreamOptions {
  commitResult?: boolean;
  replaceIds?: string[];
}

/** Signature of the resumeActiveStream function defined in ChatView. */
export type ResumeActiveStreamFn = (
  marker: ResumeMarker,
  options?: ResumeStreamOptions,
) => void | Promise<void>;

/**
 * External callbacks that ChatView wires up after calling other hooks.
 * The effects and simple callbacks in this hook read from this ref at
 * call-time (not render-time), so they always see the latest values.
 */
export interface TurnStateMachineExternalCallbacks {
  /** Main prompt submission (defined in ChatView, needs streaming infrastructure). */
  submitPrompt: SubmitPromptFn;
  /** Reattach to a stream that was active when the app reloaded. */
  resumeActiveStream: ResumeActiveStreamFn;
  /** From useChatActivityProjection — pushes WS terminal status into projection. */
  markProjectedTurnStatus: (status: string) => void;
}

export interface UseChatTurnStateMachineParams {
  thread: ChatThread;
  messages: ChatMessage[];
  onStreamingChange?: (busy: boolean) => void;
  onThreadChanged: () => void | Promise<void>;
  onRuntimeChanged: () => void | Promise<void>;
  autoSubmit?: ChatAutoSubmit | null;
  onAutoSubmitConsumed?: (id: string) => void;
  incomingBackgroundTurn?: {
    turnId: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null;
  /** Unique per-ChatView-instance ID for resume-marker ownership. */
  sessionId: string;
}

/**
 * Owns the turn state machine: all state atoms and refs related to the
 * turn lifecycle (submitting, streaming, stream status, live activity),
 * the derived thread-messages view, and the effects that react to turn
 * state changes (WS subscription, auto-submit, resume marker, background
 * turn).
 *
 * The streaming functions (submitPrompt, resumeActiveStream, …) stay in
 * ChatView because they depend on streaming infrastructure hooks that
 * are wired after this hook. They are provided back to this hook's
 * effects via `externalRef` so the effects always call the latest
 * version.
 */
export function useChatTurnStateMachine({
  thread,
  messages,
  onThreadChanged,
  onRuntimeChanged,
  autoSubmit,
  onAutoSubmitConsumed,
  incomingBackgroundTurn,
  sessionId,
}: UseChatTurnStateMachineParams) {
  // ── State atoms ──────────────────────────────────────────────────
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<ChatStreamStatus | null>(null);
  const [liveActivitySteps, setLiveActivitySteps] = useState<string[]>([]);
  const [livePlanMarkdown, setLivePlanMarkdown] = useState<string | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[] | null>(null);
  const [autoContinueMessageId, setAutoContinueMessageId] = useState<string | null>(null);
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────
  const activeTurnIdRef = useRef<string | null>(null);
  const turnReplayRef = useRef<TurnReplayState | null>(null);
  const streamOwnerTurnRef = useRef<string | null>(null);
  const handledBackgroundTurnsRef = useRef<Set<string>>(new Set());
  const resumedThreadsRef = useRef<Set<string>>(new Set());
  const consumedAutoSubmitIdsRef = useRef<Set<string>>(new Set());

  // ── External callbacks ref (wired by ChatView) ───────────────────
  const externalRef = useRef<TurnStateMachineExternalCallbacks>(
    {} as TurnStateMachineExternalCallbacks,
  );

  // ── Derived values ───────────────────────────────────────────────
  const threadMessages = useMemo(() => {
    const base = optimisticMessages ?? messages;
    return base.filter((m) => !(m.role === "assistant" && m.id.endsWith("_ready")));
  }, [optimisticMessages, messages]);

  const activeStreamInProgress = Boolean(promptSubmitting || streamingAssistantId);

  // ── Simple callbacks ──────────────────────────────────────────────
  async function refreshAfterChatSubmit() {
    try {
      await onRuntimeChanged();
      await onThreadChanged();
    } catch (error) {
      console.warn("chat read model refresh unavailable", error);
    }
  }

  // ── Effects ──────────────────────────────────────────────────────

  // Global WS provides a second observation of turn state. The monotonic
  // reducer makes it safe to overlap with the durable per-turn stream.
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
      if (isTerminalWsTurnStatus(next.status)) {
        externalRef.current.markProjectedTurnStatus(next.status);
      }
    });
    return unsub;
    // Subscription is set up once; reads from refs and externalRef at callback time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-submit: bridge externally-created threads into the canonical chat pipeline.
  useEffect(() => {
    if (!autoSubmit) return;
    if (autoSubmit.threadId !== thread.threadId) return;
    if (!isTurnIdle(promptSubmitting, streamingAssistantId)) return;
    if (consumedAutoSubmitIdsRef.current.has(autoSubmit.id)) return;
    consumedAutoSubmitIdsRef.current.add(autoSubmit.id);
    onAutoSubmitConsumed?.(autoSubmit.id);
    void externalRef.current.submitPrompt(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit, promptSubmitting, streamingAssistantId, thread.threadId]);

  // After a reload, reattach to an answer that was still streaming (resume).
  useEffect(() => {
    if (resumedThreadsRef.current.has(thread.threadId)) return;
    if (!isTurnIdle(promptSubmitting, streamingAssistantId)) return;
    const marker = readResumeMarker(thread.threadId);
    if (!marker) return;
    const commitResult = !isOwnResumeMarker(marker, sessionId);
    resumedThreadsRef.current.add(thread.threadId);
    void externalRef.current.resumeActiveStream(marker, { commitResult });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.threadId, sessionId]);

  // A background turn (channel/scheduled reply, or a turn started from
  // another window) began on THIS open thread. Attach to its live stream
  // exactly like an in-app turn via resumeActiveStream.
  useEffect(() => {
    const incoming = incomingBackgroundTurn;
    if (!incoming || incoming.threadId !== thread.threadId) return;
    if (handledBackgroundTurnsRef.current.has(incoming.turnId)) return;
    if (!isTurnIdle(promptSubmitting, streamingAssistantId)) return;
    const placeholder = messages.find(
      (message) => message.id === incoming.assistantMessageId,
    );
    if (!placeholder) return; // persisted rows not loaded yet → retry when messages updates
    const userText =
      messages.find((message) => message.id === incoming.userMessageId)?.text ?? "";
    const requestId = requestIdFromTurnId(incoming.turnId);
    handledBackgroundTurnsRef.current.add(incoming.turnId);
    void externalRef.current.resumeActiveStream(
      { requestId, userText, assistantMessageId: incoming.assistantMessageId },
      { commitResult: true, replaceIds: [incoming.userMessageId, incoming.assistantMessageId] },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingBackgroundTurn, messages, promptSubmitting, streamingAssistantId, thread.threadId]);

  return {
    // State values
    promptSubmitting,
    promptError,
    streamingAssistantId,
    streamStatus,
    liveActivitySteps,
    livePlanMarkdown,
    optimisticMessages,
    autoContinueMessageId,
    replyContext,
    // Setters
    setPromptSubmitting,
    setPromptError,
    setStreamingAssistantId,
    setStreamStatus,
    setLiveActivitySteps,
    setLivePlanMarkdown,
    setOptimisticMessages,
    setAutoContinueMessageId,
    setReplyContext,
    // Refs
    activeTurnIdRef,
    turnReplayRef,
    streamOwnerTurnRef,
    handledBackgroundTurnsRef,
    resumedThreadsRef,
    consumedAutoSubmitIdsRef,
    // External callbacks ref (ChatView populates after calling other hooks)
    externalRef,
    // Derived values
    threadMessages,
    activeStreamInProgress,
    // Callbacks
    refreshAfterChatSubmit,
  };
}
