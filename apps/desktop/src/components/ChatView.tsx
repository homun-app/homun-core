import {
  ArrowUp,
  AlertCircle,
  AtSign,
  BookMarked,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Braces,
  Clock3,
  Cloud,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode,
  FileCog,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  AlertTriangle,
  Globe2,
  HardDrive,
  ListTodo,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  PanelRight,
  Pause,
  Pencil,
  Play,
  Plug,
  Puzzle,
  Reply,
  RotateCcw,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import {
  coreBridge,
  type ActiveModelInfo,
  type ChatAttachmentInput,
  type CoreComputerSessionSnapshot,
  type CorePromptSubmissionResult,
  type CoreTaskQueueSnapshot,
  type FsEntry,
  type FsFilePayload,
  type McpRegistryServer,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryWikiPage,
  type SkillSummary,
} from "../lib/coreBridge";
import {
  createLoadingComputerSession,
  createUnavailableComputerSession,
  mapCoreComputerSession,
} from "../lib/localComputerViewModel";
import { fileLocalPathFromBridge } from "../lib/gatewayConfig";
import { connectComposioToolkit } from "../lib/composioConnect";
import { MarkdownEditor } from "./MarkdownEditor";
import { RichMessage } from "./RichMessage";
import { CodeView, DiffView, diffStats } from "./CodeView";
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [variants, setVariants] = useState<
    Record<string, { texts: string[]; index: number }>
  >({});
  const [modelOpen, setModelOpen] = useState(false);
  const [activeModelInfo, setActiveModelInfo] = useState<ActiveModelInfo | null>(null);
  const [timelineCollapsed, setTimelineCollapsed] = useState(true);
  const [computerCardCollapsed, setComputerCardCollapsed] = useState(true);
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[] | null>(null);
  const [streamHasVisibleText, setStreamHasVisibleText] = useState(false);
  const [autoContinueMessageId, setAutoContinueMessageId] = useState<string | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Workbench (right-side panel, Claude-Code style): `artifactsOpen` is the
  // open/closed flag; `workbenchTab` is the active tab. Phase 1 ships the
  // "Artefatti" tab; File / Computer / Attività / Piano land in later phases.
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("files");
  const [artifactsInitial, setArtifactsInitial] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [followUpsFor, setFollowUpsFor] = useState<string | null>(null);
  const titledThreadsRef = useRef<Set<string>>(new Set());
  const resumedThreadsRef = useRef<Set<string>>(new Set());
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
  // All artifacts generated in this conversation (from persisted ‹‹ARTIFACT››
  // markers) — drives the Artifacts workspace panel.
  const conversationArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const out: ParsedArtifact[] = [];
    for (const message of threadMessages) {
      for (const artifact of parseArtifacts(message.text ?? "")) {
        if (!seen.has(artifact.name)) {
          seen.add(artifact.name);
          out.push(artifact);
        }
      }
    }
    return out;
  }, [threadMessages]);
  // The agent's operational plan for this conversation (latest update_plan), shown
  // in the Workbench "Piano" panel.
  const conversationPlan = useMemo(() => latestPlanMarkdown(threadMessages), [threadMessages]);
  // Files the user uploaded in THIS conversation (e.g. the patente PDF), derived
  // from message attachments — the chat-context "File" tab of the Workbench.
  const uploadedFiles = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatAttachment[] = [];
    for (const message of threadMessages) {
      for (const attachment of message.attachments ?? []) {
        if (!seen.has(attachment.title)) {
          seen.add(attachment.title);
          out.push(attachment);
        }
      }
    }
    return out;
  }, [threadMessages]);
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
    model?: string,
    images?: string[],
    baseMessages?: ChatMessage[],
  ) {
    const text = prompt.trim();
    if (!text) return;
    const conversationBase = baseMessages ?? threadMessages;
    const userVisibleText = (visibleText ?? text).trim();
    if (!userVisibleText) return;
    const visiblePrompt = userVisibleText === text ? undefined : userVisibleText;

    setPromptSubmitting(true);
    setPromptError(null);
    const imageAttachments: ChatAttachment[] = (images ?? []).map((dataUrl, index) => ({
      artifactId: `img_${Date.now()}_${index}`,
      title: `Immagine ${index + 1}`,
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
    const promptMessages = [...conversationBase, userMessage];
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
      // Record an active stream so a reload mid-answer can reattach (resume).
      writeResumeMarker(thread.threadId, {
        requestId,
        userText: userVisibleText,
        assistantMessageId: streamingMessage.id,
      });
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
        model,
        images,
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
      clearResumeMarker(thread.threadId);
    }
  }

  function cancelActiveStreaming() {
    cancelStreamingRequestRef.current?.();
  }

  // Reattach to an answer that was streaming when the app was reloaded: replays
  // the buffered events from the gateway and continues live, then persists.
  async function resumeActiveStream(marker: ResumeMarker) {
    if (promptSubmitting || streamingAssistantId) return;
    const requestId = marker.requestId;
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
      metadata: "Modello locale",
    };
    const promptMessages = [...messages, userMessage];
    let streamedText = "";
    let unlistenStream: (() => void) | undefined;
    const flushStreamingMessage = () => {
      streamingFrameRef.current = null;
      setOptimisticMessages([...promptMessages, { ...streamingMessage, text: streamedText }]);
      afterStreamingFramePaint();
    };
    const scheduleStreamingMessage = () => {
      if (streamingFrameRef.current !== null) return;
      streamingFrameRef.current = window.requestAnimationFrame(flushStreamingMessage);
    };

    setPromptSubmitting(true);
    setOptimisticMessages([...promptMessages, streamingMessage]);
    resetStreamingState("");
    setStreamingAssistantId(streamingMessage.id);
    streamingUserPinnedRef.current = true;
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: "Riprendo la risposta",
      detail: "Mi riaggancio alla generazione in corso.",
    });
    try {
      unlistenStream = await coreBridge.listenChatStreamDelta((payload) => {
        if (payload.request_id !== requestId) return;
        streamedText += payload.delta;
        setStreamHasVisibleText(true);
        scheduleStreamingMessage();
      });
      const result = await coreBridge.resumeChatPromptStream(
        requestId,
        thread.threadId,
        computerSessionId,
        marker.userText,
        marker.assistantMessageId,
      );
      streamedText = result.assistant_message.text || streamedText;
      cancelScheduledStreamingFrame();
      const finalAssistant = chatMessageFromAssistantResult(result, streamedText);
      const finalMessages = [...promptMessages, finalAssistant];
      setOptimisticMessages(finalMessages);
      onMessagesChange(finalMessages);
      await refreshAfterChatSubmit();
      setOptimisticMessages(null);
    } catch {
      // Stream gone (expired/evicted) → drop the optimistic pair, keep persisted.
      setOptimisticMessages(null);
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      streamingUserPinnedRef.current = false;
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) => (current?.requestId === requestId ? null : current));
      setPromptSubmitting(false);
      clearResumeMarker(thread.threadId);
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

  function submitComposerPrompt(
    prompt: string,
    attachments: ChatAttachmentInput[],
    options?: {
      model?: string;
      forcedSkillId?: string;
      contextText?: string;
      images?: string[];
    },
  ) {
    const activeReplyContext = replyContext;
    setReplyContext(null);
    const images = options?.images;

    // Forcing a skill (🧩 picker) augments the MODEL-facing prompt while the
    // user still sees their clean text. The gateway honors "usa la skill X".
    const skillPrefix = options?.forcedSkillId
      ? `Usa la skill \`${options.forcedSkillId}\` per soddisfare questa richiesta.\n\n`
      : "";
    // @ file context: the selected files' content is prepended to the hidden
    // prompt; the user keeps seeing their clean message.
    const contextPrefix = options?.contextText ? `${options.contextText}\n\n` : "";
    const model = options?.model;
    const augmented = Boolean(skillPrefix || contextPrefix);

    if (!activeReplyContext) {
      if (augmented) {
        void submitPrompt(
          `${skillPrefix}${contextPrefix}${prompt}`,
          attachments,
          undefined,
          prompt,
          model,
          images,
        );
      } else {
        void submitPrompt(prompt, attachments, undefined, undefined, model, images);
      }
      return;
    }

    const promptWithReplyContext = [
      skillPrefix,
      contextPrefix,
      "Rispondi al messaggio citato mantenendo il contesto.",
      `Messaggio citato (${messageRoleLabel(activeReplyContext.role)}):`,
      activeReplyContext.preview,
      "",
      "Richiesta dell'utente:",
      prompt,
    ].join("\n");
    void submitPrompt(promptWithReplyContext, attachments, undefined, prompt, model, images);
  }

  async function copyMessageText(message: ChatMessage) {
    if (!message.text) return;
    await navigator.clipboard.writeText(message.text);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1_400);
  }

  // Switch which generated variant of an assistant message is shown (‹ n/m ›).
  function switchVariant(messageId: string, direction: number) {
    const variant = variants[messageId];
    if (!variant) return;
    const index = Math.max(0, Math.min(variant.texts.length - 1, variant.index + direction));
    if (index === variant.index) return;
    setVariants((prev) => ({ ...prev, [messageId]: { ...prev[messageId], index } }));
    setOptimisticMessages((current) =>
      (current ?? messages).map((message) =>
        message.id === messageId ? { ...message, text: variant.texts[index] } : message,
      ),
    );
  }

  // Regenerate an assistant answer as an ALTERNATIVE variant (kept alongside the
  // previous one with a ‹ n/m › picker), streamed into the same message.
  function regenerateAsVariant(messageId: string) {
    if (promptSubmitting || streamingAssistantId) return;
    const assistant = threadMessages.find((message) => message.id === messageId);
    const previousUser = findPreviousUserMessage(threadMessages, messageId);
    if (!assistant || !previousUser) {
      setPromptError("Non trovo il prompt precedente da rigenerare.");
      return;
    }
    void streamVariantIntoMessage(assistant, previousUser, threadMessages);
  }

  async function streamVariantIntoMessage(
    message: ChatMessage,
    userMessage: ChatMessage,
    baseMessages: ChatMessage[],
  ) {
    const requestId = `chat_stream_variant_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const originalText = message.text;
    let streamedText = "";
    let unlistenStream: (() => void) | undefined;
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
      cancelledStreamIdsRef.current.add(requestId);
      void coreBridge.cancelChatPromptStream(requestId).catch(() => undefined);
      unlistenStream?.();
      cancelScheduledStreamingFrame();
    };

    setPromptSubmitting(true);
    setStreamingAssistantId(message.id);
    resetStreamingState("");
    streamingUserPinnedRef.current = conversationBottomDistance() < 220;
    window.setTimeout(() => scrollConversationToBottomIfPinned("auto"), 0);
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: "Rigenero la risposta",
      detail: "Genero una variante alternativa.",
    });
    cancelStreamingRequestRef.current = cancelStreamingRequest;
    unlistenStream = await coreBridge.listenChatStreamDelta((payload) => {
      if (payload.request_id !== requestId) return;
      if (cancelledStreamIdsRef.current.has(requestId)) return;
      streamedText += payload.delta;
      setStreamHasVisibleText(true);
      scheduleStreamingMessage();
    });

    try {
      const result = await coreBridge.submitChatPromptStream(
        requestId,
        thread.threadId,
        computerSessionId,
        userMessage.text,
        [],
        undefined,
      );
      if (cancelledStreamIdsRef.current.has(requestId)) return;
      const finalText = result.assistant_message.text || streamedText;
      cancelScheduledStreamingFrame();
      const nextMessages = baseMessages.map((item) =>
        item.id === message.id ? { ...item, text: finalText } : item,
      );
      setComputerSession(mapCoreComputerSession(result.computer_session));
      setComputerCardCollapsed(true);
      setTimelineCollapsed(!result.plan);
      setOptimisticMessages(nextMessages);
      onMessagesChange(nextMessages);
      setVariants((prev) => {
        const existing = prev[message.id] ?? { texts: [originalText], index: 0 };
        const texts = [...existing.texts, finalText];
        return { ...prev, [message.id]: { texts, index: texts.length - 1 } };
      });
    } catch (error) {
      setPromptError(`Rigenerazione non riuscita: ${describeBridgeError(error)}`);
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      streamingUserPinnedRef.current = false;
      setStreamingAssistantId(null);
      resetStreamingState("");
      setPromptSubmitting(false);
      setStreamStatus((current) => (current?.requestId === requestId ? null : current));
      if (cancelStreamingRequestRef.current === cancelStreamingRequest) {
        cancelStreamingRequestRef.current = null;
      }
      cancelledStreamIdsRef.current.delete(requestId);
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

  // Edit a user message: truncate the thread at that point and re-run from the
  // edited text (a fresh branch of the conversation).
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
    setOptimisticMessages(base);
    onMessagesChange(base);
    void submitPrompt(
      text,
      [],
      original.attachments ?? [],
      undefined,
      undefined,
      undefined,
      base,
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
      // Show a "jump to latest" affordance once the user scrolls well away.
      setShowJumpToBottom(bottomDistance > 260);
    }

    updateStickToBottom();
    scrollNode.addEventListener("scroll", updateStickToBottom, { passive: true });
    return () => scrollNode.removeEventListener("scroll", updateStickToBottom);
  }, []);

  // Dynamic follow-up suggestions: once the latest assistant answer is complete,
  // ask the model for a few short next-questions (once per message).
  useEffect(() => {
    if (streamingAssistantId) return undefined;
    const latest = [...threadMessages]
      .reverse()
      .find((message) => message.role === "assistant" && Boolean(message.text?.trim()));
    if (!latest || latest.id === followUpsFor) return undefined;
    const previousUser = findPreviousUserMessage(threadMessages, latest.id);
    let cancelled = false;
    setFollowUps([]);
    setFollowUpsFor(latest.id);
    void coreBridge
      .chatSuggestions(previousUser?.text ?? "", latest.text)
      .then((items) => {
        if (!cancelled) setFollowUps(items);
      })
      .catch(() => {
        if (!cancelled) setFollowUps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [threadMessages, streamingAssistantId, followUpsFor]);

  // After a reload, reattach to an answer that was still streaming (resume).
  useEffect(() => {
    if (resumedThreadsRef.current.has(thread.threadId)) return;
    if (promptSubmitting || streamingAssistantId) return;
    const marker = readResumeMarker(thread.threadId);
    if (!marker) return;
    resumedThreadsRef.current.add(thread.threadId);
    void resumeActiveStream(marker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.threadId]);

  // Auto-title a thread (LLM) once its first exchange is complete; persisted by
  // the gateway, then the thread list refreshes. Once per thread.
  useEffect(() => {
    if (streamingAssistantId) return;
    if (titledThreadsRef.current.has(thread.threadId)) return;
    const firstUser = threadMessages.find(
      (message) => message.role === "user" && Boolean(message.text?.trim()),
    );
    const latestAssistant = [...threadMessages]
      .reverse()
      .find((message) => message.role === "assistant" && Boolean(message.text?.trim()));
    if (!firstUser || !latestAssistant) return;
    titledThreadsRef.current.add(thread.threadId);
    void coreBridge
      .autoTitleThread(thread.threadId, firstUser.text, latestAssistant.text)
      .then(() => onRuntimeChanged())
      .catch(() => {
        /* keep existing title on failure */
      });
  }, [threadMessages, streamingAssistantId, thread.threadId, onRuntimeChanged]);

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

  useEffect(() => {
    let cancelled = false;
    void coreBridge
      .runtimeModel()
      .then((info) => {
        if (!cancelled) setActiveModelInfo(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Header status (read-only): the REAL active model; the per-chat picker lives in
  // the composer. Channel threads run the read-only tool policy; in-app chats get
  // the full local toolset.
  const headerModelLabel = activeModelInfo ? shortModelName(activeModelInfo.model) : "Modello";
  const headerModelMeta = activeModelInfo
    ? `${activeModelInfo.locality} · ${formatContextTokens(activeModelInfo.context_window)}`
    : "attivo";
  const headerToolPolicy = thread.source ? "Solo lettura (canale)" : "Strumenti locali completi";

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
              <div className="model-menu-row" title={activeModelInfo?.model ?? undefined}>
                <Sparkles size={15} />
                <span className="model-menu-name">{headerModelLabel}</span>
                <span>{headerModelMeta}</span>
              </div>
              <div className="model-menu-row">
                <HardDrive size={15} />
                <span className="model-menu-name">Strumenti</span>
                <span>{headerToolPolicy}</span>
              </div>
              <p className="model-menu-hint">Cambia il modello per questa chat dal selettore nel composer ↓</p>
            </div>
          )}
        </div>

        <div className="task-top-actions">
          {/* Header stripped to a single affordance: the Workbench toggle. Model
              lives in the composer selector; share/⋯ removed as clutter. */}
          <button
            className={`workbench-toggle${artifactsOpen ? " active" : ""}`}
            type="button"
            title="Pannello (file, artefatti)"
            aria-label="Apri pannello"
            onClick={() => setArtifactsOpen((value) => !value)}
          >
            <PanelRight size={18} />
            {conversationArtifacts.length > 0 && (
              <span className="top-action-count">{conversationArtifacts.length}</span>
            )}
          </button>
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
                  <MessageActivity text={displayMessage.text} live />
                  {displayMessage.text && (
                    <RichMessage text={displayMessage.text} streaming />
                  )}
                </>
              ) : editingMessageId === displayMessage.id ? (
                <div className="message-edit">
                  <textarea
                    autoFocus
                    value={editingText}
                    onChange={(event) => setEditingText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        saveEditedMessage();
                      } else if (event.key === "Escape") {
                        cancelEditMessage();
                      }
                    }}
                  />
                  <div className="message-edit-actions">
                    <button type="button" onClick={cancelEditMessage}>
                      Annulla
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!editingText.trim()}
                      onClick={saveEditedMessage}
                    >
                      Salva e invia
                    </button>
                  </div>
                </div>
              ) : displayMessage.text ? (
                <AssistantMessageBody
                  text={displayMessage.text}
                  messageId={displayMessage.id}
                  threadId={thread.threadId}
                  onOpenArtifact={(artifact) => {
                    setArtifactsInitial(artifact.name);
                    setWorkbenchTab("artifacts");
                    setArtifactsOpen(true);
                  }}
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
                  canEdit={displayMessage.role === "user" && Boolean(displayMessage.text)}
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
                  onEdit={() => startEditMessage(displayMessage)}
                  onRegenerate={() => regenerateAsVariant(displayMessage.id)}
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
              {!isStreamingMessage &&
                variants[displayMessage.id] &&
                variants[displayMessage.id].texts.length > 1 && (
                  <div className="branch-picker" aria-label="Varianti risposta">
                    <button
                      type="button"
                      aria-label="Variante precedente"
                      disabled={variants[displayMessage.id].index === 0}
                      onClick={() => switchVariant(displayMessage.id, -1)}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span>
                      {variants[displayMessage.id].index + 1} /{" "}
                      {variants[displayMessage.id].texts.length}
                    </span>
                    <button
                      type="button"
                      aria-label="Variante successiva"
                      disabled={
                        variants[displayMessage.id].index ===
                        variants[displayMessage.id].texts.length - 1
                      }
                      onClick={() => switchVariant(displayMessage.id, 1)}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              {!isStreamingMessage &&
                followUpsFor === displayMessage.id &&
                followUps.length > 0 && (
                  <div className="chat-followups" aria-label="Domande di follow-up">
                    {followUps.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => {
                          setFollowUps([]);
                          void submitPrompt(suggestion, []);
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
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

      {showJumpToBottom && (
        <button
          className="chat-jump-bottom"
          type="button"
          aria-label="Vai all'ultimo messaggio"
          title="Vai in fondo"
          onClick={() => {
            shouldStickToBottomRef.current = true;
            scrollConversationToBottom("smooth");
          }}
        >
          <ChevronDown size={18} />
        </button>
      )}

      <Workbench
        open={artifactsOpen}
        tab={workbenchTab}
        onTab={setWorkbenchTab}
        onClose={() => setArtifactsOpen(false)}
        artifacts={conversationArtifacts}
        artifactsInitial={artifactsInitial}
        uploadedFiles={uploadedFiles}
        threadId={thread.threadId}
        operationalPlanMarkdown={conversationPlan ?? visibleComputerSession.operationalPlanMarkdown}
      />

      <ChatComputerPanel />

      <Composer
        disabled={promptSubmitting}
        error={promptError}
        replyContext={replyContext}
        streaming={promptSubmitting}
        threadId={thread.threadId}
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
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-label">{status?.title ?? "Sto pensando…"}</span>
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
  canEdit,
  canSaveToMemory,
  contentKind,
  copied,
  feedback,
  linkedAutomation,
  linkedTask,
  metrics,
  savedToMemory,
  onCopy,
  onEdit,
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
  canEdit: boolean;
  canSaveToMemory: boolean;
  contentKind: MessageContentKind;
  copied: boolean;
  feedback: ChatMessage["feedback"];
  linkedAutomation: boolean;
  linkedTask: boolean;
  metrics?: ChatMessageMetrics;
  savedToMemory: boolean;
  onCopy: () => void;
  onEdit: () => void;
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
      {canEdit && (
        <button type="button" onClick={onEdit} aria-label="Modifica messaggio" title="Modifica">
          <Pencil size={14} />
          <span>Modifica</span>
        </button>
      )}
      {canReply && (
        <button type="button" onClick={onReply} aria-label="Rispondi al messaggio" title="Rispondi">
          <Reply size={14} />
          <span>Rispondi</span>
        </button>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copia messaggio"
        title={copied ? "Copiato" : "Copia"}
      >
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
      {attachments.map((attachment) =>
        attachment.kind === "image" && attachment.previewUrl ? (
          <img
            className="message-image-attachment"
            key={attachment.artifactId}
            src={attachment.previewUrl}
            alt={attachment.title}
          />
        ) : (
          <span className="message-attachment-chip" key={attachment.artifactId}>
            <Paperclip size={13} />
            <span>{attachment.title}</span>
            <small>
              {attachment.kind} · {formatFileSize(attachment.sizeBytes)}
            </small>
          </span>
        ),
      )}
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

/** A pending write action the model proposed, carried in the message text.
 *  `kind` routes execution to the right backend: Composio vs an MCP server tool. */
interface ComposioPendingAction {
  tool: string;
  arguments: unknown;
  kind?: "composio" | "mcp";
}

const COMPOSIO_CONFIRM_RE = /‹‹COMPOSIO_CONFIRM››([\s\S]*?)‹‹\/COMPOSIO_CONFIRM››/;
const MCP_CONFIRM_RE = /‹‹MCP_CONFIRM››([\s\S]*?)‹‹\/MCP_CONFIRM››/;
const FS_AUTHORIZE_RE = /‹‹FS_AUTHORIZE››([\s\S]*?)‹‹\/FS_AUTHORIZE››/;
const CONNECT_SUGGEST_RE = /‹‹CONNECT_SUGGEST››([\s\S]*?)‹‹\/CONNECT_SUGGEST››/;
const COMPOSIO_DONE_RE = /‹‹COMPOSIO_DONE››([\s\S]*?)‹‹\/COMPOSIO_DONE››/;
const COMPOSIO_RECONNECT_RE = /‹‹COMPOSIO_RECONNECT››([\s\S]*?)‹‹\/COMPOSIO_RECONNECT››/;
const COMPOSIO_MARKERS_RE =
  /‹‹(?:COMPOSIO_(?:CONFIRM|DONE|RECONNECT)|MCP_CONFIRM|FS_AUTHORIZE|CONNECT_SUGGEST)››[\s\S]*?‹‹\/(?:COMPOSIO_(?:CONFIRM|DONE|RECONNECT)|MCP_CONFIRM|FS_AUTHORIZE|CONNECT_SUGGEST)››/g;

/** One clickable suggestion in an in-chat connect-card. */
interface ConnectSuggestItem {
  kind: "mcp" | "skill" | "composio";
  name: string;
  description?: string;
  official?: boolean;
  /** Present for kind==="mcp": the full normalized registry server to connect. */
  server?: McpRegistryServer;
  /** Present for kind==="skill"|"composio": catalog/toolkit slug. */
  slug?: string;
  /** Set by the backend rewrite once the user connected this item. */
  connected?: boolean;
}

interface ConnectSuggest {
  need: string;
  items: ConnectSuggestItem[];
}

// Tool-activity trace markers (browser / skill / sandbox / connected-tool steps).
// They are extracted into a compact collapsible panel so the answer body stays
// clean — the pattern Claude/assistant-ui use for "tool activity".
const ACTIVITY_RE = /‹‹ACT››([\s\S]*?)‹‹\/ACT››/g;

function parseActivitySteps(text: string): string[] {
  if (!text.includes("‹‹ACT››")) return [];
  return Array.from(text.matchAll(ACTIVITY_RE), (match) => match[1].trim()).filter(
    (step) => step.length > 0,
  );
}

// Generated-file artifacts surfaced by the gateway (skill outputs in $OUTPUT_DIR).
const ARTIFACT_RE = /‹‹ARTIFACT››([\s\S]*?)‹‹\/ARTIFACT››/g;

interface ParsedArtifact {
  name: string;
  thread: string;
  size: number;
  /** True when this emission overwrote an existing file (a new version). */
  updated?: boolean;
}

function parseArtifacts(text: string): ParsedArtifact[] {
  if (!text.includes("‹‹ARTIFACT››")) return [];
  const seen = new Set<string>();
  const out: ParsedArtifact[] = [];
  for (const match of text.matchAll(ARTIFACT_RE)) {
    try {
      const parsed = JSON.parse(match[1]) as ParsedArtifact;
      if (parsed?.name && !seen.has(parsed.name)) {
        seen.add(parsed.name);
        out.push(parsed);
      }
    } catch {
      /* malformed marker → skip */
    }
  }
  return out;
}

// Operational plan emitted by the agent via the update_plan tool (‹‹PLAN›› markers).
// The latest one in the conversation drives the Workbench "Piano" panel.
const PLAN_RE = /‹‹PLAN››([\s\S]*?)‹‹\/PLAN››/g;

function latestPlanMarkdown(messages: { text?: string }[]): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    const text = message.text ?? "";
    if (!text.includes("‹‹PLAN››")) continue;
    for (const match of text.matchAll(PLAN_RE)) latest = match[1].trim();
  }
  return latest && latest.length > 0 ? latest : null;
}

/** File-type icon (colored) by extension — like Claude Code's file list. */
function artifactTypeIcon(name: string) {
  const ext = artifactExt(name);
  if (["json"].includes(ext)) return <Braces size={16} color="#d19a00" />;
  if (["yml", "yaml"].includes(ext)) return <FileCode size={16} color="#e5484d" />;
  if (["toml", "ini", "conf", "cfg", "env"].includes(ext)) return <FileCog size={16} color="#2f7ed8" />;
  if (["csv", "xlsx", "xls", "tsv"].includes(ext)) return <FileSpreadsheet size={16} color="#1a9b53" />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext))
    return <FileImage size={16} color="#7c5cff" />;
  if (["md", "markdown", "txt", "log"].includes(ext)) return <FileText size={16} color="#6b7280" />;
  if (ARTIFACT_CODE_EXT.has(ext)) return <FileCode size={16} color="#2f7ed8" />;
  return <FileText size={16} color="#6b7280" />;
}

async function openArtifactFolder(artifact: ParsedArtifact) {
  try {
    const path = await coreBridge.artifactFolder(artifact.thread);
    await coreBridge.revealPath(path);
  } catch {
    /* reveal unavailable → ignore */
  }
}

/** Cards for files generated/authored in the conversation. The NAME opens the
 *  right-side workspace panel; the chevron expands an inline scrollable preview
 *  (Claude Code's two-affordance pattern). */
function MessageArtifacts({
  text,
  onOpen,
}: {
  text: string;
  onOpen: (artifact: ParsedArtifact) => void;
}) {
  const artifacts = useMemo(() => parseArtifacts(text), [text]);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (artifacts.length === 0) return null;

  return (
    <div className="msg-artifacts" aria-label="File generati">
      {artifacts.map((artifact) => (
        <ArtifactCardRow
          key={artifact.name}
          artifact={artifact}
          expanded={expanded === artifact.name}
          onToggle={() =>
            setExpanded((current) => (current === artifact.name ? null : artifact.name))
          }
          onOpen={() => onOpen(artifact)}
        />
      ))}
    </div>
  );
}

/** One artifact card row. For an updated file it loads the "+N −M" diff counts
 *  and shows them on the row (Claude Code's "Modificato file +N −M"). */
function ArtifactCardRow({
  artifact,
  expanded,
  onToggle,
  onOpen,
}: {
  artifact: ParsedArtifact;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const [counts, setCounts] = useState<{ added: number; removed: number } | null>(null);

  useEffect(() => {
    if (!artifact.updated) return;
    let cancelled = false;
    void (async () => {
      try {
        const versions = await coreBridge.artifactVersions(artifact.thread, artifact.name);
        if (versions <= 0 || cancelled) return;
        const newBlob = await coreBridge.downloadArtifact(artifact.thread, artifact.name);
        const oldBlob = await coreBridge.downloadArtifact(
          artifact.thread,
          artifact.name,
          versions - 1,
        );
        const [newText, oldText] = await Promise.all([newBlob.text(), oldBlob.text()]);
        if (!cancelled) setCounts(diffStats(oldText, newText));
      } catch {
        /* counts unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact]);

  return (
    <div className="artifact-row-wrap">
      <div className="artifact-row">
        <span className="artifact-type-icon" aria-hidden="true">
          {artifactTypeIcon(artifact.name)}
        </span>
        <button type="button" className="artifact-name" onClick={onOpen} title="Apri nel pannello">
          <span className="artifact-fname">{artifact.name}</span>
          {artifact.updated && <span className="artifact-updated">Modificato</span>}
          {counts && (
            <span className="diff-counts">
              <span className="add">+{counts.added}</span>{" "}
              <span className="del">−{counts.removed}</span>
            </span>
          )}
        </button>
        <button
          type="button"
          className="artifact-quick"
          onClick={() => void triggerArtifactDownload(artifact)}
          aria-label="Scarica"
          title="Scarica"
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          className="artifact-expand"
          aria-label={expanded ? "Comprimi anteprima" : "Espandi anteprima"}
          onClick={onToggle}
        >
          <ChevronRight
            size={15}
            className={expanded ? "artifact-chevron open" : "artifact-chevron"}
          />
        </button>
      </div>
      {expanded && <InlineArtifactPreview artifact={artifact} />}
    </div>
  );
}

/** The Artefatti panel, rendered IDENTICALLY to the chat: the same artifact cards
 *  (icon · name · Modificato · +N −M diff · download · expand → inline preview), just
 *  as a LIST of all the conversation's artifacts. */
function ArtifactsList({
  artifacts,
  initialName,
}: {
  artifacts: ParsedArtifact[];
  initialName?: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(
    initialName ?? artifacts[0]?.name ?? null,
  );
  return (
    <div className="workbench-files">
      <div className="msg-artifacts workbench-artifacts-list">
        {artifacts.map((artifact) => (
          <ArtifactCardRow
            key={artifact.name}
            artifact={artifact}
            expanded={expanded === artifact.name}
            onToggle={() =>
              setExpanded((current) => (current === artifact.name ? null : artifact.name))
            }
            onOpen={() => setExpanded(artifact.name)}
          />
        ))}
      </div>
    </div>
  );
}

const ARTIFACT_CODE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "rb", "php", "c", "cpp", "h",
  "cs", "json", "yaml", "yml", "toml", "sh", "bash", "sql", "html", "css", "scss", "xml",
]);
const ARTIFACT_IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

function artifactExt(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

async function triggerArtifactDownload(artifact: ParsedArtifact, version?: number) {
  try {
    const blob = await coreBridge.downloadArtifact(artifact.thread, artifact.name, version);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch {
    /* ignore */
  }
}

type ArtifactPreview =
  | { kind: "image" | "pdf"; url: string; ext: string }
  | { kind: "pdf-images"; pages: string[]; ext: string }
  | { kind: "markdown" | "code" | "csv" | "text"; text: string; ext: string }
  | { kind: "binary" | "error"; ext: string };

/** Fetches an artifact and builds a renderable preview by type. For image/pdf it
 *  creates an object URL the caller must revoke (preview.url). */
async function buildArtifactPreview(
  artifact: ParsedArtifact,
  version?: number,
): Promise<ArtifactPreview> {
  const ext = artifactExt(artifact.name);
  const blob = await coreBridge.downloadArtifact(artifact.thread, artifact.name, version);
  if (ARTIFACT_IMAGE_EXT.includes(ext)) return { kind: "image", url: URL.createObjectURL(blob), ext };
  if (ext === "pdf") {
    // Prefer a clean document-style preview: render the pages to images server-side
    // (pdfium). Fall back to the native PDF viewer iframe if that's unavailable.
    try {
      const pages = await coreBridge.artifactPdfPages(artifact.thread, artifact.name, version);
      if (pages.length > 0) return { kind: "pdf-images", pages, ext };
    } catch {
      /* pdfium unavailable → native viewer */
    }
    return { kind: "pdf", url: URL.createObjectURL(blob), ext };
  }
  if (ext === "md" || ext === "markdown") return { kind: "markdown", text: await blob.text(), ext };
  if (ext === "csv") return { kind: "csv", text: await blob.text(), ext };
  if (ARTIFACT_CODE_EXT.has(ext)) return { kind: "code", text: await blob.text(), ext };
  if (ext === "txt" || ext === "log" || ext === "") return { kind: "text", text: await blob.text(), ext };
  return { kind: "binary", ext };
}

/** Inline, scrollable preview of an artifact under its card. For an UPDATED file
 *  it defaults to the DIFF vs the previous version (with a File/Diff toggle), so
 *  a modification shows the change right in the chat. */
function InlineArtifactPreview({ artifact }: { artifact: ParsedArtifact }) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [diff, setDiff] = useState<{ oldText: string; newText: string } | null>(null);
  const [mode, setMode] = useState<"diff" | "file">(artifact.updated ? "diff" : "file");
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let count = 0;
      try {
        count = await coreBridge.artifactVersions(artifact.thread, artifact.name);
      } catch {
        /* no versions */
      }
      try {
        const next = await buildArtifactPreview(artifact);
        if (cancelled) {
          if ("url" in next) URL.revokeObjectURL(next.url);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = "url" in next ? next.url : null;
        setPreview(next);
      } catch {
        if (!cancelled) setPreview({ kind: "error", ext: artifactExt(artifact.name) });
      }
      if (count > 0) {
        try {
          const newBlob = await coreBridge.downloadArtifact(artifact.thread, artifact.name);
          const oldBlob = await coreBridge.downloadArtifact(artifact.thread, artifact.name, count - 1);
          const [newText, oldText] = await Promise.all([newBlob.text(), oldBlob.text()]);
          if (!cancelled) setDiff({ oldText, newText });
        } catch {
          /* no diff */
        }
      } else if (!cancelled) {
        setDiff(null);
        setMode("file");
      }
    })();
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [artifact]);

  const counts = diff ? diffStats(diff.oldText, diff.newText) : null;
  const textLike =
    preview?.kind === "code" ||
    preview?.kind === "text" ||
    preview?.kind === "markdown" ||
    preview?.kind === "csv";

  return (
    <div className="artifact-inline-preview">
      {diff && textLike && (
        <div className="artifact-inline-toolbar">
          <button
            type="button"
            className={mode === "diff" ? "active" : ""}
            onClick={() => setMode("diff")}
          >
            Diff
            {counts && (
              <span className="diff-counts">
                <span className="add">+{counts.added}</span>{" "}
                <span className="del">−{counts.removed}</span>
              </span>
            )}
          </button>
          <button
            type="button"
            className={mode === "file" ? "active" : ""}
            onClick={() => setMode("file")}
          >
            File
          </button>
        </div>
      )}
      {diff && mode === "diff" && textLike ? (
        <DiffView oldText={diff.oldText} newText={diff.newText} />
      ) : preview ? (
        <ArtifactPreviewBody preview={preview} />
      ) : (
        <p className="artifacts-preview-note">Carico…</p>
      )}
    </div>
  );
}

/** Artifacts workspace: a side panel listing the conversation's generated files
 *  and rendering each by type (markdown, code, csv table, image, pdf) — the
 *  "interactive workspace alongside the chat" model. */
/** Tabs of the right-side Workbench panel. "files" = context-aware (chat uploads +
 *  project directory tree); "artifacts" = generated outputs; "activity" =
 *  background/scheduled tasks; "plan" = the orchestrator's operational plan.
 *  (Computer stays docked above the composer by design.) */
type WorkbenchTab = "files" | "artifacts" | "memoria" | "activity" | "plan";

/** The Workbench: one toggle → a docked right panel with tabs, consolidating the
 *  assistant's tools/outputs (Claude-Code / IDE inspector pattern). Replaces the
 *  scattered header affordances. */
// Navigable visual graph of the project's memory: project at the centre, decisions
// linked to the files they affect and the alternatives they rejected, plus facts and
// preferences. Self-rendered SVG (no graph lib): a small deterministic force layout +
// pan/zoom + click-to-inspect. Data from GET /api/memory/graph.
const GRAPH_KIND_STYLE: Record<string, { fill: string; r: number; label: string }> = {
  project: { fill: "#6366f1", r: 16, label: "Progetto" },
  decision: { fill: "#0ea5e9", r: 11, label: "Decisione" },
  file: { fill: "#10b981", r: 8, label: "File / entità" },
  alternative: { fill: "#fb7185", r: 7, label: "Alternativa scartata" },
  fact: { fill: "#f59e0b", r: 8, label: "Fatto" },
  preference: { fill: "#a78bfa", r: 8, label: "Preferenza" },
  entity: { fill: "#94a3b8", r: 8, label: "Entità" },
};

type LaidOutNode = MemoryGraphNode & { x: number; y: number };

function layoutMemoryGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): LaidOutNode[] {
  const n = nodes.length;
  if (n === 0) return [];
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    const radius = node.kind === "project" ? 0 : 140 + (i % 6) * 26;
    pos.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 });
  });
  for (let iter = 0; iter < 220; iter++) {
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const pa = pos.get(nodes[a].id)!;
        const pb = pos.get(nodes[b].id)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d = Math.sqrt(d2);
        const force = 5200 / d2;
        pa.vx += (dx / d) * force;
        pa.vy += (dy / d) * force;
        pb.vx -= (dx / d) * force;
        pb.vy -= (dy / d) * force;
      }
    }
    for (const e of edges) {
      const pa = pos.get(e.source);
      const pb = pos.get(e.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const force = (d - 96) * 0.018;
      pa.vx += (dx / d) * force;
      pa.vy += (dy / d) * force;
      pb.vx -= (dx / d) * force;
      pb.vy -= (dy / d) * force;
    }
    for (const node of nodes) {
      const p = pos.get(node.id)!;
      if (node.kind === "project") {
        p.x = 0;
        p.y = 0;
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      p.vx -= p.x * 0.0024;
      p.vy -= p.y * 0.0024;
      p.vx *= 0.84;
      p.vy *= 0.84;
      p.x += p.vx;
      p.y += p.vy;
    }
  }
  return nodes.map((node) => {
    const p = pos.get(node.id)!;
    return { ...node, x: p.x, y: p.y };
  });
}

export function MemoryGraphPanel({
  threadId,
  workspace,
}: {
  threadId?: string;
  workspace?: string;
}) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [mode, setMode] = useState<"graph" | "wiki">("graph");
  const [wiki, setWiki] = useState<MemoryWikiPage[] | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingWiki, setSavingWiki] = useState(false);
  // viewBox tracks the container's pixel size (centred at origin) so the graph FILLS
  // the panel and adapts when it's expanded/fullscreen — no fixed-aspect letterboxing.
  const [size, setSize] = useState({ w: 760, h: 600 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mode === "wiki" && wiki === null) {
      coreBridge
        .memoryWiki(threadId, workspace)
        .then(setWiki)
        .catch(() => setWiki([]));
    }
  }, [mode, wiki, threadId, workspace]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    coreBridge
      .memoryGraph(threadId, workspace)
      .then((g) => setGraph(g))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [threadId, workspace]);

  useEffect(() => {
    reload();
  }, [reload]);

  const laidOut = useMemo(
    () => (graph ? layoutMemoryGraph(graph.nodes, graph.edges) : []),
    [graph],
  );
  const posById = useMemo(() => {
    const map = new Map<string, LaidOutNode>();
    for (const node of laidOut) map.set(node.id, node);
    return map;
  }, [laidOut]);

  const selectedNode = selected ? posById.get(selected) : null;
  const selectedEdges = useMemo(() => {
    if (!graph || !selected) return [];
    return graph.edges
      .filter((e) => e.source === selected || e.target === selected)
      .map((e) => {
        const otherId = e.source === selected ? e.target : e.source;
        return { label: e.label, other: posById.get(otherId)?.label ?? otherId };
      });
  }, [graph, selected, posById]);

  const onWheel = (event: ReactWheelEvent) => {
    event.preventDefault();
    setView((v) => {
      const k = Math.min(Math.max(v.k * (event.deltaY < 0 ? 1.12 : 0.89), 0.3), 3);
      return { ...v, k };
    });
  };
  const onPointerDown = (event: ReactMouseEvent) => {
    if ((event.target as Element).closest(".memory-graph-node")) return;
    dragRef.current = { x: event.clientX, y: event.clientY };
    setSelected(null);
  };
  const onPointerMove = (event: ReactMouseEvent) => {
    if (!dragRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = size.w / Math.max(rect.width, 1); // viewBox units per px
    setView((v) => ({
      ...v,
      x: v.x + (event.clientX - dragRef.current!.x) * scale,
      y: v.y + (event.clientY - dragRef.current!.y) * scale,
    }));
    dragRef.current = { x: event.clientX, y: event.clientY };
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  if (loading) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} />
        <p>Carico la memoria del progetto…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} />
        <p>Memoria non disponibile: {error}</p>
        <button type="button" className="ghost-button" onClick={reload}>
          Riprova
        </button>
      </div>
    );
  }
  if (!graph || graph.nodes.length <= 1) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} />
        <p>
          Ancora nessuna memoria per questo progetto. Decisioni, file toccati e fatti
          appariranno qui come grafo navigabile man mano che lavoriamo.
        </p>
      </div>
    );
  }

  return (
    <div className="memory-graph">
      <div className="memory-graph-toolbar">
        <div className="memory-graph-modes">
          <button type="button" className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
            Grafo
          </button>
          <button type="button" className={mode === "wiki" ? "active" : ""} onClick={() => setMode("wiki")}>
            Wiki
          </button>
        </div>
        <span className="memory-graph-count">
          {mode === "graph"
            ? `${graph.nodes.length} nodi · ${graph.edges.length} collegamenti`
            : `${wiki?.length ?? 0} pagine`}
        </span>
        {mode === "graph" && (
          <div className="memory-graph-zoom">
            <button type="button" onClick={() => setView((v) => ({ ...v, k: Math.min(v.k * 1.2, 3) }))} aria-label="Zoom +">
              +
            </button>
            <button type="button" onClick={() => setView((v) => ({ ...v, k: Math.max(v.k * 0.83, 0.3) }))} aria-label="Zoom −">
              −
            </button>
            <button type="button" onClick={() => setView({ x: 0, y: 0, k: 1 })} aria-label="Reimposta vista">
              ⟲
            </button>
          </div>
        )}
      </div>
      {mode === "wiki" ? (
        <div className="memory-wiki">
          {wiki === null ? (
            <p className="memory-wiki-empty">Carico la wiki…</p>
          ) : wiki.length === 0 ? (
            <p className="memory-wiki-empty">
              Nessuna pagina wiki ancora. Le decisioni del progetto vengono proiettate qui in
              markdown man mano che lavoriamo.
            </p>
          ) : (
            wiki.map((page) =>
              editingPath === page.path ? (
                <article className="memory-wiki-page" key={page.path}>
                  <MarkdownEditor value={editBody} onChange={setEditBody} />
                  <div className="memory-wiki-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={savingWiki}
                      onClick={() => {
                        setSavingWiki(true);
                        coreBridge
                          .saveMemoryWiki({ thread: threadId, workspace }, page.path, editBody)
                          .then(() => {
                            setEditingPath(null);
                            setWiki(null);
                          })
                          .catch(() => {})
                          .finally(() => setSavingWiki(false));
                      }}
                    >
                      {savingWiki ? "Salvo…" : "Salva"}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setEditingPath(null)}>
                      Annulla
                    </button>
                  </div>
                </article>
              ) : (
                <article className="memory-wiki-page" key={page.path}>
                  <div className="memory-wiki-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setEditingPath(page.path);
                        setEditBody(page.body);
                      }}
                    >
                      Modifica
                    </button>
                  </div>
                  <RichMessage text={page.body} />
                </article>
              ),
            )
          )}
        </div>
      ) : (
        <>
      <div className="memory-graph-canvas" ref={canvasRef}>
        <svg
          ref={svgRef}
          viewBox={`${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onMouseDown={onPointerDown}
          onMouseMove={onPointerMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {graph.edges.map((edge, i) => {
              const a = posById.get(edge.source);
              const b = posById.get(edge.target);
              if (!a || !b) return null;
              const active = selected === edge.source || selected === edge.target;
              const dashed = edge.label === "scartata";
              return (
                <g key={i}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={active ? "#475569" : "#cbd5e1"}
                    strokeWidth={active ? 1.6 : 0.9}
                    strokeDasharray={dashed ? "4 3" : undefined}
                  />
                </g>
              );
            })}
            {laidOut.map((node) => {
              const style = GRAPH_KIND_STYLE[node.kind] ?? GRAPH_KIND_STYLE.entity;
              const isSel = selected === node.id;
              const short = node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label;
              return (
                <g
                  key={node.id}
                  className="memory-graph-node"
                  transform={`translate(${node.x} ${node.y})`}
                  onClick={() => setSelected(node.id)}
                  style={{ cursor: "pointer" }}
                >
                  <circle
                    r={style.r + (isSel ? 3 : 0)}
                    fill={style.fill}
                    stroke={isSel ? "#0f172a" : "#fff"}
                    strokeWidth={isSel ? 2 : 1}
                  />
                  {(node.kind === "project" || node.kind === "decision" || node.kind === "file" || isSel) && (
                    <text
                      x={style.r + 4}
                      y={3}
                      fontSize={node.kind === "project" ? 11 : 9}
                      fill="#1e293b"
                    >
                      {short}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        {selectedNode && (
          <div className="memory-graph-detail">
            <div className="memory-graph-detail-kind" style={{ color: GRAPH_KIND_STYLE[selectedNode.kind]?.fill }}>
              {GRAPH_KIND_STYLE[selectedNode.kind]?.label ?? selectedNode.kind}
            </div>
            <div className="memory-graph-detail-title">{selectedNode.label}</div>
            {selectedNode.detail && <p className="memory-graph-detail-body">{selectedNode.detail}</p>}
            {selectedEdges.length > 0 && (
              <ul className="memory-graph-detail-links">
                {selectedEdges.map((link, i) => (
                  <li key={i}>
                    <span className="memory-graph-link-label">{link.label}</span> {link.other}
                  </li>
                ))}
              </ul>
            )}
            <div className="memory-graph-detail-actions">
              {["decision", "fact", "preference", "entity"].includes(selectedNode.kind) && (
                <button
                  type="button"
                  className="ghost-button danger"
                  onClick={() => {
                    coreBridge
                      .decideMemory(selectedNode.id, "delete")
                      .then(() => {
                        setSelected(null);
                        setWiki(null);
                        reload();
                      })
                      .catch(() => {});
                  }}
                >
                  Elimina dalla memoria
                </button>
              )}
              <button type="button" className="ghost-button" onClick={() => setSelected(null)}>
                Chiudi
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="memory-graph-legend">
        {["project", "decision", "file", "alternative", "fact", "preference"].map((kind) => (
          <span key={kind}>
            <i style={{ background: GRAPH_KIND_STYLE[kind].fill }} />
            {GRAPH_KIND_STYLE[kind].label}
          </span>
        ))}
      </div>
        </>
      )}
    </div>
  );
}

function Workbench({
  open,
  tab,
  onTab,
  onClose,
  artifacts,
  artifactsInitial,
  uploadedFiles,
  threadId,
  operationalPlanMarkdown,
}: {
  open: boolean;
  tab: WorkbenchTab;
  onTab: (tab: WorkbenchTab) => void;
  onClose: () => void;
  artifacts: ParsedArtifact[];
  artifactsInitial?: string | null;
  uploadedFiles: ChatAttachment[];
  threadId: string;
  operationalPlanMarkdown?: string;
}) {
  // Project-folder browser state (File tab): the thread's linked folder, navigable.
  const [fsRoot, setFsRoot] = useState<string | null>(null);
  const [fsCwd, setFsCwd] = useState<string | null>(null);
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  // Panel sizing: draggable width + fullscreen toggle (so wide files/diffs read well).
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(520);
  const startResize = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    const onMove = (ev: MouseEvent) => {
      // Panel is docked right: width grows as the cursor moves left.
      const next = Math.min(Math.max(window.innerWidth - ev.clientX, 320), window.innerWidth - 120);
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  // Background/scheduled tasks (Attività tab), fetched lazily when the tab opens.
  const [tasks, setTasks] = useState<CoreTaskQueueSnapshot | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  // Open file viewer (File tab): content + git diff toggle.
  const [openFile, setOpenFile] = useState<FsFilePayload | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [diffOn, setDiffOn] = useState(false);

  const openFileAt = useCallback(
    async (path: string) => {
      setFileLoading(true);
      setDiffOn(false);
      setOpenFile({ authorized: true, path, text: "", old_text: "", in_git: false, modified: false, binary: false });
      try {
        const payload = await coreBridge.fsFile(path, threadId);
        setOpenFile(payload);
      } catch {
        setOpenFile(null);
      } finally {
        setFileLoading(false);
      }
    },
    [threadId],
  );

  const cancelTaskItem = useCallback(async (taskId: string) => {
    try {
      setTasks(await coreBridge.cancelTask(taskId));
    } catch {
      /* best-effort; the next tab open refetches */
    }
  }, []);

  const loadFs = useCallback(
    async (path: string | null) => {
      setFsLoading(true);
      setFsError(null);
      setOpenFile(null);
      try {
        const result = await coreBridge.fsList(path, threadId);
        setFsRoot(result.root);
        setFsCwd(result.path);
        setFsEntries(result.authorized ? result.entries : []);
        if (!result.authorized) setFsError("Cartella non autorizzata.");
      } catch (error) {
        setFsError((error as Error).message);
        setFsEntries([]);
      } finally {
        setFsLoading(false);
      }
    },
    [threadId],
  );

  // Reset when the thread changes; (lazy) load when the File tab is shown.
  useEffect(() => {
    setFsRoot(null);
    setFsCwd(null);
    setFsEntries([]);
    setOpenFile(null);
  }, [threadId]);
  useEffect(() => {
    if (open && tab === "files" && fsCwd === null) void loadFs(null);
  }, [open, tab, fsCwd, loadFs]);
  // Load the task queue when the Attività tab is shown (and refresh on re-open).
  useEffect(() => {
    if (!open || tab !== "activity") return;
    let cancelled = false;
    setTasksLoading(true);
    void coreBridge
      .taskQueue(threadId)
      .then((snapshot) => {
        if (!cancelled) setTasks(snapshot);
      })
      .catch(() => {
        if (!cancelled) setTasks(null);
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, threadId]);

  if (!open) return null;
  const planItems = parseOperationalPlanItems(operationalPlanMarkdown);
  const activeTasks = tasks
    ? [...tasks.active, ...tasks.queued, ...tasks.blocked]
    : [];
  const atRoot = !fsRoot || fsCwd === fsRoot;
  const cwdLabel = fsCwd ? fsCwd.replace(/\/+$/, "").split("/").pop() || fsCwd : "";
  const parentOf = (path: string) => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const tabs: { key: WorkbenchTab; label: string; icon: typeof FileText; badge?: number }[] = [
    {
      key: "files",
      label: "File",
      icon: FolderOpen,
      badge: uploadedFiles.length || undefined,
    },
    {
      key: "artifacts",
      label: "Artefatti",
      icon: FileText,
      badge: artifacts.length || undefined,
    },
    {
      key: "memoria",
      label: "Memoria",
      icon: Share2,
    },
    {
      key: "activity",
      label: "Attività",
      icon: Clock3,
      badge: activeTasks.length || undefined,
    },
    {
      key: "plan",
      label: "Piano",
      icon: ListTodo,
      badge: planItems.length || undefined,
    },
  ];
  return (
    <aside
      className={`workbench${expanded ? " expanded" : ""}`}
      aria-label="Pannello di lavoro"
      style={expanded ? undefined : { width }}
    >
      {!expanded && (
        <div
          className="workbench-resize"
          role="separator"
          aria-label="Ridimensiona pannello"
          onMouseDown={startResize}
        />
      )}
      <div className="workbench-tabs" role="tablist">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.key}
              role="tab"
              type="button"
              aria-selected={tab === entry.key}
              className={`workbench-tab${tab === entry.key ? " active" : ""}`}
              onClick={() => onTab(entry.key)}
            >
              <Icon size={15} />
              <span>{entry.label}</span>
              {entry.badge ? <span className="workbench-tab-count">{entry.badge}</span> : null}
            </button>
          );
        })}
        <span className="workbench-tabs-spacer" />
        <button
          className="workbench-close"
          type="button"
          aria-label={expanded ? "Riduci pannello" : "Schermo intero"}
          title={expanded ? "Riduci" : "Schermo intero"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          className="workbench-close"
          type="button"
          aria-label="Chiudi pannello"
          title="Chiudi pannello"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="workbench-body">
        {tab === "files" && openFile && (
          <div className="workbench-fileview">
            <div className="workbench-breadcrumb">
              <button
                type="button"
                aria-label="Indietro"
                title="Torna ai file"
                onClick={() => setOpenFile(null)}
              >
                <ChevronLeft size={14} />
              </button>
              <span className="wf-name" title={openFile.path}>
                {openFile.path.split("/").pop()}
              </span>
              {fileLoading && <Loader2 size={13} className="spin" />}
              {openFile.modified && !fileLoading && (
                <button
                  type="button"
                  className={`workbench-diff-toggle${diffOn ? " active" : ""}`}
                  title="Mostra le modifiche rispetto a git"
                  onClick={() => setDiffOn((value) => !value)}
                >
                  ± Diff
                </button>
              )}
            </div>
            <div className="workbench-fileview-body">
              {openFile.error ? (
                <div className="workbench-empty">
                  <AlertCircle size={24} />
                  <p>{openFile.error}</p>
                </div>
              ) : openFile.binary ? (
                <div className="workbench-empty">
                  <FileText size={24} />
                  <p>File binario: anteprima non disponibile.</p>
                </div>
              ) : diffOn && openFile.modified ? (
                <DiffView oldText={openFile.old_text} newText={openFile.text} />
              ) : (
                <CodeView code={openFile.text} language={languageForPath(openFile.path)} />
              )}
            </div>
          </div>
        )}
        {tab === "files" && !openFile && (
          <div className="workbench-files">
            {uploadedFiles.length > 0 && (
              <>
                <div className="workbench-section-label">Caricati in questa chat</div>
                <ul className="workbench-file-list">
                  {uploadedFiles.map((file) => (
                    <li key={file.artifactId}>
                      {file.kind === "image" ? <FileImage size={15} /> : <FileText size={15} />}
                      <span className="wf-name" title={file.title}>
                        {file.title}
                      </span>
                      <small>{formatFileSize(file.sizeBytes)}</small>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {fsRoot ? (
              <>
                <div
                  className="workbench-section-label"
                  style={{ marginTop: uploadedFiles.length ? 14 : 4 }}
                >
                  Cartella di progetto
                </div>
                <div className="workbench-breadcrumb">
                  <button
                    type="button"
                    aria-label="Cartella superiore"
                    disabled={atRoot || fsLoading}
                    onClick={() => fsCwd && void loadFs(parentOf(fsCwd))}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span title={fsCwd ?? ""}>{cwdLabel}</span>
                  {fsLoading && <Loader2 size={13} className="spin" />}
                </div>
                <ul className="workbench-file-list">
                  {fsEntries.map((entry) => (
                    <li key={entry.path}>
                      {entry.is_dir ? <FolderOpen size={15} /> : <FileText size={15} />}
                      {entry.is_dir ? (
                        <button
                          type="button"
                          className="wf-name wf-dir"
                          title={entry.name}
                          onClick={() => void loadFs(entry.path)}
                        >
                          {entry.name}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="wf-name wf-file"
                          title={entry.name}
                          onClick={() => void openFileAt(entry.path)}
                        >
                          {entry.name}
                        </button>
                      )}
                      {!entry.is_dir && <small>{formatFileSize(entry.size)}</small>}
                    </li>
                  ))}
                  {fsEntries.length === 0 && !fsLoading && (
                    <li className="wf-muted">(cartella vuota)</li>
                  )}
                </ul>
              </>
            ) : (
              uploadedFiles.length === 0 && (
                <div className="workbench-empty">
                  <FolderOpen size={28} />
                  <p>
                    {fsError ??
                      "Nessun file in questa chat e nessuna cartella di progetto collegata. Allega un file (📎) o collega una cartella al progetto."}
                  </p>
                </div>
              )
            )}
          </div>
        )}
        {tab === "artifacts" &&
          (artifacts.length > 0 ? (
            <ArtifactsList artifacts={artifacts} initialName={artifactsInitial} />
          ) : (
            <div className="workbench-empty">
              <FileText size={28} />
              <p>Nessun artefatto ancora. I file generati o creati dall'assistente compaiono qui.</p>
            </div>
          ))}
        {tab === "memoria" && <MemoryGraphPanel threadId={threadId} />}
        {tab === "activity" && (
          <div className="workbench-files">
            {tasksLoading && activeTasks.length === 0 ? (
              <div className="workbench-empty">
                <Loader2 size={22} className="spin" />
                <p>Carico le attività…</p>
              </div>
            ) : activeTasks.length > 0 ? (
              <>
                <div className="workbench-section-label">Attività in corso e pianificate</div>
                <ul className="workbench-file-list">
                  {activeTasks.map((item) => (
                    <li key={item.task_id}>
                      <Clock3 size={15} />
                      <span className="wf-name" title={item.goal}>
                        {item.goal || item.kind}
                      </span>
                      <small>{item.blocked_reason ? "bloccato" : item.status}</small>
                      <button
                        type="button"
                        className="wf-cancel"
                        title="Annulla questo task"
                        aria-label="Annulla task"
                        onClick={() => void cancelTaskItem(item.task_id)}
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="workbench-empty">
                <Clock3 size={28} />
                <p>Nessuna attività in background. I task pianificati e ricorrenti compaiono qui.</p>
              </div>
            )}
          </div>
        )}
        {tab === "plan" &&
          (planItems.length > 0 ? (
            <div className="workbench-files">
              <OperationalPlanPreview collapsed={false} markdown={operationalPlanMarkdown} />
            </div>
          ) : (
            <div className="workbench-empty">
              <ListTodo size={28} />
              <p>Nessun piano operativo attivo. Quando l'assistente pianifica un compito a più passi, gli step compaiono qui.</p>
            </div>
          ))}
      </div>
    </aside>
  );
}

function ArtifactsPanel({
  artifacts,
  initialName,
  onClose,
  embedded = false,
}: {
  artifacts: ParsedArtifact[];
  initialName?: string | null;
  onClose: () => void;
  /** Rendered inside the Workbench tab: drop the standalone panel chrome
   *  (fixed position, own close/expand) — the Workbench owns those. */
  embedded?: boolean;
}) {
  const [selectedName, setSelectedName] = useState<string | null>(
    initialName ?? artifacts[0]?.name ?? null,
  );
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [loading, setLoading] = useState(false);
  // Versioning: `versions` = archived count; selectable slots are 0..versions,
  // where `versions` is the current (latest). `slot` is the shown version.
  const [versions, setVersions] = useState(0);
  const [slot, setSlot] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [diffData, setDiffData] = useState<{ oldText: string; newText: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);
  const showList = artifacts.length > 1;

  const selected = artifacts.find((a) => a.name === selectedName) ?? artifacts[0] ?? null;

  function applyPreview(next: ArtifactPreview) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "url" in next ? next.url : null;
    setPreview(next);
  }

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setEditing(false);
    setShowDiff(false);
    setDiffData(null);
    const ext = artifactExt(selected.name);
    void (async () => {
      let count = 0;
      try {
        count = await coreBridge.artifactVersions(selected.thread, selected.name);
      } catch {
        /* no versions */
      }
      if (cancelled) return;
      setVersions(count);
      setSlot(count);
      try {
        const next = await buildArtifactPreview(selected);
        if (cancelled) {
          if ("url" in next) URL.revokeObjectURL(next.url);
          return;
        }
        applyPreview(next);
      } catch {
        if (!cancelled) setPreview({ kind: "error", ext });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, reloadKey]);

  const editableKind =
    preview?.kind === "markdown" ||
    preview?.kind === "code" ||
    preview?.kind === "text" ||
    preview?.kind === "csv";
  const textKind = preview?.kind === "code" || preview?.kind === "text";
  const canDiff = textKind && versions > 0 && slot > 0;

  // Load the diff between the shown version and the previous one when requested.
  useEffect(() => {
    if (!showDiff || !selected || slot <= 0) {
      setDiffData(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const newBlob = await coreBridge.downloadArtifact(
          selected.thread,
          selected.name,
          slot < versions ? slot : undefined,
        );
        const oldBlob = await coreBridge.downloadArtifact(selected.thread, selected.name, slot - 1);
        const [newText, oldText] = await Promise.all([newBlob.text(), oldBlob.text()]);
        if (!cancelled) setDiffData({ oldText, newText });
      } catch {
        if (!cancelled) setDiffData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiff, slot, selected, versions]);

  const diffCounts = diffData ? diffStats(diffData.oldText, diffData.newText) : null;

  async function saveEdit() {
    if (!selected) return;
    setSaving(true);
    try {
      await coreBridge.saveArtifactContent(selected.thread, selected.name, editText);
      setEditing(false);
      setReloadKey((key) => key + 1);
    } catch {
      /* keep editing on failure */
    } finally {
      setSaving(false);
    }
  }

  function goToVersion(target: number) {
    if (!selected) return;
    const clamped = Math.max(0, Math.min(versions, target));
    setSlot(clamped);
    setLoading(true);
    const ext = artifactExt(selected.name);
    void (async () => {
      try {
        const next = await buildArtifactPreview(selected, clamped < versions ? clamped : undefined);
        applyPreview(next);
      } catch {
        setPreview({ kind: "error", ext });
      } finally {
        setLoading(false);
      }
    })();
  }

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return (
    <aside
      className={`artifacts-panel${expanded ? " expanded" : ""}${embedded ? " embedded" : ""}`}
      aria-label="File del progetto"
    >
      {!embedded && (
        <header className="artifacts-panel-head">
          <strong>File del progetto</strong>
          <button
            type="button"
            aria-label={expanded ? "Riduci" : "Schermo intero"}
            title={expanded ? "Riduci" : "Schermo intero"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" aria-label="Chiudi" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
      )}
      <div className={`artifacts-panel-body${showList ? "" : " no-list"}`}>
        {showList && (
          <ul className="artifacts-list">
            {artifacts.map((artifact) => (
              <li key={artifact.name}>
                <button
                  type="button"
                  className={selected?.name === artifact.name ? "active" : ""}
                  onClick={() => setSelectedName(artifact.name)}
                >
                  <FileText size={14} />
                  <span>{artifact.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="artifacts-preview">
          {selected && (
            <div className="artifacts-preview-bar">
              <span title={selected.name}>{selected.name}</span>
              {versions > 0 && (
                <div className="artifact-version-switch" aria-label="Versioni">
                  <button
                    type="button"
                    aria-label="Versione precedente"
                    disabled={slot === 0}
                    onClick={() => goToVersion(slot - 1)}
                  >
                    <ChevronLeft size={13} />
                  </button>
                  <span>
                    v{slot + 1}/{versions + 1}
                  </span>
                  <button
                    type="button"
                    aria-label="Versione successiva"
                    disabled={slot === versions}
                    onClick={() => goToVersion(slot + 1)}
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
              )}
              {canDiff && (
                <button
                  type="button"
                  className={showDiff ? "active" : ""}
                  onClick={() => setShowDiff((value) => !value)}
                  title="Mostra le modifiche rispetto alla versione precedente"
                >
                  Diff
                  {showDiff && diffCounts && (
                    <span className="diff-counts">
                      <span className="add">+{diffCounts.added}</span>{" "}
                      <span className="del">−{diffCounts.removed}</span>
                    </span>
                  )}
                </button>
              )}
              {textKind && !showDiff && (
                <button
                  type="button"
                  className={wrap ? "active" : ""}
                  onClick={() => setWrap((value) => !value)}
                  title="A capo automatico"
                >
                  Word wrap
                </button>
              )}
              {editableKind && !editing && slot === versions && (
                <button
                  type="button"
                  onClick={() => {
                    setEditText(preview && "text" in preview ? preview.text : "");
                    setEditing(true);
                  }}
                >
                  <Pencil size={14} />
                  <span>Modifica</span>
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void triggerArtifactDownload(selected, slot < versions ? slot : undefined)
                }
              >
                <Download size={14} />
                <span>Scarica</span>
              </button>
              <button
                type="button"
                className="artifact-folder"
                onClick={() => void openArtifactFolder(selected)}
                aria-label="Apri cartella"
                title="Apri cartella"
              >
                <FolderOpen size={14} />
              </button>
            </div>
          )}
          <div className="artifacts-preview-body">
            {editing ? (
              <div className="artifact-edit">
                <textarea
                  className="artifact-edit-area"
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  spellCheck={false}
                />
                <div className="artifact-edit-actions">
                  <button type="button" onClick={() => setEditing(false)} disabled={saving}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveEdit()}
                    disabled={saving}
                  >
                    {saving ? "Salvo…" : "Salva versione"}
                  </button>
                </div>
              </div>
            ) : loading ? (
              <p className="artifacts-preview-note">Carico…</p>
            ) : showDiff && diffData ? (
              <DiffView oldText={diffData.oldText} newText={diffData.newText} />
            ) : (
              <ArtifactPreviewBody preview={preview} wrap={wrap} />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function ArtifactPreviewBody({
  preview,
  wrap = false,
}: {
  preview: ArtifactPreview | null;
  wrap?: boolean;
}) {
  if (!preview) return <p className="artifacts-preview-note">Seleziona un file.</p>;
  switch (preview.kind) {
    case "image":
      return <img className="artifact-preview-img" src={preview.url} alt="" />;
    case "pdf-images":
      return (
        <div className="artifact-preview-pages">
          {preview.pages.map((src, index) => (
            <img
              key={index}
              className="artifact-preview-page"
              src={src}
              alt={`Pagina ${index + 1}`}
            />
          ))}
        </div>
      );
    case "pdf":
      return (
        <iframe
          className="artifact-preview-frame"
          src={`${preview.url}#toolbar=0&navpanes=0&view=FitH`}
          title="Anteprima PDF"
        />
      );
    case "markdown":
      return (
        <div className="artifact-preview-doc">
          <RichMessage text={preview.text} />
        </div>
      );
    case "code":
      return <CodeView code={preview.text} language={preview.ext} wrap={wrap} />;
    case "text":
      return <CodeView code={preview.text} language="text" wrap={wrap} />;
    case "csv":
      return <ArtifactCsvTable text={preview.text} />;
    case "error":
      return <p className="artifacts-preview-note">Anteprima non disponibile.</p>;
    default:
      return (
        <p className="artifacts-preview-note">
          Anteprima non disponibile per questo tipo. Usa “Scarica”.
        </p>
      );
  }
}

function ArtifactCsvTable({ text }: { text: string }) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 200)
    .map((line) => line.split(","));
  if (rows.length === 0) return <p className="artifacts-preview-note">Vuoto.</p>;
  const [head, ...body] = rows;
  return (
    <div className="artifact-preview-table-wrap">
      <table className="artifact-preview-table">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact, collapsible trace of the tool steps the assistant ran (browse, skill,
 *  sandbox, connected tools). Always collapsed by default: while streaming, the
 *  collapsed line reflects the latest action in progress; once done it shows the
 *  step count. Expanding reveals every step. Keeps the answer in focus. */
function MessageActivity({ text, live = false }: { text: string; live?: boolean }) {
  const steps = useMemo(() => parseActivitySteps(text), [text]);
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const countLabel = `Attività · ${steps.length} ${steps.length === 1 ? "passo" : "passi"}`;
  const collapsedLabel = live ? steps[steps.length - 1] : countLabel;
  return (
    <div className={`msg-activity${open ? " open" : ""}${live ? " live" : ""}`}>
      <button
        type="button"
        className="msg-activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {live && !open ? (
          <span className="msg-activity-dot" aria-hidden="true" />
        ) : (
          <SquareTerminal size={13} className="msg-activity-icon" />
        )}
        <span className="msg-activity-label">{open ? countLabel : collapsedLabel}</span>
        <ChevronDown size={13} className="msg-activity-caret" />
      </button>
      {open && (
        <ol className="msg-activity-steps">
          {steps.map((step, index) => (
            <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Splits an assistant message into visible text + an optional pending write
 *  action (editable card) OR an already-executed marker (static "done" note). */
function parseComposioConfirm(text: string): {
  visible: string;
  action: ComposioPendingAction | null;
  doneTool: string | null;
  reconnectSlug: string | null;
  fsAuthorize: { path: string; op: string } | null;
  connectSuggest: ConnectSuggest | null;
} {
  let action: ComposioPendingAction | null = null;
  const confirm = text.match(COMPOSIO_CONFIRM_RE);
  if (confirm) {
    try {
      const parsed = JSON.parse(confirm[1]) as ComposioPendingAction;
      if (parsed && typeof parsed.tool === "string") action = { ...parsed, kind: "composio" };
    } catch {
      /* malformed → just hide it */
    }
  }
  // MCP server tools use a dedicated marker → routed to /mcp/execute, not Composio.
  const mcpConfirm = text.match(MCP_CONFIRM_RE);
  if (!action && mcpConfirm) {
    try {
      const parsed = JSON.parse(mcpConfirm[1]) as ComposioPendingAction;
      if (parsed && typeof parsed.tool === "string") action = { ...parsed, kind: "mcp" };
    } catch {
      /* malformed → just hide it */
    }
  }
  // Native filesystem: in-chat "authorize this folder" card (no Settings trip).
  let fsAuthorize: { path: string; op: string } | null = null;
  const fsMatch = text.match(FS_AUTHORIZE_RE);
  if (fsMatch) {
    try {
      const parsed = JSON.parse(fsMatch[1]) as { path?: string; op?: string };
      if (parsed && typeof parsed.path === "string") {
        fsAuthorize = { path: parsed.path, op: parsed.op === "read" ? "read" : "list" };
      }
    } catch {
      /* malformed → just hide it */
    }
  }
  // Clickable connect-cards from suggest_capabilities (install skill / connect MCP
  // / link Composio in-chat, no Settings trip).
  let connectSuggest: ConnectSuggest | null = null;
  const csMatch = text.match(CONNECT_SUGGEST_RE);
  if (csMatch) {
    try {
      const parsed = JSON.parse(csMatch[1]) as ConnectSuggest;
      if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
        connectSuggest = parsed;
      }
    } catch {
      /* malformed → just hide it */
    }
  }
  const done = text.match(COMPOSIO_DONE_RE);
  const doneTool = done ? done[1].trim() : null;
  const reconnectMatch = text.match(COMPOSIO_RECONNECT_RE);
  const reconnectSlug = reconnectMatch ? reconnectMatch[1].trim() : null;
  const visible = text.replace(COMPOSIO_MARKERS_RE, "").trim();
  // A persisted "done" marker wins: never reopen the editable card.
  return {
    visible,
    action: doneTool ? null : action,
    doneTool,
    reconnectSlug,
    fsAuthorize,
    connectSuggest,
  };
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
  onOpenArtifact,
}: {
  text: string;
  streaming?: boolean;
  messageId?: string;
  threadId?: string;
  onOpenArtifact?: (artifact: ParsedArtifact) => void;
}) {
  const { visible, action, doneTool, reconnectSlug, fsAuthorize, connectSuggest } = useMemo(
    () => parseComposioConfirm(text),
    [text],
  );
  const readable = useMemo(() => humanizeToolSlugs(visible), [visible]);
  return (
    <>
      <MessageActivity text={text} />
      {readable && <RichMessage text={readable} streaming={streaming} />}
      {!streaming && onOpenArtifact && <MessageArtifacts text={text} onOpen={onOpenArtifact} />}
      {doneTool && !streaming && (
        <div className="cmp-confirm done">
          <ShieldCheck size={15} />
          <span>Azione eseguita: {humanizeToolName(doneTool)}</span>
        </div>
      )}
      {action && !streaming && (
        <ComposioConfirmCard action={action} messageId={messageId} threadId={threadId} />
      )}
      {reconnectSlug && !streaming && <ComposioReconnectCard slug={reconnectSlug} />}
      {fsAuthorize && !streaming && (
        <FsAuthorizeCard
          path={fsAuthorize.path}
          op={fsAuthorize.op}
          messageId={messageId}
          threadId={threadId}
        />
      )}
      {connectSuggest && !streaming && (
        <ConnectSuggestCard
          suggest={connectSuggest}
          messageId={messageId}
          threadId={threadId}
        />
      )}
    </>
  );
}

/** In-chat connect-cards: turns `suggest_capabilities` results into clickable
 *  actions (install skill / connect MCP / link Composio) so the user adds a
 *  capability from the conversation, never hunting in Settings. Each item tracks
 *  its own status; on success we persist via /api/connect/mark so the item shows
 *  "Collegato" on reload (the other items stay actionable). */
function ConnectSuggestCard({
  suggest,
  messageId,
  threadId,
}: {
  suggest: ConnectSuggest;
  messageId?: string;
  threadId?: string;
}) {
  return (
    <div className="cmp-confirm" style={{ gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Plug size={15} />
        <strong>Collega una capacità per «{suggest.need}»</strong>
      </div>
      <p className="set-hint" style={{ fontSize: 12, margin: 0 }}>
        Non ho ancora questo strumento. Scegli cosa collegare qui sotto — lo gestisci
        anche da Impostazioni.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {suggest.items.map((item, index) => (
          <ConnectSuggestRow
            key={`${item.kind}-${item.slug ?? item.server?.id ?? item.name}-${index}`}
            item={item}
            messageId={messageId}
            threadId={threadId}
          />
        ))}
      </div>
    </div>
  );
}

const CONNECT_KIND_META: Record<
  ConnectSuggestItem["kind"],
  { icon: typeof Plug; label: string; cta: string }
> = {
  mcp: { icon: Plug, label: "Server MCP", cta: "Connetti" },
  skill: { icon: Puzzle, label: "Skill", cta: "Installa" },
  composio: { icon: Cloud, label: "Servizio cloud", cta: "Collega" },
};

/** A single connectable suggestion. MCP servers with required params expand an
 *  inline form (mirrors Settings → Catalogo MCP); skills install directly;
 *  Composio opens the OAuth consent in the browser. */
function ConnectSuggestRow({
  item,
  messageId,
  threadId,
}: {
  item: ConnectSuggestItem;
  messageId?: string;
  threadId?: string;
}) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "opened" | "error">(
    item.connected ? "done" : "idle",
  );
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const meta = CONNECT_KIND_META[item.kind];
  const Icon = meta.icon;
  const inputs = item.kind === "mcp" ? (item.server?.inputs ?? []) : [];
  const hasInputs = inputs.length > 0;
  const missingRequired = inputs.some(
    (i) => i.required && !(values[i.key] ?? i.default ?? "").trim(),
  );

  const markConnected = async () => {
    const ref = item.kind === "mcp" ? item.server?.id : item.slug;
    if (!ref) return;
    try {
      await coreBridge.connectMark({ kind: item.kind, ref, ctx: { threadId, messageId } });
    } catch {
      /* persistence is best-effort; the connect itself already succeeded */
    }
  };

  const connectMcp = async () => {
    const server = item.server;
    if (!server) return;
    setStatus("running");
    setNote(null);
    try {
      const env: Record<string, string> = {};
      const headers: Record<string, string> = {};
      const extraArgs: string[] = [];
      for (const input of server.inputs) {
        const value = (values[input.key] ?? input.default ?? "").trim();
        if (!value) continue;
        if (input.target === "env") env[input.key] = value;
        else if (input.target === "header") headers[input.key] = value;
        else extraArgs.push(value);
      }
      const result =
        server.transport === "http"
          ? await coreBridge.mcpConnect({
              name: server.name,
              url: server.url ?? undefined,
              headers,
            })
          : await coreBridge.mcpConnect({
              name: server.name,
              command: server.command,
              args: [...server.args, ...extraArgs],
              env,
            });
      setNote(
        result.discovery_error
          ? `Connesso con avviso: ${result.discovery_error}`
          : `${result.tools_cached} strumenti disponibili.`,
      );
      setStatus("done");
      await markConnected();
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const installSkill = async () => {
    if (!item.slug) return;
    setStatus("running");
    setNote(null);
    try {
      await coreBridge.catalogInstall(item.slug);
      setStatus("done");
      setNote("Skill installata. Riprova la richiesta.");
      await markConnected();
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const linkComposio = async () => {
    if (!item.slug) return;
    setStatus("running");
    setNote(`Apro l'autorizzazione di ${item.name}…`);
    const ok = await connectComposioToolkit(item.slug, {
      onStatus: (s) => {
        if (s === "connecting") {
          setNote(`Autorizza ${item.name} nel browser: rilevo automaticamente quando è fatto…`);
        }
      },
    });
    if (ok) {
      setStatus("done");
      setNote(`${item.name} connesso.`);
      await markConnected();
    } else {
      setStatus("error");
      setNote("Connessione non completata. Riprova, o collega da Impostazioni → Connettori.");
    }
  };

  // MCP with required params → expand the form first; otherwise act immediately.
  const onPrimary = () => {
    if (item.kind === "mcp") {
      if (hasInputs && !expanded) {
        setExpanded(true);
        return;
      }
      void connectMcp();
    } else if (item.kind === "skill") {
      void installSkill();
    } else {
      void linkComposio();
    }
  };

  const done = status === "done";
  const opened = status === "opened";

  return (
    <div
      className="conn-tool"
      style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="conn-tool-main" style={{ minWidth: 0 }}>
          <span className="conn-tool-name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icon size={13} />
            {item.name}
            {item.official && (
              <span className="set-badge green" style={{ marginLeft: 4 }} title="Server ufficiale">
                <ShieldCheck size={11} /> Ufficiale
              </span>
            )}
            <span className="mdl-tag" style={{ marginLeft: 2 }}>
              {meta.label}
            </span>
          </span>
          {item.description && <span className="conn-tool-desc">{item.description}</span>}
        </div>
        {done ? (
          <span className="set-badge green" title="Collegato">
            <Check size={12} /> Collegato
          </span>
        ) : (
          <button
            className="set-btn primary"
            type="button"
            disabled={status === "running"}
            onClick={onPrimary}
          >
            {status === "running"
              ? "…"
              : item.kind === "mcp" && hasInputs && !expanded
                ? "Configura"
                : meta.cta}
          </button>
        )}
      </div>

      {expanded && item.kind === "mcp" && !done && (
        <div className="mdl-field" style={{ gap: 8, marginTop: 2 }}>
          {inputs.map((input) => (
            <div key={input.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label className="mdl-field-label">
                {input.label}
                {input.required ? " *" : " (opzionale)"}
                {input.secret && " · segreto"}
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="set-input"
                  type={input.secret && !reveal[input.key] ? "password" : "text"}
                  placeholder={input.default ?? input.key}
                  value={values[input.key] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [input.key]: e.target.value }))
                  }
                />
                {input.secret && (
                  <button
                    className="set-btn"
                    type="button"
                    title={reveal[input.key] ? "Nascondi" : "Mostra"}
                    onClick={() =>
                      setReveal((prev) => ({ ...prev, [input.key]: !prev[input.key] }))
                    }
                  >
                    {reveal[input.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="cmp-confirm-actions">
            <button
              className="set-btn primary"
              type="button"
              disabled={status === "running" || missingRequired}
              onClick={() => void connectMcp()}
            >
              {status === "running" ? "Connetto…" : "Connetti"}
            </button>
            {item.server?.homepage && (
              <a
                href={item.server.homepage}
                target="_blank"
                rel="noreferrer"
                className="set-hint"
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
              >
                Pagina del progetto <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      )}

      {note && (
        <p className={`set-hint${status === "error" ? " error" : ""}`} style={{ fontSize: 12, margin: 0 }}>
          {opened && <ExternalLink size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />}
          {note}
        </p>
      )}
    </div>
  );
}

/** One-click reconnect for an EXPIRED Composio connector, surfaced in-chat so the
 *  user re-authorizes without hunting in Settings. OAuth re-consent is unavoidable
 *  (security), so this opens the provider's consent and asks the user to retry. */
/** In-chat card to grant the assistant access to a folder — so the user
 *  authorizes (and sees the result) without leaving the conversation. */
function FsAuthorizeCard({
  path,
  op,
  messageId,
  threadId,
}: {
  path: string;
  op: string;
  messageId?: string;
  threadId?: string;
}) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [output, setOutput] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result = await coreBridge.fsAuthorize(path, op, { threadId, messageId });
      if (!result.ok) {
        setStatus("error");
        setNote(result.summary || "Autorizzazione non riuscita.");
        return;
      }
      setOutput(result.output ?? "");
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  if (status === "done") {
    return (
      <div className="cmp-confirm">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldCheck size={15} />
          <strong>Accesso concesso a {path}</strong>
        </div>
        {output && (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              marginTop: 8,
              maxHeight: 300,
              overflow: "auto",
            }}
          >
            {output}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="cmp-confirm">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ShieldCheck size={15} />
        <strong>Dare accesso a questa cartella?</strong>
      </div>
      <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", marginTop: 4 }}>
        {path}
      </code>
      <p className="set-hint" style={{ fontSize: 12 }}>
        Potrò leggere file e cartelle qui dentro. Lo gestisci anche da Impostazioni → Computer.
      </p>
      {status === "error" && <p className="cmp-confirm-err">Non riuscito: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void run()}
        >
          <ShieldCheck size={14} />
          <span style={{ marginLeft: 6 }}>
            {status === "running"
              ? "Autorizzo…"
              : op === "read"
                ? "Autorizza e leggi"
                : "Autorizza ed elenca"}
          </span>
        </button>
      </div>
    </div>
  );
}

function ComposioReconnectCard({ slug }: { slug: string }) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);

  const reconnect = async () => {
    setStatus("running");
    setNote(`Apro la riconnessione di ${name}…`);
    const ok = await connectComposioToolkit(slug, {
      onStatus: (s) => {
        if (s === "connecting") {
          setNote(`Autorizza ${name} nel browser: rilevo automaticamente quando è fatto…`);
        }
      },
    });
    if (ok) {
      setStatus("done");
      setNote(`${name} ricollegato.`);
    } else {
      setStatus("error");
      setNote("Riconnessione non completata. Riprova, o usa Impostazioni → Connettori.");
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
  return (
    <div className="cmp-confirm">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Collegamento scaduto</strong>
        <span className="cmp-confirm-name">{name}</span>
      </div>
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void reconnect()}
        >
          {status === "running" ? "Apro…" : `Riconnetti ${name}`}
        </button>
      </div>
      {note && (status === "running" || status === "error") && (
        <p className={`cmp-confirm-note ${status === "error" ? "error" : ""}`}>{note}</p>
      )}
    </div>
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
  // Calendar / events
  summary: "Titolo",
  title: "Titolo",
  description: "Descrizione",
  location: "Luogo",
  start_datetime: "Inizio",
  end_datetime: "Fine",
  start_time: "Inizio",
  end_time: "Fine",
  start: "Inizio",
  end: "Fine",
  due_date: "Scadenza",
  date: "Data",
  attendees: "Partecipanti",
  timezone: "Fuso orario",
};

/** Opaque machine identifiers: the model needs them, but showing them to the user
 *  in a confirm card is noise (e.g. event_id) — they can't verify or edit them.
 *  Hidden from the card (still SENT in the arguments). */
const OPAQUE_FIELD_KEYS = new Set([
  "id",
  "event_id",
  "calendar_id",
  "message_id",
  "thread_id",
  "draft_id",
  "user_id",
  "connected_account_id",
  "connection_id",
  "entity_id",
  "resource_id",
  "file_id",
]);

/** "GMAIL_SEND_EMAIL" → "Send email · Gmail"; "mcp__fs__read_file" → "read file · fs". */
function humanizeToolName(slug: string): string {
  // MCP tools are namespaced `mcp__{server}__{tool}` → "tool · server".
  if (slug.startsWith("mcp__")) {
    const rest = slug.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2).replace(/[_-]+/g, " ").trim();
      return `${tool || rest} · ${server}`;
    }
  }
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

  const isMcp = action.kind === "mcp";
  const run = async (scope: "once" | "always") => {
    setStatus("running");
    setNote(null);
    try {
      const result = isMcp
        ? await coreBridge.mcpExecute(action.tool, args, { threadId, messageId })
        : await coreBridge.composioExecute(action.tool, args, scope, { threadId, messageId });
      if (!result.ok) {
        // The backend replied but the action failed — never show a green "done".
        setStatus("error");
        setNote(result.summary || "Azione non riuscita.");
        return;
      }
      setStatus("done");
      setNote(
        scope === "always" && !isMcp
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

  // Show only meaningful fields; opaque ids (event_id…) are still SENT, just hidden.
  const keys = Object.keys(args).filter((k) => !OPAQUE_FIELD_KEYS.has(k.toLowerCase()));
  const hiddenIdCount = Object.keys(args).length - keys.length;
  // Flag destructive actions (delete/remove/cancel/…) so the user can't approve a
  // data-loss op blindly — the real "leggi le email" → it confirmed DELETE_EVENT
  // bug. Slugs are underscore-separated, so match by segment.
  const destructive = action.tool
    .toUpperCase()
    .split("_")
    .some((part) =>
      ["DELETE", "REMOVE", "TRASH", "CANCEL", "CLEAR", "DROP", "PURGE", "REVOKE", "UNSEND", "DESTROY"].includes(part),
    );
  return (
    <div className={`cmp-confirm${destructive ? " destructive" : ""}`}>
      <div className="cmp-confirm-head">
        {destructive ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
        <strong>{destructive ? "Conferma: azione che ELIMINA dati" : "Conferma azione"}</strong>
        <span className="cmp-confirm-name">{title}</span>
      </div>
      {destructive && (
        <p className="cmp-confirm-warn">
          ⚠ Azione DISTRUTTIVA su {humanizeToolName(action.tool).split(" · ")[1] ?? "un servizio collegato"}: elimina/rimuove dati. Procedi solo se è esattamente ciò che vuoi.
        </p>
      )}
      <div className="cmp-confirm-fields">
        {keys.length === 0 && (
          <p className="cmp-confirm-empty">
            {hiddenIdCount > 0
              ? "L'azione agisce sull'elemento già individuato (nessun campo da modificare)."
              : "Nessun parametro."}
          </p>
        )}
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
        {!isMcp && (
          <button
            className="set-btn"
            type="button"
            disabled={status === "running"}
            onClick={() => void run("always")}
            title={`Non chiedere più per ${title}`}
          >
            Esegui sempre
          </button>
        )}
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
  threadId,
  onCancelStreaming,
  onClearReply,
  onSubmit,
}: {
  disabled: boolean;
  error: string | null;
  replyContext: ReplyContext | null;
  streaming: boolean;
  threadId: string;
  onCancelStreaming: () => void;
  onClearReply: () => void;
  onSubmit: (
    prompt: string,
    attachments: ChatAttachmentInput[],
    options?: {
      model?: string;
      forcedSkillId?: string;
      contextText?: string;
      images?: string[];
    },
  ) => void;
}) {
  const [value, setValue] = useState("");
  const [linkedFolder, setLinkedFolder] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [folderPathInput, setFolderPathInput] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [contextFiles, setContextFiles] = useState<
    Array<{ path: string; content: string; truncated: boolean }>
  >([]);
  const [models, setModels] = useState<string[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // True once the user picks a model from the menu (a per-message override): then
  // a refresh must NOT clobber their choice with the default.
  const [userPickedModel, setUserPickedModel] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  // Refetches the model list + default (= orchestrator role). Called on mount and
  // when the menu opens, so a Settings change to the default reflects without an
  // app restart.
  async function refreshModels() {
    try {
      const list = await coreBridge.runtimeModels();
      setModels(list.available ?? []);
      setActiveModel(list.active);
      if (!userPickedModel) setSelectedModel(list.active);
    } catch {
      /* models unavailable → selector hidden */
    }
  }
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [forcedSkill, setForcedSkill] = useState<SkillSummary | null>(null);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const [composerAttachmentError, setComposerAttachmentError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; name: string; size: number; type: string; localPath: string }>
  >([]);
  const [composerImages, setComposerImages] = useState<
    Array<{ id: string; name: string; dataUrl: string }>
  >([]);
  const [dragOver, setDragOver] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await refreshModels();
      try {
        const response = await coreBridge.skills();
        if (cancelled) return;
        setSkills((response.skills ?? []).filter((skill) => skill.enabled));
      } catch {
        /* skills unavailable → picker hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function startDictation() {
    setDictationError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => void finishDictation();
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setDictationError("Microfono non disponibile o permesso negato.");
    }
  }

  function stopDictation() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    setRecording(false);
  }

  async function finishDictation() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    const blob = new Blob(audioChunksRef.current, {
      type: mediaRecorderRef.current?.mimeType || "audio/webm",
    });
    audioChunksRef.current = [];
    if (blob.size === 0) return;
    setTranscribing(true);
    try {
      const base64 = await blobToBase64(blob);
      const text = await coreBridge.transcribe(base64);
      if (text) {
        setValue((current) => (current.trim() ? `${current.trim()} ${text}` : text));
        requestAnimationFrame(() => {
          adjustComposerHeight();
          textareaRef.current?.focus();
        });
      }
    } catch (error) {
      setDictationError(describeBridgeError(error));
    } finally {
      setTranscribing(false);
    }
  }

  // Load the conversation's linked folder; reset @ state when the thread changes.
  useEffect(() => {
    let cancelled = false;
    setContextFiles([]);
    setFileMenuOpen(false);
    setFileQuery("");
    void (async () => {
      try {
        const { path } = await coreBridge.threadFolder(threadId);
        if (!cancelled) setLinkedFolder(path);
      } catch {
        if (!cancelled) setLinkedFolder(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Search files in the linked folder as the query changes (while the @ menu is open).
  useEffect(() => {
    if (!fileMenuOpen || !linkedFolder) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const files = await coreBridge.searchThreadFiles(threadId, fileQuery);
          if (!cancelled) setFileResults(files);
        } catch {
          if (!cancelled) setFileResults([]);
        }
      })();
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [fileMenuOpen, fileQuery, linkedFolder, threadId]);

  async function linkFolderPath(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const result = await coreBridge.setThreadFolder(threadId, trimmed);
      setLinkedFolder(result.path);
      setFolderPathInput("");
    } catch (error) {
      setFolderError(describeBridgeError(error));
    } finally {
      setFolderBusy(false);
    }
  }

  async function browseFolder() {
    if (folderBusy) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const path = await coreBridge.pickFolder();
      if (path) {
        const result = await coreBridge.setThreadFolder(threadId, path);
        setLinkedFolder(result.path);
      } else {
        setFolderError("Selettore non disponibile: incolla il percorso della cartella qui sotto.");
      }
    } catch (error) {
      setFolderError(describeBridgeError(error));
    } finally {
      setFolderBusy(false);
    }
  }

  function unlinkFolder() {
    void coreBridge.setThreadFolder(threadId, null).catch(() => undefined);
    setLinkedFolder(null);
    setFileMenuOpen(false);
    setContextFiles([]);
  }

  async function addContextFile(path: string) {
    if (contextFiles.some((file) => file.path === path)) {
      setFileMenuOpen(false);
      return;
    }
    try {
      const file = await coreBridge.readThreadFile(threadId, path);
      setContextFiles((current) => [...current, file]);
    } catch {
      /* unreadable file → ignore */
    }
    setFileMenuOpen(false);
    setFileQuery("");
    textareaRef.current?.focus();
  }

  function buildContextText(): string | undefined {
    if (contextFiles.length === 0) return undefined;
    const blocks = contextFiles.map((file) => {
      const note = file.truncated ? " (troncato)" : "";
      return `### File: ${file.path}${note}\n\`\`\`\n${file.content}\n\`\`\``;
    });
    return `Contesto dai file allegati dalla cartella collegata:\n\n${blocks.join("\n\n")}`;
  }

  const folderName = linkedFolder
    ? linkedFolder.replace(/\/+$/, "").split("/").pop() || linkedFolder
    : null;

  const filteredSkills = skills.filter((skill) => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      skill.name.toLowerCase().includes(q) ||
      skill.id.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q)
    );
  });

  async function handleImprovePrompt() {
    const draft = value.trim();
    if (!draft || improving || disabled) return;
    setImproving(true);
    setImproveError(null);
    try {
      const improved = await coreBridge.improvePrompt(draft);
      if (improved && improved !== draft) {
        setValue(improved);
        requestAnimationFrame(() => {
          adjustComposerHeight();
          textareaRef.current?.focus();
        });
      }
    } catch (error) {
      setImproveError(describeBridgeError(error));
    } finally {
      setImproving(false);
    }
  }

  function adjustComposerHeight() {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }

  function submitCurrentValue() {
    const prompt = value.trim();
    // Allow images-only messages (vision); supply a sensible default prompt.
    if ((!prompt && composerImages.length === 0) || disabled) return;
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
    const images = composerImages.map((image) => image.dataUrl);
    const effectivePrompt = prompt || "Descrivi questa immagine.";
    const modelOverride =
      selectedModel && selectedModel !== activeModel ? selectedModel : undefined;
    const forcedSkillId = forcedSkill?.id;
    const contextText = buildContextText();
    setValue("");
    setAttachments([]);
    setComposerImages([]);
    setContextFiles([]);
    setComposerAttachmentError(null);
    requestAnimationFrame(adjustComposerHeight);
    onSubmit(effectivePrompt, attachmentInputs, {
      model: modelOverride,
      forcedSkillId,
      contextText,
      images: images.length > 0 ? images : undefined,
    });
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

  // Reads image files (paste/drop) into base64 data URLs for vision models.
  function addImageFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    images.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = String(reader.result);
        if (!dataUrl.startsWith("data:image/")) return;
        setComposerImages((current) => [
          ...current,
          { id: `${file.name}_${file.size}_${file.lastModified}_${current.length}`, name: file.name, dataUrl },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }

  function removeComposerImage(id: string) {
    setComposerImages((current) => current.filter((item) => item.id !== id));
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length > 0) {
      event.preventDefault();
      addImageFiles(images);
    }
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      setDragOver(false);
      return;
    }
    event.preventDefault();
    // Images → vision (base64 inline); everything else (PDF, docs, text) →
    // attachment with its on-disk path, same as the paperclip picker.
    const images = files.filter((file) => file.type.startsWith("image/"));
    const others = files.filter((file) => !file.type.startsWith("image/"));
    if (images.length > 0) addImageFiles(images);
    if (others.length > 0) {
      setAttachments((current) => [
        ...current,
        ...others.map((file) => ({
          id: `${file.name}_${file.size}_${file.lastModified}`,
          name: file.name,
          size: file.size,
          type: file.type || "file",
          localPath: fileLocalPath(file),
        })),
      ]);
    }
    setDragOver(false);
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
    <form
      className={`composer-surface${dragOver ? " drag-over" : ""}`}
      aria-label="Prompt operativo"
      onSubmit={handleSubmit}
      onDrop={handleComposerDrop}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file")) {
          event.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragOver(false);
      }}
    >
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
        onPaste={handleComposerPaste}
        placeholder="Invia un messaggio o aggiungi istruzioni al task"
        ref={textareaRef}
        value={value}
      />
      {composerImages.length > 0 && (
        <div className="composer-image-tray" aria-label="Immagini allegate">
          {composerImages.map((image) => (
            <span className="composer-image-thumb" key={image.id}>
              <img src={image.dataUrl} alt={image.name} />
              <button
                type="button"
                aria-label={`Rimuovi ${image.name}`}
                onClick={() => removeComposerImage(image.id)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
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
      {forcedSkill && (
        <div className="composer-forced-skill" aria-label="Skill forzata per il prossimo messaggio">
          <Puzzle size={13} />
          <span>{forcedSkill.name}</span>
          <button type="button" aria-label="Rimuovi skill" onClick={() => setForcedSkill(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {contextFiles.length > 0 && (
        <div className="composer-context-files" aria-label="File allegati come contesto">
          {contextFiles.map((file) => (
            <span className="composer-file-chip" key={file.path} title={file.path}>
              <AtSign size={12} />
              <span>{file.path.split("/").pop()}</span>
              <button
                type="button"
                aria-label={`Rimuovi ${file.path}`}
                onClick={() =>
                  setContextFiles((current) => current.filter((item) => item.path !== file.path))
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {improveError && <span className="composer-error">{improveError}</span>}
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
            title="Allega file"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={17} />
          </button>
          <div className="composer-pop-wrap">
            <button
              className={`icon-button${contextFiles.length > 0 || linkedFolder ? " active" : ""}`}
              type="button"
              aria-label={linkedFolder ? "Menziona un file della cartella" : "Collega una cartella"}
              aria-expanded={fileMenuOpen}
              title={
                linkedFolder
                  ? `Menziona un file · ${folderName}`
                  : "Collega una cartella alla conversazione"
              }
              onClick={() => {
                setFileMenuOpen((open) => !open);
                setSkillMenuOpen(false);
                setModelMenuOpen(false);
              }}
            >
              <AtSign size={17} />
            </button>
            {fileMenuOpen && !linkedFolder && (
              <div className="composer-pop composer-skill-pop" role="menu">
                <div className="composer-pop-link">
                  <p className="composer-pop-link-title">
                    Collega una cartella a questa conversazione
                  </p>
                  <p className="composer-pop-link-hint">
                    Poi potrai menzionare i suoi file con <strong>@</strong>.
                  </p>
                  <button
                    type="button"
                    className="composer-link-browse"
                    disabled={folderBusy}
                    onClick={() => void browseFolder()}
                  >
                    {folderBusy ? <Loader2 size={14} className="composer-spin" /> : <Search size={14} />}
                    Sfoglia…
                  </button>
                  <div className="composer-pop-search">
                    <input
                      type="text"
                      placeholder="…oppure incolla il percorso"
                      value={folderPathInput}
                      onChange={(event) => setFolderPathInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void linkFolderPath(folderPathInput);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="composer-link-confirm"
                      disabled={folderBusy || !folderPathInput.trim()}
                      onClick={() => void linkFolderPath(folderPathInput)}
                    >
                      Collega
                    </button>
                  </div>
                  {folderError && <p className="composer-pop-error">{folderError}</p>}
                </div>
              </div>
            )}
            {fileMenuOpen && linkedFolder && (
              <div className="composer-pop composer-skill-pop" role="menu">
                <div className="composer-pop-folder">
                  <span title={linkedFolder}>📁 {folderName}</span>
                  <button type="button" onClick={unlinkFolder} title="Scollega cartella">
                    Scollega
                  </button>
                </div>
                <div className="composer-pop-search">
                  <Search size={14} />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Cerca file…"
                    value={fileQuery}
                    onChange={(event) => setFileQuery(event.target.value)}
                  />
                </div>
                <div className="composer-pop-list">
                  {fileResults.length === 0 ? (
                    <p className="composer-pop-empty">Nessun file</p>
                  ) : (
                    fileResults.map((file) => (
                      <button
                        key={file}
                        type="button"
                        role="menuitem"
                        onClick={() => void addContextFile(file)}
                      >
                        <strong>{file.split("/").pop()}</strong>
                        <small>{file}</small>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {skills.length > 0 && (
            <div className="composer-pop-wrap">
              <button
                className={`icon-button${forcedSkill ? " active" : ""}`}
                type="button"
                aria-label="Scegli una skill"
                aria-expanded={skillMenuOpen}
                title="Usa una skill"
                onClick={() => {
                  setSkillMenuOpen((open) => !open);
                  setModelMenuOpen(false);
                }}
              >
                <Puzzle size={17} />
              </button>
              {skillMenuOpen && (
                <div className="composer-pop composer-skill-pop" role="menu">
                  <div className="composer-pop-search">
                    <Search size={14} />
                    <input
                      autoFocus
                      type="text"
                      placeholder="Cerca skill"
                      value={skillQuery}
                      onChange={(event) => setSkillQuery(event.target.value)}
                    />
                  </div>
                  <div className="composer-pop-list">
                    {filteredSkills.length === 0 ? (
                      <p className="composer-pop-empty">Nessuna skill</p>
                    ) : (
                      filteredSkills.map((skill) => (
                        <button
                          key={skill.id}
                          type="button"
                          role="menuitem"
                          className={forcedSkill?.id === skill.id ? "active" : ""}
                          onClick={() => {
                            setForcedSkill(skill);
                            setSkillMenuOpen(false);
                            setSkillQuery("");
                            textareaRef.current?.focus();
                          }}
                        >
                          <strong>{skill.name}</strong>
                          <small>{skill.description}</small>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label="Migliora il prompt"
            title="Migliora il prompt"
            disabled={disabled || improving || !value.trim()}
            onClick={() => void handleImprovePrompt()}
          >
            {improving ? <Loader2 size={17} className="composer-spin" /> : <WandSparkles size={17} />}
          </button>
        </div>
        <div className="composer-actions">
          <button
            className={`icon-button${recording ? " recording" : ""}`}
            type="button"
            aria-label={recording ? "Ferma dettatura" : "Dettatura vocale"}
            title={recording ? "Ferma e trascrivi" : "Dettatura vocale (multilingua)"}
            disabled={transcribing}
            onClick={() => (recording ? stopDictation() : void startDictation())}
          >
            {transcribing ? (
              <Loader2 size={17} className="composer-spin" />
            ) : recording ? (
              <span className="composer-stop-square" aria-hidden="true" />
            ) : (
              <Mic size={17} />
            )}
          </button>
          {models.length > 0 && (
            <div className="composer-pop-wrap">
              <button
                className="composer-model-button"
                type="button"
                aria-label="Scegli il modello"
                aria-expanded={modelMenuOpen}
                onClick={() => {
                  setModelMenuOpen((open) => {
                    if (!open) void refreshModels();
                    return !open;
                  });
                  setSkillMenuOpen(false);
                }}
              >
                <span>{shortModelName(selectedModel ?? activeModel ?? "modello")}</span>
                <ChevronDown size={14} />
              </button>
              {modelMenuOpen && (
                <div className="composer-pop composer-model-pop" role="menu">
                  <div className="composer-pop-list">
                    {models.map((modelId) => (
                      <button
                        key={modelId}
                        type="button"
                        role="menuitem"
                        className={selectedModel === modelId ? "active" : ""}
                        onClick={() => {
                          setSelectedModel(modelId);
                          setUserPickedModel(true);
                          setModelMenuOpen(false);
                        }}
                      >
                        {selectedModel === modelId ? <Check size={14} /> : <span className="composer-model-dot" />}
                        <span>{modelId}</span>
                        {modelId === activeModel && <small>default</small>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {error && <span className="composer-error">{error}</span>}
          {composerAttachmentError && (
            <span className="composer-error">{composerAttachmentError}</span>
          )}
          {dictationError && <span className="composer-error">{dictationError}</span>}
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

interface ResumeMarker {
  requestId: string;
  userText: string;
  assistantMessageId: string;
}

function resumeMarkerKey(threadId: string) {
  return `lfpa.resume.${threadId}`;
}

function writeResumeMarker(threadId: string, marker: ResumeMarker) {
  try {
    window.localStorage.setItem(resumeMarkerKey(threadId), JSON.stringify(marker));
  } catch {
    /* storage unavailable → resume simply won't be offered */
  }
}

function clearResumeMarker(threadId: string) {
  try {
    window.localStorage.removeItem(resumeMarkerKey(threadId));
  } catch {
    /* ignore */
  }
}

function readResumeMarker(threadId: string): ResumeMarker | null {
  try {
    const raw = window.localStorage.getItem(resumeMarkerKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeMarker;
    if (parsed && parsed.requestId && parsed.assistantMessageId) return parsed;
  } catch {
    /* ignore malformed */
  }
  return null;
}

/** Reads a Blob as a base64 string (without the `data:...;base64,` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Trims a long model id (e.g. provider prefixes) for the inline selector. */
function shortModelName(model: string): string {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return tail.length > 22 ? `${tail.slice(0, 21)}…` : tail;
}

function formatContextTokens(n: number): string {
  if (!n || n <= 0) return "contesto n/d";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `~${Number.isInteger(m) ? m : m.toFixed(1)}M ctx`;
  }
  return `~${Math.round(n / 1000)}k ctx`;
}

/** Maps a file extension to a highlight.js language for the file viewer. */
function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    rs: "rust", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", go: "go", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
    rb: "ruby", php: "php", sh: "bash", bash: "bash", zsh: "bash", json: "json",
    yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", md: "markdown", markdown: "markdown",
    html: "xml", xml: "xml", css: "css", scss: "scss", sql: "sql",
  };
  return map[ext] ?? "text";
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileLocalPath(file: File): string {
  // Electron >= 32 removed File.path; resolve via webUtils.getPathForFile (preload
  // bridge). Falls back to the legacy property for any older shell, then "".
  const viaBridge = fileLocalPathFromBridge(file);
  if (viaBridge) return viaBridge;
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
