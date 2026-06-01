import {
  ArrowUp,
  AlertCircle,
  BookMarked,
  Check,
  ChevronDown,
  Copy,
  Clock3,
  FileText,
  Globe2,
  HardDrive,
  ListTodo,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pause,
  Play,
  Reply,
  RotateCcw,
  Share2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import {
  coreBridge,
  type ChatAttachmentInput,
  type CoreComputerSessionSnapshot,
  type CorePromptSubmissionResult,
} from "../lib/coreBridge";
import {
  createLoadingComputerSession,
  createUnavailableComputerSession,
  mapCoreComputerSession,
} from "../lib/localComputerViewModel";
import { RichMessage } from "./RichMessage";
import { ChatComputerPanel } from "./ChatComputerPanel";
import type {
  ChatMessage,
  ChatMessageMetrics,
  ChatAttachment,
  ChatThread,
  ComputerSession,
  ComputerSurfaceKind,
  ApprovalItem,
  RuntimeHealth,
  TaskItem,
} from "../types";

interface ChatViewProps {
  approvals: ApprovalItem[];
  approvalBusyId: string | null;
  computerSessionId: string;
  messages: ChatMessage[];
  health: RuntimeHealth[];
  task: TaskItem;
  thread: ChatThread;
  onMessagesChange: (messages: ChatMessage[]) => void;
  onOpenTasks: () => void;
  onApproveApproval: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void;
  onRejectApproval: (approvalId: string) => void;
  onRuntimeChanged: () => void | Promise<void>;
  onThreadChanged: () => void | Promise<void>;
}

const surfaceIcons: Record<ComputerSurfaceKind, typeof Globe2> = {
  browser: Globe2,
  shell: SquareTerminal,
  files: FileText,
  logs: HardDrive,
};

interface ReplyContext {
  messageId: string;
  role: ChatMessage["role"];
  preview: string;
}

type MessageFeedback = NonNullable<ChatMessage["feedback"]>;
type MessageContentKind = "user" | "system" | "text" | "code" | "diagram";
type ChatStreamPhase = "accepted" | "thinking" | "writing";

interface ChatStreamStatus {
  requestId: string;
  phase: ChatStreamPhase;
  title: string;
  detail: string;
}

export function ChatView({
  approvals,
  approvalBusyId,
  computerSessionId,
  messages,
  health,
  task,
  thread,
  onMessagesChange,
  onOpenTasks,
  onApproveApproval,
  onRejectApproval,
  onRuntimeChanged,
  onThreadChanged,
}: ChatViewProps) {
  const [computerSession, setComputerSession] = useState<ComputerSession>(() =>
    createLoadingComputerSession(computerSessionId),
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activeSurface, setActiveSurface] = useState<ComputerSurfaceKind>(
    computerSession.activeSurface,
  );
  const [smokeTestRunning, setSmokeTestRunning] = useState(false);
  const [smokeTestError, setSmokeTestError] = useState<string | null>(null);
  const [planStepRunning, setPlanStepRunning] = useState(false);
  const [planStepError, setPlanStepError] = useState<string | null>(null);
  const [computerControlBusy, setComputerControlBusy] = useState(false);
  const [computerControlError, setComputerControlError] = useState<string | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<ChatStreamStatus | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(true);
  const [computerCardCollapsed, setComputerCardCollapsed] = useState(true);
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[] | null>(null);
  const [streamHasVisibleText, setStreamHasVisibleText] = useState(false);
  const [autoContinueMessageId, setAutoContinueMessageId] = useState<string | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const streamingUserPinnedRef = useRef(false);
  const streamingFrameRef = useRef<number | null>(null);
  const cancelStreamingRequestRef = useRef<(() => void) | null>(null);
  const cancelledStreamIdsRef = useRef<Set<string>>(new Set());
  const activeHealth = useMemo(
    () => health.filter((item) => item.status !== "attention").slice(0, 2),
    [health],
  );
  const threadMessages = optimisticMessages ?? messages;
  const activeApprovals = approvals.filter((approval) =>
    approval.requestedBy.includes(computerSessionId),
  );
  const visibleComputerSession = useMemo(
    () => ({
      ...computerSession,
      timeline: computerSession.timeline.filter(isUserVisibleComputerEvent),
    }),
    [computerSession],
  );
  const showComputerActivity =
    activeApprovals.length > 0 ||
    planStepRunning ||
    smokeTestRunning ||
    visibleComputerSession.timeline.length > 0 ||
    visibleComputerSession.artifacts.length > 0 ||
    detailsOpen;

  function scrollConversationToBottom(behavior: ScrollBehavior) {
    const node = conversationRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }

  function conversationBottomDistance() {
    const node = conversationRef.current;
    if (!node) return 0;
    return node.scrollHeight - node.scrollTop - node.clientHeight;
  }

  function shouldAutoScrollConversation() {
    return streamingUserPinnedRef.current || shouldStickToBottomRef.current;
  }

  function scrollConversationToBottomIfPinned(behavior: ScrollBehavior) {
    if (!shouldAutoScrollConversation()) return;
    scrollConversationToBottom(behavior);
  }

  function resetStreamingState(initialText = "") {
    setStreamHasVisibleText(Boolean(initialText));
    cancelScheduledStreamingFrame();
  }

  function cancelScheduledStreamingFrame() {
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
  }

  function afterStreamingFramePaint() {
    scrollConversationToBottomIfPinned("auto");
  }

  async function runLocalSmokeTest() {
    setSmokeTestRunning(true);
    setSmokeTestError(null);
    setComputerCardCollapsed(false);
    try {
      const snapshot =
        await coreBridge.runLocalComputerSmokeTest(computerSessionId);
      setComputerSession(mapCoreComputerSession(snapshot));
      await onRuntimeChanged();
    } catch (error) {
      setSmokeTestError(describeBridgeError(error));
    } finally {
      setSmokeTestRunning(false);
    }
  }

  async function runPromptPlanNextStep() {
    setPlanStepRunning(true);
    setPlanStepError(null);
    setComputerCardCollapsed(false);
    try {
      const result = await coreBridge.runPromptPlanReadySteps(
        computerSessionId,
        4,
      );
      const snapshot = await coreBridge.localComputerSession(computerSessionId);
      if (snapshot) {
        setComputerSession(mapCoreComputerSession(snapshot));
      }
      await onRuntimeChanged();
      await onThreadChanged();
    } catch (error) {
      setPlanStepError(describeBridgeError(error));
    } finally {
      setPlanStepRunning(false);
    }
  }

  async function runComputerControl(
    action: (sessionId: string) => Promise<CoreComputerSessionSnapshot>,
  ) {
    setComputerControlBusy(true);
    setComputerControlError(null);
    try {
      const snapshot = await action(computerSessionId);
      setComputerSession(mapCoreComputerSession(snapshot));
    } catch (error) {
      setComputerControlError(describeBridgeError(error));
    } finally {
      setComputerControlBusy(false);
    }
  }

  async function submitPrompt(
    prompt: string,
    attachments: ChatAttachmentInput[],
    visibleAttachments?: ChatAttachment[],
    visibleText?: string,
  ) {
    const text = prompt.trim();
    if (!text) return;
    const userVisibleText = (visibleText ?? text).trim();
    if (!userVisibleText) return;
    const visiblePrompt = userVisibleText === text ? undefined : userVisibleText;

    setPromptSubmitting(true);
    setPromptError(null);
    const userMessage: ChatMessage = {
      id: `local_user_${Date.now()}`,
      role: "user",
      text: userVisibleText,
      timestamp: currentTimestampSeconds(),
      attachments: visibleAttachments ?? attachments.map(toMessageAttachment),
    };
    const promptMessages = [...threadMessages, userMessage];
    const requestId = `chat_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setStreamStatus({
      requestId,
      phase: "accepted",
      title: "Prompt ricevuto",
      detail: "Preparo la richiesta per il modello locale.",
    });
    setOptimisticMessages(promptMessages);
    const streamingMessage: ChatMessage = {
      id: `local_assistant_${Date.now()}`,
      role: "assistant",
      text: "",
      timestamp: currentTimestampSeconds(),
      metadata: "Modello locale",
    };
    let streamedText = "";
    let streamChunks = 0;
    const streamStartedAt = performance.now();
    let unlistenStream: (() => void) | undefined;
    let cancelledLocally = false;
    const flushStreamingMessage = () => {
      streamingFrameRef.current = null;
      setOptimisticMessages([
        ...promptMessages,
        {
          ...streamingMessage,
          text: streamedText,
        },
      ]);
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      if (streamingFrameRef.current !== null) return;
      streamingFrameRef.current = window.requestAnimationFrame(flushStreamingMessage);
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
      cancelledStreamIdsRef.current.add(requestId);
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
          text: streamedText || "Risposta interrotta.",
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
      setStreamingAssistantId(streamingMessage.id);
      streamingUserPinnedRef.current = conversationBottomDistance() < 220;
      window.setTimeout(() => scrollConversationToBottomIfPinned("auto"), 0);
      cancelStreamingRequestRef.current = cancelStreamingRequest;
      unlistenStream = await coreBridge.listenChatStreamDelta((payload) => {
        if (payload.request_id !== requestId) return;
        if (cancelledStreamIdsRef.current.has(requestId)) return;
        const firstDelta = streamedText.length === 0;
        streamChunks += 1;
        streamedText += payload.delta;
        if (firstDelta) {
          setStreamStatus({
            requestId,
            phase: "writing",
            title: "L'assistente sta scrivendo",
            detail: "La risposta sta arrivando in streaming.",
          });
        }
        if (firstDelta) {
          debugStream("paint_first_delta");
        }
        setStreamHasVisibleText(true);
        scheduleStreamingMessage();
      });
      setStreamStatus({
        requestId,
        phase: "thinking",
        title: "L'assistente sta pensando",
        detail: "Costruisco il contesto locale e avvio la generazione.",
      });
      const result = await coreBridge.submitChatPromptStream(
        requestId,
        thread.threadId,
        computerSessionId,
        text,
        attachments,
        visiblePrompt,
      );
      if (cancelledStreamIdsRef.current.has(requestId)) {
        return;
      }
      streamedText = result.assistant_message.text || streamedText;
      cancelScheduledStreamingFrame();
      debugStream("paint_done_before_commit");
      if (cancelledStreamIdsRef.current.has(requestId)) {
        return;
      }
      setComputerSession(mapCoreComputerSession(result.computer_session));
      setComputerCardCollapsed(true);
      setTimelineCollapsed(!result.plan);
      const finalAssistantMessage = chatMessageFromAssistantResult(
        result,
        result.assistant_message.text || streamedText,
      );
      let finalMessages = [
        ...promptMessages,
        finalAssistantMessage,
      ];
      setOptimisticMessages(finalMessages);
      onMessagesChange(finalMessages);
      if (isLikelyIncompleteMessage(finalAssistantMessage)) {
        finalMessages = await autoContinueAssistantResponse(
          finalAssistantMessage,
          finalMessages,
        );
      }
      setOptimisticMessages(finalMessages);
      onMessagesChange(finalMessages);
      await refreshAfterChatSubmit();
      setOptimisticMessages(null);
    } catch (error) {
      cancelScheduledStreamingFrame();
      if (cancelledLocally || cancelledStreamIdsRef.current.has(requestId)) {
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
        streamingUserPinnedRef.current = false;
        setStreamingAssistantId(null);
        resetStreamingState("");
        setStreamStatus((current) =>
          current?.requestId === requestId ? null : current,
        );
        setPromptSubmitting(false);
      }
      if (cancelStreamingRequestRef.current === cancelStreamingRequest) {
        cancelStreamingRequestRef.current = null;
      }
      cancelledStreamIdsRef.current.delete(requestId);
    }
  }

  function cancelActiveStreaming() {
    cancelStreamingRequestRef.current?.();
  }

  async function refreshAfterChatSubmit() {
    try {
      await onRuntimeChanged();
      await onThreadChanged();
    } catch (error) {
      console.warn("chat read model refresh unavailable", error);
    }
  }

  function submitComposerPrompt(prompt: string, attachments: ChatAttachmentInput[]) {
    const activeReplyContext = replyContext;
    setReplyContext(null);

    if (!activeReplyContext) {
      void submitPrompt(prompt, attachments);
      return;
    }

    const promptWithReplyContext = [
      "Rispondi al messaggio citato mantenendo il contesto.",
      `Messaggio citato (${messageRoleLabel(activeReplyContext.role)}):`,
      activeReplyContext.preview,
      "",
      "Richiesta dell'utente:",
      prompt,
    ].join("\n");
    void submitPrompt(promptWithReplyContext, attachments, undefined, prompt);
  }

  async function copyMessageText(message: ChatMessage) {
    if (!message.text) return;
    await navigator.clipboard.writeText(message.text);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1_400);
  }

  function regenerateAssistantResponse(messageId: string) {
    if (promptSubmitting) return;
    const previousUserMessage = findPreviousUserMessage(threadMessages, messageId);
    if (!previousUserMessage) {
      setPromptError("Non trovo il prompt precedente da rigenerare.");
      return;
    }
    void submitPrompt(previousUserMessage.text, [], previousUserMessage.attachments ?? []);
  }

  function replyToMessage(message: ChatMessage) {
    if (!message.text) return;
    setReplyContext({
      messageId: message.id,
      role: message.role,
      preview: createReplyPreview(message.text),
    });
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

  async function createTaskFromMessage(message: ChatMessage) {
    if (message.role !== "assistant" || message.linkedTaskId) return;
    const optimisticMessages = threadMessages.map((item) =>
      item.id === message.id ? { ...item, linkedTaskId: "pending" } : item,
    );
    onMessagesChange(optimisticMessages);
    setPromptError(null);
    try {
      await coreBridge.createTaskFromChatMessage(thread.threadId, message.id);
      await onRuntimeChanged();
      await onThreadChanged();
    } catch (error) {
      onMessagesChange(threadMessages);
      setPromptError(describeBridgeError(error));
    }
  }

  async function createAutomationFromMessage(message: ChatMessage) {
    if (message.role !== "assistant" || message.linkedAutomationRef) return;
    const optimisticMessages = threadMessages.map((item) =>
      item.id === message.id ? { ...item, linkedAutomationRef: "pending" } : item,
    );
    onMessagesChange(optimisticMessages);
    setPromptError(null);
    try {
      await coreBridge.createAutomationFromChatMessage(thread.threadId, message.id);
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
      setPromptError("Non trovo la risposta da continuare.");
      return;
    }
    const continuationPrompt =
      "Continua la risposta precedente dal punto in cui si e' interrotta. Non ripetere parti gia' scritte. Mantieni la stessa lingua e lo stesso formato.";
    void submitPrompt(continuationPrompt, [], [], "Continua");
  }

  async function autoContinueAssistantResponse(
    assistantMessage: ChatMessage,
    baseMessages: ChatMessage[],
  ) {
    const maxAutoContinuations = 2;
    let currentMessages = baseMessages;
    let currentMessage = assistantMessage;

    for (
      let attempt = 0;
      attempt < maxAutoContinuations && isLikelyIncompleteMessage(currentMessage);
      attempt += 1
    ) {
      setAutoContinueMessageId(currentMessage.id);
      try {
        currentMessages = await streamContinuationIntoMessage(
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
        setPromptError(`Continuazione automatica non completata: ${describeBridgeError(error)}`);
        break;
      } finally {
        setAutoContinueMessageId(null);
      }
    }

    return currentMessages;
  }

  async function streamContinuationIntoMessage(
    message: ChatMessage,
    baseMessages: ChatMessage[],
    attempt: number,
  ) {
    const requestId = `chat_stream_continue_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let streamedText = message.text;
    let unlistenStream: (() => void) | undefined;
    let cancelledLocally = false;
    const flushStreamingMessage = () => {
      streamingFrameRef.current = null;
      setOptimisticMessages(
        baseMessages.map((item) =>
          item.id === message.id ? { ...item, text: streamedText } : item,
        ),
      );
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      if (streamingFrameRef.current !== null) return;
      streamingFrameRef.current = window.requestAnimationFrame(flushStreamingMessage);
    };
    const cancelStreamingRequest = () => {
      cancelledLocally = true;
      cancelledStreamIdsRef.current.add(requestId);
      void coreBridge.cancelChatPromptStream(requestId).catch(() => undefined);
      unlistenStream?.();
      cancelScheduledStreamingFrame();
    };

    setStreamingAssistantId(message.id);
    resetStreamingState(message.text);
    streamingUserPinnedRef.current = conversationBottomDistance() < 220;
    window.setTimeout(() => scrollConversationToBottomIfPinned("auto"), 0);
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: "Continuo la risposta",
      detail: `La generazione era arrivata al limite. Proseguo automaticamente (${attempt}).`,
    });
    cancelStreamingRequestRef.current = cancelStreamingRequest;
    unlistenStream = await coreBridge.listenChatStreamDelta((payload) => {
      if (payload.request_id !== requestId) return;
      if (cancelledStreamIdsRef.current.has(requestId)) return;
      const firstDelta = streamedText.length === message.text.length;
      streamedText += payload.delta;
      if (firstDelta) {
        setStreamStatus({
          requestId,
          phase: "writing",
          title: "L'assistente sta continuando",
          detail: "Sto completando la risposta nello stesso messaggio.",
        });
      }
      setStreamHasVisibleText(true);
      scheduleStreamingMessage();
    });

    try {
      const result = await coreBridge.continueChatMessageStream(
        requestId,
        thread.threadId,
        message.id,
        computerSessionId,
        message.text,
      );
      if (cancelledStreamIdsRef.current.has(requestId)) {
        return baseMessages;
      }
      streamedText = result.assistant_message.text || streamedText;
      cancelScheduledStreamingFrame();
      const updatedMessage = chatMessageFromAssistantResult(result, streamedText);
      const nextMessages = baseMessages.map((item) =>
        item.id === message.id ? updatedMessage : item,
      );
      setComputerSession(mapCoreComputerSession(result.computer_session));
      setComputerCardCollapsed(true);
      setTimelineCollapsed(!result.plan);
      setOptimisticMessages(nextMessages);
      onMessagesChange(nextMessages);
      return nextMessages;
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      streamingUserPinnedRef.current = false;
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) =>
        current?.requestId === requestId ? null : current,
      );
      if (cancelStreamingRequestRef.current === cancelStreamingRequest) {
        cancelStreamingRequestRef.current = null;
      }
      cancelledStreamIdsRef.current.delete(requestId);
    }
  }

  function expandAssistantResponse(messageId: string) {
    askAboutAssistantResponse(
      messageId,
      "Approfondisci",
      "Approfondisci la risposta precedente con dettagli utili, senza ripetere l'intera risposta.",
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
      setPromptError("Non trovo la risposta precedente.");
      return;
    }
    const followUpPrompt = [
      instruction,
      "Mantieni la stessa lingua dell'utente.",
      "",
      "Risposta precedente:",
      message.text,
    ].join("\n");
    void submitPrompt(followUpPrompt, [], [], visibleText);
  }

  useEffect(() => {
    let cancelled = false;
    setComputerSession(createLoadingComputerSession(computerSessionId));
    setPreviewDataUrl(null);

    async function loadLocalComputerSession() {
      try {
        const snapshot = await coreBridge.localComputerSession(computerSessionId);
        if (cancelled) return;
        setComputerSession(
          snapshot
            ? mapCoreComputerSession(snapshot)
            : createUnavailableComputerSession(
                computerSessionId,
                "Nessuna sessione computer trovata nel core locale.",
              ),
        );
      } catch (error) {
        if (cancelled) return;
        setComputerSession(
          createUnavailableComputerSession(
            computerSessionId,
            describeBridgeError(error),
          ),
        );
      }
    }

    void loadLocalComputerSession();
    const interval = window.setInterval(loadLocalComputerSession, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [computerSessionId]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    streamingUserPinnedRef.current = false;
    window.setTimeout(() => scrollConversationToBottom("auto"), 0);
  }, [thread.threadId]);

  useEffect(() => {
    let cancelled = false;
    const artifactId = computerSession.previewArtifactId;
    if (!artifactId || computerSession.source !== "core") {
      setPreviewDataUrl(null);
      return () => {
        cancelled = true;
      };
    }
    const previewArtifactId = artifactId;

    async function loadPreview() {
      try {
        const preview = await coreBridge.localComputerArtifactPreview(
          computerSession.id,
          previewArtifactId,
        );
        if (!cancelled) {
          setPreviewDataUrl(preview?.data_url ?? null);
        }
      } catch {
        if (!cancelled) {
          setPreviewDataUrl(null);
        }
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [computerSession.id, computerSession.previewArtifactId, computerSession.source]);

  useEffect(() => {
    if (
      !computerSession.surfaces.some((surface) => surface.id === activeSurface)
    ) {
      setActiveSurface(computerSession.activeSurface);
    }
  }, [activeSurface, computerSession.activeSurface, computerSession.surfaces]);

  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return undefined;
    const scrollNode = node;

    function updateStickToBottom() {
      const bottomDistance = conversationBottomDistance();
      shouldStickToBottomRef.current = bottomDistance < 140;
      if (streamingUserPinnedRef.current && bottomDistance > 160) {
        streamingUserPinnedRef.current = false;
      }
    }

    updateStickToBottom();
    scrollNode.addEventListener("scroll", updateStickToBottom, { passive: true });
    return () => scrollNode.removeEventListener("scroll", updateStickToBottom);
  }, []);

  useEffect(() => {
    const handleResize = () => scrollConversationToBottomIfPinned("auto");
    const behavior: ScrollBehavior = streamingAssistantId ? "auto" : "smooth";

    const frame = window.requestAnimationFrame(() =>
      scrollConversationToBottomIfPinned(behavior),
    );
    const timeout = streamingAssistantId
      ? undefined
      : window.setTimeout(() => scrollConversationToBottomIfPinned("smooth"), 120);
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      window.removeEventListener("resize", handleResize);
    };
  }, [
    threadMessages,
    detailsOpen,
    streamingAssistantId,
  ]);

  return (
    <section className="chat-view active-task-layout" aria-labelledby="chat-title">
      <header className="task-topbar">
        <div className="task-title-area">
          <button
            className="task-title-button"
            type="button"
            onClick={() => setModelOpen((value) => !value)}
          >
            <span id="chat-title">{thread.title}</span>
            <ChevronDown size={15} />
          </button>
          {modelOpen && (
            <div className="floating-menu model-menu" role="menu">
              <button type="button">
                <Sparkles size={15} />
                Modello locale
                <span>attivo</span>
              </button>
              <button type="button">
                <HardDrive size={15} />
                Solo strumenti locali
                <span>default</span>
              </button>
            </div>
          )}
        </div>

        <div className="task-top-actions">
          {activeHealth.map((item) => (
            <span className={`status-pill ${item.status}`} key={item.label}>
              {item.label}
            </span>
          ))}
          <button
            className="top-action"
            type="button"
            onClick={() => setShareOpen((value) => !value)}
          >
            <Share2 size={15} />
            Condividi
          </button>
          <button className="icon-button" type="button" aria-label="Altre azioni">
            <MoreHorizontal size={18} />
          </button>
          {shareOpen && (
            <div className="floating-menu share-menu" role="menu">
              <strong>Condivisione</strong>
              <button type="button">Solo io</button>
              <button type="button">Esporta riepilogo redatto</button>
              <button type="button">Crea link locale</button>
            </div>
          )}
        </div>
      </header>

      <div className="thread-scroll" aria-label="Thread attivo" ref={conversationRef}>
        <div className="thread-content">
          <div className="thread-message-list">
          {threadMessages.map((message) => {
            const isStreamingMessage = message.id === streamingAssistantId;
            const displayMessage = message;
            const contentKind = messageContentKind(displayMessage);
            const assistantTextMessage =
              displayMessage.role === "assistant" && contentKind === "text";
            const assistantMessage = displayMessage.role === "assistant";
            const assistantOperationalMessage =
              displayMessage.role === "assistant" && contentKind !== "system";
            const incompleteMessage = isLikelyIncompleteMessage(displayMessage);

            return (
            <div
              className="thread-message-row"
              key={displayMessage.id}
            >
            <article className={`message ${displayMessage.role}`}>
              {displayMessage.role !== "user" && (
                <header
                  className={`assistant-label ${displayMessage.role === "system" ? "system-label" : ""}`}
                >
                  {displayMessage.role === "system" ? (
                    <Clock3 size={15} />
                  ) : (
                    <Sparkles size={17} />
                  )}
                  <strong>{displayMessage.role === "system" ? "stato" : "assistant"}</strong>
                  <span>{displayMessage.role === "system" ? "Sistema" : "Assistente"}</span>
                </header>
              )}
              {isStreamingMessage ? (
                <>
                  {!streamHasVisibleText && (
                    <AssistantThinkingState status={streamStatus} />
                  )}
                  {displayMessage.text && (
                    <RichMessage text={displayMessage.text} streaming />
                  )}
                </>
              ) : displayMessage.text ? (
                <AssistantMessageBody
                  text={displayMessage.text}
                  messageId={displayMessage.id}
                  threadId={thread.threadId}
                />
              ) : (
                <AssistantThinkingState
                  status={
                    isStreamingMessage ? streamStatus : null
                  }
                />
              )}
              {displayMessage.text && !isStreamingMessage && (
                <>
                {assistantMessage && incompleteMessage && (
                  <div className="message-incomplete-note" role="note">
                    Risposta probabilmente interrotta. Puoi continuare la generazione.
                  </div>
                )}
                {autoContinueMessageId === displayMessage.id && (
                  <div className="auto-continue-status" role="status" aria-live="polite">
                    <Sparkles size={14} />
                    <span>Sto completando automaticamente questa risposta.</span>
                  </div>
                )}
                <MessageActionBar
                  contentKind={contentKind}
                  copied={copiedMessageId === displayMessage.id}
                  canContinue={
                    assistantMessage && Boolean(displayMessage.text) && incompleteMessage
                  }
                  canRegenerate={
                    displayMessage.role === "assistant" &&
                    Boolean(findPreviousUserMessage(threadMessages, displayMessage.id))
                  }
                  canReply={displayMessage.role !== "system" && Boolean(displayMessage.text)}
                  canCreateAutomation={assistantTextMessage}
                  canCreateTask={assistantTextMessage}
                  canExpand={assistantTextMessage}
                  canSaveToMemory={assistantOperationalMessage}
                  feedback={displayMessage.feedback}
                  linkedAutomation={Boolean(displayMessage.linkedAutomationRef)}
                  linkedTask={Boolean(displayMessage.linkedTaskId)}
                  metrics={displayMessage.metrics}
                  savedToMemory={Boolean(displayMessage.savedMemoryRef)}
                  onCopy={() => copyMessageText(displayMessage)}
                  onContinue={() => continueAssistantResponse(displayMessage.id)}
                  onCreateAutomation={() => void createAutomationFromMessage(displayMessage)}
                  onCreateTask={() => void createTaskFromMessage(displayMessage)}
                  onExpand={() => expandAssistantResponse(displayMessage.id)}
                  onExplainCode={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Spiega codice",
                      "Spiega il codice precedente in modo breve e operativo.",
                    )
                  }
                  onExplainDiagram={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Spiega diagramma",
                      "Spiega il diagramma precedente in modo breve e operativo.",
                    )
                  }
                  onFeedback={(feedback) => void setMessageFeedback(displayMessage, feedback)}
                  onImproveCode={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Migliora codice",
                      "Migliora il codice precedente mantenendolo breve e includendo un blocco markdown fenced.",
                    )
                  }
                  onReply={() => replyToMessage(displayMessage)}
                  onRegenerate={() => regenerateAssistantResponse(displayMessage.id)}
                  onReviseDiagram={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Modifica diagramma",
                      "Proponi una versione migliorata del diagramma precedente in un blocco markdown fenced mermaid.",
                    )
                  }
                  onSaveToMemory={() => void saveMessageToMemory(displayMessage)}
                />
                </>
              )}
              {displayMessage.attachments && displayMessage.attachments.length > 0 && (
                <MessageAttachmentList attachments={displayMessage.attachments} />
              )}
              <footer>
                <span>{formatMessageTimestamp(displayMessage.timestamp)}</span>
                {visibleMessageMetadata(displayMessage.metadata) && (
                  <span>{visibleMessageMetadata(displayMessage.metadata)}</span>
                )}
              </footer>
            </article>
            </div>
            );
          })}
          </div>

          {promptSubmitting && !streamingAssistantId && (
            <article className="message assistant pending" aria-live="polite">
              <header className="assistant-label">
                <Sparkles size={17} />
                <strong>assistant</strong>
                <span>Assistente</span>
              </header>
              <AssistantThinkingState status={streamStatus} />
            </article>
          )}

          {showComputerActivity && (
            <OperationalPlanPreview
              collapsed={timelineCollapsed}
              markdown={visibleComputerSession.operationalPlanMarkdown}
            />
          )}

          {showComputerActivity && (
            <InlineTimeline
              collapsed={timelineCollapsed}
              onToggle={() => setTimelineCollapsed((current) => !current)}
              session={visibleComputerSession}
            />
          )}

          <InlineApprovalPanel
            approvals={activeApprovals}
            busyId={approvalBusyId}
            session={visibleComputerSession}
            onApprove={onApproveApproval}
            onReject={onRejectApproval}
          />

          {showComputerActivity && (
            <LocalComputerCard
              approvalsCount={activeApprovals.length}
              collapsed={computerCardCollapsed}
              smokeTestError={smokeTestError}
              smokeTestRunning={smokeTestRunning}
              planStepError={planStepError}
              planStepRunning={planStepRunning}
              previewDataUrl={previewDataUrl}
              session={visibleComputerSession}
              task={task}
              onOpen={() => setDetailsOpen(true)}
              onOpenTasks={onOpenTasks}
              onRunPlanStep={runPromptPlanNextStep}
              onRunSmokeTest={runLocalSmokeTest}
              onToggleCollapsed={() =>
                setComputerCardCollapsed((current) => !current)
              }
            />
          )}
        </div>
      </div>

      {detailsOpen && (
        <ComputerDetailPanel
          activeSurface={activeSurface}
          controlBusy={computerControlBusy}
          controlError={computerControlError}
          onClose={() => setDetailsOpen(false)}
          onPause={() => runComputerControl(coreBridge.pauseLocalComputerSession)}
          onResume={() => runComputerControl(coreBridge.resumeLocalComputerSession)}
          onSelectSurface={setActiveSurface}
          onTakeover={() => runComputerControl(coreBridge.requestLocalComputerTakeover)}
          previewDataUrl={previewDataUrl}
          session={computerSession}
        />
      )}

      <ChatComputerPanel />

      <Composer
        disabled={promptSubmitting}
        error={promptError}
        replyContext={replyContext}
        streaming={promptSubmitting}
        onCancelStreaming={cancelActiveStreaming}
        onClearReply={() => setReplyContext(null)}
        onSubmit={submitComposerPrompt}
      />
    </section>
  );
}

function AssistantThinkingState({ status }: { status: ChatStreamStatus | null }) {
  return (
    <div className="assistant-thinking-state" aria-live="polite">
      <div
        className={`thinking-status-dot ${status?.phase ?? "accepted"}`}
        aria-hidden="true"
      >
        <span />
      </div>
      <div>
        <strong>{status?.title ?? "L'assistente sta rispondendo"}</strong>
        <span>
          {status?.detail ?? "Attendo il primo token dal runtime locale."}
        </span>
      </div>
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function describeBridgeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Gateway locale non raggiungibile in questa visualizzazione.";
  }

  if (error.message.includes("Gateway")) {
    return "Gateway locale non ancora disponibile: uso il runtime locale diretto quando possibile.";
  }

  return error.message;
}

function chatMessageFromAssistantResult(
  result: CorePromptSubmissionResult,
  fallbackText: string,
): ChatMessage {
  return {
    id: result.assistant_message.id,
    role: result.assistant_message.role,
    text: result.assistant_message.text || fallbackText,
    timestamp: result.assistant_message.timestamp,
    metadata: result.assistant_message.metadata ?? undefined,
    metrics: result.assistant_message.metrics
      ? {
          promptTokens: result.assistant_message.metrics.prompt_tokens,
          generationTokens: result.assistant_message.metrics.generation_tokens,
          promptTps: result.assistant_message.metrics.prompt_tps,
          generationTps: result.assistant_message.metrics.generation_tps,
          peakMemoryGb: result.assistant_message.metrics.peak_memory_gb,
          elapsedSeconds: result.assistant_message.metrics.elapsed_seconds,
          maxTokens: result.assistant_message.metrics.max_tokens,
          promptBuildSeconds:
            result.assistant_message.metrics.prompt_build_seconds ?? undefined,
          timeToFirstTokenSeconds:
            result.assistant_message.metrics.time_to_first_token_seconds ?? undefined,
          totalElapsedSeconds:
            result.assistant_message.metrics.total_elapsed_seconds ?? undefined,
          runtimeStatusBefore:
            result.assistant_message.metrics.runtime_status_before ?? undefined,
        }
      : undefined,
  };
}

function visibleMessageMetadata(metadata: string | undefined) {
  if (!metadata) return undefined;
  const hidden = new Set([
    "Electron core locale",
    "Inviato al core locale",
    "Non salvato come payload raw",
  ]);
  return hidden.has(metadata) ? undefined : metadata;
}

function messageContentKind(message: ChatMessage): MessageContentKind {
  if (message.role === "user") return "user";
  if (message.role === "system") return "system";
  if (hasMermaidContent(message.text)) return "diagram";
  if (hasCodeContent(message.text)) return "code";
  return "text";
}

function hasMermaidContent(text: string) {
  return /```mermaid[\s\S]*?```/i.test(text);
}

function hasCodeContent(text: string) {
  return (
    /```[\w-]*[\s\S]*?```/.test(text) ||
    /^fn\s+[a-zA-Z_]\w*\s*\([^)]*\)\s*\{?/m.test(text) ||
    /^use\s+[\w:]+/m.test(text) ||
    /^let\s+(mut\s+)?[a-zA-Z_]\w*/m.test(text) ||
    /^println!\s*\(/m.test(text)
  );
}

function isLikelyIncompleteMessage(message: ChatMessage) {
  const metrics = message.metrics;
  if (
    metrics &&
    metrics.maxTokens > 0 &&
    metrics.generationTokens >= Math.floor(metrics.maxTokens * 0.96)
  ) {
    return true;
  }
  const trimmed = message.text.trim();
  if (!trimmed) return false;
  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) return true;
  if (/[({[]$/.test(trimmed)) return true;
  if (/(^|\n)\s*\d+\.\s+\*\*[^*\n]*$/.test(trimmed)) return true;
  return false;
}

function createReplyPreview(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function messageRoleLabel(role: ChatMessage["role"]) {
  if (role === "assistant") return "assistant";
  if (role === "system") return "stato";
  return "utente";
}

function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

function formatMessageTimestamp(timestamp: string) {
  if (!/^\d+$/.test(timestamp)) {
    return timestamp;
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

function formatMetricSeconds(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value < 0.01) return "<0,01s";
  if (value < 10) return `${value.toFixed(2).replace(".", ",")}s`;
  return `${value.toFixed(1).replace(".", ",")}s`;
}

function formatRuntimeStatus(status: string | undefined) {
  if (!status) return "-";
  const labels: Record<string, string> = {
    configured: "configurato",
    managed_running: "caldo",
    external_running: "esterno",
    ready: "pronto",
    unhealthy: "non sano",
    duplicate_conflict: "duplicato",
    stopped: "spento",
  };
  return labels[status] ?? status.replace(/_/g, " ");
}

function MessageActionBar({
  canContinue,
  canCreateAutomation,
  canCreateTask,
  canExpand,
  canRegenerate,
  canReply,
  canSaveToMemory,
  contentKind,
  copied,
  feedback,
  linkedAutomation,
  linkedTask,
  metrics,
  savedToMemory,
  onCopy,
  onContinue,
  onCreateAutomation,
  onCreateTask,
  onExpand,
  onExplainCode,
  onExplainDiagram,
  onFeedback,
  onImproveCode,
  onReply,
  onRegenerate,
  onReviseDiagram,
  onSaveToMemory,
}: {
  canContinue: boolean;
  canCreateAutomation: boolean;
  canCreateTask: boolean;
  canExpand: boolean;
  canRegenerate: boolean;
  canReply: boolean;
  canSaveToMemory: boolean;
  contentKind: MessageContentKind;
  copied: boolean;
  feedback: ChatMessage["feedback"];
  linkedAutomation: boolean;
  linkedTask: boolean;
  metrics?: ChatMessageMetrics;
  savedToMemory: boolean;
  onCopy: () => void;
  onContinue: () => void;
  onCreateAutomation: () => void;
  onCreateTask: () => void;
  onExpand: () => void;
  onExplainCode: () => void;
  onExplainDiagram: () => void;
  onFeedback: (feedback: MessageFeedback) => void;
  onImproveCode: () => void;
  onReply: () => void;
  onRegenerate: () => void;
  onReviseDiagram: () => void;
  onSaveToMemory: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] =
    useState<MessageActionMenuPlacement>("below");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const showMoreMenu =
    canExpand ||
    canRegenerate ||
    canSaveToMemory ||
    canCreateTask ||
    canCreateAutomation ||
    contentKind === "code" ||
    contentKind === "diagram";

  useEffect(() => {
    if (!menuOpen) return undefined;

    function updatePlacement() {
      setMenuPlacement(resolveMessageActionMenuPlacement(menuButtonRef.current));
    }

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [menuOpen]);

  function toggleMoreMenu() {
    setMenuOpen((current) => {
      const next = !current;
      if (next) {
        setMenuPlacement(resolveMessageActionMenuPlacement(menuButtonRef.current));
      }
      return next;
    });
  }

  return (
    <div className="message-action-bar" aria-label="Azioni messaggio">
      {canReply && (
        <button type="button" onClick={onReply} aria-label="Rispondi al messaggio">
          <Reply size={14} />
          <span>Rispondi</span>
        </button>
      )}
      <button type="button" onClick={onCopy} aria-label="Copia messaggio">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? "Copiato" : "Copia"}</span>
      </button>
      {canContinue && (
        <button
          className="primary-continue-action"
          type="button"
          onClick={onContinue}
          aria-label="Continua risposta"
        >
          <Play size={14} />
          <span>Continua</span>
        </button>
      )}
      {showMoreMenu && (
        <div className="message-action-menu-wrap">
          <button
            ref={menuButtonRef}
            type="button"
            aria-expanded={menuOpen}
            aria-label="Altre azioni messaggio"
            onClick={toggleMoreMenu}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className={`message-action-menu ${menuPlacement}`} role="menu">
              {canExpand && (
                <button type="button" role="menuitem" onClick={onExpand}>
                  <Play size={14} />
                  <span>Approfondisci</span>
                </button>
              )}
              {contentKind === "code" && (
                <>
                  <button type="button" role="menuitem" onClick={onExplainCode}>
                    <SquareTerminal size={14} />
                    <span>Spiega codice</span>
                  </button>
                  <button type="button" role="menuitem" onClick={onImproveCode}>
                    <WandSparkles size={14} />
                    <span>Migliora codice</span>
                  </button>
                </>
              )}
              {contentKind === "diagram" && (
                <>
                  <button type="button" role="menuitem" onClick={onExplainDiagram}>
                    <FileText size={14} />
                    <span>Spiega diagramma</span>
                  </button>
                  <button type="button" role="menuitem" onClick={onReviseDiagram}>
                    <WandSparkles size={14} />
                    <span>Modifica diagramma</span>
                  </button>
                </>
              )}
              {canRegenerate && (
                <button type="button" role="menuitem" onClick={onRegenerate}>
                  <RotateCcw size={14} />
                  <span>Rigenera</span>
                </button>
              )}
              {canSaveToMemory && (
                <button
                  className={savedToMemory ? "active" : ""}
                  type="button"
                  role="menuitem"
                  onClick={onSaveToMemory}
                >
                  <BookMarked size={14} />
                  <span>{savedToMemory ? "Salvato in memoria" : "Salva in memoria"}</span>
                </button>
              )}
              {canCreateTask && (
                <button
                  className={linkedTask ? "active" : ""}
                  type="button"
                  role="menuitem"
                  onClick={onCreateTask}
                >
                  <ListTodo size={14} />
                  <span>{linkedTask ? "Task creato" : "Crea task"}</span>
                </button>
              )}
              {canCreateAutomation && (
                <button
                  className={linkedAutomation ? "active" : ""}
                  type="button"
                  role="menuitem"
                  onClick={onCreateAutomation}
                >
                  <WandSparkles size={14} />
                  <span>{linkedAutomation ? "Automazione proposta" : "Crea automazione"}</span>
                </button>
              )}
              <div className="message-action-menu-feedback" aria-label="Feedback risposta">
                <button
                  className={feedback === "useful" ? "active" : ""}
                  type="button"
                  onClick={() => onFeedback("useful")}
                  aria-label="Segna risposta utile"
                >
                  <ThumbsUp size={14} />
                </button>
                <button
                  className={feedback === "not_useful" ? "active" : ""}
                  type="button"
                  onClick={() => onFeedback("not_useful")}
                  aria-label="Segna risposta non utile"
                >
                  <ThumbsDown size={14} />
                </button>
              </div>
              {metrics && (
                <div
                  className="message-latency-summary"
                  aria-label="Metriche prestazioni messaggio"
                >
                  <strong>Prestazioni</strong>
                  <span>
                    Tempo al primo token
                    <b>{formatMetricSeconds(metrics.timeToFirstTokenSeconds)}</b>
                  </span>
                  <span>
                    Generazione
                    <b>{formatMetricSeconds(metrics.elapsedSeconds)}</b>
                  </span>
                  <span>
                    Totale
                    <b>{formatMetricSeconds(metrics.totalElapsedSeconds)}</b>
                  </span>
                  <span>
                    Prompt build
                    <b>{formatMetricSeconds(metrics.promptBuildSeconds)}</b>
                  </span>
                  <span>
                    Runtime prima
                    <b>{formatRuntimeStatus(metrics.runtimeStatusBefore)}</b>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type MessageActionMenuPlacement = "above" | "below";

const MESSAGE_ACTION_MENU_MIN_BOTTOM_SPACE = 300;

function resolveMessageActionMenuPlacement(
  anchor: HTMLElement | null,
): MessageActionMenuPlacement {
  if (!anchor) return "below";

  const rect = anchor.getBoundingClientRect();
  const scrollContainer = anchor.closest(".thread-scroll");
  const visibleBottom =
    scrollContainer instanceof HTMLElement
      ? scrollContainer.getBoundingClientRect().bottom
      : window.innerHeight;
  const spaceBelow = visibleBottom - rect.bottom;
  const spaceAbove = rect.top;

  if (
    spaceBelow < MESSAGE_ACTION_MENU_MIN_BOTTOM_SPACE &&
    spaceAbove > spaceBelow
  ) {
    return "above";
  }

  return "below";
}

function findPreviousUserMessage(
  messages: ChatMessage[],
  messageId: string,
): ChatMessage | undefined {
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  if (messageIndex <= 0) return undefined;

  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index];
    }
  }

  return undefined;
}

function isLatestAssistantMessage(messages: ChatMessage[], messageId: string) {
  const latestAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && Boolean(message.text));
  return latestAssistant?.id === messageId;
}

function MessageAttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="message-attachment-list" aria-label="Allegati del messaggio">
      {attachments.map((attachment) => (
        <span className="message-attachment-chip" key={attachment.artifactId}>
          <Paperclip size={13} />
          <span>{attachment.title}</span>
          <small>
            {attachment.kind} · {formatFileSize(attachment.sizeBytes)}
          </small>
        </span>
      ))}
    </div>
  );
}

function toMessageAttachment(attachment: ChatAttachmentInput): ChatAttachment {
  return {
    artifactId: `pending_${attachment.displayName}_${attachment.sizeBytes}`,
    title: attachment.displayName,
    kind: attachmentKindFromMime(attachment.mimeType),
    sizeBytes: attachment.sizeBytes,
    previewAvailable: attachment.mimeType.startsWith("image/"),
    privacyDomain: "local_files",
  };
}

function isUserVisibleComputerEvent(item: ComputerSession["timeline"][number]) {
  return item.title !== "Sessione locale pronta" && item.id !== "bridge-unavailable";
}

type OperationalPlanItem = {
  detail: string;
  id: string;
  status: "done" | "running" | "waiting" | "blocked";
  title: string;
};

function OperationalPlanPreview({
  collapsed,
  markdown,
}: {
  collapsed: boolean;
  markdown?: string;
}) {
  const items = useMemo(() => parseOperationalPlanItems(markdown), [markdown]);
  if (!markdown || items.length === 0) {
    return null;
  }

  const blocked = items.filter((item) => item.status === "blocked");
  const completed = items.filter((item) => item.status === "done");
  const running = items.filter((item) => item.status === "running");
  const visibleItems = collapsed
    ? planPreviewItems(items, blocked)
    : items;

  return (
    <section className="operational-plan-preview" aria-label="Piano operativo">
      <header>
        <span>
          <ListTodo size={16} />
          <strong>Piano operativo</strong>
        </span>
        <small>
          {completed.length} completati
          {running.length ? ` · ${running.length} in corso` : ""}
          {blocked.length ? ` · ${blocked.length} bloccati` : ""}
        </small>
      </header>
      <div className="operational-plan-steps">
        {visibleItems.map((item) => (
          <div className={`operational-plan-step ${item.status}`} key={item.id}>
            <span className="timeline-state">
              {item.status === "done" ? <Check size={12} /> : <Clock3 size={12} />}
            </span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function parseOperationalPlanItems(markdown?: string): OperationalPlanItem[] {
  if (!markdown) return [];
  return markdown
    .split("\n")
    .map((line) => {
      const match = line.match(
        /^- \[([ x!\-])\] \*\*(.*?)\*\*(?: `[^`]+`)? \(`([^`]+)`\): (.*)$/,
      );
      if (!match) return null;
      return {
        status: planMarkerToStatus(match[1]),
        title: match[2],
        id: match[3],
        detail: match[4],
      } satisfies OperationalPlanItem;
    })
    .filter((item): item is OperationalPlanItem => item !== null);
}

function planMarkerToStatus(marker: string): OperationalPlanItem["status"] {
  if (marker === "x") return "done";
  if (marker === "-") return "running";
  if (marker === "!") return "blocked";
  return "waiting";
}

function planPreviewItems(
  items: OperationalPlanItem[],
  blocked: OperationalPlanItem[],
) {
  const importantIds = new Set([
    "source_trovatreno_extract",
    "source_trenitalia_extract",
    "source_italo_fill",
    "consolidate_options",
    "answer_and_next_gate",
  ]);
  const important = items.filter((item) => importantIds.has(item.id));
  const merged = [...blocked, ...important];
  const seen = new Set<string>();
  return merged
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, 5);
}

function InlineTimeline({
  collapsed,
  onToggle,
  session,
}: {
  collapsed: boolean;
  onToggle: () => void;
  session: ComputerSession;
}) {
  if (session.timeline.length === 0) {
    return null;
  }

  const visibleTimeline = collapsed ? session.timeline.slice(-2) : session.timeline;

  return (
    <div
      className={`inline-timeline ${collapsed ? "timeline-collapsed" : ""}`}
      aria-label="Avanzamento attività"
    >
      <div className="timeline-header">
        <div>
          <strong>Attività computer</strong>
          <span>
            {session.progressCurrent} / {session.progressTotal}
          </span>
        </div>
        <button
          className="timeline-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span>{collapsed ? "Mostra dettagli" : "Nascondi"}</span>
          <ChevronDown
            className={collapsed ? "" : "timeline-toggle-icon-open"}
            size={15}
          />
        </button>
      </div>
      {visibleTimeline.map((item) => {
        const Icon = surfaceIcons[item.surface];
        return (
          <div className={`timeline-step ${item.status}`} key={item.id}>
            <span className="timeline-state">
              {item.status === "done" ? <Check size={12} /> : <Clock3 size={12} />}
            </span>
            <div>
              <strong>{item.title}</strong>
              <small>
                <Icon size={13} />
                {item.detail}
              </small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A pending write action the model proposed, carried in the message text. */
interface ComposioPendingAction {
  tool: string;
  arguments: unknown;
}

const COMPOSIO_CONFIRM_RE = /‹‹COMPOSIO_CONFIRM››([\s\S]*?)‹‹\/COMPOSIO_CONFIRM››/;
const COMPOSIO_DONE_RE = /‹‹COMPOSIO_DONE››([\s\S]*?)‹‹\/COMPOSIO_DONE››/;
const COMPOSIO_MARKERS_RE = /‹‹COMPOSIO_(?:CONFIRM|DONE)››[\s\S]*?‹‹\/COMPOSIO_(?:CONFIRM|DONE)››/g;

/** Splits an assistant message into visible text + an optional pending write
 *  action (editable card) OR an already-executed marker (static "done" note). */
function parseComposioConfirm(text: string): {
  visible: string;
  action: ComposioPendingAction | null;
  doneTool: string | null;
} {
  let action: ComposioPendingAction | null = null;
  const confirm = text.match(COMPOSIO_CONFIRM_RE);
  if (confirm) {
    try {
      const parsed = JSON.parse(confirm[1]) as ComposioPendingAction;
      if (parsed && typeof parsed.tool === "string") action = parsed;
    } catch {
      /* malformed → just hide it */
    }
  }
  const done = text.match(COMPOSIO_DONE_RE);
  const doneTool = done ? done[1].trim() : null;
  const visible = text.replace(COMPOSIO_MARKERS_RE, "").trim();
  // A persisted "done" marker wins: never reopen the editable card.
  return { visible, action: doneTool ? null : action, doneTool };
}

/** Replaces raw tool slugs (GMAIL_SEND_EMAIL) anywhere in assistant text with a
 *  human-readable name. Targets SCREAMING_SNAKE_CASE tokens, which in chat are
 *  practically always tool slugs. */
function humanizeToolSlugs(text: string): string {
  return text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (slug) => humanizeToolName(slug));
}

/** Renders an assistant message body, surfacing a write-confirmation card when
 *  the model proposed a write action that needs approval (once / always), or a
 *  static "done" note once it has been executed. */
function AssistantMessageBody({
  text,
  streaming,
  messageId,
  threadId,
}: {
  text: string;
  streaming?: boolean;
  messageId?: string;
  threadId?: string;
}) {
  const { visible, action, doneTool } = useMemo(() => parseComposioConfirm(text), [text]);
  const readable = useMemo(() => humanizeToolSlugs(visible), [visible]);
  return (
    <>
      {readable && <RichMessage text={readable} streaming={streaming} />}
      {doneTool && !streaming && (
        <div className="cmp-confirm done">
          <ShieldCheck size={15} />
          <span>Azione eseguita: {humanizeToolName(doneTool)}</span>
        </div>
      )}
      {action && !streaming && (
        <ComposioConfirmCard action={action} messageId={messageId} threadId={threadId} />
      )}
    </>
  );
}

const COMPOSIO_FIELD_LABELS: Record<string, string> = {
  recipient_email: "Destinatario",
  recipientemail: "Destinatario",
  to: "Destinatario",
  cc: "Cc",
  bcc: "Ccn",
  subject: "Oggetto",
  body: "Testo",
  message: "Testo",
  is_html: "HTML",
  attachment: "Allegato",
};

/** "GMAIL_SEND_EMAIL" → "Send email · Gmail". */
function humanizeToolName(slug: string): string {
  const parts = slug.split("_").filter(Boolean);
  if (parts.length === 0) return slug;
  const toolkit = parts[0].charAt(0) + parts[0].slice(1).toLowerCase();
  const action = parts.slice(1).map((w) => w.toLowerCase()).join(" ");
  if (!action) return toolkit;
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} · ${toolkit}`;
}

function humanizeFieldKey(key: string): string {
  return (
    COMPOSIO_FIELD_LABELS[key.toLowerCase()] ??
    key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function ComposioConfirmCard({
  action,
  messageId,
  threadId,
}: {
  action: ComposioPendingAction;
  messageId?: string;
  threadId?: string;
}) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  // Editable copy of the proposed arguments.
  const initial =
    action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments)
      ? (action.arguments as Record<string, unknown>)
      : {};
  const [args, setArgs] = useState<Record<string, unknown>>(() => ({ ...initial }));
  const title = humanizeToolName(action.tool);

  const setField = (key: string, value: unknown) =>
    setArgs((prev) => ({ ...prev, [key]: value }));

  const run = async (scope: "once" | "always") => {
    setStatus("running");
    setNote(null);
    try {
      await coreBridge.composioExecute(action.tool, args, scope, { threadId, messageId });
      setStatus("done");
      setNote(
        scope === "always"
          ? `Fatto. D'ora in poi «${title}» verrà eseguito senza chiedere.`
          : "Fatto.",
      );
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  if (status === "done") {
    return (
      <div className="cmp-confirm done">
        <ShieldCheck size={15} />
        <span>{note}</span>
      </div>
    );
  }

  const keys = Object.keys(args);
  return (
    <div className="cmp-confirm">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Conferma azione</strong>
        <span className="cmp-confirm-name">{title}</span>
      </div>
      <div className="cmp-confirm-fields">
        {keys.length === 0 && <p className="cmp-confirm-empty">Nessun parametro.</p>}
        {keys.map((key) => {
          const value = args[key];
          const label = humanizeFieldKey(key);
          if (typeof value === "boolean") {
            return (
              <label key={key} className="cmp-field-check">
                <input
                  type="checkbox"
                  checked={value}
                  disabled={status === "running"}
                  onChange={(e) => setField(key, e.target.checked)}
                />
                <span>{label}</span>
              </label>
            );
          }
          const isObject = value !== null && typeof value === "object";
          const str = isObject ? JSON.stringify(value, null, 2) : String(value ?? "");
          const multiline = isObject || str.length > 60 || /body|message|text/i.test(key);
          return (
            <div key={key} className="cmp-field">
              <label>{label}</label>
              {multiline ? (
                <textarea
                  className="set-input"
                  rows={isObject ? 4 : 5}
                  value={str}
                  disabled={status === "running"}
                  onChange={(e) => {
                    if (isObject) {
                      try {
                        setField(key, JSON.parse(e.target.value));
                      } catch {
                        setField(key, e.target.value);
                      }
                    } else {
                      setField(key, e.target.value);
                    }
                  }}
                />
              ) : (
                <input
                  className="set-input"
                  value={str}
                  disabled={status === "running"}
                  onChange={(e) => setField(key, e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {status === "error" && <p className="cmp-confirm-err">Non riuscito: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void run("once")}
        >
          {status === "running" ? "Eseguo…" : "Esegui una volta"}
        </button>
        <button
          className="set-btn"
          type="button"
          disabled={status === "running"}
          onClick={() => void run("always")}
          title={`Non chiedere più per ${title}`}
        >
          Esegui sempre
        </button>
      </div>
    </div>
  );
}

function InlineApprovalPanel({
  approvals,
  busyId,
  onApprove,
  onReject,
  session,
}: {
  approvals: ApprovalItem[];
  busyId: string | null;
  onApprove: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void;
  onReject: (approvalId: string) => void;
  session: ComputerSession;
}) {
  const approval = approvals[0];
  const scopeOptions = approval?.scopeOptions ?? ["once"];
  const browserVisibilityOptions = approval?.browserVisibilityOptions ?? [];
  const [scope, setScope] = useState<"once" | "always">(scopeOptions[0] ?? "once");
  const [browserVisibility, setBrowserVisibility] = useState<"auto" | "visible" | "headless">(
    approval?.defaultBrowserVisibility ?? "auto",
  );

  useEffect(() => {
    setScope(scopeOptions[0] ?? "once");
    setBrowserVisibility(approval?.defaultBrowserVisibility ?? "auto");
  }, [approval?.id]);

  if (!approval) {
    return null;
  }

  const waitingSteps = session.timeline
    .filter((item) => item.status === "waiting")
    .slice(0, 4);
  const summary = approval.action.startsWith("prompt_plan")
    ? "Approvi solo il prossimo passaggio del piano. Login, acquisto, invio e pagamento restano bloccati finche' non dai una conferma esplicita per quella singola azione."
    : approval.reason;
  const busy = busyId === approval.id;
  return (
    <article className="inline-approval-panel" aria-label="Conferma richiesta">
      <header>
        <span className={`approval-dot ${approval.risk}`}>
          <AlertCircle size={15} />
        </span>
        <div>
          <strong>Serve una tua conferma per continuare</strong>
          <small>{approval.risk === "high" ? "Rischio alto" : "Azione controllata"}</small>
        </div>
      </header>

      <p>{summary}</p>

      {waitingSteps.length > 0 && (
        <div className="approval-plan-preview">
          <span>Cosa sta per fare</span>
          {waitingSteps.map((step) => {
            const Icon = surfaceIcons[step.surface];
            return (
              <div key={step.id}>
                <Icon size={14} />
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </div>
            );
          })}
        </div>
      )}

      <div className="approval-safety-note">
        <ShieldCheck size={15} />
        <span>Dati raw non esposti. Nessuna operazione esterna irreversibile senza conferma.</span>
      </div>

      <div className="approval-scope-note">
        <span>Ambito conferma</span>
        <div className="approval-scope-options" aria-label="Ambito conferma">
          {scopeOptions.map((option) => (
            <button
              key={option}
              aria-pressed={scope === option}
              type="button"
              onClick={() => setScope(option)}
            >
              {option === "always" ? "Sempre per questi URL" : "Solo questa volta"}
            </button>
          ))}
        </div>
        <small>
          {scope === "always"
            ? "Salva una regola locale per i domini coinvolti in questo task."
            : "Vale solo per questa esecuzione del task."}
        </small>
      </div>

      {browserVisibilityOptions.length > 0 && (
        <div className="approval-scope-note">
          <span>Browser</span>
          <div className="approval-scope-options" aria-label="Modalita browser">
            {browserVisibilityOptions.map((option) => (
              <button
                key={option}
                aria-pressed={browserVisibility === option}
                type="button"
                onClick={() => setBrowserVisibility(option)}
              >
                {option === "auto" ? "Auto" : option === "visible" ? "Visibile" : "Headless"}
              </button>
            ))}
          </div>
          <small>Auto usa la scelta del sistema; visibile mostra il computer locale.</small>
        </div>
      )}

      <footer>
        <button
          className="secondary-button"
          disabled={busy}
          type="button"
          onClick={() => onReject(approval.id)}
        >
          Rifiuta
        </button>
        <button
          className="primary-button"
          disabled={busy}
          type="button"
          onClick={() =>
            onApprove(approval.id, {
              scope,
              ...(browserVisibilityOptions.length
                ? { browser_visibility: browserVisibility }
                : {}),
            })
          }
        >
          {busy ? "Continuo..." : "Approva e continua"}
        </button>
      </footer>
    </article>
  );
}

function LocalComputerCard({
  approvalsCount,
  collapsed,
  onOpen,
  onOpenTasks,
  onRunPlanStep,
  onRunSmokeTest,
  onToggleCollapsed,
  planStepError,
  planStepRunning,
  previewDataUrl,
  session,
  smokeTestError,
  smokeTestRunning,
  task,
}: {
  approvalsCount: number;
  collapsed: boolean;
  onOpen: () => void;
  onOpenTasks: () => void;
  onRunPlanStep: () => void;
  onRunSmokeTest: () => void;
  onToggleCollapsed: () => void;
  planStepError: string | null;
  planStepRunning: boolean;
  previewDataUrl: string | null;
  session: ComputerSession;
  smokeTestError: string | null;
  smokeTestRunning: boolean;
  task: TaskItem;
}) {
  const surfaceLabel =
    session.activeSurface === "browser"
      ? "Browser"
      : session.activeSurface === "shell"
        ? "Terminale"
        : "Computer";
  const activityLabel =
    planStepRunning || smokeTestRunning ? "in esecuzione" : "pronto";
  const hasApproval = approvalsCount > 0;
  const hasWaitingStep = session.timeline.some((item) => item.status === "waiting");

  return (
    <article className={`local-computer-card ${collapsed ? "collapsed" : ""}`}>
      <div className="computer-card-toolbar">
        <button
          className="computer-toolbar-main"
          type="button"
          onClick={onOpen}
        >
          <Play size={14} />
          <strong>{session.title}</strong>
          <span>{surfaceLabel} {activityLabel}</span>
        </button>
        <div className="computer-toolbar-meta">
          <span>
            {session.progressCurrent} / {session.progressTotal}
          </span>
          {hasApproval ? (
            <button
              className="computer-inline-action attention"
              type="button"
              onClick={onOpenTasks}
            >
              Conferma richiesta
            </button>
          ) : (
            <button
              className="computer-inline-action"
              disabled={planStepRunning || !hasWaitingStep}
              type="button"
              onClick={onRunPlanStep}
            >
              {planStepRunning
                ? "Esecuzione"
                : hasWaitingStep
                  ? "Continua"
                  : "Nessuna azione"}
            </button>
          )}
          <button
            className="computer-collapse-button"
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Mostra computer locale" : "Nascondi computer locale"}
            onClick={onToggleCollapsed}
          >
            <ChevronDown
              className={collapsed ? "" : "computer-collapse-icon-open"}
              size={15}
            />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <button className="computer-card-main" type="button" onClick={onOpen}>
            <div className="computer-preview" aria-hidden="true">
              {previewDataUrl ? (
                <img
                  className="computer-preview-image"
                  alt=""
                  src={previewDataUrl}
                />
              ) : (
                <>
                  <div className="browser-chrome">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="browser-lines">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="terminal-preview">
                    <span>$ date</span>
                    <span>CEST · local</span>
                  </div>
                </>
              )}
            </div>
            <div className="computer-card-copy">
              <div className="computer-card-title">
                <strong>{session.previewTitle}</strong>
                <span>{session.elapsed}</span>
              </div>
              <p>{session.subtitle}</p>
              <small>{session.previewDetail}</small>
            </div>
            <div className="computer-card-progress">
              <span>Apri dettaglio</span>
              <ChevronDown size={16} />
            </div>
          </button>

          <div className="computer-card-footer">
            <span className="status-line">
              <Play size={14} />
              {task.title}
            </span>
            <div className="computer-card-actions">
              {(smokeTestError || planStepError) && (
                <span>{smokeTestError ?? planStepError}</span>
              )}
              <button
                className="smoke-test-button"
                disabled={planStepRunning || !hasWaitingStep}
                type="button"
                onClick={onRunPlanStep}
              >
                {planStepRunning
                  ? "Esecuzione"
                  : hasWaitingStep
                    ? "Esegui piano"
                    : "Piano fermo"}
              </button>
              {hasApproval && (
                <button
                  className="smoke-test-button attention"
                  type="button"
                  onClick={onOpenTasks}
                >
                  Apri approval
                </button>
              )}
              <button
                className="smoke-test-button"
                disabled={smokeTestRunning}
                type="button"
                onClick={onRunSmokeTest}
              >
                {smokeTestRunning ? "In esecuzione" : "Test reale"}
              </button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}

function ComputerDetailPanel({
  activeSurface,
  controlBusy,
  controlError,
  onClose,
  onPause,
  onResume,
  onSelectSurface,
  onTakeover,
  previewDataUrl,
  session,
}: {
  activeSurface: ComputerSurfaceKind;
  controlBusy: boolean;
  controlError: string | null;
  onClose: () => void;
  onPause: () => void;
  onResume: () => void;
  onSelectSurface: (surface: ComputerSurfaceKind) => void;
  onTakeover: () => void;
  previewDataUrl: string | null;
  session: ComputerSession;
}) {
  const currentSurface = session.surfaces.find((surface) => surface.id === activeSurface);
  const paused = session.status === "paused";

  return (
    <aside className="computer-detail-panel" aria-label="Dettaglio computer locale">
      <header>
        <div>
          <strong>{session.title}</strong>
          <small>{session.subtitle}</small>
        </div>
        <button className="icon-button" type="button" aria-label="Chiudi computer" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <nav className="surface-tabs" aria-label="Superfici computer">
        {session.surfaces.map((surface) => {
          const Icon = surfaceIcons[surface.id];
          return (
            <button
              className={activeSurface === surface.id ? "active" : ""}
              key={surface.id}
              type="button"
              onClick={() => onSelectSurface(surface.id)}
            >
              <Icon size={15} />
              {surface.label}
            </button>
          );
        })}
      </nav>

      <div className="computer-live-view">
        {activeSurface === "browser" && (
          <div className="browser-live-frame">
            <div className="browser-live-bar">
              <span>{session.previewTitle}</span>
            </div>
            <div className="browser-live-body">
              {previewDataUrl ? (
                <img
                  className="browser-live-image"
                  alt="Preview browser redatta"
                  src={previewDataUrl}
                />
              ) : (
                <>
                  <strong>{session.previewTitle}</strong>
                  <p>{session.previewDetail}</p>
                  <div className="result-skeleton">
                    <span />
                    <span />
                    <span />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {activeSurface === "shell" && (
          <pre className="terminal-live-frame">
            {session.terminalExcerpt.length
              ? session.terminalExcerpt.join("\n")
              : "Nessun output terminale disponibile."}
          </pre>
        )}

        {activeSurface === "files" && (
          <div className="artifact-list">
            {session.artifacts.length ? (
              session.artifacts.map((artifact) => (
                <article key={artifact.id}>
                  <FileText size={17} />
                  <div>
                    <strong>{artifact.name}</strong>
                    <small>{artifact.detail}</small>
                  </div>
                </article>
              ))
            ) : (
              <p className="empty-panel-state">Nessun artifact redatto.</p>
            )}
          </div>
        )}

        {activeSurface === "logs" && (
          <div className="log-list">
            {session.timeline.length ? (
              session.timeline.map((item) => (
                <span key={item.id}>
                  {item.timestamp} · {item.title}
                </span>
              ))
            ) : (
              <span>Nessun evento redatto disponibile.</span>
            )}
          </div>
        )}
      </div>

      <footer className="computer-panel-footer">
        <span>{controlError ?? currentSurface?.detail}</span>
        <div>
          <button
            className="secondary-button"
            disabled={controlBusy}
            type="button"
            onClick={paused ? onResume : onPause}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Riprendi" : "Pausa"}
          </button>
          <button
            className="primary-button"
            disabled={controlBusy}
            type="button"
            onClick={onTakeover}
          >
            Prendi controllo
          </button>
        </div>
      </footer>
    </aside>
  );
}

function Composer({
  disabled,
  error,
  replyContext,
  streaming,
  onCancelStreaming,
  onClearReply,
  onSubmit,
}: {
  disabled: boolean;
  error: string | null;
  replyContext: ReplyContext | null;
  streaming: boolean;
  onCancelStreaming: () => void;
  onClearReply: () => void;
  onSubmit: (prompt: string, attachments: ChatAttachmentInput[]) => void;
}) {
  const [value, setValue] = useState("");
  const [composerAttachmentError, setComposerAttachmentError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; name: string; size: number; type: string; localPath: string }>
  >([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const suggestions = [
    "Rispondi in modo diretto",
    "Mostra i passaggi essenziali",
    "Trasforma in lista operativa",
  ];
  const showSuggestions = value.trim().length > 0 && !streaming;

  useEffect(() => {
    if (replyContext) {
      textareaRef.current?.focus();
    }
  }, [replyContext]);

  function adjustComposerHeight() {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }

  function submitCurrentValue() {
    const prompt = value.trim();
    if (!prompt || disabled) return;
    if (attachments.some((attachment) => !attachment.localPath)) {
      setComposerAttachmentError("Path locale non disponibile in questa shell.");
      return;
    }
    const attachmentInputs = attachments.map((attachment) => ({
      localPath: attachment.localPath,
      displayName: attachment.name,
      mimeType: attachment.type,
      sizeBytes: attachment.size,
    }));
    setValue("");
    setAttachments([]);
    setComposerAttachmentError(null);
    requestAnimationFrame(adjustComposerHeight);
    onSubmit(prompt, attachmentInputs);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitCurrentValue();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    submitCurrentValue();
  }

  function handleValueChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setValue(event.target.value);
    requestAnimationFrame(adjustComposerHeight);
  }

  function handleAttachmentSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setAttachments((current) => [
      ...current,
      ...files.map((file) => ({
        id: `${file.name}_${file.size}_${file.lastModified}`,
        name: file.name,
        size: file.size,
        type: file.type || "file",
        localPath: fileLocalPath(file),
      })),
    ]);
    event.target.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function applySuggestion(suggestion: string) {
    setValue((current) => {
      if (!current.trim()) return suggestion;
      return `${current.trim()}\n${suggestion}`;
    });
    requestAnimationFrame(() => {
      adjustComposerHeight();
      textareaRef.current?.focus();
    });
  }

  return (
    <form className="composer-surface" aria-label="Prompt operativo" onSubmit={handleSubmit}>
      {replyContext && (
        <div className="reply-context-card" aria-label="Messaggio citato">
          <Reply size={14} />
          <div>
            <strong>Rispondi a {messageRoleLabel(replyContext.role)}</strong>
            <span>{replyContext.preview}</span>
          </div>
          <button type="button" aria-label="Rimuovi citazione" onClick={onClearReply}>
            <X size={14} />
          </button>
        </div>
      )}
      <textarea
        aria-label="Richiesta per l'assistente"
        disabled={disabled}
        onChange={handleValueChange}
        onKeyDown={handleKeyDown}
        placeholder="Invia un messaggio o aggiungi istruzioni al task"
        ref={textareaRef}
        value={value}
      />
      {attachments.length > 0 && (
        <div className="composer-attachment-tray" aria-label="Allegati selezionati">
          {attachments.map((attachment) => (
            <span className="composer-attachment-item" key={attachment.id}>
              <Paperclip size={13} />
              <span>{attachment.name}</span>
              <small>{formatFileSize(attachment.size)}</small>
              {!attachment.localPath && <small>path non disponibile</small>}
              <button
                type="button"
                aria-label={`Rimuovi ${attachment.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      {showSuggestions && (
        <div className="composer-suggestion-row" aria-label="Suggerimenti prompt">
          {suggestions.map((suggestion) => (
            <button
              disabled={disabled}
              key={suggestion}
              type="button"
              onClick={() => applySuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <div className="composer-toolbar">
        <div className="composer-actions">
          <input
            hidden
            multiple
            ref={fileInputRef}
            type="file"
            onChange={handleAttachmentSelect}
          />
          <button
            className="icon-button"
            disabled={disabled}
            type="button"
            aria-label="Aggiungi allegato"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={17} />
          </button>
        </div>
        <div className="composer-actions">
          <button className="icon-button" type="button" aria-label="Dettatura">
            <Mic size={17} />
          </button>
          {error && <span className="composer-error">{error}</span>}
          {composerAttachmentError && (
            <span className="composer-error">{composerAttachmentError}</span>
          )}
          {streaming ? (
            <button
              className="composer-stop-button"
              type="button"
              aria-label="Interrompi risposta"
              onClick={onCancelStreaming}
            >
              <X size={17} />
            </button>
          ) : (
            <button className="send-button" disabled={disabled || !value.trim()} type="submit" aria-label="Invia">
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileLocalPath(file: File): string {
  const fileWithPath = file as File & { path?: string };
  return fileWithPath.path ?? "";
}

function attachmentKindFromMime(mimeType: string): ChatAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("markdown")
  ) {
    return "text";
  }
  return "file";
}
