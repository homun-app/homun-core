import {
  ArrowUp,
  AlertCircle,
  AtSign,
  BarChart3,
  BookMarked,
  ClipboardList,
  Presentation,
  Check,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Bot,
  Braces,
  Bug,
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
  GitMerge,
  AlertTriangle,
  Globe2,
  HardDrive,
  ListTodo,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic,
  Minimize2,
  Monitor,
  MoreHorizontal,
  Paperclip,
  Plus,
  Pause,
  Pencil,
  Play,
  Plug,
  Puzzle,
  Reply,
  RotateCcw,
  Search,
  Share2,
  Tag,
  Target,
  CheckSquare,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  WandSparkles,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ForceGraph2D from "react-force-graph-2d";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  coreBridge,
  subscribeAppEvents,
  type ActiveModelInfo,
  type ChatAttachmentInput,
  type CoreBranchPoint,
  type CoreChatStreamEvent,
  type CoreComputerSessionSnapshot,
  type CorePromptSubmissionResult,
  type CoreTaskQueueSnapshot,
  type ProjectGoalsData,
  type FsEntry,
  type FsFilePayload,
  type McpRegistryServer,
  type MemoryArtifactView,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryHygieneSuggestion,
  type MemoryWikiPage,
  type PaymentApprovalSnapshot,
  type ProjectSubdir,
  modelIsCloud,
  type ProviderModelsGroup,
  type SkillsSummary,
  type VaultProposalAcceptResult,
} from "../lib/coreBridge";
import { wsSubscription } from "../lib/wsSubscription";
import {
  createLoadingComputerSession,
  createUnavailableComputerSession,
  mapCoreComputerSession,
} from "../lib/localComputerViewModel";
import { captureAppScreenshot, fileLocalPathFromBridge, IS_DESKTOP } from "../lib/gatewayConfig";
import { copyText } from "../lib/clipboard";
import { connectComposioToolkit } from "../lib/composioConnect";
import {
  STRUCTURED_MARKER_DELTA_RE,
  COMPOSIO_CONFIRM_RE,
  MCP_CONFIRM_RE,
  FS_AUTHORIZE_RE,
  SANDBOX_ESCALATE_RE,
  CONNECT_SUGGEST_RE,
  COMPOSIO_DONE_RE,
  COMPOSIO_RECONNECT_RE,
  VAULT_PROPOSE_RE,
  VAULT_REVEAL_RE,
  PAYMENT_APPROVAL_RE,
  CHOICES_RE,
  PLAN_PROPOSE_RE,
  GOAL_PROPOSE_RE,
  UNCLOSED_PROPOSE_RE,
  COMPOSIO_MARKERS_RE,
  PROPOSE_MARKERS_VISIBLE_RE,
  ACTIVITY_RE,
  ARTIFACT_RE,
  PLAN_RE,
} from "../lib/markers";
import { MarkdownEditor } from "./MarkdownEditor";
import { RichMessage } from "./RichMessage";
import { CodeView, DiffView, diffStats } from "./CodeView";
import { ChatComputerPanel } from "./ChatComputerPanel";
import { ProjectContextPanel } from "./ProjectContextPanel";
import { WorkspaceIsland } from "./WorkspaceIsland";
import type {
  ChatMessage,
  ChatMessageMetrics,
  ChatEventPart,
  ChatAttachment,
  ChatThread,
  ComputerSession,
  ComputerSurfaceKind,
  ApprovelItem,
  RuntimeHealth,
  TaskItem,
  DiffEventPayload,
} from "../types";

const CHAT_VIEW_SESSION_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat_view_${Date.now()}_${Math.random().toString(36).slice(2)}`;

interface ChatViewProps {
  approvals: ApprovelItem[];
  approvalBusyId: string | null;
  computerSessionId: string;
  messages: ChatMessage[];
  health: RuntimeHealth[];
  task: TaskItem;
  thread: ChatThread;
  onMessagesChange: (
    messages: ChatMessage[],
    options?: { advanceActivity?: boolean },
  ) => void;
  onOpenTasks: () => void;
  onApproveApprovel: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void;
  onRejectApprovel: (approvalId: string) => void;
  onRuntimeChanged: () => void | Promise<void>;
  onThreadChanged: () => void | Promise<void>;
  // Fires when this thread starts/stops generating, so the parent can mark the
  // thread busy in the sidebar in real time (before the 2.5s taskQueue poll).
  onStreamingChange?: (busy: boolean) => void;
  // Pre-fill the composer (e.g. engaging a proactivity card opens a chat seeded
  // with the card's context). The nonce re-applies the same text.
  seed?: { text: string; nonce: number } | null;
  autoSubmit?: ChatAutoSubmit | null;
  onAutoSubmitConsumed?: (id: string) => void;
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
type ChatStreamPhase = "accepted" | "thinking" | "writing" | "recalling";

function chatEventPartFromStream(event: CoreChatStreamEvent): ChatEventPart | null {
  switch (event.type) {
    case "reasoning":
      return { type: "reasoning", text: event.text };
    case "activity":
      return { type: "activity", text: event.text };
    case "plan_update":
      return { type: "plan_update", markdown: event.markdown };
    case "choice_prompt":
    case "vault_propose":
    case "vault_reveal":
    case "payment_approval":
    case "tool_result":
    case "recall":
    case "diff":
      return { type: event.type, payload: event.payload } as ChatEventPart;
    default:
      return null;
  }
}

function normalizeChatEventParts(parts: unknown[] | undefined): ChatEventPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part): ChatEventPart[] => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    switch (item.type) {
      case "reasoning":
      case "activity":
        return typeof item.text === "string" ? [{ type: item.type, text: item.text }] : [];
      case "plan_update":
        return typeof item.markdown === "string"
          ? [{ type: "plan_update", markdown: item.markdown }]
          : [];
      case "choice_prompt":
      case "vault_propose":
      case "vault_reveal":
      case "payment_approval":
      case "tool_result":
      case "recall":
      case "diff":
        return [{ type: item.type, payload: item.payload } as ChatEventPart];
      default:
        return [];
    }
  });
}

function shouldDropStructuredMarkerDelta(delta: string) {
  return STRUCTURED_MARKER_DELTA_RE.test(delta.trim());
}

export interface ChatStreamStatus {
  requestId: string;
  phase: ChatStreamPhase;
  title: string;
  detail: string;
}

interface ChatAutoSubmit {
  id: string;
  threadId: string;
  prompt: string;
  visibleText: string;
  attachments: ChatAttachmentInput[];
  visibleAttachments?: ChatAttachment[];
  mode?: string;
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
  // Live workspace state: accumulates activity/plan events DURING streaming so
  // the island shows them in real-time (not just after the persisted text arrives).
  // Cleared on submit; superseded by the persisted values when streaming ends.
  const [liveActivitySteps, setLiveActivitySteps] = useState<string[]>([]);
  const [livePlanMarkdown, setLivePlanMarkdown] = useState<string | null>(null);
  // Track the active turn_id for WS event filtering. Set when a turn starts,
  // cleared when it ends. Used by the wsSubscription subscriber to route events.
  const activeTurnIdRef = useRef<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [chatExported, setChatExported] = useState(false);
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  // Persisted conversation branches (non-destructive edit + regenerate). Each
  // entry is a node on the active path that has alternative siblings, driving the
  // ‹ n/m › switcher. Replaces the old ephemeral, reload-lossy "variants".
  const [branches, setBranches] = useState<CoreBranchPoint[]>([]);
  const [branchBusy, setBranchBusy] = useState(false);
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
  // "Artefatti" tab; File / Computer / Activity / Piano land in later phases.
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("files");
  const [artifactsInitial, setArtifactsInitial] = useState<string | null>(null);
  const [memoryArtifacts, setMemoryArtifacts] = useState<MemoryArtifactView[]>([]);
  // Is this thread a project? Reliable context signal (not keyword-detection) that gates
  // the "Save as goal" message action + the Obiettivi tab. `goalSeed` pre-fills
  // the Obiettivi compose when promoting a chat message to a goal.
  const [threadIsProject, setThreadIsProject] = useState(false);
  const [projectGoalCount, setProjectGoalCount] = useState(0);
  const [projectMemoryCount, setProjectMemoryCount] = useState(0);
  const [goalSeed, setGoalSeed] = useState<string | null>(null);
  const [computerLiveStatus, setComputerLiveStatus] = useState<{
    active: boolean;
    activity: string | null;
  }>({ active: false, activity: null });
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [followUpsFor, setFollowUpsFor] = useState<string | null>(null);
  const titledThreadsRef = useRef<Set<string>>(new Set());
  const resumedThreadsRef = useRef<Set<string>>(new Set());
  const consumedAutoSubmitIdsRef = useRef<Set<string>>(new Set());
  const conversationRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const streamingUserPinnedRef = useRef(false);
  const streamingFrameRef = useRef<number | null>(null);
  const cancelStreamingRequestRef = useRef<(() => void) | null>(null);
  const cancelledStreamIdsRef = useRef<Set<string>>(new Set());
  // Tracks whether THIS ChatView instance is still mounted. The chat stream
  // (submitChat) keeps running in the background after the user navigates to
  // another thread (the gateway persists the answer; the client still commits
  // it). This guard prevents a detached instance from touching dead state — the
  // final commit lands via the same closure, but UI updates are skipped.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  // Notifies the parent of streaming start/stop. A ref holds the latest callback
  // so the unmount cleanup ([]) fires only on REAL unmount — not on every render,
  // which would immediately undo a `notifyStreaming(true)` and flicker the dot off.
  const onStreamingChangeRef = useRef(onStreamingChange);
  onStreamingChangeRef.current = onStreamingChange;
  const notifyStreaming = useCallback((busy: boolean) => {
    if (!isMountedRef.current && busy) return;
    onStreamingChangeRef.current?.(busy);
  }, []);
  useEffect(() => {
    return () => {
      notifyStreaming(false);
    };
  }, [notifyStreaming]);
  // ── Unified WS subscription for turn events ──
  // Listens for turn.event messages on the WS for the currently-active turn.
  // Feeds the island (activity steps + plan markdown) in real-time, independent
  // of the bridge NDJSON stream. This is the primary live channel for the island.
  useEffect(() => {
    const unsub = wsSubscription.subscribe((msg) => {
      if (msg.type !== "turn.event") return;
      const turnId = msg.turn_id as string | undefined;
      if (!turnId || turnId !== activeTurnIdRef.current) return;
      const kind = msg.kind as string;
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (kind === "activity" && payload?.text) {
        setLiveActivitySteps((prev) =>
          [...prev, String(payload.text).trim()].filter((s) => s.length > 0),
        );
      } else if (kind === "plan_update" && payload?.markdown) {
        setLivePlanMarkdown(String(payload.markdown));
      }
    });
    return unsub;
  }, []);
  const activeHealth = useMemo(
    () => health.filter((item) => item.status !== "attention").slice(0, 2),
    [health],
  );
  // The backend seeds a placeholder "ready" greeting on every new thread (id ends
  // "_ready"). The designed new-chat experience is the centered hero, so hide that
  // greeting: a thread whose only message is the greeting then renders as empty →
  // ChatEmptyHero shows; threads with real messages no longer carry a stray greeting
  // on top. It's a contentless placeholder, so dropping it from context too is fine.
  const threadMessages = useMemo(() => {
    const base = optimisticMessages ?? messages;
    return base.filter((m) => !(m.role === "assistant" && m.id.endsWith("_ready")));
  }, [optimisticMessages, messages]);
  // All artifacts generated in this conversation (from persisted ‹‹ARTIFACT››
  // markers) — drives the Artifacts workspace panel.
  // ADR 0022 (Piano UI C2): dipende dai messaggi PERSISTED (`messages`), NON da
  // `threadMessages` (che include optimisticMessages e cambia ogni frame di stream).
  // Così questo memo NON ricalcola durante lo streaming del messaggio corrente —
  // il vero riduttore di jank su thread lunghi. Gli artifact del messaggio streaming
  // si vedono quando viene persisted.
  const conversationArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const out: ParsedArtifact[] = [];
    for (const message of messages) {
      if (message.role === "assistant" && message.id.endsWith("_ready")) continue;
      for (const artifact of parseArtifacts(message.text ?? "")) {
        if (!seen.has(artifact.name)) {
          seen.add(artifact.name);
          out.push(artifact);
        }
      }
    }
    return out;
  }, [messages]);
  const workbenchArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const out: ParsedArtifact[] = [];
    for (const artifact of conversationArtifacts) {
      seen.add(artifact.name);
      out.push(artifact);
    }
    for (const artifact of memoryArtifacts) {
      const displayName = artifact.project_relative_path || artifact.name;
      if (!displayName || seen.has(displayName)) continue;
      seen.add(displayName);
      out.push({
        name: displayName,
        thread: thread.threadId,
        size: artifact.size,
        updated: artifact.updated,
        source: "project",
        projectPath: artifact.project_path ?? undefined,
        projectRelativePath: artifact.project_relative_path ?? displayName,
      });
    }
    return out;
  }, [conversationArtifacts, memoryArtifacts, thread.threadId]);
  // The agent's operational plan for this conversation (latest update_plan), shown
  // in the Workbench "Piano" panel. Merge of two lines:
  //  - Piano UI C2 (persisted): the fallback derives from PERSISTED `messages`, NOT
  //    `threadMessages` (which changes every stream frame → churn).
  //  - unified-WS live island: during streaming, prefer the live-accumulated
  //    plan/activity from the stream events so the island updates in real-time.
  // Net: live while streaming, persisted-from-`messages` at rest.
  const persistedPlan = useMemo(() => latestPlanMarkdown(messages), [messages]);
  const persistedActivity = useMemo(() => latestActivitySteps(messages), [messages]);
  const isStreaming = promptSubmitting || Boolean(streamingAssistantId);
  const conversationPlan = isStreaming && livePlanMarkdown ? livePlanMarkdown : persistedPlan;
  const conversationActivity = isStreaming && liveActivitySteps.length > 0 ? liveActivitySteps : persistedActivity;
  const workspacePlanSteps = useMemo(
    () => (conversationPlan ? parsePlanSteps(conversationPlan) : []),
    [conversationPlan],
  );
  // Files the user uploaded in THIS conversation (e.g. the patente PDF), derived
  // from message attachments — the chat-context "File" tab of the Workbench.
  const uploadedFiles = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatAttachment[] = [];
    for (const message of messages) {
      if (message.role === "assistant" && message.id.endsWith("_ready")) continue;
      for (const attachment of message.attachments ?? []) {
        if (!seen.has(attachment.title)) {
          seen.add(attachment.title);
          out.push(attachment);
        }
      }
    }
    return out;
  }, [messages]);
  const activeApprovels = approvals.filter((approval) =>
    approval.requestedBy.includes(computerSessionId),
  );
  const availableWorkbenchViews = useMemo(
    () =>
      PANEL_VIEWS.filter((view) => {
        if (view.key === "artifacts") return workbenchArtifacts.length > 0;
        if (view.key === "files") return uploadedFiles.length > 0;
        if (view.key === "activity") return conversationActivity.length > 0 || activeApprovels.length > 0;
        if (view.key === "plan") return workspacePlanSteps.length > 0;
        if (view.key === "goals") return projectGoalCount > 0 || Boolean(goalSeed);
        if (view.key === "memoria") return projectMemoryCount > 0;
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
    ],
  );
  const workbenchOpen = artifactsOpen;
  const visibleComputerSession = useMemo(
    () => ({
      ...computerSession,
      timeline: computerSession.timeline.filter(isUserVisibleComputerEvent),
    }),
    [computerSession],
  );
  const showComputerActivity =
    activeApprovels.length > 0 ||
    planStepRunning ||
    smokeTestRunning ||
    detailsOpen;

  useEffect(() => {
    if (availableWorkbenchViews.some((view) => view.key === workbenchTab)) return;
    if (artifactsOpen) {
      const next = availableWorkbenchViews[0]?.key;
      if (next) {
        setWorkbenchTab(next);
      } else {
        setArtifactsOpen(false);
      }
    }
  }, [artifactsOpen, availableWorkbenchViews, workbenchTab]);

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
    mode?: string,
    branchFromId?: string,
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
    const promptMessages = [...conversationBase, userMessage];
    const requestId = `chat_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    activeTurnIdRef.current = `turn_${requestId}`;
    setStreamStatus({
      requestId,
      phase: "accepted",
      title: t("chat.promptReceived"),
      detail: "Preparing the request for the local model.",
    });
    setOptimisticMessages(promptMessages);
    onMessagesChange(promptMessages);
    const streamingMessage: ChatMessage = {
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
      streamingFrameRef.current = null;
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
      streamingUserPinnedRef.current = conversationBottomDistance() < 220;
      window.setTimeout(() => scrollConversationToBottomIfPinned("auto"), 0);
      cancelStreamingRequestRef.current = cancelStreamingRequest;
      // Record an active stream so a reload mid-answer can reattach (resume).
      writeResumeMarker(thread.threadId, {
        requestId,
        userText: userVisibleText,
        assistantMessageId: streamingMessage.id,
      });
      unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
        if (payload.request_id !== requestId) return;
        if (cancelledStreamIdsRef.current.has(requestId)) return;
        const part = chatEventPartFromStream(payload);
        if (part) {
          // ADR 0022 (Piano UI A2): quando arriva un evento recall, mostra la fase
          // "Sto controllando la memoria…" (precedenza su thinking/writing).
          if (part.type === "recall") {
            const count = part.payload?.hits?.length ?? 0;
            setStreamStatus({
              requestId,
              phase: "recalling",
              title: t("chat.recalling"),
              detail:
                count > 0
                  ? t("chat.recallingHits", { count })
                  : t("chat.recallingNoHits"),
            });
          }
          streamEventParts = [...streamEventParts, part];
          // Feed the island in real-time from live activity/plan events.
          if (part.type === "activity" && part.text) {
            setLiveActivitySteps((prev) => [...prev, part.text!.trim()].filter((s) => s.length > 0));
          } else if (part.type === "plan_update" && part.markdown) {
            setLivePlanMarkdown(part.markdown);
          }
          scheduleStreamingMessage();
          return;
        }
        if (payload.type !== "delta") return;
        if (shouldDropStructuredMarkerDelta(payload.delta)) return;
        const firstDelta = streamedText.length === 0;
        streamChunks += 1;
        streamedText += payload.delta;
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
        setStreamHasVisibleText(true);
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
      );
      if (cancelledStreamIdsRef.current.has(requestId)) {
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
      if (cancelledStreamIdsRef.current.has(requestId)) {
        return;
      }
      setComputerSession(mapCoreComputerSession(result.computer_session));
      setComputerCardCollapsed(true);
      setTimelineCollapsed(!result.plan);
      // Model that produced THIS turn. Prefer the gateway's authoritative
      // x-effective-model (via result.effective_model) — it reflects what ACTUALLY ran
      // (the chat role default is NOT the global activeModelInfo). Fall back to the
      // picked override's model, then the global default.
      const turnModel =
        result.effective_model ??
        (model ? model.split("::").pop() ?? model : activeModelInfo?.model ?? undefined);
      const finalAssistantMessage: ChatMessage = {
        ...withChatMetrics(
          chatMessageFromAssistantResult(result, result.assistant_message.text || streamedText),
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
        setLiveActivitySteps([]);
        setLivePlanMarkdown(null);
        setStreamStatus((current) =>
          current?.requestId === requestId ? null : current,
        );
        setPromptSubmitting(false);
      }
      notifyStreaming(false);
      if (cancelStreamingRequestRef.current === cancelStreamingRequest) {
        cancelStreamingRequestRef.current = null;
      }
      cancelledStreamIdsRef.current.delete(requestId);
      activeTurnIdRef.current = null;
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
    );
    // submitPrompt intentionally owns the live streaming lifecycle. This effect
    // only bridges externally-created threads into that canonical chat pipeline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit, promptSubmitting, streamingAssistantId, thread.threadId]);

  function cancelActiveStreaming() {
    cancelStreamingRequestRef.current?.();
  }

  // Reattach to an answer that was streaming when the app was reloaded: replays
  // the buffered events from the gateway and continues live, then persists.
  async function resumeActiveStream(marker: ResumeMarker, options?: { commitResult?: boolean }) {
    if (promptSubmitting || streamingAssistantId) return;
    const shouldAutoTitleAfterResume = isPlaceholderThreadTitle(thread.title);
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
      metadata: "Local model",
    };
    const promptMessages = [...messages, userMessage];
    let streamedText = "";
    let streamEventParts: ChatEventPart[] = [];
    let unlistenStream: (() => void) | undefined;
    const flushStreamingMessage = () => {
      streamingFrameRef.current = null;
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
      if (streamingFrameRef.current !== null) return;
      streamingFrameRef.current = window.requestAnimationFrame(flushStreamingMessage);
    };

    setPromptSubmitting(true);
    setOptimisticMessages([...promptMessages, streamingMessage]);
    resetStreamingState("");
    setStreamingAssistantId(streamingMessage.id);
    notifyStreaming(true);
    streamingUserPinnedRef.current = true;
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: t("chat.resumingResponse"),
      detail: t("chat.reattachingGeneration"),
    });
    try {
      unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
        if (payload.request_id !== requestId) return;
        const part = chatEventPartFromStream(payload);
        if (part) {
          streamEventParts = [...streamEventParts, part];
          scheduleStreamingMessage();
          return;
        }
        if (payload.type !== "delta") return;
        if (shouldDropStructuredMarkerDelta(payload.delta)) return;
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
      const finalAssistant = chatMessageFromAssistantResult(result, streamedText);
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
      streamingUserPinnedRef.current = false;
      setStreamingAssistantId(null);
      resetStreamingState("");
      setStreamStatus((current) => (current?.requestId === requestId ? null : current));
      setPromptSubmitting(false);
      notifyStreaming(false);
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

  // Seed text for the composer (empty-state quick-action chips prefill it; bump the
  // nonce so the same chip re-applies).
  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number } | null>(
    null,
  );

  // External seed (e.g. a proactivity card engaged from the dashboard) → prefill
  // the composer. Keyed by nonce so re-engaging the same card re-applies.
  useEffect(() => {
    if (seed && seed.text.trim()) {
      setComposerSeed({ text: seed.text, nonce: seed.nonce });
    }
  }, [seed?.nonce]);

  function submitComposerPrompt(
    prompt: string,
    attachments: ChatAttachmentInput[],
    options?: {
      model?: string;
      mode?: string;
      forcedSkillsId?: string;
      contextText?: string;
      images?: string[];
    },
  ) {
    const activeReplyContext = replyContext;
    setReplyContext(null);
    const images = options?.images;
    const mode = options?.mode;

    // Forcing a skill (🧩 picker) augments the MODEL-facing prompt while the
    // user still sees their clean text. The gateway honors "usa la skill X".
    const skillPrefix = options?.forcedSkillsId
      ? `Use the skill \`${options.forcedSkillsId}\` to fulfill this request.\n\n`
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
          undefined,
          mode,
        );
      } else {
        void submitPrompt(prompt, attachments, undefined, undefined, model, images, undefined, mode);
      }
      return;
    }

    const promptWithReplyContext = [
      skillPrefix,
      contextPrefix,
      "Reply to the quoted message keeping the context.",
      `Quoted message (${messageRoleLabel(activeReplyContext.role)}):`,
      activeReplyContext.preview,
      "",
      "User request:",
      prompt,
    ].join("\n");
    void submitPrompt(promptWithReplyContext, attachments, undefined, prompt, model, images, undefined, mode);
  }

  async function copyMessageText(message: ChatMessage) {
    if (!message.text) return;
    const ok = await copyText(message.text);
    if (!ok) return;
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1_400);
  }

  // Export the whole conversation as Markdown to the clipboard — so the user can
  // paste the full thread (e.g. to report a usability issue). Control markers
  // (activity/plan/confirmation) are stripped; generated files become "[file: …]".
  async function exportChatMarkdown() {
    const strip = (raw: string) =>
      raw
        .replace(/‹‹ARTIFACT››([\s\S]*?)‹‹\/ARTIFACT››/g, (_m, j) => {
          try {
            return `\n_[file: ${JSON.parse(j).name}]_`;
          } catch {
            return "\n_[file]_";
          }
        })
        .replace(/‹‹(ACT|PLAN|COMPOSIO_[A-Z]+)››[\s\S]*?‹‹\/\1››/g, "")
        .replace(/‹‹[A-Z_]+››|‹‹\/[A-Z_]+››/g, "")
        .trim();
    const lines: string[] = [`# ${thread.title || "Chat"}`, ""];
    for (const m of threadMessages) {
      const who = m.role === "user" ? "Utente" : m.role === "assistant" ? "Homun" : m.role;
      lines.push(`## ${who}`, "", strip(m.text ?? "") || "_(vuoto)_", "");
    }
    const ok = await copyText(lines.join("\n"));
    if (ok) {
      setChatExported(true);
      window.setTimeout(() => setChatExported(false), 1_800);
    }
  }

  // Capture the whole app window to a PNG and reveal it in Finder — the user can then
  // share the image to show the actual UI / pagination / a broken state.
  async function captureScreenshot() {
    await captureAppScreenshot();
  }

  // Refresh the persisted branch map for this thread (which nodes have siblings).
  const refreshBranches = useCallback(async () => {
    try {
      const next = await coreBridge.chatBranches(thread.threadId);
      if (isMountedRef.current) setBranches(next);
    } catch {
      /* switcher is best-effort; ignore */
    }
  }, [thread.threadId]);

  // Reload whenever the persisted conversation changes (after a send, edit,
  // regenerate or switch). Optimistic streaming doesn't touch `messages`, so this
  // doesn't fire mid-stream.
  useEffect(() => {
    void refreshBranches();
  }, [refreshBranches, messages]);

  // Switch the displayed branch at a node: point the thread's active leaf at the
  // chosen sibling's tip, then resync the (mapped) messages from the gateway.
  async function switchBranch(point: CoreBranchPoint, direction: number) {
    if (branchBusy || promptSubmitting || streamingAssistantId) return;
    const index = point.active_index + direction;
    if (index < 0 || index >= point.options.length) return;
    setBranchBusy(true);
    try {
      await coreBridge.setActiveLeaf(thread.threadId, point.options[index].leaf_id);
      setOptimisticMessages(null);
      await onThreadChanged();
      await refreshBranches();
    } catch (error) {
      setPromptError(describeBridgeError(error));
    } finally {
      setBranchBusy(false);
    }
  }

  // Phase 4: name (or clear) a branch so the switcher labels it — handy for the
  // coding workflow ("try A" vs "try B"). Minimal inline prompt.
  async function renameBranch(childId: string, current: string | null) {
    const input = window.prompt(t("chat.branchLabelPrompt"), current ?? "");
    if (input === null) return;
    const label = input.trim();
    try {
      setBranches(await coreBridge.setBranchLabel(thread.threadId, childId, label || null));
    } catch (error) {
      setPromptError(describeBridgeError(error));
    }
  }

  // Regenerate an assistant answer as a persisted SIBLING branch under its user
  // message — streamed into the same slot, then committed to the chat tree.
  function regenerateAnswer(messageId: string) {
    if (promptSubmitting || streamingAssistantId) return;
    const assistant = threadMessages.find((message) => message.id === messageId);
    const previousUser = findPreviousUserMessage(threadMessages, messageId);
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
      streamingFrameRef.current = null;
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
      if (streamingFrameRef.current !== null) return;
      streamingFrameRef.current = window.requestAnimationFrame(flushStreamingMessage);
    };
    const cancelStreamingRequest = () => {
      cancelledStreamIdsRef.current.add(requestId);
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
    streamingUserPinnedRef.current = conversationBottomDistance() < 220;
    window.setTimeout(() => scrollConversationToBottomIfPinned("auto"), 0);
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: t("chat.regeneratingResponse"),
      detail: t("chat.generatingAlternativeVariant"),
    });
    cancelStreamingRequestRef.current = cancelStreamingRequest;
    unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
      if (payload.request_id !== requestId) return;
      if (cancelledStreamIdsRef.current.has(requestId)) return;
      const part = chatEventPartFromStream(payload);
      if (part) {
        streamEventParts = [...streamEventParts, part];
        scheduleStreamingMessage();
        return;
      }
      if (payload.type !== "delta") return;
      if (shouldDropStructuredMarkerDelta(payload.delta)) return;
      streamedText += payload.delta;
      setStreamHasVisibleText(true);
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
      if (cancelledStreamIdsRef.current.has(requestId)) return;
      cancelScheduledStreamingFrame();
      setComputerSession(mapCoreComputerSession(result.computer_session));
      setComputerCardCollapsed(true);
      setTimelineCollapsed(!result.plan);
      // The new answer is now a sibling in the tree; resync the real path + switcher.
      await refreshAfterChatSubmit();
      setOptimisticMessages(null);
      await refreshBranches();
    } catch (error) {
      setPromptError(t("chat.regenerateFailed", { error: describeBridgeError(error) }));
    } finally {
      cancelScheduledStreamingFrame();
      unlistenStream?.();
      streamingUserPinnedRef.current = false;
      setStreamingAssistantId(null);
      resetStreamingState("");
      setPromptSubmitting(false);
      setStreamStatus((current) => (current?.requestId === requestId ? null : current));
      notifyStreaming(false);
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

  // Resolve once per thread whether it's a project (gates "Save as goal").
  useEffect(() => {
    let cancelled = false;
    setThreadIsProject(false);
    setProjectGoalCount(0);
    setProjectMemoryCount(0);
    void coreBridge
      .projectGoals(thread.threadId)
      .then((d) => {
        if (cancelled) return;
        const isProject = Boolean(d?.is_project);
        setThreadIsProject(isProject);
        setProjectGoalCount(d?.goals.length ?? 0);
        if (!isProject) {
          setProjectMemoryCount(0);
          return;
        }
        void coreBridge
          .memoryGraph(thread.threadId)
          .then((graph) => {
            if (!cancelled) {
              setProjectMemoryCount(Math.max(0, graph.nodes.length - 1));
            }
          })
          .catch(() => {
            if (!cancelled) setProjectMemoryCount(0);
          });
      })
      .catch(() => {
        if (cancelled) return;
        setThreadIsProject(false);
        setProjectGoalCount(0);
        setProjectMemoryCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.threadId]);

  useEffect(() => {
    let cancelled = false;
    void coreBridge
      .memoryArtifacts(thread.threadId)
      .then((items) => {
        if (!cancelled) setMemoryArtifacts(items);
      })
      .catch(() => {
        if (!cancelled) setMemoryArtifacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.threadId, threadMessages]);

  // Promote a chat message to a project objective: hand the text off to the Obiettivi
  // panel's compose (open Workbench → Obiettivi tab, pre-filled) so the user trims and
  // confirms with the polished UI — never auto-saving long prose verbatim.
  function saveMessageAsGoal(text?: string | null) {
    const seed = (text ?? "").trim();
    if (!seed) return;
    setGoalSeed(seed);
    setArtifactsOpen(true);
    setWorkbenchTab("goals");
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
    const continuationPrompt =
      "Continue the previous response from where it stopped. Do not repeat already written parts. Keep the same language and format.";
    void submitPrompt(continuationPrompt, [], [], "Continue");
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
      streamingFrameRef.current = null;
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
    notifyStreaming(true);
    resetStreamingState(message.text);
    streamingUserPinnedRef.current = conversationBottomDistance() < 220;
    window.setTimeout(() => scrollConversationToBottomIfPinned("auto"), 0);
    setStreamStatus({
      requestId,
      phase: "thinking",
      title: t("chat.continuingResponse"),
      detail: t("chat.generationLimitReached", { attempt }),
    });
    cancelStreamingRequestRef.current = cancelStreamingRequest;
    unlistenStream = await coreBridge.listenChatStreamEvent((payload) => {
      if (payload.request_id !== requestId) return;
      if (cancelledStreamIdsRef.current.has(requestId)) return;
      const part = chatEventPartFromStream(payload);
      if (part) {
        streamEventParts = [...streamEventParts, part];
        scheduleStreamingMessage();
        return;
      }
      if (payload.type !== "delta") return;
      if (shouldDropStructuredMarkerDelta(payload.delta)) return;
      const firstDelta = streamedText.length === message.text.length;
      streamedText += payload.delta;
      if (firstDelta) {
        setStreamStatus({
          requestId,
          phase: "writing",
          title: t("chat.assistantContinuing"),
          detail: t("chat.completingInSameMessage"),
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
        message.model,
      );
      if (cancelledStreamIdsRef.current.has(requestId)) {
        return baseMessages;
      }
      streamedText = result.assistant_message.text || streamedText;
      streamEventParts = [];
      cancelScheduledStreamingFrame();
      const updatedMessage = chatMessageFromAssistantResult(result, streamedText);
      const nextMessages = baseMessages.map((item) =>
        item.id === message.id ? updatedMessage : item,
      );
      setComputerSession(mapCoreComputerSession(result.computer_session));
      setComputerCardCollapsed(true);
      setTimelineCollapsed(!result.plan);
      setOptimisticMessages(nextMessages);
      onMessagesChange(nextMessages, { advanceActivity: true });
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
      notifyStreaming(false);
      if (cancelStreamingRequestRef.current === cancelStreamingRequest) {
        cancelStreamingRequestRef.current = null;
      }
      cancelledStreamIdsRef.current.delete(requestId);
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
    const followUpPrompt = [
      instruction,
      "Keep the same language as the user.",
      "",
      "Previous response:",
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
                t("chat.noComputerSessionFound"),
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
    const commitResult = !isOwnResumeMarker(marker);
    resumedThreadsRef.current.add(thread.threadId);
    void resumeActiveStream(marker, { commitResult });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.threadId]);

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
  const headerModelLabel = activeModelInfo ? shortModelName(activeModelInfo.model) : "Model";
  const headerModelMeta = activeModelInfo
    ? `${activeModelInfo.locality} · ${formatContextTokens(activeModelInfo.context_window)}`
    : t("chat.active");
  const headerToolPolicy = thread.source ? t("chat.readOnlyChannel") : t("chat.fullLocalTools");

  return (
    <section
      className={`chat-view active-task-layout${detailsOpen || workbenchOpen ? " panel-open" : ""}${
        threadMessages.length === 0 ? " is-empty" : ""
      }`}
      aria-labelledby="chat-title"
    >
      <header className="task-topbar">
        <div className="task-title-area">
          <div className="task-title-button" style={{ cursor: "default" }}>
            <span id="chat-title">{thread.title}</span>
          </div>
        </div>

      </header>

      <div className="chat-status-stack" aria-label="Live workspace status">
        {/* ADR 0022: un unico pannello unificato — ProjectContextPanel (solo progetti)
            + WorkspaceIsland fusi visivamente in una sola card contigua, senza gap. */}
        <div className={`unified-status-panel${thread.workspaceId ? " has-project-context" : ""}`}>
          {thread.workspaceId && <ProjectContextPanel threadId={thread.threadId} />}
          <WorkspaceIsland
            threadId={thread.threadId}
            activitySteps={conversationActivity}
            computerActivity={computerLiveStatus.activity}
            computerLive={computerLiveStatus.active}
            planSteps={workspacePlanSteps}
            streaming={promptSubmitting || Boolean(streamingAssistantId)}
            status={streamStatus}
            threadHasMessages={threadMessages.length > 0}
            onCaptureScreenshot={IS_DESKTOP ? () => void captureScreenshot() : undefined}
            onExportChat={() => void exportChatMarkdown()}
            onOpenWorkbench={(tab) => {
              setArtifactsInitial(null);
              setWorkbenchTab(tab);
              setArtifactsOpen(true);
            }}
          />
        </div>
        <ChatComputerPanel threadId={thread.threadId} onLiveChange={setComputerLiveStatus} />
      </div>

      <div className="thread-scroll" aria-label={t("chat.activeThread")} ref={conversationRef}>
        <div className="thread-content">
          <div className="thread-message-list">
          {threadMessages.length === 0 && !promptSubmitting && (
            <ChatEmptyHero
              onPick={(text) => setComposerSeed({ text, nonce: Date.now() })}
            />
          )}
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
              {displayMessage.role === "system" && (
                <header className="assistant-label system-label">
                  <Clock3 size={15} />
                  <strong>{t("chat.status")}</strong>
                  <span>{t("chat.roleSystem")}</span>
                </header>
              )}
              {isStreamingMessage ? (
                <>
                  {!streamHasVisibleText && (
                    <AssistantThinkingState status={streamStatus} />
                  )}
                  {displayMessage.text && (
                    <AssistantMessageBody
                      text={displayMessage.text}
                      eventParts={displayMessage.eventParts}
                      streaming
                      messageId={displayMessage.id}
                      threadId={thread.threadId}
                      onOpenArtifact={(artifact) => {
                        setArtifactsInitial(artifact.name);
                        setWorkbenchTab("artifacts");
                        setArtifactsOpen(true);
                      }}
                      onChoose={(answer) => void submitComposerPrompt(answer, [])}
                    />
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
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!editingText.trim()}
                      onClick={saveEditedMessage}
                    >
                      {t("chat.saveAndSend")}
                    </button>
                  </div>
                </div>
              ) : displayMessage.text ? (
                <>
                  {/* The ‹‹ACT››…‹‹/ACT›› trace markers are already persisted inside
                      chat_messages.text; mounting it here (not just on the live streaming
                      path) makes a turn's activity survive reload instead of vanishing
                      once streaming ends. */}
                  {assistantMessage && (
                    <MessageActivity text={displayMessage.text} live={false} />
                  )}
                  <AssistantMessageBody
                    text={displayMessage.text}
                    eventParts={displayMessage.eventParts}
                    messageId={displayMessage.id}
                    threadId={thread.threadId}
                    onOpenArtifact={(artifact) => {
                      setArtifactsInitial(artifact.name);
                      setWorkbenchTab("artifacts");
                      setArtifactsOpen(true);
                    }}
                    onChoose={(answer) => void submitComposerPrompt(answer, [])}
                  />
                </>
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
                    {t("chat.responseLikelyInterrupted")}
                  </div>
                )}
                {autoContinueMessageId === displayMessage.id && (
                  <div className="auto-continue-status" role="status" aria-live="polite">
                    <Sparkles size={14} />
                    <span>{t("chat.autoCompleting")}</span>
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
                  canExpand={assistantTextMessage}
                  canSaveToMemory={assistantOperationalMessage}
                  canSaveAsGoal={assistantOperationalMessage && threadIsProject}
                  feedback={displayMessage.feedback}
                  metrics={displayMessage.metrics}
                  savedToMemory={Boolean(displayMessage.savedMemoryRef)}
                  onCopy={() => copyMessageText(displayMessage)}
                  onContinue={() => continueAssistantResponse(displayMessage.id)}
                  onExpand={() => expandAssistantResponse(displayMessage.id)}
                  onExplainCode={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Explain code",
                      "Explain the previous code briefly and operationally.",
                    )
                  }
                  onExplainDiagram={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Explain diagram",
                      "Explain the previous diagram briefly and operationally.",
                    )
                  }
                  onFeedback={(feedback) => void setMessageFeedback(displayMessage, feedback)}
                  onImproveCode={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Improve code",
                      "Improve the previous code keeping it short and including a fenced markdown block.",
                    )
                  }
                  onReply={() => replyToMessage(displayMessage)}
                  onEdit={() => startEditMessage(displayMessage)}
                  onRegenerate={() => regenerateAnswer(displayMessage.id)}
                  onReviseDiagram={() =>
                    askAboutAssistantResponse(
                      displayMessage.id,
                      "Edit diagram",
                      "Propose an improved version of the previous diagram in a fenced mermaid markdown block.",
                    )
                  }
                  onSaveToMemory={() => void saveMessageToMemory(displayMessage)}
                  onSaveAsGoal={() => saveMessageAsGoal(displayMessage.text)}
                />
                </>
              )}
              {!isStreamingMessage &&
                (() => {
                  const point = branches.find((b) => b.node_id === displayMessage.id);
                  if (!point || point.options.length < 2) return null;
                  const active = point.options[point.active_index];
                  const label = active?.label ?? null;
                  return (
                    <div className="branch-picker" aria-label={t("chat.responseVariants")}>
                      <button
                        type="button"
                        aria-label={t("chat.prevVariant")}
                        disabled={branchBusy || point.active_index === 0}
                        onClick={() => void switchBranch(point, -1)}
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <span>
                        {point.active_index + 1} / {point.options.length}
                      </span>
                      <button
                        type="button"
                        aria-label={t("chat.nextVariant")}
                        disabled={branchBusy || point.active_index === point.options.length - 1}
                        onClick={() => void switchBranch(point, 1)}
                      >
                        <ChevronRight size={14} />
                      </button>
                      {label && <span className="branch-label">{label}</span>}
                      <button
                        type="button"
                        className="branch-rename"
                        aria-label={t("chat.branchLabelAria")}
                        title={t("chat.branchLabelAria")}
                        onClick={() => void renameBranch(displayMessage.id, label)}
                      >
                        <Tag size={13} />
                      </button>
                    </div>
                  );
                })()}
              {!isStreamingMessage &&
                followUpsFor === displayMessage.id &&
                followUps.length > 0 && (
                  <div className="chat-followups" aria-label={t("chat.followUpQuestions")}>
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
                {displayMessage.role === "assistant" ? (
                  <>
                    {/* Model label intentionally hidden (override verified via
                        x-effective-model). Duration+tokens are robust: the cloud path
                        leaves elapsed_seconds=0 but total_elapsed_seconds is the real
                        wall-clock; tokens are estimated from text when not provided. */}
                    {(() => {
                      const m = displayMessage.metrics;
                      if (!m) return null;
                      const secs =
                        m.elapsedSeconds > 0 ? m.elapsedSeconds : m.totalElapsedSeconds ?? 0;
                      if (secs <= 0) return null;
                      const tokens =
                        m.generationTokens > 0
                          ? m.generationTokens
                          : Math.max(1, Math.round((displayMessage.text?.length ?? 0) / 4));
                      return (
                        <span>
                          {formatChatDuration(secs)} · {tokens} token
                        </span>
                      );
                    })()}
                    {/* ADR 0022 (Piano UI A3): memory badge — quante memorie sono
                        state richiamate per questa risposta. Derivato dalle
                        eventParts recall (se l'evento Recall è stato emesso). */}
                    {(() => {
                      const recallCount =
                        displayMessage.eventParts
                          ?.filter((p) => p.type === "recall")
                          .reduce((sum, p) => sum + (p.payload?.hits?.length ?? 0), 0) ?? 0;
                      if (recallCount === 0) return null;
                      return (
                        <span
                          className="memory-recall-badge"
                          title={displayMessage.eventParts
                            ?.filter((p) => p.type === "recall")
                            .flatMap((p) => p.payload?.hits ?? [])
                            .map((h) => `• ${h.text}`)
                            .join("\n")}
                        >
                          📝 {t("chat.memoryBadge", { count: recallCount })}
                        </span>
                      );
                    })()}
                  </>
                ) : (
                  visibleMessageMetadata(displayMessage.metadata) && (
                    <span>{visibleMessageMetadata(displayMessage.metadata)}</span>
                  )
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
                <span>{t("chat.roleAssistant")}</span>
              </header>
              <AssistantThinkingState status={streamStatus} />
            </article>
          )}

          <InlineApprovelPanel
            approvals={activeApprovels}
            busyId={approvalBusyId}
            session={visibleComputerSession}
            onApprove={onApproveApprovel}
            onReject={onRejectApprovel}
          />
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
          aria-label={t("chat.jumpToLast")}
          title={t("chat.jumpToBottom")}
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
        artifacts={workbenchArtifacts}
        artifactsInitial={artifactsInitial}
        uploadedFiles={uploadedFiles}
        threadId={thread.threadId}
        projectThread={threadIsProject}
        goalSeed={goalSeed}
        onGoalSeedConsumed={() => setGoalSeed(null)}
        operationalPlanMarkdown={conversationPlan ?? visibleComputerSession.operationalPlanMarkdown}
      />

      <Composer
        disabled={promptSubmitting}
        error={promptError}
        replyContext={replyContext}
        seed={composerSeed}
        streaming={promptSubmitting}
        threadId={thread.threadId}
        onCancelStreaming={cancelActiveStreaming}
        onClearReply={() => setReplyContext(null)}
        onSubmit={submitComposerPrompt}
      />
    </section>
  );
}

// ADR 0022 (Piano UI D1): activity signal = verb-tense + timer + count (non
// spinner-only). I typing-dots restano come affiancamento visivo, ma il label
// mostra la fase verb-tense + un timer elapsed + il detail (count per recall).
function AssistantThinkingState({ status }: { status: ChatStreamStatus | null }) {
  const { t } = useTranslation();
  // Timer elapsed dalla comparsa dello stato (per mostrare "thinking… 3s").
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      if (startRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [status?.requestId, status?.phase]);
  return (
    <div className="assistant-thinking-state" aria-live="polite">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-label">
        {status?.title ?? t("chat.thinking")}
        {elapsed > 0 && <span className="thinking-elapsed"> {elapsed}s</span>}
      </span>
      {status?.detail && <span className="thinking-detail">{status.detail}</span>}
    </div>
  );
}

function describeBridgeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Local gateway unreachable in this view.";
  }

  if (error.message.includes("Gateway")) {
    return "Local gateway not yet available: using the direct local runtime when possible.";
  }

  return error.message;
}

// Ensure an assistant message carries duration + token stats. The OpenAI-compat
// streaming path (cloud models) doesn't return native metrics like the local runtime,
// so we fill elapsed from the FRONTEND measurement and estimate generation tokens from
// the text length (~4 chars/token) when the backend didn't provide a real count.
function withChatMetrics(message: ChatMessage, measuredElapsedSeconds: number): ChatMessage {
  if (message.role !== "assistant") return message;
  const existing = message.metrics;
  const elapsed =
    existing && existing.elapsedSeconds > 0 ? existing.elapsedSeconds : measuredElapsedSeconds;
  const tokens =
    existing && existing.generationTokens > 0
      ? existing.generationTokens
      : Math.max(1, Math.round((message.text?.length ?? 0) / 4));
  const base = existing ?? {
    promptTokens: 0,
    generationTokens: 0,
    promptTps: 0,
    generationTps: 0,
    peakMemoryGb: 0,
    elapsedSeconds: 0,
    maxTokens: 0,
  };
  return {
    ...message,
    metrics: { ...base, elapsedSeconds: elapsed, generationTokens: tokens },
  };
}

// Claude-style duration label: "0.8s" / "12s" / "1m 46s".
function formatChatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
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
    eventParts: normalizeChatEventParts(result.assistant_message.event_parts),
  };
}

function visibleMessageMetadata(metadata: string | undefined) {
  if (!metadata) return undefined;
  const hidden = new Set([
    "Electron core locale",
    "Sent to the local core",
    "Not saved as raw payload",
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
  return /```(?!mermaid\b)[\w-]*\n[\s\S]*?```/i.test(text);
}

function isLikelyIncompleteMessage(message: ChatMessage) {
  const trimmed = message.text.trim();
  if (!trimmed) return false;
  // Structural truncation signals: an unclosed code fence, a dangling open bracket, or a
  // numbered-list item with a bold lead-in but no body — these mean the text was genuinely cut.
  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) return true;
  if (/[({[]$/.test(trimmed)) return true;
  if (/(^|\n)\s*\d+\.\s+\*\*[^*\n]*$/.test(trimmed)) return true;
  // Near the token budget is NOT truncation on its own: a reasoning model can spend its whole
  // budget THINKING (the ‹‹REASONING›› trace lives at the START, the answer at the END) and
  // still finish a clean answer. Auto-continuing it then re-feeds a COMPLETE answer and the
  // model rambles "il testo è già completo". So only treat near-max as incomplete when the text
  // ALSO ends mid-thought — no sentence-terminating punctuation, closing fence, or table row.
  const metrics = message.metrics;
  const nearMax = Boolean(
    metrics &&
      metrics.maxTokens > 0 &&
      metrics.generationTokens >= Math.floor(metrics.maxTokens * 0.96),
  );
  if (nearMax) {
    const endsCleanly = /[.!?…»"'”’)\]`|]\s*$/u.test(trimmed);
    return !endsCleanly;
  }
  return false;
}

function createReplyPreview(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function messageRoleLabel(role: ChatMessage["role"]) {
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "user";
}

function isPlaceholderThreadTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return normalized === "new task" || normalized === "nuovo compito";
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
  canExpand,
  canRegenerate,
  canReply,
  canEdit,
  canSaveToMemory,
  canSaveAsGoal,
  contentKind,
  copied,
  feedback,
  metrics,
  savedToMemory,
  onCopy,
  onEdit,
  onContinue,
  onExpand,
  onExplainCode,
  onExplainDiagram,
  onFeedback,
  onImproveCode,
  onReply,
  onRegenerate,
  onReviseDiagram,
  onSaveToMemory,
  onSaveAsGoal,
}: {
  canContinue: boolean;
  canExpand: boolean;
  canRegenerate: boolean;
  canReply: boolean;
  canEdit: boolean;
  canSaveToMemory: boolean;
  canSaveAsGoal: boolean;
  contentKind: MessageContentKind;
  copied: boolean;
  feedback: ChatMessage["feedback"];
  metrics?: ChatMessageMetrics;
  savedToMemory: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onContinue: () => void;
  onExpand: () => void;
  onExplainCode: () => void;
  onExplainDiagram: () => void;
  onFeedback: (feedback: MessageFeedback) => void;
  onImproveCode: () => void;
  onReply: () => void;
  onRegenerate: () => void;
  onReviseDiagram: () => void;
  onSaveToMemory: () => void;
  onSaveAsGoal: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] =
    useState<MessageActionMenuPlacement>("below");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const showMoreMenu =
    canExpand ||
    canRegenerate ||
    canSaveToMemory ||
    canSaveAsGoal ||
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

  function runMessageMenuAction(action: () => void) {
    setMenuOpen(false);
    action();
  }

  return (
    <div className="message-action-bar" aria-label={t("chat.messageActions")}>
      {canEdit && (
        <button type="button" onClick={onEdit} aria-label={t("chat.editMessage")} title={t("common.edit")}>
          <Pencil size={14} />
          <span>{t("common.edit")}</span>
        </button>
      )}
      {canReply && (
        <button type="button" onClick={onReply} aria-label={t("chat.replyToMessage")} title="Reply">
          <Reply size={14} />
          <span>{t("chat.action.reply")}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label={t("chat.copyMessage")}
        title={copied ? t("common.copied") : t("common.copy")}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? t("common.copied") : t("common.copy")}</span>
      </button>
      {canContinue && (
        <button
          className="primary-continue-action"
          type="button"
          onClick={onContinue}
          aria-label={t("chat.action.continueResponse")}
        >
          <Play size={14} />
          <span>{t("chat.action.continue")}</span>
        </button>
      )}
      {showMoreMenu && (
        <div className="message-action-menu-wrap">
          <button
            ref={menuButtonRef}
            type="button"
            aria-expanded={menuOpen}
            aria-label={t("chat.moreActions")}
            onClick={toggleMoreMenu}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className={`message-action-menu ${menuPlacement}`} role="menu">
              {canExpand && (
                <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onExpand)}>
                  <Play size={14} />
                  <span>{t("chat.action.expand")}</span>
                </button>
              )}
              {contentKind === "code" && (
                <>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onExplainCode)}>
                    <SquareTerminal size={14} />
                    <span>{t("chat.action.explainCode")}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onImproveCode)}>
                    <WandSparkles size={14} />
                    <span>{t("chat.action.improveCode")}</span>
                  </button>
                </>
              )}
              {contentKind === "diagram" && (
                <>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onExplainDiagram)}>
                    <FileText size={14} />
                    <span>{t("chat.action.explainDiagram")}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onReviseDiagram)}>
                    <WandSparkles size={14} />
                    <span>{t("chat.action.editDiagram")}</span>
                  </button>
                </>
              )}
              {canRegenerate && (
                <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onRegenerate)}>
                  <RotateCcw size={14} />
                  <span>{t("chat.action.regenerate")}</span>
                </button>
              )}
              {canSaveToMemory && (
                <button
                  className={savedToMemory ? "active" : ""}
                  type="button"
                  role="menuitem"
                  onClick={() => runMessageMenuAction(onSaveToMemory)}
                >
                  <BookMarked size={14} />
                  <span>{savedToMemory ? t("chat.savedToMemory") : t("chat.saveToMemory")}</span>
                </button>
              )}
              {canSaveAsGoal && (
                <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onSaveAsGoal)}>
                  <Target size={14} />
                  <span>{t("chat.action.saveAsGoal")}</span>
                </button>
              )}
              <div className="message-action-menu-feedback" aria-label={t("chat.responseFeedback")}>
                <button
                  className={feedback === "useful" ? "active" : ""}
                  type="button"
                  onClick={() => onFeedback("useful")}
                  aria-label={t("chat.markHelpful")}
                >
                  <ThumbsUp size={14} />
                </button>
                <button
                  className={feedback === "not_useful" ? "active" : ""}
                  type="button"
                  onClick={() => onFeedback("not_useful")}
                  aria-label={t("chat.markNotHelpful")}
                >
                  <ThumbsDown size={14} />
                </button>
              </div>
              {metrics && (
                <div
                  className="message-latency-summary"
                  aria-label={t("chat.messageMetrics")}
                >
                  <strong>{t("chat.metrics")}</strong>
                  <span>
                    Time to first token
                    <b>{formatMetricSeconds(metrics.timeToFirstTokenSeconds)}</b>
                  </span>
                  <span>
                    {t("chat.generation")}
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
  const { t } = useTranslation();
  return (
    <div className="message-attachment-list" aria-label={t("chat.messageAttachments")}>
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
  return item.title !== "Local session ready" && item.id !== "bridge-unavailable";
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
  const { t } = useTranslation();
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
    <section className="operational-plan-preview" aria-label={t("chat.operationalPlan")}>
      <header>
        <span>
          <ListTodo size={16} />
          <strong>{t("chat.operationalPlan")}</strong>
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
  const { t } = useTranslation();
  if (session.timeline.length === 0) {
    return null;
  }

  const visibleTimeline = collapsed ? session.timeline.slice(-2) : session.timeline;

  return (
    <div
      className={`inline-timeline ${collapsed ? "timeline-collapsed" : ""}`}
      aria-label={t("chat.activityProgress")}
    >
      <div className="timeline-header">
        <div>
          <strong>{t("chat.computerActivity")}</strong>
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
          <span>{collapsed ? t("chat.showDetails") : t("chat.hide")}</span>
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

interface VaultProposal {
  category: string;
  label: string;
  redacted_preview: string;
  pending_id?: string;
}

interface VaultRevealProposal {
  record_id: string;
  category: string;
  label: string;
  redacted_preview: string;
}

interface PaymentApprovalProposal {
  snapshot: PaymentApprovalSnapshot;
}

/** Composer interaction modes (Cursor-style, adapted for a general assistant).
 *  Debug is project-only (coding context); the others fit any chat. */
type ChatMode = "agent" | "plan" | "ask" | "debug";
const CHAT_MODES: {
  key: ChatMode;
  label: string;
  desc: string;
  icon: typeof Bot;
  projectOnly?: boolean;
}[] = [
  { key: "agent", label: "Agent", desc: "Reasons, uses tools and acts", icon: Bot },
  { key: "plan", label: "Plan", desc: "Proposes a plan and waits for OK before acting", icon: ListTodo },
  { key: "ask", label: "Ask", desc: "Replies and converses, without tools or actions", icon: MessageCircle },
  { key: "debug", label: "Debug", desc: "Systematic debugging (code projects)", icon: Bug, projectOnly: true },
];

/** A single/multi-choice question the model asks the user (Claude-Code style). */
interface ChoicePrompt {
  question: string;
  multi: boolean;
  options: string[];
}

/** A plan the model proposes BEFORE executing (plan-mode): the card gates execution
 *  behind Accetta / Edit. */
interface PlanProposal {
  summary: string;
  steps: string[];
}

/** One step of the live operational plan (update_plan), rendered inline with status. */
export interface PlanStep {
  status: "todo" | "doing" | "done" | "blocked";
  title: string;
  detail: string;
}

function eventPayload(parts: ChatEventPart[] | undefined, type: ChatEventPart["type"]) {
  const part = parts?.find((item) => item.type === type);
  return part && "payload" in part ? part.payload : null;
}

function latestPlanUpdateMarkdown(parts: ChatEventPart[] | undefined) {
  const plans = (parts ?? []).filter(
    (item): item is Extract<ChatEventPart, { type: "plan_update" }> =>
      item.type === "plan_update",
  );
  return plans.length > 0 ? plans[plans.length - 1].markdown : null;
}

function parseVaultProposalPayload(payload: unknown): VaultProposal | null {
  const parsed = payload as Partial<VaultProposal> | null;
  if (
    parsed &&
    typeof parsed.category === "string" &&
    typeof parsed.label === "string" &&
    typeof parsed.redacted_preview === "string"
  ) {
    return {
      category: parsed.category,
      label: parsed.label,
      redacted_preview: parsed.redacted_preview,
      ...(typeof parsed.pending_id === "string" ? { pending_id: parsed.pending_id } : {}),
    };
  }
  return null;
}

function parseVaultRevealPayload(payload: unknown): VaultRevealProposal | null {
  const parsed = payload as Partial<VaultRevealProposal> | null;
  if (
    parsed &&
    typeof parsed.record_id === "string" &&
    typeof parsed.category === "string" &&
    typeof parsed.label === "string" &&
    typeof parsed.redacted_preview === "string"
  ) {
    return {
      record_id: parsed.record_id,
      category: parsed.category,
      label: parsed.label,
      redacted_preview: parsed.redacted_preview,
    };
  }
  return null;
}

function parsePaymentApprovalPayload(payload: unknown): PaymentApprovalProposal | null {
  const parsed = payload as { snapshot?: Partial<PaymentApprovalSnapshot> } | null;
  const snapshot = parsed?.snapshot;
  if (
    snapshot &&
    typeof snapshot.approval_id === "string" &&
    typeof snapshot.merchant === "string" &&
    typeof snapshot.domain === "string" &&
    typeof snapshot.amount_minor === "number" &&
    typeof snapshot.currency === "string" &&
    typeof snapshot.product_summary === "string" &&
    typeof snapshot.payment_method_label === "string" &&
    typeof snapshot.checkout_fingerprint === "string"
  ) {
    return { snapshot: snapshot as PaymentApprovalSnapshot };
  }
  return null;
}

function parseChoicePromptPayload(payload: unknown): ChoicePrompt | null {
  const parsed = payload as Partial<ChoicePrompt> | null;
  if (!parsed || !Array.isArray(parsed.options) || parsed.options.length === 0) return null;
  return {
    question: typeof parsed.question === "string" ? parsed.question : "",
    multi: parsed.multi === true,
    options: parsed.options.filter((option) => typeof option === "string" && option.trim()),
  };
}

/** Parses the ‹‹PLAN›› markdown (`- [x] **Title** (`s1`): detail`) into typed steps. */
function parsePlanSteps(markdown: string): PlanStep[] {
  const out: PlanStep[] = [];
  for (const raw of markdown.split("\n")) {
    const m = raw.match(/^-\s*\[(.)\]\s*\*\*(.+?)\*\*\s*(?:\(`[^`]*`\))?\s*:?\s*(.*)$/);
    if (!m) continue;
    const marker = m[1];
    const status: PlanStep["status"] =
      marker === "x" ? "done" : marker === "-" ? "doing" : marker === "!" ? "blocked" : "todo";
    out.push({ status, title: m[2].trim(), detail: m[3].trim() });
  }
  return out;
}

// Tool-activity trace markers (browser / skill / sandbox / connected-tool steps).
// They are extracted into a compact collapsible panel so the answer body stays
// clean — the pattern Claude/assistant-ui use for "tool activity".

function parseActivitySteps(text: string): string[] {
  if (!text.includes("‹‹ACT››")) return [];
  return Array.from(text.matchAll(ACTIVITY_RE), (match) => match[1].trim()).filter(
    (step) => step.length > 0,
  );
}

// Generated-file artifacts surfaced by the gateway (skill outputs in $OUTPUT_DIR).

export interface ParsedArtifact {
  name: string;
  thread: string;
  size: number;
  /** True when this emission overwrote an existing file (a new version). */
  updated?: boolean;
  /** Managed artifacts live in Homun's artifact folder; project artifacts live in the project root. */
  source?: "managed" | "project";
  managed_path?: string;
  projectPath?: string;
  projectRelativePath?: string;
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

function latestPlanMarkdown(messages: { text?: string; eventParts?: ChatEventPart[] }[]): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    const structuredPlan = latestPlanUpdateMarkdown(message.eventParts);
    if (structuredPlan) {
      latest = structuredPlan;
      continue;
    }
    const text = message.text ?? "";
    if (!text.includes("‹‹PLAN››")) continue;
    for (const match of text.matchAll(PLAN_RE)) latest = match[1].trim();
  }
  return latest && latest.length > 0 ? latest : null;
}

function latestActivitySteps(messages: { text?: string }[]): string[] {
  let latest: string[] = [];
  for (const message of messages) {
    const steps = parseActivitySteps(message.text ?? "");
    if (steps.length > 0) latest = steps;
  }
  return latest;
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
    if (artifact.source === "project" && artifact.projectPath) {
      await coreBridge.revealPath(artifact.projectPath);
      return;
    }
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
  const { t } = useTranslation();
  const artifacts = useMemo(() => parseArtifacts(text), [text]);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (artifacts.length === 0) return null;

  return (
    <div className="msg-artifacts" aria-label={t("chat.generatedFiles")}>
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
 *  and shows them on the row (Claude Code's "Modified file +N −M"). */
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
  const { t } = useTranslation();
  const [counts, setCounts] = useState<{ added: number; removed: number } | null>(null);
  // Images render their preview inline by default — a generated picture should be
  // visible in the chat without the user having to expand the chip.
  const isImage = ARTIFACT_IMAGE_EXT.includes(artifactExt(artifact.name));
  const locationHint =
    artifact.projectPath ??
    artifact.projectRelativePath ??
    artifact.managed_path ??
    null;

  useEffect(() => {
    if (!artifact.updated || artifact.source === "project") return;
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
        <button type="button" className="artifact-name" onClick={onOpen} title={t("chat.openInPanel")}>
          <span className="artifact-fname">{artifact.name}</span>
          {artifact.updated && <span className="artifact-updated">{t("chat.modified")}</span>}
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
          aria-label={t("chat.action.download")}
          title={t("chat.action.download")}
        >
          <Download size={14} />
        </button>
        {!isImage && (
          <button
            type="button"
            className="artifact-expand"
            aria-label={expanded ? t("chat.collapsePreview") : t("chat.expandPreview")}
            onClick={onToggle}
          >
            <ChevronRight
              size={15}
              className={expanded ? "artifact-chevron open" : "artifact-chevron"}
            />
          </button>
        )}
      </div>
      {locationHint && (
        <div className="artifact-path-hint" title={locationHint}>
          {locationHint}
        </div>
      )}
      {(expanded || isImage) && <InlineArtifactPreview artifact={artifact} />}
    </div>
  );
}

/** The Artefatti panel, rendered IDENTICALLY to the chat: the same artifact cards
 *  (icon · name · Modified · +N −M diff · download · expand → inline preview), just
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
    const blob =
      artifact.source === "project"
        ? await projectArtifactBlob(artifact)
        : await coreBridge.downloadArtifact(artifact.thread, artifact.name, version);
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

async function projectArtifactBlob(artifact: ParsedArtifact): Promise<Blob> {
  const path = artifact.projectPath || artifact.projectRelativePath || artifact.name;
  const payload = await coreBridge.fsFile(path, artifact.thread);
  if (!payload.authorized || payload.binary || payload.error) {
    throw new Error(payload.error ?? "project artifact unavailable");
  }
  return new Blob([payload.text], { type: "text/plain;charset=utf-8" });
}

type ArtifactPreview =
  | { kind: "image" | "pdf"; url: string; ext: string }
  | { kind: "html"; url: string; ext: string }
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
  if (artifact.source === "project") {
    const path = artifact.projectPath || artifact.projectRelativePath || artifact.name;
    const payload = await coreBridge.fsFile(path, artifact.thread);
    if (!payload.authorized || payload.error) return { kind: "error", ext };
    if (payload.binary) return { kind: "binary", ext };
    if (ext === "md" || ext === "markdown") return { kind: "markdown", text: payload.text, ext };
    if (ext === "csv") return { kind: "csv", text: payload.text, ext };
    if (ARTIFACT_CODE_EXT.has(ext)) return { kind: "code", text: payload.text, ext };
    if (ext === "txt" || ext === "log" || ext === "") return { kind: "text", text: payload.text, ext };
    return { kind: "text", text: payload.text, ext };
  }
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
  if (ext === "html" || ext === "htm") {
    // Render the deck/page inline (self-contained HTML — decks inline their images).
    // Re-blob as text/html so the iframe renders rather than downloads.
    const html = await blob.text();
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    return { kind: "html", url, ext };
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
      if (artifact.source !== "project") {
        try {
          count = await coreBridge.artifactVersions(artifact.thread, artifact.name);
        } catch {
          /* no versions */
        }
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
export type WorkbenchTab = "files" | "artifacts" | "memoria" | "goals" | "activity" | "plan";

// Shared view metadata for the panel: the header dropdown (chat top-right) and the
// in-panel title both read from here, so labels/icons never drift. Mock interaction:
// toggle → dropdown menu → docked panel with that view + a clean title header.
const PANEL_VIEWS: { key: WorkbenchTab; label: string; icon: typeof FileText }[] = [
  { key: "artifacts", label: "Review", icon: ClipboardList },
  { key: "files", label: "Files", icon: FolderOpen },
  { key: "activity", label: "Activity", icon: Clock3 },
  { key: "plan", label: "Plan", icon: ListTodo },
  { key: "memoria", label: "Memory", icon: Share2 },
  { key: "goals", label: "Goals", icon: Target },
];
const PANEL_VIEW_LABEL: Record<WorkbenchTab, string> = {
  files: "Files",
  artifacts: "Review",
  memoria: "Memory",
  goals: "Goals",
  activity: "Activity",
  plan: "Plan",
};

/** The Workbench: one toggle → a docked right panel with tabs, consolidating the
 *  assistant's tools/outputs (Claude-Code / IDE inspector pattern). Replaces the
 *  scattered header affordances. */
// Navigable visual graph of the project's memory: project at the centre, decisions
// linked to the files they affect and the alternatives they rejected, plus facts and
// preferences. Rendered with react-force-graph-2d (canvas + continuous d3-force):
// zoom/pan/drag, hover highlights neighbours, click inspects. Data from /api/memory/graph.
const GRAPH_KIND_STYLE: Record<string, { fill: string; r: number; label: string }> = {
  project: { fill: "#6366f1", r: 16, label: "Space" },
  decision: { fill: "#0ea5e9", r: 11, label: "Decision" },
  file: { fill: "#10b981", r: 8, label: "File" },
  alternative: { fill: "#fb7185", r: 7, label: "Rejected alternative" },
  fact: { fill: "#f59e0b", r: 8, label: "Fact" },
  preference: { fill: "#a78bfa", r: 8, label: "Preference" },
  wiki: { fill: "#0d9488", r: 10, label: "Wiki page" },
  entity: { fill: "#94a3b8", r: 8, label: "Entity" },
  // Entity ontology (G1): one colour per type so the personal graph reads at a
  // glance — people pink, organizations teal, events orange, places green…
  "entity:person": { fill: "#ec4899", r: 9, label: "Person" },
  "entity:organization": { fill: "#14b8a6", r: 8, label: "Organization" },
  "entity:place": { fill: "#84cc16", r: 8, label: "Place" },
  "entity:event": { fill: "#f97316", r: 9, label: "Event" },
  "entity:topic": { fill: "#eab308", r: 8, label: "Interest" },
  "entity:tool": { fill: "#64748b", r: 7, label: "Tool" },
  "entity:project": { fill: "#818cf8", r: 8, label: "Project" },
  // Code graph (project map): functions/methods, files, docs, rationale.
  "entity:code_symbol": { fill: "#0ea5e9", r: 7, label: "Function" },
  "entity:code_file": { fill: "#10b981", r: 9, label: "File" },
  "entity:code_doc": { fill: "#94a3b8", r: 7, label: "Document" },
  "entity:code_rationale": { fill: "#a78bfa", r: 7, label: "Note" },
};

/// Entity nodes get a per-type style when the ontology knows the type.
function graphStyleKey(node: { kind: string; entity_type?: string }): string {
  if (node.kind === "entity" && node.entity_type) {
    const key = `entity:${node.entity_type}`;
    if (GRAPH_KIND_STYLE[key]) return key;
  }
  return node.kind;
}

function normalizeGoalText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupeGoalDrafts(drafts: string[], existingGoals: Set<string>): string[] {
  const seen = new Set(existingGoals);
  const out: string[] = [];
  for (const draft of drafts) {
    const clean = draft.trim();
    const normalized = normalizeGoalText(clean);
    if (!clean || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(clean);
  }
  return out;
}

/** Workbench "Obiettivi" tab: the LLM-free, user-driven goals manager. Shows current
 * goals + lets the user promote decisions to goals or add a custom one. Mutations hit
 * the gateway (which regenerates the injected project brief) then refetch. */
function GoalsPanel({
  data,
  threadId,
  seed,
  onSeedConsumed,
  onRefresh,
}: {
  data: ProjectGoalsData;
  threadId: string;
  seed?: string | null;
  onSeedConsumed?: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [newGoal, setNewGoal] = useState("");
  const [busy, setBusy] = useState(false);
  // Pre-fill the compose when a chat message was promoted to a goal (then clear the seed).
  useEffect(() => {
    if (seed && seed.trim()) {
      setNewGoal(seed);
      onSeedConsumed?.();
    }
  }, [seed, onSeedConsumed]);
  // Assistant-proposed objectives (north star), editable before saving.
  const [drafts, setDrafts] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const existingGoalTexts = useMemo(
    () => new Set(data.goals.map((goal) => normalizeGoalText(goal.text))),
    [data.goals],
  );
  useEffect(() => {
    setDrafts((current) => (current ? dedupeGoalDrafts(current, existingGoalTexts) : current));
  }, [existingGoalTexts]);

  const consumeDraft = (text: string) => {
    const normalized = normalizeGoalText(text);
    setDrafts((current) =>
      current ? current.filter((draft) => normalizeGoalText(draft) !== normalized) : current,
    );
  };

  const add = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const normalized = normalizeGoalText(clean);
    if (existingGoalTexts.has(normalized)) {
      setNewGoal("");
      consumeDraft(clean);
      return;
    }
    setBusy(true);
    void coreBridge
      .addGoal(data.workspace, clean)
      .then(() => {
        setNewGoal("");
        consumeDraft(clean);
        onRefresh();
      })
      .finally(() => setBusy(false));
  };
  const deleteGoal = (g: ProjectGoalsData["goals"][number]) => {
    setBusy(true);
    void coreBridge
      .decideMemory(g.reference, "delete")
      .then(() => {
        onRefresh();
      })
      .finally(() => setBusy(false));
  };
  const suggest = () => {
    setSuggesting(true);
    void coreBridge
      .suggestGoals(threadId)
      .then((objs) => setDrafts(dedupeGoalDrafts(objs, existingGoalTexts)))
      .finally(() => setSuggesting(false));
  };
  const promote = () => {
    if (sel.size === 0) return;
    setBusy(true);
    void coreBridge
      .promoteGoals(data.workspace, Array.from(sel))
      .then(() => {
        setSel(new Set());
        onRefresh();
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="goals-manager" aria-label={t("chat.projectGoal")}>
      <header className="goals-head">
        <span className="goals-head-title">
          <Target size={16} />
          <strong>{t("chat.projectGoal")}</strong>
        </span>
        {data.goals.length > 0 && (
          <small>
            {data.goals.length} {data.goals.length === 1 ? t("chat.goalsCount_one") : t("chat.goalsCount_other")}
          </small>
        )}
      </header>

      {data.goals.length > 0 ? (
        <div className="goals-steps">
          {data.goals.map((g) => (
            <div className="goals-step" key={g.reference}>
              <span className="timeline-state" aria-hidden="true">
                <Target size={12} />
              </span>
              <div>{g.text}</div>
              <button
                type="button"
                className="goals-delete"
                aria-label="Delete goal"
                title="Delete goal"
                disabled={busy}
                onClick={() => deleteGoal(g)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="goals-empty">{t("chat.noGoalsYet")}</p>
      )}

      <textarea
        className="goals-compose"
        placeholder={t("chat.goalPlaceholder")}
        rows={2}
        value={newGoal}
        onChange={(e) => setNewGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(newGoal);
        }}
        disabled={busy}
      />
      <div className="goals-actions">
        <button
          className="goals-btn goals-btn-accent"
          onClick={() => add(newGoal)}
          disabled={busy || !newGoal.trim() || existingGoalTexts.has(normalizeGoalText(newGoal))}
        >
          {t("chat.addGoal")}
        </button>
        <button className="goals-btn" onClick={suggest} disabled={suggesting || busy}>
          <span className="goals-spark" aria-hidden="true">
            <Sparkles size={13} />
          </span>
          {suggesting ? t("chat.proposing") : t("chat.propose")}
        </button>
      </div>

      {drafts && (
        <div className="goals-section">
          {drafts.length === 0 ? (
            <p className="goals-empty">{t("chat.noProposals")}</p>
          ) : (
            <>
              <div className="goals-section-label">{t("chat.projectProposalsEditable")}</div>
              <div className="goals-steps">
                {drafts.map((d, i) => (
                  <div key={i} className="goals-draft-card">
                    <textarea
                      className="goals-draft-text"
                      rows={2}
                      value={d}
                      onChange={(e) => {
                        const next = [...drafts];
                        next[i] = e.target.value;
                        setDrafts(next);
                      }}
                      disabled={busy}
                    />
                    <div className="goals-draft-foot">
                      <button
                        className="goals-btn goals-btn-sm"
                        onClick={() => add(d)}
                        disabled={busy || !d.trim() || existingGoalTexts.has(normalizeGoalText(d))}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {data.decisions.length > 0 && (
        <details className="goals-promote">
          <summary>{t("chat.elevateDecisionToGoal")} ({data.decisions.length})</summary>
          <div className="goals-promote-list">
            {data.decisions.slice(0, 50).map((d) => (
              <label key={d.reference} className="goals-promote-item">
                <input
                  type="checkbox"
                  checked={sel.has(d.reference)}
                  onChange={(e) => {
                    const next = new Set(sel);
                    if (e.target.checked) next.add(d.reference);
                    else next.delete(d.reference);
                    setSel(next);
                  }}
                />
                <span>{d.text.split("\n")[0].slice(0, 120)}</span>
              </label>
            ))}
          </div>
          <button className="goals-btn goals-btn-sm" onClick={promote} disabled={busy || sel.size === 0}>
            {t("chat.elevateToGoal")} {sel.size > 0 ? `(${sel.size})` : ""}
          </button>
        </details>
      )}
    </section>
  );
}

export function MemoryGraphPanel({
  threadId,
  workspace,
  controlledMode,
  layoutSignal,
}: {
  threadId?: string;
  workspace?: string;
  /** When set, the parent drives graph/wiki (top-level tabs) and the internal
   *  toggle is hidden. */
  controlledMode?: "graph" | "wiki";
  /** External geometry signal from the Workbench shell (fullscreen / dock width). */
  layoutSignal?: string;
}) {
  const { t } = useTranslation();
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeFirst, setMergeFirst] = useState<string | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{
    survivor: MemoryGraphNode;
    absorbed: MemoryGraphNode;
    reason: string;
  } | null>(null);
  const [merging, setMerging] = useState(false);
  const [hygieneSuggestions, setHygieneSuggestions] = useState<MemoryHygieneSuggestion[]>([]);
  const [ignoredSuggestionKeys, setIgnoredSuggestionKeys] = useState<Set<string>>(new Set());
  const [buildingGraph, setBuildingGraph] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [subdirs, setSubdirs] = useState<ProjectSubdir[]>([]);
  const [internalMode, setInternalMode] = useState<"graph" | "wiki">("graph");
  const mode = controlledMode ?? internalMode;
  const setMode = setInternalMode;
  const [wiki, setWiki] = useState<MemoryWikiPage[] | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingWiki, setSavingWiki] = useState(false);
  // viewBox tracks the container's pixel size (centred at origin) so the graph FILLS
  // the panel and adapts when it's expanded/fullscreen — no fixed-aspect letterboxing.
  const [size, setSize] = useState({ w: 760, h: 600 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // react-force-graph imperative handle (zoom / zoomToFit / centerAt).
  const fgRef = useRef<any>(null);
  // Theme-aware node-label colour, captured from the panel's computed style.
  const labelColorRef = useRef<string>("#1e293b");

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Canvas can't use CSS vars: capture the panel's inherited text colour so node
    // labels stay legible in both light and dark themes.
    labelColorRef.current = getComputedStyle(el).color || "#1e293b";
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
    // Reset the wiki too so it RE-loads for the new scope: its load is guarded by
    // `wiki === null`, so without this, switching workspace kept the stale (often
    // empty) wiki — the "0 pagine" bug even when the project has decisions.
    setWiki(null);
    coreBridge
      .memoryGraph(threadId, workspace)
      .then((g) => {
        setGraph(g);
        setMergeFirst(null);
        return coreBridge
          .memoryHygieneSuggestions(threadId, workspace)
          .then(setHygieneSuggestions)
          .catch(() => setHygieneSuggestions([]));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [threadId, workspace]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!graph?.workspace) return;
    try {
      const raw = window.localStorage.getItem(`homun.memory.ignore.${graph.workspace}`);
      setIgnoredSuggestionKeys(new Set(raw ? JSON.parse(raw) : []));
    } catch {
      setIgnoredSuggestionKeys(new Set());
    }
  }, [graph?.workspace]);

  // Transparent project map: on opening a project graph, ensure its code map is
  // fresh (built behind the scenes if missing/stale). Show a neutral "building"
  // state and reload when the gateway signals the graph is ready. Never "Graphify".
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    setTooLarge(false);
    setSubdirs([]);
    coreBridge
      .ensureProjectGraph(workspace)
      .then((building) => {
        if (active) setBuildingGraph(building);
      })
      .catch(() => {});
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.workspace !== workspace) return;
      if (event.type === "project_graph.ready") {
        setBuildingGraph(false);
        setTooLarge(false);
        reload();
      } else if (event.type === "project_graph.too_large") {
        // Huge repo: don't auto-map — offer to map a subfolder instead.
        setBuildingGraph(false);
        setTooLarge(true);
        coreBridge.projectGraphSubdirs(workspace).then((s) => {
          if (active) setSubdirs(s);
        });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspace, reload]);

  // Map a chosen subtree of a huge repo, then show the building state.
  const mapSubdir = (name: string) => {
    if (!workspace) return;
    setTooLarge(false);
    setBuildingGraph(true);
    coreBridge.ensureProjectGraph(workspace, name).catch(() => {});
  };

  // Lookups + force-graph data. react-force-graph owns the layout (continuous
  // d3-force): we hand it nodes (colour/size by ontology) and links, and it settles
  // them, supporting zoom/pan/drag natively. graphData is rebuilt only when the graph
  // changes (so node positions persist across hover/select state changes).
  const nodeById = useMemo(() => {
    const map = new Map<string, MemoryGraphNode>();
    if (graph) for (const node of graph.nodes) map.set(node.id, node);
    return map;
  }, [graph]);
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (graph)
      for (const e of graph.edges) {
        map.set(e.source, (map.get(e.source) ?? new Set()).add(e.target));
        map.set(e.target, (map.get(e.target) ?? new Set()).add(e.source));
      }
    return map;
  }, [graph]);
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    return {
      nodes: graph.nodes.map((n) => {
        const style = GRAPH_KIND_STYLE[graphStyleKey(n)] ?? GRAPH_KIND_STYLE.entity;
        const isRoot = n.kind === "project";
        const deg = degree.get(n.id) ?? 0;
        return {
          id: n.id,
          label: n.label,
          kind: n.kind,
          color: style.fill,
          // Node AREA scales with connections: hubs (many edges) read big, isolated
          // facts stay small. The scope root is the biggest and pinned at centre.
          val: isRoot ? 9 : 1 + deg * 0.7,
          // Anchor the root at the origin so everything orbits it (hub-and-spoke).
          ...(isRoot ? { fx: 0, fy: 0 } : {}),
        };
      }),
      links: graph.edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
    };
  }, [graph]);

  const fitMemoryGraph = useCallback(
    (duration = 320, padding = 44, options: { reheat?: boolean } = {}) => {
      const graphApi = fgRef.current;
      if (!graphApi || mode !== "graph") return;
      if (options.reheat) graphApi.d3ReheatSimulation?.();
      graphApi.zoomToFit?.(duration, padding);
    },
    [mode],
  );

  useEffect(() => {
    const graphApi = fgRef.current;
    if (!graphApi || mode !== "graph") return;
    const linkForce = graphApi.d3Force?.("link");
    linkForce?.distance?.((link: any) => (link.label === "nel progetto" ? 48 : 34));
    linkForce?.strength?.((link: any) => (link.label === "nel progetto" ? 0.95 : 0.72));
    graphApi.d3Force?.("charge")?.strength?.(-46);
    graphApi.d3ReheatSimulation?.();
  }, [graphData, mode]);

  useEffect(() => {
    if (mode !== "graph" || !graph || size.w <= 0 || size.h <= 0) return undefined;
    let firstFrame = 0;
    let secondFrame = 0;
    const resizeFitTimer = window.setTimeout(() => {
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          fitMemoryGraph(360, 44, { reheat: true });
        });
      });
    }, 100);
    return () => {
      window.clearTimeout(resizeFitTimer);
      if (firstFrame) window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [fitMemoryGraph, graph, layoutSignal, mode, size.h, size.w]);

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const relationCountFor = (nodeId: string) =>
    graph?.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId).length ?? 0;
  const suggestionKey = (suggestion: MemoryHygieneSuggestion) =>
    `${suggestion.survivor_ref}|${suggestion.absorbed_ref}`;
  const visibleHygieneSuggestions = hygieneSuggestions.filter(
    (suggestion) => !ignoredSuggestionKeys.has(suggestionKey(suggestion)),
  );
  const ignoreSuggestion = (suggestion: MemoryHygieneSuggestion, persist: boolean) => {
    const key = suggestionKey(suggestion);
    setIgnoredSuggestionKeys((current) => {
      const next = new Set(current);
      next.add(key);
      if (persist && graph?.workspace) {
        window.localStorage.setItem(
          `homun.memory.ignore.${graph.workspace}`,
          JSON.stringify([...next]),
        );
      }
      return next;
    });
  };
  const isMergeableNode = (
    node: MemoryGraphNode | null | undefined,
  ): node is MemoryGraphNode => node?.kind === "entity" && node.id.startsWith("entity:");
  const proposeMerge = useCallback(
    (survivorId: string, absorbedId: string, reason: string) => {
      if (survivorId === absorbedId) return;
      const survivor = nodeById.get(survivorId);
      const absorbed = nodeById.get(absorbedId);
      if (!isMergeableNode(survivor) || !isMergeableNode(absorbed)) return;
      setPendingMerge({ survivor, absorbed, reason });
    },
    [nodeById],
  );
  const confirmMerge = useCallback(() => {
    if (!pendingMerge) return;
    setMerging(true);
    coreBridge
      .mergeMemoryEntities(
        pendingMerge.survivor.id,
        pendingMerge.absorbed.id,
        pendingMerge.reason,
      )
      .then(() => {
        setPendingMerge(null);
        setMergeFirst(null);
        setSelected(null);
        setWiki(null);
        reload();
      })
      .catch((error) => setError(String(error)))
      .finally(() => setMerging(false));
  }, [pendingMerge, reload]);
  const selectedEdges = useMemo(() => {
    if (!graph || !selected) return [];
    return graph.edges
      .filter((e) => e.source === selected || e.target === selected)
      .map((e) => {
        const otherId = e.source === selected ? e.target : e.source;
        return { label: e.label, other: nodeById.get(otherId)?.label ?? otherId };
      });
  }, [graph, selected, nodeById]);

  if (loading) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} />
        <p>{t("chat.loadingMemory")}</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} />
        <p>Memory unavailable: {error}</p>
        <button type="button" className="ghost-button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }
  if (tooLarge && (!graph || graph.nodes.length <= 1)) {
    return (
      <div className="workbench-empty project-map-picker">
        <Share2 size={28} />
        <p>{t("chat.largeProjectPickFolder")}</p>
        {subdirs.length === 0 ? (
          <p className="muted">{t("chat.noCodeSubfolders")}</p>
        ) : (
          <div className="project-map-subdirs">
            {subdirs.slice(0, 24).map((s) => (
              <button key={s.name} className="project-map-subdir" onClick={() => mapSubdir(s.name)}>
                <span className="name">{s.name}</span>
                <span className="count">{s.code_files} file</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (!graph || graph.nodes.length <= 1) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} className={buildingGraph ? "spin" : undefined} />
        <p>
          {buildingGraph
            ? t("chat.mappingProject")
            : t("chat.noMemoryForProject")}
        </p>
      </div>
    );
  }

  return (
    <div className="memory-graph">
      <div className="memory-graph-toolbar">
        {!controlledMode && (
          <div className="memory-graph-modes">
            <button type="button" className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
              {t("chat.graph")}
            </button>
            <button type="button" className={mode === "wiki" ? "active" : ""} onClick={() => setMode("wiki")}>
              {t("chat.wiki")}
            </button>
          </div>
        )}
        <span className="memory-graph-count">
          {mode === "graph"
            ? t("chat.graphCount", { nodes: graph.nodes.length, edges: graph.edges.length })
            : t("chat.wikiPagesCount", { count: wiki?.length ?? 0 })}
        </span>
        {mode === "graph" && (
          <div className="memory-graph-zoom">
            <button
              type="button"
              className={mergeMode ? "active" : ""}
              onClick={() => {
                setMergeMode((value) => !value);
                setMergeFirst(null);
              }}
              aria-label="Merge entities"
              title="Merge entities"
            >
              <GitMerge size={14} />
            </button>
            <button type="button" onClick={() => fgRef.current?.zoom((fgRef.current?.zoom() ?? 1) * 1.3, 300)} aria-label="Zoom +">
              +
            </button>
            <button type="button" onClick={() => fgRef.current?.zoom((fgRef.current?.zoom() ?? 1) * 0.77, 300)} aria-label="Zoom −">
              −
            </button>
            <button type="button" onClick={() => fitMemoryGraph(400, 50)} aria-label={t("chat.fitToView")}>
              ⟲
            </button>
          </div>
        )}
      </div>
      {mode === "wiki" ? (
        <div className="memory-wiki">
          {wiki === null ? (
            <p className="memory-wiki-empty">{t("chat.loadingWiki")}</p>
          ) : wiki.length === 0 ? (
            <p className="memory-wiki-empty">{t("chat.noWikiPagesYet")}</p>
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
                      {savingWiki ? t("chat.saving") : t("common.save")}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setEditingPath(null)}>
                      {t("common.cancel")}
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
                      {t("common.edit")}
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
      {(mergeMode || visibleHygieneSuggestions.length > 0) && (
        <div className="memory-hygiene-panel">
          {mergeMode && (
            <span className="memory-hygiene-status">
              <GitMerge size={14} />
              {mergeFirst
                ? `Selected: ${nodeById.get(mergeFirst)?.label ?? "entity"}`
                : "Merge mode"}
            </span>
          )}
          {visibleHygieneSuggestions.slice(0, 4).map((suggestion) => (
            <span
              key={`${suggestion.survivor_ref}-${suggestion.absorbed_ref}`}
              className="memory-hygiene-suggestion"
            >
              <button
                type="button"
                onClick={() =>
                  proposeMerge(
                    suggestion.survivor_ref,
                    suggestion.absorbed_ref,
                    suggestion.reason,
                  )
                }
              >
                <GitMerge size={13} />
                {suggestion.survivor_label} ← {suggestion.absorbed_label}
              </button>
              {suggestion.safe_auto_merge && <strong>safe</strong>}
              <button type="button" onClick={() => ignoreSuggestion(suggestion, false)}>
                Ignore
              </button>
              <button type="button" onClick={() => ignoreSuggestion(suggestion, true)}>
                Never
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="memory-graph-canvas" ref={canvasRef}>
        {graph?.truncated && (
          <div className="memory-graph-truncated">
            {t("chat.graphTruncated", {
              shown: graph.nodes.length.toLocaleString("en-US"),
              total: (graph.total_nodes ?? graph.nodes.length).toLocaleString("en-US"),
            })}
          </div>
        )}
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={4}
          nodeVal={(n: any) => n.val}
          cooldownTicks={140}
          onEngineStop={() => fitMemoryGraph(400, 60)}
          onNodeClick={(n: any) => {
            if (mergeMode) {
              const node = nodeById.get(n.id);
              if (!isMergeableNode(node)) return;
              if (!mergeFirst) {
                setMergeFirst(n.id);
                setSelected(n.id);
                return;
              }
              proposeMerge(mergeFirst, n.id, "merged from graph selection");
              return;
            }
            setSelected(n.id);
            // Focus: centre + zoom onto the clicked node and its neighbourhood.
            if (typeof n.x === "number" && typeof n.y === "number") {
              fgRef.current?.centerAt(n.x, n.y, 600);
              fgRef.current?.zoom(2.4, 600);
            }
          }}
          onNodeDragEnd={(n: any) => {
            if (!mergeMode || typeof n.x !== "number" || typeof n.y !== "number") return;
            const nodes = fgRef.current?.graphData?.().nodes ?? [];
            let nearest: { id: string; d: number } | null = null;
            for (const candidate of nodes) {
              if (candidate.id === n.id) continue;
              if (typeof candidate.x !== "number" || typeof candidate.y !== "number") continue;
              const dx = candidate.x - n.x;
              const dy = candidate.y - n.y;
              const d = dx * dx + dy * dy;
              if (!nearest || d < nearest.d) nearest = { id: candidate.id, d };
            }
            if (nearest && nearest.d < 900) {
              proposeMerge(nearest.id, n.id, "merged by graph drag");
            }
          }}
          onNodeHover={(n: any) => setHoverId(n?.id ?? null)}
          onBackgroundClick={() => setSelected(null)}
          linkDirectionalParticles={(l: any) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return hoverId && (s === hoverId || t === hoverId) ? 4 : 0;
          }}
          linkDirectionalParticleWidth={2.2}
          linkDirectionalParticleSpeed={0.006}
          nodeColor={(n: any) => {
            if (!hoverId) return n.color;
            if (n.id === hoverId || neighbors.get(hoverId)?.has(n.id)) return n.color;
            return "rgba(148,163,184,0.22)"; // dim non-neighbours on hover
          }}
          linkColor={(l: any) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            const active =
              (hoverId && (s === hoverId || t === hoverId)) ||
              (selected && (s === selected || t === selected));
            if (active) return "#475569";
            return hoverId ? "rgba(203,213,225,0.18)" : "#cbd5e1";
          }}
          linkWidth={(l: any) => {
            const s = typeof l.source === "object" ? l.source.id : l.source;
            const t = typeof l.target === "object" ? l.target.id : l.target;
            return (hoverId && (s === hoverId || t === hoverId)) ||
              (selected && (s === selected || t === selected))
              ? 1.8
              : 0.7;
          }}
          linkLineDash={(l: any) => (l.label === "scartata" ? [4, 3] : null)}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
            // Label only the hubs and the hovered/selected node, so the canvas stays
            // legible instead of a wall of overlapping text.
            const important = node.kind === "project" || node.id === selected || node.id === hoverId;
            if (!important) return;
            const text = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
            const fontSize = 12 / globalScale;
            ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillStyle = labelColorRef.current;
            // Offset past the node's radius (radius = sqrt(val) * nodeRelSize).
            const off = (Math.sqrt(node.val ?? 1) * 4 + 3) / globalScale;
            ctx.fillText(text, node.x + off, node.y);
          }}
        />
        {selectedNode && (
          <div className="memory-graph-detail">
            <div
              className="memory-graph-detail-kind"
              style={{ color: GRAPH_KIND_STYLE[graphStyleKey(selectedNode)]?.fill }}
            >
              {GRAPH_KIND_STYLE[graphStyleKey(selectedNode)]?.label ?? selectedNode.kind}
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
                  {t("chat.deleteFromMemory")}
                </button>
              )}
              <button type="button" className="ghost-button" onClick={() => setSelected(null)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        )}
        {pendingMerge && (
          <div className="memory-graph-detail memory-merge-preview">
            <div className="memory-graph-detail-kind">
              <GitMerge size={14} /> Merge
            </div>
            <div className="memory-graph-detail-title">
              {pendingMerge.survivor.label} ← {pendingMerge.absorbed.label}
            </div>
            <p className="memory-graph-detail-body">
              {pendingMerge.reason}
              {pendingMerge.survivor.detail ? `\n${pendingMerge.survivor.detail}` : ""}
              {pendingMerge.absorbed.detail ? `\n${pendingMerge.absorbed.detail}` : ""}
              {`\n${relationCountFor(pendingMerge.survivor.id)} + ${relationCountFor(
                pendingMerge.absorbed.id,
              )} links`}
            </p>
            <div className="memory-graph-detail-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={merging}
                onClick={confirmMerge}
              >
                {merging ? "Merging…" : "Merge"}
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={merging}
                onClick={() => setPendingMerge(null)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="memory-graph-legend">
        {[
          "decision",
          "fact",
          "preference",
          "wiki",
          "entity:person",
          "entity:organization",
          "entity:place",
          "entity:event",
          "entity:topic",
        ].map((kind) => (
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
  projectThread,
  goalSeed,
  onGoalSeedConsumed,
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
  projectThread: boolean;
  goalSeed?: string | null;
  onGoalSeedConsumed?: () => void;
  operationalPlanMarkdown?: string;
}) {
  const { t } = useTranslation();
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
  // Background/scheduled tasks (Activity tab), fetched lazily when the tab opens.
  const [tasks, setTasks] = useState<CoreTaskQueueSnapshot | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  // Project goals (Obiettivi tab): goals + promotable decisions, resolved from the thread.
  const [goalsData, setGoalsData] = useState<ProjectGoalsData | null>(null);
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
        if (!result.authorized) setFsError("Folder not authorized.");
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
  // Probe the filesystem when the panel opens (not only on the File tab) so we know
  // upfront whether this thread has a project folder → drives File-tab visibility.
  useEffect(() => {
    if (open && fsCwd === null) void loadFs(null);
  }, [open, fsCwd, loadFs]);
  // No auto-redirect: every panel-open path picks a view explicitly (dropdown pick,
  // save-goal → "goals", open-artifact → "artifacts"), and every view has its own
  // empty state — so an explicitly chosen empty view stays put instead of bouncing.
  // Load project goals (Obiettivi tab) when the panel opens — resolves scope from thread.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void coreBridge.projectGoals(threadId).then((d) => {
      if (!cancelled) setGoalsData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [open, threadId]);
  // Load the task queue when the Activity tab is shown (and refresh on re-open).
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
  const refreshGoals = () => {
    void coreBridge.projectGoals(threadId).then(setGoalsData);
  };
  const planItems = parseOperationalPlanItems(operationalPlanMarkdown);
  const activeTasks = tasks
    ? [...tasks.active, ...tasks.queued, ...tasks.blocked]
    : [];
  const atRoot = !fsRoot || fsCwd === fsRoot;
  const cwdLabel = fsCwd ? fsCwd.replace(/\/+$/, "").split("/").pop() || fsCwd : "";
  const parentOf = (path: string) => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return (
    <aside
      className={`workbench${expanded ? " expanded" : ""}`}
      aria-label={t("chat.workbench")}
      style={expanded ? undefined : { width }}
    >
      {!expanded && (
        <div
          className="workbench-resize"
          role="separator"
          aria-label={t("chat.resizePanel")}
          onMouseDown={startResize}
        />
      )}
      <div className="workbench-header">
        <span className="workbench-title">{PANEL_VIEW_LABEL[tab]}</span>
        <span className="workbench-header-actions">
          <button
            className="workbench-close"
            type="button"
            aria-label={expanded ? t("chat.collapsePanel") : t("chat.fullscreen")}
            title={expanded ? t("chat.collapse") : t("chat.fullscreen")}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            className="workbench-close"
            type="button"
            aria-label={t("chat.closePanel")}
            title={t("chat.closePanel")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </span>
      </div>
      <div className="workbench-body">
        {tab === "files" && openFile && (
          <div className="workbench-fileview">
            <div className="workbench-breadcrumb">
              <button
                type="button"
                aria-label={t("common.back")}
                title={t("chat.backToFiles")}
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
                  title={t("chat.showGitDiff")}
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
                  <p>{t("chat.binaryFileHint")}</p>
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
                <div className="workbench-section-label">{t("chat.uploadedInChat")}</div>
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
                  {t("chat.projectFolder")}
                </div>
                <div className="workbench-breadcrumb">
                  <button
                    type="button"
                    aria-label={t("chat.parentFolder")}
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
                    <li className="wf-muted">{t("chat.emptyFolder")}</li>
                  )}
                </ul>
              </>
            ) : (
              uploadedFiles.length === 0 && (
                <div className="workbench-empty">
                  <FolderOpen size={28} />
                  <p>
                    {fsError ??
                      "No files in this chat and no project folder linked. Attach a file (📎) or link a folder to the project."}
                  </p>
                </div>
              )
            )}
          </div>
        )}
        {tab === "artifacts" &&
          (artifacts.length > 0 ? (
            <ArtifactsPanel
              artifacts={artifacts}
              initialName={artifactsInitial}
              onClose={onClose}
              embedded
            />
          ) : (
            <div className="workbench-empty">
              <FileText size={28} />
              <p>No artifacts yet. Files generated or created by the assistant appear here.</p>
            </div>
          ))}
        {tab === "memoria" && <MemoryGraphPanel threadId={threadId} layoutSignal={`${expanded ? "expanded" : "docked"}:${width}`} />}
        {tab === "goals" && goalsData && (
          <GoalsPanel
            data={goalsData}
            threadId={threadId}
            seed={goalSeed}
            onSeedConsumed={onGoalSeedConsumed}
            onRefresh={refreshGoals}
          />
        )}
        {tab === "activity" && (
          <div className="workbench-files">
            {tasksLoading && activeTasks.length === 0 ? (
              <div className="workbench-empty">
                <Loader2 size={22} className="spin" />
                <p>{t("chat.loadingActivity")}</p>
              </div>
            ) : activeTasks.length > 0 ? (
              <>
                <div className="workbench-section-label">{t("chat.ongoingAndPlanned")}</div>
                <ul className="workbench-file-list">
                  {activeTasks.map((item) => (
                    <li key={item.task_id}>
                      <Clock3 size={15} />
                      <span className="wf-name" title={item.goal}>
                        {item.goal || item.kind}
                      </span>
                      <small>{item.blocked_reason ? "blocked" : item.status}</small>
                      <button
                        type="button"
                        className="wf-cancel"
                        title={t("chat.cancelTask")}
                        aria-label={t("chat.cancelTask")}
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
                <p>No background activity. Scheduled and recurring tasks appear here.</p>
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
              <p>No active operational plan. When the assistant plans a multi-step task, steps appear here.</p>
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
  const { t } = useTranslation();
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
      if (selected.source !== "project") {
        try {
          count = await coreBridge.artifactVersions(selected.thread, selected.name);
        } catch {
          /* no versions */
        }
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
    selected?.source !== "project" &&
    (preview?.kind === "markdown" ||
      preview?.kind === "code" ||
      preview?.kind === "text" ||
      preview?.kind === "csv");
  const textKind = preview?.kind === "code" || preview?.kind === "text";
  const canDiff = textKind && versions > 0 && slot > 0;

  // Load the diff between the shown version and the previous one when requested.
  useEffect(() => {
    if (!showDiff || !selected || selected.source === "project" || slot <= 0) {
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
      aria-label={t("chat.projectFiles")}
    >
      {!embedded && (
        <header className="artifacts-panel-head">
          <strong>{t("chat.projectFiles")}</strong>
          <button
            type="button"
            aria-label={expanded ? "Riduci" : "Schermo intero"}
            title={expanded ? "Riduci" : "Schermo intero"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" aria-label="Close" onClick={onClose}>
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
                <div className="artifact-version-switch" aria-label={t("chat.versions")}>
                  <button
                    type="button"
                    aria-label={t("chat.prevVersion")}
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
                    aria-label={t("chat.nextVersion")}
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
                  title={t("chat.showVersionDiff")}
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
                  title={t("chat.wordWrap")}
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
                  <span>{t("common.edit")}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void triggerArtifactDownload(selected, slot < versions ? slot : undefined)
                }
              >
                <Download size={14} />
                <span>{t("chat.action.download")}</span>
              </button>
              <button
                type="button"
                className="artifact-folder"
                onClick={() => void openArtifactFolder(selected)}
                aria-label={t("chat.openFolder")}
                title={t("chat.openFolder")}
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
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveEdit()}
                    disabled={saving}
                  >
                    {saving ? "Salvo…" : "Save versione"}
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
  const { t } = useTranslation();
  if (!preview) return <p className="artifacts-preview-note">{t("chat.selectAFile")}</p>;
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
              alt={t("chat.pageN", { n: index + 1 })}
            />
          ))}
        </div>
      );
    case "pdf":
      return (
        <iframe
          className="artifact-preview-frame"
          src={`${preview.url}#toolbar=0&navpanes=0&view=FitH`}
          title="Preview PDF"
        />
      );
    case "html":
      // Inline render of an HTML deck/page (e.g. an on-brand presentation). Sandboxed:
      // same-origin so a self-contained file (inlined CSS + data-URL images) displays,
      // scripts/forms/navigation stay blocked.
      return (
        <iframe
          className="artifact-preview-html"
          src={preview.url}
          sandbox="allow-same-origin"
          title="Preview"
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
      return <p className="artifacts-preview-note">{t("chat.previewUnavailable")}</p>;
    default:
      return (
        <p className="artifacts-preview-note">
          {t("chat.previewUnavailableForType")}
        </p>
      );
  }
}

function ArtifactCsvTable({ text }: { text: string }) {
  const { t } = useTranslation();
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 200)
    .map((line) => line.split(","));
  if (rows.length === 0) return <p className="artifacts-preview-note">{t("chat.emptyDot")}</p>;
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
  const countLabel = `Activity · ${steps.length} ${steps.length === 1 ? "passo" : "passi"}`;
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
          {steps.map((step, index) => {
            // Per-step status, inferred without backend lifecycle data: the gateway's
            // problem markers (⏳ retry / ↩ fallback / ⏹ stop / 🔧 fix) → "warn"; in a
            // LIVE turn the last announced step is the one in progress; the rest are done.
            const status = /^(?:⏳|↩|⏹|🔧)/u.test(step)
              ? "warn"
              : live && index === steps.length - 1
                ? "doing"
                : "done";
            return (
              <li key={`${index}-${step.slice(0, 24)}`} data-status={status}>
                {step.replace(/^(?:\p{Extended_Pictographic}|️|‍|\s)+/u, "")}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Splits an assistant message into visible text + an optional pending write
 *  action (editable card) OR an already-executed marker (static "done" note). */
function parseComposioConfirm(text: string, eventParts?: ChatEventPart[]): {
  visible: string;
  action: ComposioPendingAction | null;
  doneTool: string | null;
  reconnectSlug: string | null;
  fsAuthorize: { path: string; op: string } | null;
  sandboxEscalate: { command: string; cwd: string } | null;
  connectSuggest: ConnectSuggest | null;
  vaultPropose: VaultProposal | null;
  vaultReveal: VaultRevealProposal | null;
  paymentApproval: PaymentApprovalProposal | null;
  choices: ChoicePrompt | null;
  planPropose: PlanProposal | null;
  goalPropose: string[] | null;
  planSteps: PlanStep[];
} {
  // Some models (GLM/Zhipu) leak their NATIVE tool-call delimiter tokens as text — they
  // use a fullwidth bar (U+FF5C), e.g. `<｜tool▁calls▁begin｜>` or `</｜DSML｜tool_calls>`.
  // Strip them before anything else so they never render and don't break marker matching
  // (a leaked end-token replaces a marker's proper close → the marker would leak whole).
  text = text.replace(/<\/?[^<>]*｜[^<>]*>/g, "");
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
  // ADR 0023: shell command blocked by the Seatbelt sandbox → in-chat "run without
  // sandbox" card. Payload is a tool call: {arguments:{command,cwd}}.
  let sandboxEscalate: { command: string; cwd: string } | null = null;
  const escMatch = text.match(SANDBOX_ESCALATE_RE);
  if (escMatch) {
    try {
      const parsed = JSON.parse(escMatch[1]) as {
        arguments?: { command?: string; cwd?: string };
      };
      const command = parsed?.arguments?.command;
      if (typeof command === "string") {
        sandboxEscalate = { command, cwd: parsed.arguments?.cwd ?? "" };
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
  let vaultPropose: VaultProposal | null = parseVaultProposalPayload(
    eventPayload(eventParts, "vault_propose"),
  );
  const vaultMatch = text.match(VAULT_PROPOSE_RE);
  if (!vaultPropose && vaultMatch) {
    try {
      vaultPropose = parseVaultProposalPayload(JSON.parse(vaultMatch[1]));
    } catch {
      /* malformed → just hide it */
    }
  }
  let vaultReveal: VaultRevealProposal | null = parseVaultRevealPayload(
    eventPayload(eventParts, "vault_reveal"),
  );
  const vaultRevealMatch = text.match(VAULT_REVEAL_RE);
  if (!vaultReveal && vaultRevealMatch) {
    try {
      vaultReveal = parseVaultRevealPayload(JSON.parse(vaultRevealMatch[1]));
    } catch {
      /* malformed → just hide it */
    }
  }
  let paymentApproval: PaymentApprovalProposal | null = parsePaymentApprovalPayload(
    eventPayload(eventParts, "payment_approval"),
  );
  const paymentMatch = text.match(PAYMENT_APPROVAL_RE);
  if (!paymentApproval && paymentMatch) {
    try {
      paymentApproval = parsePaymentApprovalPayload(JSON.parse(paymentMatch[1]));
    } catch {
      /* malformed → just hide it */
    }
  }
  // Single/multi-choice question card.
  let choices: ChoicePrompt | null = parseChoicePromptPayload(
    eventPayload(eventParts, "choice_prompt"),
  );
  const chMatch = text.match(CHOICES_RE);
  if (!choices && chMatch) {
    try {
      choices = parseChoicePromptPayload(JSON.parse(chMatch[1]));
    } catch {
      /* malformed → just hide it */
    }
  }
  // Plan proposal (plan-mode): steps + Accetta/Edit gate.
  let planPropose: PlanProposal | null = null;
  const ppMatch = text.match(PLAN_PROPOSE_RE);
  if (ppMatch) {
    try {
      const parsed = JSON.parse(ppMatch[1]) as { summary?: unknown; steps?: unknown };
      // Tolerant parsing (caposaldo): the model may emit steps as plain strings OR as
      // richer objects ({title, detail, …}) — e.g. gemma proposes object-steps. Accept
      // both, extracting a label from objects, instead of dropping them (which left the
      // card empty → "the plan doesn't activate").
      const rawSteps: unknown[] = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const steps = rawSteps
        .map((s) => {
          if (typeof s === "string") return s;
          if (s && typeof s === "object") {
            const o = s as Record<string, unknown>;
            const label = o.title ?? o.step ?? o.name ?? o.detail ?? o.summary ?? "";
            return typeof label === "string" ? label : "";
          }
          return "";
        })
        .filter((s) => s.trim().length > 0);
      if (steps.length > 0) {
        planPropose = {
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          steps,
        };
      }
    } catch {
      /* malformed → just hide it */
    }
  }
  // Goal proposal (projects): forward-looking objectives the model proposed → card to save.
  let goalPropose: string[] | null = null;
  const gpoMatch = text.match(GOAL_PROPOSE_RE);
  if (gpoMatch) {
    try {
      const parsed = JSON.parse(gpoMatch[1]) as { objectives?: unknown };
      const objectives = Array.isArray(parsed?.objectives)
        ? parsed.objectives.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
        : [];
      if (objectives.length > 0) goalPropose = objectives;
    } catch {
      /* malformed → just hide it */
    }
  }
  // Live operational plan (update_plan): take the LATEST ‹‹PLAN›› in the message and
  // render it inline with per-step status. PLAN_RE is global → matchAll gives all.
  let planSteps: PlanStep[] = [];
  const structuredPlan = latestPlanUpdateMarkdown(eventParts);
  if (structuredPlan) {
    planSteps = parsePlanSteps(structuredPlan);
  } else {
    const planMatches = [...text.matchAll(PLAN_RE)];
    if (planMatches.length > 0) {
    planSteps = parsePlanSteps(planMatches[planMatches.length - 1][1]);
    }
  }
  const done = text.match(COMPOSIO_DONE_RE);
  const doneTool = done ? done[1].trim() : null;
  const reconnectMatch = text.match(COMPOSIO_RECONNECT_RE);
  const reconnectSlug = reconnectMatch ? reconnectMatch[1].trim() : null;
  const visible = text
    .replace(COMPOSIO_MARKERS_RE, "")
    // Proposal markers are parsed into cards above. Strip them from prose even when a
    // provider leaves a malformed/unterminated close after an error path.
    .replace(PROPOSE_MARKERS_VISIBLE_RE, "")
    // Also drop an UNCLOSED plan/goal marker (model didn't emit its proper close): its
    // JSON payload is for a card, never prose.
    .replace(UNCLOSED_PROPOSE_RE, "")
    .trim();
  // A persisted "done" marker wins: never reopen the editable card.
  return {
    visible,
    action: doneTool ? null : action,
    doneTool,
    reconnectSlug,
    fsAuthorize,
    sandboxEscalate,
    connectSuggest,
    vaultPropose,
    vaultReveal,
    paymentApproval,
    choices,
    planPropose,
    goalPropose,
    planSteps,
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
// ADR 0022 (Piano UI C4): memo per stabilizzare l'identity dei messaggi non-
// streaming. Durante lo stream di un messaggio, l'array optimisticMessages è
// fresco ogni frame → senza memo TUTTI i messaggi re-renderizzano. Questo comparatore
// re-renderizza un messaggio solo se il suo text/eventParts/streaming cambiano;
// i messaggi finalizzati (text stabile) NON re-renderizzano durante lo stream altrui.
const AssistantMessageBody = memo(
  function AssistantMessageBody({
    text,
    eventParts,
    streaming,
    messageId,
    threadId,
    onOpenArtifact,
    onChoose,
  }: {
    text: string;
    eventParts?: ChatEventPart[];
    streaming?: boolean;
    messageId?: string;
    threadId?: string;
    onOpenArtifact?: (artifact: ParsedArtifact) => void;
    onChoose?: (answer: string) => void;
  }) {
  const {
    visible,
    action,
    doneTool,
    reconnectSlug,
    fsAuthorize,
    sandboxEscalate,
    connectSuggest,
    vaultPropose,
    vaultReveal,
    paymentApproval,
    choices,
    planPropose,
    goalPropose,
  } = useMemo(() => parseComposioConfirm(text, eventParts), [text, eventParts]);
  const readable = useMemo(() => humanizeToolSlugs(visible), [visible]);
  return (
    <>
      {readable && <RichMessage text={readable} streaming={streaming} eventParts={eventParts} />}
      {!streaming && onOpenArtifact && <MessageArtifacts text={text} onOpen={onOpenArtifact} />}
      {doneTool && !streaming && (
        <div className="cmp-confirm done">
          <ShieldCheck size={15} />
          <span>Action completed: {humanizeToolName(doneTool)}</span>
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
      {sandboxEscalate && !streaming && (
        <SandboxEscalateCard
          command={sandboxEscalate.command}
          cwd={sandboxEscalate.cwd}
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
      {vaultPropose && !streaming && (
        <VaultProposeCard
          proposal={vaultPropose}
          messageId={messageId}
          threadId={threadId}
        />
      )}
      {vaultReveal && !streaming && <VaultRevealCard proposal={vaultReveal} />}
      {paymentApproval && !streaming && (
        <PaymentApprovalCard
          proposal={paymentApproval}
          messageId={messageId}
          threadId={threadId}
        />
      )}
      {choices && !streaming && onChoose && (
        <ChoicesCard prompt={choices} onChoose={onChoose} />
      )}
      {planPropose && !streaming && onChoose && (
        <PlanProposeCard plan={planPropose} onAnswer={onChoose} />
      )}
      {goalPropose && !streaming && threadId && (
        <GoalProposeCard objectives={goalPropose} threadId={threadId} />
      )}
      {eventParts
        ?.filter((p): p is Extract<ChatEventPart, { type: "diff" }> => p.type === "diff")
        .map((part, index) => (
          <DiffCard key={`diff-${index}`} payload={part.payload} />
        ))}
    </>
  );
  },
  // Comparatore: re-renderizza solo se il contenuto del messaggio cambia.
  // Le callback (onOpenArtifact/onChoose) sono stabili nel caller — skip.
  (prev, next) =>
    prev.text === next.text &&
    prev.streaming === next.streaming &&
    prev.messageId === next.messageId &&
    prev.threadId === next.threadId &&
    prev.eventParts === next.eventParts,
);

// D3 (Piano UI): inline code-diff card. Renders the model's proposed change for a single
// file path with a header and the unified line diff (added=green, removed=red).
function DiffCard({ payload }: { payload: DiffEventPayload }) {
  return (
    <div className="diff-card">
      <div className="diff-card-header">
        <span className="diff-card-path">📄 {payload.path}</span>
        {payload.label && <span className="diff-card-label">{payload.label}</span>}
      </div>
      <DiffView oldText={payload.old ?? ""} newText={payload.new} />
    </div>
  );
}

function VaultProposeCard({
  proposal,
  messageId,
  threadId,
}: {
  proposal: VaultProposal;
  messageId?: string;
  threadId?: string;
}) {
  const [status, setStatus] = useState<
    "idle" | "saving" | "saved" | "dismissed" | "conflict" | "error"
  >("idle");
  const [note, setNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<VaultProposalAcceptResult | null>(null);

  const payload = {
    category: proposal.category,
    label: proposal.label,
    redacted_preview: proposal.redacted_preview,
    ...(proposal.pending_id ? { pending_id: proposal.pending_id } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
  };

  // A save can come back "created", "ignored" (an identical record already
  // existed — treated as done), or "conflict" (a partial match the user resolves).
  const applyResult = (result: VaultProposalAcceptResult) => {
    if (result.status === "conflict") {
      setConflict(result);
      setStatus("conflict");
      return;
    }
    setConflict(null);
    setStatus("saved");
    setNote(
      result.status === "ignored"
        ? "Già presente nel Vault."
        : `Salvato nel Vault (${result.record_id}).`,
    );
  };

  const save = async () => {
    setStatus("saving");
    setNote(null);
    try {
      applyResult(await coreBridge.vaultProposalAccept(payload));
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const resolveConflict = async (resolution: "add" | "update" | "ignore") => {
    setStatus("saving");
    setNote(null);
    try {
      applyResult(
        await coreBridge.vaultProposalAccept({
          ...payload,
          resolution,
          // update/ignore target the pre-existing record surfaced in the conflict.
          ...(resolution === "add"
            ? {}
            : { record_id: conflict?.existing?.id }),
        }),
      );
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const dismiss = async () => {
    setStatus("saving");
    setNote(null);
    try {
      await coreBridge.vaultProposalDismiss(payload);
      setStatus("dismissed");
      setNote("Proposta scartata.");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const busy = status === "saving";

  if (status === "saved") {
    return (
      <div className="cmp-confirm done">
        <Check size={15} />
        <span>Saved to Vault</span>
      </div>
    );
  }

  if (status === "dismissed") {
    return (
      <div className="cmp-confirm done">
        <Check size={15} />
        <span>Vault proposal dismissed</span>
      </div>
    );
  }

  if (status === "conflict" && conflict) {
    const isKeyMatch = conflict.match_type === "key";
    return (
      <div className="cmp-confirm">
        <div className="cmp-confirm-head">
          <ShieldCheck size={15} />
          <strong>Similar Vault record exists</strong>
          <span className="cmp-confirm-name">{proposal.category}</span>
        </div>
        <div className="cmp-confirm-fields">
          <label>Existing record</label>
          <input className="set-input" readOnly value={conflict.existing?.label ?? ""} />
          <label>Existing preview</label>
          <input
            className="set-input"
            readOnly
            value={conflict.existing?.redacted_preview ?? ""}
          />
        </div>
        <p className="cmp-confirm-note">
          {isKeyMatch
            ? "A record with the same key already exists with a different value. Update it, add a separate record, or keep the existing one."
            : "This value is already stored under a different record. Add it here too, update the existing one, or keep it as is."}
        </p>
        <div className="cmp-confirm-actions">
          <button
            className="set-btn primary"
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("update")}
          >
            Update existing
          </button>
          <button
            className="set-btn"
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("add")}
          >
            Add new
          </button>
          <button
            className="set-btn"
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("ignore")}
          >
            Keep existing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-confirm">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Sensitive data detected</strong>
        <span className="cmp-confirm-name">{proposal.category}</span>
      </div>
      <div className="cmp-confirm-fields">
        <label>Record</label>
        <input className="set-input" readOnly value={proposal.label} />
        <label>Redacted preview</label>
        <input className="set-input" readOnly value={proposal.redacted_preview} />
      </div>
      <p className="cmp-confirm-note">
        The value stays out of normal memory. Save stores the redacted record now; local PIN is
        required later to reveal or edit the value.
      </p>
      {status === "error" && <p className="cmp-confirm-err">Error: {note}</p>}
      <div className="cmp-confirm-actions">
        <button className="set-btn primary" type="button" disabled={busy} onClick={() => void save()}>
          Save to Vault
        </button>
        <button className="set-btn" type="button" disabled={busy} onClick={() => void dismiss()}>
          Do not save
        </button>
      </div>
    </div>
  );
}

function VaultRevealCard({ proposal }: { proposal: VaultRevealProposal }) {
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "revealed" | "error">("idle");
  const [secretValue, setSecretValue] = useState("");
  const [showValue, setShowValue] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const busy = status === "running";

  const reveal = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result = await coreBridge.vaultRecordReveal(proposal.record_id, pin);
      setSecretValue(result.secret_value);
      setPin("");
      setShowValue(true);
      setStatus("revealed");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  return (
    <div className="cmp-confirm">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Vault unlock required</strong>
        <span className="cmp-confirm-name">{proposal.category}</span>
      </div>
      <div className="cmp-confirm-fields">
        <label>Record</label>
        <input className="set-input" readOnly value={proposal.label} />
        <label>Redacted preview</label>
        <input className="set-input" readOnly value={proposal.redacted_preview} />
      </div>
      {status !== "revealed" ? (
        <>
          <p className="cmp-confirm-note">
            Enter your local PIN to reveal this value on this device. The value is not saved back
            into the chat transcript.
          </p>
          <div className="cmp-confirm-fields">
            <label>Local PIN</label>
            <input
              className="set-input"
              inputMode="numeric"
              type="password"
              value={pin}
              disabled={busy}
              onChange={(event) => setPin(event.target.value)}
            />
          </div>
          {status === "error" && <p className="cmp-confirm-err">Error: {note}</p>}
          <div className="cmp-confirm-actions">
            <button
              className="set-btn primary"
              type="button"
              disabled={busy || pin.length === 0}
              onClick={() => void reveal()}
            >
              {busy ? "Unlocking..." : "Reveal value"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="cmp-confirm-fields">
            <label>Value</label>
            <input
              className="set-input"
              readOnly
              type={showValue ? "text" : "password"}
              value={secretValue}
            />
          </div>
          <div className="cmp-confirm-actions">
            <button className="set-btn" type="button" onClick={() => setShowValue((value) => !value)}>
              {showValue ? "Hide value" : "Show value"}
            </button>
            <button
              className="set-btn"
              type="button"
              onClick={() => {
                setSecretValue("");
                setStatus("idle");
                setShowValue(true);
              }}
            >
              Lock
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PaymentApprovalCard({
  proposal,
  messageId,
  threadId,
}: {
  proposal: PaymentApprovalProposal;
  messageId?: string;
  threadId?: string;
}) {
  const snapshot = proposal.snapshot;
  const [pin, setPin] = useState("");
  const [cvv, setCvv] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "approved" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);

  const approve = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result = await coreBridge.vaultPaymentApprovalApprove(snapshot, pin, cvv, {
        threadId,
        messageId,
      });
      setPin("");
      setCvv("");
      setStatus("approved");
      setNote(
        `Pagamento autorizzato: ${result.payment_approval_id}. L'autorizzazione scade tra ${result.expires_in_seconds}s.`,
      );
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const amount = formatPaymentAmount(snapshot.amount_minor, snapshot.currency);
  const busy = status === "running";

  return (
    <div className="cmp-confirm destructive">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Conferma pagamento</strong>
        <span className="cmp-confirm-name">{amount}</span>
      </div>
      <div className="cmp-confirm-fields">
        <label>Merchant</label>
        <input readOnly value={snapshot.merchant} />
        <label>Dominio</label>
        <input readOnly value={snapshot.domain} />
        <label>Prodotto</label>
        <textarea className="set-input" readOnly rows={2} value={snapshot.product_summary} />
        <label>Metodo</label>
        <input readOnly value={snapshot.payment_method_label} />
      </div>
      <p className="cmp-confirm-note">
        Il click finale resta bloccato finché PIN e CVV one-shot non sono verificati localmente.
        Il CVV non viene salvato.
      </p>
      {status !== "approved" && (
        <div className="cmp-confirm-fields">
          <label>PIN locale</label>
          <input
            className="set-input"
            inputMode="numeric"
            type="password"
            value={pin}
            disabled={busy}
            onChange={(event) => setPin(event.target.value)}
          />
          <label>CVV/CV2 one-shot</label>
          <input
            className="set-input"
            inputMode="numeric"
            type="password"
            value={cvv}
            disabled={busy}
            onChange={(event) => setCvv(event.target.value)}
          />
        </div>
      )}
      {status === "error" && <p className="cmp-confirm-err">Errore: {note}</p>}
      {status === "approved" && note && <p className="cmp-confirm-note">{note}</p>}
      {status !== "approved" && (
        <div className="cmp-confirm-actions">
          <button
            className="set-btn primary"
            type="button"
            disabled={busy || pin.length === 0 || cvv.length === 0}
            onClick={() => void approve()}
          >
            {busy ? "Verifico..." : "Autorizza pagamento"}
          </button>
        </div>
      )}
    </div>
  );
}

function formatPaymentAmount(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/** Plan-mode card: the model proposed a plan and stopped. Accetta sends the approval
 *  (the agent executes next turn); Edit reveals a box to request changes. The
 *  answer becomes the next user message. */
/** Inline affordance: the model proposed the project's objective(s) — save them with one
 * click (content-contextual via a model-emitted marker, not keyword parsing). Resolves the
 * project workspace from the thread, then saves each chosen objective as a `goal`. */
function GoalProposeCard({ objectives, threadId }: { objectives: string[]; threadId: string }) {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void coreBridge.projectGoals(threadId).then((d) => {
      if (!cancelled) setWorkspace(d?.workspace ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  const save = (i: number, text: string) => {
    if (!workspace || saved.has(i)) return;
    setBusy(i);
    void coreBridge
      .addGoal(workspace, text)
      .then((ok) => {
        if (ok) setSaved((prev) => new Set(prev).add(i));
      })
      .finally(() => setBusy(null));
  };
  return (
    <div className="goal-propose-card">
      <div className="goal-propose-head">
        <Target size={14} />
        <span>{t("chat.proposedGoalsHint")}</span>
      </div>
      <div className="goal-propose-list">
        {objectives.map((o, i) => (
          <div key={i} className="goal-propose-item">
            <span>{o}</span>
            <button
              className="goals-btn goals-btn-sm"
              disabled={busy !== null || saved.has(i) || !workspace}
              onClick={() => save(i, o)}
            >
              {saved.has(i) ? (
                <>
                  <Check size={13} /> Saveto
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanProposeCard({
  plan,
  onAnswer,
}: {
  plan: PlanProposal;
  onAnswer: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"idle" | "editing" | "sent">("idle");
  const [feedback, setFeedback] = useState("");
  const [decision, setDecision] = useState("");
  if (phase === "sent") {
    return (
      <div className="plan-card done">
        <Check size={14} />
        <span>{decision}</span>
      </div>
    );
  }
  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <CalendarClock size={15} />
        <strong>{t("chat.proposedPlan")}</strong>
        <span className="plan-card-gate">{t("chat.awaitingConfirmation")}</span>
      </div>
      {plan.summary && <p className="plan-card-summary">{plan.summary}</p>}
      <ol className="plan-card-steps">
        {plan.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {phase === "editing" ? (
        <div className="plan-card-edit">
          <textarea
            autoFocus
            placeholder={t("chat.whatToChangeInPlan")}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="plan-card-actions">
            <button type="button" className="plan-btn ghost" onClick={() => setPhase("idle")}>
              Cancel
            </button>
            <button
              type="button"
              className="plan-btn primary"
              disabled={!feedback.trim()}
              onClick={() => {
                setDecision(t("chat.changesRequested"));
                setPhase("sent");
                onAnswer(`Review the plan before proceeding: ${feedback.trim()}`);
              }}
            >
              {t("chat.sendChanges")}
            </button>
          </div>
        </div>
      ) : (
        <div className="plan-card-actions">
          <button
            type="button"
            className="plan-btn primary"
            onClick={() => {
              setDecision(t("chat.planAccepted"));
              setPhase("sent");
              onAnswer("I approve the plan: proceed with execution.");
            }}
          >
            Accetta ed esegui
          </button>
          <button type="button" className="plan-btn ghost" onClick={() => setPhase("editing")}>
            Edit / Ridiscuti
          </button>
        </div>
      )}
    </div>
  );
}

/** Live operational plan rendered inline (Claude-Code todo style): a checklist with a
 *  status icon per step, updated as the agent calls update_plan (doing→done). */
function PlanProgressCard({ steps }: { steps: PlanStep[] }) {
  const { t } = useTranslation();
  const doneCount = steps.filter((s) => s.status === "done").length;
  return (
    <div className="plan-progress">
      <div className="plan-progress-head">
        <ListTodo size={14} />
        <strong>{t("chat.plan")}</strong>
        <span className="plan-progress-count">
          {doneCount}/{steps.length}
        </span>
      </div>
      <ul className="plan-progress-steps">
        {steps.map((step, i) => (
          <li key={i} className={`plan-progress-step ${step.status}`}>
            <span className="plan-progress-icon">
              {step.status === "done" ? (
                <Check size={14} />
              ) : step.status === "doing" ? (
                <Loader2 size={14} className="composer-spin" />
              ) : step.status === "blocked" ? (
                <AlertTriangle size={14} />
              ) : (
                <span className="plan-progress-dot" />
              )}
            </span>
            <span className="plan-progress-text">
              <span className="plan-progress-title">{step.title}</span>
              {step.detail && step.detail !== "—" && (
                <span className="plan-progress-detail">{step.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Single/multi-choice question card. Single: each option is a button that sends the
 *  answer on click. Multi: toggle chips + a Confirm button that sends the joined
 *  selection. The answer becomes the next user message (like Claude Code's choices). */
function ChoicesCard({
  prompt,
  onChoose,
}: {
  prompt: ChoicePrompt;
  onChoose: (answer: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  if (sent) {
    return (
      <div className="choices-card done">
        <Check size={14} />
        <span>{picked.join(", ")}</span>
      </div>
    );
  }
  const toggle = (option: string) =>
    setPicked((cur) =>
      cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option],
    );
  const send = (answer: string[]) => {
    if (answer.length === 0) return;
    setPicked(answer);
    setSent(true);
    onChoose(answer.join(", "));
  };
  return (
    <div className="choices-card">
      {prompt.question && <p className="choices-question">{prompt.question}</p>}
      <div className="choices-options">
        {prompt.options.map((option) => {
          const active = picked.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`choices-option ${active ? "active" : ""}`}
              onClick={() => (prompt.multi ? toggle(option) : send([option]))}
            >
              {prompt.multi &&
                (active ? <CheckSquare size={15} /> : <Square size={15} />)}
              <span>{option}</span>
            </button>
          );
        })}
      </div>
      {prompt.multi && (
        <button
          type="button"
          className="choices-confirm"
          disabled={picked.length === 0}
          onClick={() => send(picked)}
        >
          Confirm{picked.length > 0 ? ` (${picked.length})` : ""}
        </button>
      )}
    </div>
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
        <strong>Connect a capability for "{suggest.need}"</strong>
      </div>
      <p className="set-hint" style={{ fontSize: 12, margin: 0 }}>
        I do not have this tool yet. Choose what to connect below — you manage it
        also from Settings.
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
  mcp: { icon: Plug, label: "MCP server", cta: "Connect" },
  skill: { icon: Puzzle, label: "Skills", cta: "Install" },
  composio: { icon: Cloud, label: "Cloud service", cta: "Link" },
};

/** A single connectable suggestion. MCP servers with required params expand an
 *  inline form (mirrors Settings → MCP catalog); skills install directly;
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
  const { t } = useTranslation();
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
          ? `Connected with warning: ${result.discovery_error}`
          : t("chat.toolsAvailable", { count: result.tools_cached }),
      );
      setStatus("done");
      await markConnected();
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const installSkills = async () => {
    if (!item.slug) return;
    setStatus("running");
    setNote(null);
    try {
      await coreBridge.catalogInstall(item.slug);
      setStatus("done");
      setNote(t("chat.skillInstalledRetry"));
      await markConnected();
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const linkComposio = async () => {
    if (!item.slug) return;
    setStatus("running");
    setNote(`Opening authorization for ${item.name}…`);
    const ok = await connectComposioToolkit(item.slug, {
      onStatus: (s) => {
        if (s === "connecting") {
          setNote(`Authorize ${item.name} in the browser: I detect automatically when it is done…`);
        }
      },
    });
    if (ok) {
      setStatus("done");
      setNote(t("chat.connectedName", { name: item.name }));
      await markConnected();
    } else {
      setStatus("error");
      setNote(t("chat.connectionNotCompleted"));
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
      void installSkills();
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
              <span className="set-badge green" style={{ marginLeft: 4 }} title={t("chat.officialServer")}>
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
          <span className="set-badge green" title={t("chat.linked")}>
            <Check size={12} /> {t("chat.linked")}
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
                ? t("chat.configure")
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
                {input.required ? " *" : " (optional)"}
                {input.secret && ` · ${t("chat.secret")}`}
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
                    title={reveal[input.key] ? t("chat.hide") : t("chat.show")}
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
              {status === "running" ? t("chat.connecting") : t("chat.connect")}
            </button>
            {item.server?.homepage && (
              <a
                href={item.server.homepage}
                target="_blank"
                rel="noreferrer"
                className="set-hint"
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
              >
                {t("chat.projectPage")} <ExternalLink size={12} />
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
  const { t } = useTranslation();
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
        setNote(result.summary || t("chat.authorizationFailed"));
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
          <strong>Access granted to {path}</strong>
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
        <strong>Grant access to this folder?</strong>
      </div>
      <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", marginTop: 4 }}>
        {path}
      </code>
      <p className="set-hint" style={{ fontSize: 12 }}>
        I will be able to read files and folders inside. You manage it also from Settings → Computer.
      </p>
      {status === "error" && <p className="cmp-confirm-err">{t("chat.failed")}: {note}</p>}
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

/** ADR 0023 — on-failure sandbox escalation card. A shell command failed under the
 *  Seatbelt workspace sandbox; approving re-runs it UNSANDBOXED with full access.
 *  Mirrors FsAuthorizeCard: the backend rewrites the originating message to a
 *  done-note (via ctx), so the card can't reopen after a successful run. */
function SandboxEscalateCard({
  command,
  cwd,
  messageId,
  threadId,
}: {
  command: string;
  cwd: string;
  messageId?: string;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [output, setOutput] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result = await coreBridge.runEscalate(command, cwd, { threadId, messageId });
      if (!result.ok) {
        setStatus("error");
        setNote(result.summary || t("chat.failed"));
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
          <strong>Command ran with full access</strong>
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
        <SquareTerminal size={15} />
        <strong>This command was blocked by the workspace sandbox. Run it with full access?</strong>
      </div>
      <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", marginTop: 4 }}>
        {command}
      </code>
      <p className="set-hint" style={{ fontSize: 12 }}>
        It will run outside the sandbox with full access to your machine. Only approve commands you trust.
      </p>
      {status === "error" && <p className="cmp-confirm-err">{t("chat.failed")}: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void run()}
        >
          <SquareTerminal size={14} />
          <span style={{ marginLeft: 6 }}>
            {status === "running" ? "Running…" : "Run without sandbox"}
          </span>
        </button>
      </div>
    </div>
  );
}

function ComposioReconnectCard({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);

  const reconnect = async () => {
    setStatus("running");
    setNote(t("chat.openingReconnection", { name }));
    const ok = await connectComposioToolkit(slug, {
      onStatus: (s) => {
        if (s === "connecting") {
          setNote(`Authorize ${name} in the browser: I detect automatically when it is done…`);
        }
      },
    });
    if (ok) {
      setStatus("done");
      setNote(t("chat.reconnectedName", { name }));
    } else {
      setStatus("error");
      setNote(t("chat.reconnectionNotCompleted"));
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
        <strong>{t("chat.linkExpired")}</strong>
        <span className="cmp-confirm-name">{name}</span>
      </div>
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void reconnect()}
        >
          {status === "running" ? t("chat.opening") : t("chat.reconnectName", { name })}
        </button>
      </div>
      {note && (status === "running" || status === "error") && (
        <p className={`cmp-confirm-note ${status === "error" ? "error" : ""}`}>{note}</p>
      )}
    </div>
  );
}

const COMPOSIO_FIELD_LABELS: Record<string, string> = {
  recipient_email: "Recipient",
  recipientemail: "Recipient",
  to: "Recipient",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Body",
  message: "Body",
  is_html: "HTML",
  attachment: "Attachment",
  // Calendar / events
  summary: "Title",
  title: "Title",
  description: "Description",
  location: "Location",
  start_datetime: "Start",
  end_datetime: "End",
  start_time: "Start",
  end_time: "End",
  start: "Start",
  end: "End",
  due_date: "Due date",
  date: "Date",
  attendees: "Attendees",
  timezone: "Time zone",
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
  const { t } = useTranslation();
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
        ? await coreBridge.mcpExecute(action.tool, args, scope, { threadId, messageId })
        : await coreBridge.composioExecute(action.tool, args, scope, { threadId, messageId });
      if (!result.ok) {
        // The backend replied but the action failed — never show a green "done".
        setStatus("error");
        setNote(result.summary || t("chat.actionFailed"));
        return;
      }
      setStatus("done");
      setNote(
        scope !== "always"
          ? "Done."
          : isMcp
            ? "Fatto. Questo server non chiederà più conferma."
            : `Done. From now on «${title}» will run without asking.`,
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
        <strong>{destructive ? t("chat.confirmDestructiveAction") : t("chat.confirmAction")}</strong>
        <span className="cmp-confirm-name">{title}</span>
      </div>
      {destructive && (
        <p className="cmp-confirm-warn">
          {t("chat.destructiveWarning", {
            service: humanizeToolName(action.tool).split(" · ")[1] ?? t("chat.aLinkedService"),
          })}
        </p>
      )}
      <div className="cmp-confirm-fields">
        {keys.length === 0 && (
          <p className="cmp-confirm-empty">
            {hiddenIdCount > 0
              ? t("chat.actsOnIdentifiedItem")
              : t("chat.noParameters")}
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
      {status === "error" && <p className="cmp-confirm-err">{t("chat.failed")}: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void run("once")}
        >
          {status === "running" ? "Running…" : "Run once"}
        </button>
        <button
          className="set-btn"
          type="button"
          disabled={status === "running"}
          onClick={() => void run("always")}
          title={isMcp ? "Non chiedere più per questo server MCP" : `Do not ask again for ${title}`}
        >
          {isMcp ? "Consenti sempre questo server" : "Esegui sempre"}
        </button>
      </div>
      <p className="cmp-confirm-note">
        {isMcp
          ? '"Consenti sempre" non chiederà più conferma per nessuna azione di questo server MCP — anche da remoto su Telegram/WhatsApp.'
          : '"Run always" disables confirmation everywhere for this tool — including remote su Telegram/WhatsApp.'}
      </p>
    </div>
  );
}

function InlineApprovelPanel({
  approvals,
  busyId,
  onApprove,
  onReject,
  session,
}: {
  approvals: ApprovelItem[];
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
  const { t } = useTranslation();
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
    ? "You approve only the next step of the plan. Login, purchase, send and payment stay blocked until you give an explicit confirmation for that single action."
    : approval.reason;
  const busy = busyId === approval.id;
  return (
    <article className="inline-approval-panel" aria-label={t("chat.confirmRequest")}>
      <header>
        <span className={`approval-dot ${approval.risk}`}>
          <AlertCircle size={15} />
        </span>
        <div>
          <strong>{t("chat.approvalRequired")}</strong>
          <small>{approval.risk === "high" ? t("chat.highRisk") : t("chat.controlledAction")}</small>
        </div>
      </header>

      <p>{summary}</p>

      {waitingSteps.length > 0 && (
        <div className="approval-plan-preview">
          <span>{t("chat.aboutToDo")}</span>
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
        <span>Raw data not exposed. No irreversible external action without confirmation.</span>
      </div>

      <div className="approval-scope-note">
        <span>Confirmation scope</span>
        <div className="approval-scope-options" aria-label="Confirmation scope">
          {scopeOptions.map((option) => (
            <button
              key={option}
              aria-pressed={scope === option}
              type="button"
              onClick={() => setScope(option)}
            >
              {option === "always" ? "Always for these URLs" : "Just this time"}
            </button>
          ))}
        </div>
        <small>
          {scope === "always"
            ? "Save a local rule for the domains involved in this task."
            : "Applies only to this task execution."}
        </small>
      </div>

      {browserVisibilityOptions.length > 0 && (
        <div className="approval-scope-note">
          <span>Browser</span>
          <div className="approval-scope-options" aria-label={t("chat.browserMode")}>
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
          <small>Auto follows the system choice; visible shows the local computer.</small>
        </div>
      )}

      <footer>
        <button
          className="secondary-button"
          disabled={busy}
          type="button"
          onClick={() => onReject(approval.id)}
        >
          Reject
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
          {busy ? "Continuo..." : "Approve e continua"}
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
  const { t } = useTranslation();
  const surfaceLabel =
    session.activeSurface === "browser"
      ? "Browser"
      : session.activeSurface === "shell"
        ? "Terminal"
        : "Computer";
  const activityLabel =
    planStepRunning || smokeTestRunning ? "running" : "ready";
  const hasApprovel = approvalsCount > 0;
  const hasWaitingStep = session.timeline.some((item) => item.status === "waiting");

  return (
    <article className={`local-computer-card ${collapsed ? "collapsed" : ""}`}>
      <div className="computer-card-toolbar">
        <button
          className="computer-toolbar-main"
          type="button"
          onClick={onOpen}
        >
          <Monitor size={15} />
          <strong>Local computer</strong>
          <span className="computer-live-badge">
            <span className="computer-live-dot" aria-hidden="true" />
            {activityLabel === "running" ? t("chat.liveView") : surfaceLabel}
          </span>
        </button>
        <div className="computer-toolbar-meta">
          <span className="computer-card-source">
            {session.activeSurface === "browser"
              ? t("chat.noVncRealBrowser")
              : session.activeSurface === "shell"
                ? t("chat.realShell")
                : t("chat.realComputer")}
          </span>
          <span>
            {session.progressCurrent} / {session.progressTotal}
          </span>
          {hasApprovel ? (
            <button
              className="computer-inline-action attention"
              type="button"
              onClick={onOpenTasks}
            >
              {t("chat.confirmRequest")}
            </button>
          ) : (
            <button
              className="computer-inline-action"
              disabled={planStepRunning || !hasWaitingStep}
              type="button"
              onClick={onRunPlanStep}
            >
              {planStepRunning
                ? t("chat.running")
                : hasWaitingStep
                  ? t("chat.action.continue")
                  : t("chat.noAction")}
            </button>
          )}
          <button
            className="computer-collapse-button"
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("chat.showLocalComputer") : t("chat.hideLocalComputer")}
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
              <span>Open details</span>
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
                  ? t("chat.running")
                  : hasWaitingStep
                    ? t("chat.runPlan")
                    : t("chat.planStopped")}
              </button>
              {hasApprovel && (
                <button
                  className="smoke-test-button attention"
                  type="button"
                  onClick={onOpenTasks}
                >
                  {t("chat.openApproval")}
                </button>
              )}
              <button
                className="smoke-test-button"
                disabled={smokeTestRunning}
                type="button"
                onClick={onRunSmokeTest}
              >
                {smokeTestRunning ? t("chat.runningEllipsis") : t("chat.realTest")}
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
  const { t } = useTranslation();
  const currentSurface = session.surfaces.find((surface) => surface.id === activeSurface);
  const paused = session.status === "paused";
  // Fullscreen toggle (design): expand the panel to near-full-window for wide
  // diffs/browser views, then shrink back. Local UI state — no persistence needed.
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <aside
      className={`computer-detail-panel${fullscreen ? " fullscreen" : ""}`}
      aria-label={t("chat.localComputerDetail")}
    >
      <header>
        <div>
          <strong>{session.title}</strong>
          <small>{session.subtitle}</small>
        </div>
        <div className="computer-panel-header-actions">
          <button
            className="icon-button"
            type="button"
            aria-label={fullscreen ? t("chat.collapsePanel") : t("chat.expandPanel")}
            title={fullscreen ? t("chat.collapse") : t("chat.action.expand")}
            onClick={() => setFullscreen((value) => !value)}
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button className="icon-button" type="button" aria-label="Close computer" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>

      <nav className="surface-tabs" aria-label={t("chat.computerSurfaces")}>
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
                  alt={t("chat.redactedBrowserPreview")}
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
              : t("chat.noTerminalOutput")}
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
              <p className="empty-panel-state">{t("chat.noRedactedArtifact")}</p>
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
              <span>No redacted events available.</span>
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
            {paused ? t("chat.resume") : t("chat.pause")}
          </button>
          <button
            className="primary-button"
            disabled={controlBusy}
            type="button"
            onClick={onTakeover}
          >
            {t("chat.takeControl")}
          </button>
        </div>
      </footer>
    </aside>
  );
}

// Quick-action chips on the empty-chat hero: the DELIVERABLE utilities Homun can create
// (Manus-style discovery — so the user sees what's possible instead of guessing) + search.
// `key` drives both the i18n label and the composer seed; the seed is a natural prompt
// that triggers the matching skill (create-presentations / create-documents / etc.).
const EMPTY_HERO_CHIPS: { key: string; icon: typeof Search }[] = [
  { key: "presentation", icon: Presentation },
  { key: "document", icon: FileText },
  { key: "research", icon: BarChart3 },
  { key: "meeting", icon: ClipboardList },
  { key: "search", icon: Search },
];

// Empty-chat hero (design): the Homun mark (the "U" + dot brandmark) + "Cosa facciamo
// oggi?" + quick-action chips that seed the composer. The mark uses the theme vars
// (U = --text, dot = --brand) so it adapts to light/dark.
function ChatEmptyHero({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="chat-hero">
      <svg className="chat-hero-mark" viewBox="646 -2 280 280" aria-hidden="true">
        <circle cx="786" cy="60" r="34" fill="var(--brand)" />
        <path
          d="M721 117V187C721 220.333 742.667 237 786 237C829.333 237 851 220.333 851 187V117"
          fill="none"
          stroke="var(--text)"
          strokeWidth="28"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <h1 className="chat-hero-title">{t("chat.emptyHero")}</h1>
      <p className="chat-hero-sub">{t("chat.emptyHeroSub")}</p>
      <div className="chat-hero-chips">
        {EMPTY_HERO_CHIPS.map((chip) => {
          const Icon = chip.icon;
          return (
            <button
              key={chip.key}
              type="button"
              className="chat-hero-chip"
              onClick={() => onPick(t(`chat.heroChip.${chip.key}.seed`))}
            >
              <Icon size={13} />
              {t(`chat.heroChip.${chip.key}.label`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Composer({
  disabled,
  error,
  replyContext,
  seed,
  streaming,
  threadId,
  onCancelStreaming,
  onClearReply,
  onSubmit,
}: {
  disabled: boolean;
  error: string | null;
  replyContext: ReplyContext | null;
  seed: { text: string; nonce: number } | null;
  streaming: boolean;
  threadId: string;
  onCancelStreaming: () => void;
  onClearReply: () => void;
  onSubmit: (
    prompt: string,
    attachments: ChatAttachmentInput[],
    options?: {
      model?: string;
      mode?: string;
      forcedSkillsId?: string;
      contextText?: string;
      images?: string[];
    },
  ) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  // Empty-state chips seed the composer; nonce lets the same chip re-apply.
  useEffect(() => {
    if (seed && seed.text) setValue(seed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);
  const [linkedFolder, setLinkedFolder] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [folderPathInput, setFolderPathInput] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [contextFiles, setContextFiles] = useState<
    Array<{ path: string; content: string; truncated: boolean }>
  >([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelGroups, setModelGroups] = useState<ProviderModelsGroup[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  // Per-message model override. null = "Auto" (use this thread's resolved role:
  // coding in a linked project, orchestrator otherwise). A picked value is the
  // composite "<provider_id>::<model>", so the same model id present in two
  // providers resolves to the provider the user actually chose.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // Interaction mode (composer pill, Cursor-style): agent | plan | ask | debug.
  // Debug is offered only when a project folder is linked (coding context).
  const [chatMode, setChatMode] = useState<ChatMode>("agent");
  const [modelQuery, setModelQuery] = useState("");

  // Refetches the model list + default resolved for THIS thread + per-provider groups.
  // Called on mount and when the menu opens, so a Settings change reflects without an
  // app restart. Does NOT touch the user's selection (Auto stays Auto unless they pick).
  // Runs at most once per mount: if the runtime list is empty, the provider's
  // model catalog was never fetched into the registry — populate it so the picker
  // isn't empty (this is why it only appeared after visiting Settings, which also
  // refreshes). Returns the model count so the mount effect can retry past the
  // gateway-startup race. Guarded by a ref so retries don't re-hit the network.
  const modelsSelfHealedRef = useRef(false);
  async function refreshModels(): Promise<number> {
    try {
      let list = await coreBridge.runtimeModels(threadId);
      if ((list.available ?? []).length === 0 && !modelsSelfHealedRef.current) {
        modelsSelfHealedRef.current = true;
        const provs = await coreBridge.providers().catch(() => null);
        const stale = (provs?.providers ?? []).filter((p) => p.enabled && p.models.length === 0);
        if (stale.length > 0) {
          await Promise.all(stale.map((p) => coreBridge.refreshProviderModels(p.id).catch(() => null)));
          list = await coreBridge.runtimeModels(threadId);
        }
      }
      setModels(list.available ?? []);
      setModelGroups(list.groups ?? []);
      setActiveModel(list.active);
      return (list.available ?? []).length;
    } catch {
      return 0; // gateway not ready yet — the mount effect retries
    }
  }
  const [skills, setSkillss] = useState<SkillsSummary[]>([]);
  const [forcedSkills, setForcedSkills] = useState<SkillsSummary | null>(null);
  const [skillMenuOpen, setSkillsMenuOpen] = useState(false);
  const [skillQuery, setSkillsQuery] = useState("");
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  // Click outside the toolbar closes any open composer menu (⊕ add / folder / skill /
  // model). Clicks INSIDE .composer-toolbar are left to the buttons' own toggles.
  useEffect(() => {
    if (!addMenuOpen && !fileMenuOpen && !skillMenuOpen && !modelMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest(".composer-toolbar")) return;
      setAddMenuOpen(false);
      setFileMenuOpen(false);
      setSkillsMenuOpen(false);
      setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addMenuOpen, fileMenuOpen, skillMenuOpen, modelMenuOpen]);
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

  useEffect(() => {
    if (replyContext) {
      textareaRef.current?.focus();
    }
  }, [replyContext]);

  // Cursor ready in the composer when you open or switch a chat — type right away,
  // no extra click. rAF so it runs after the new thread's layout settles.
  useEffect(() => {
    const id = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [threadId]);

  // When the assistant FINISHES responding (streaming true→false), return the cursor to
  // the composer so the user can type the next message immediately — no extra click.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  // The runtime model list can be empty for a moment right after launch/onboarding
  // (gateway still settling, registry just written). Poll until it resolves so the
  // model picker isn't absent on the first turn — without a manual reload. Stops as
  // soon as it's populated; capped so an unconfigured app doesn't poll forever.
  useEffect(() => {
    if (models.length > 0 || activeModel) return undefined;
    let attempts = 0;
    const id = window.setInterval(() => {
      attempts += 1;
      if (attempts > 20) {
        window.clearInterval(id);
        return;
      }
      void refreshModels();
    }, 1200);
    return () => window.clearInterval(id);
  }, [models.length, activeModel, threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await refreshModels();
      try {
        const response = await coreBridge.skills();
        if (cancelled) return;
        setSkillss((response.skills ?? []).filter((skill) => skill.enabled));
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
      setDictationError(t("chat.micUnavailable"));
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
        setFolderError("Picker unavailable: paste the folder path below.");
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
      const note = file.truncated ? " (truncated)" : "";
      return `### File: ${file.path}${note}\n\`\`\`\n${file.content}\n\`\`\``;
    });
    return `Context from files attached from the linked folder:\n\n${blocks.join("\n\n")}`;
  }

  const folderName = linkedFolder
    ? linkedFolder.replace(/\/+$/, "").split("/").pop() || linkedFolder
    : null;

  const filteredSkillss = skills.filter((skill) => {
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
      setComposerAttachmentError("Local path not available in this shell.");
      return;
    }
    const attachmentInputs = attachments.map((attachment) => ({
      localPath: attachment.localPath,
      displayName: attachment.name,
      mimeType: attachment.type,
      sizeBytes: attachment.size,
    }));
    const images = composerImages.map((image) => image.dataUrl);
    const effectivePrompt = prompt || "Describe this image.";
    // null = Auto (no override → default role); else the composite "<provider>::<model>".
    const modelOverride = selectedModel ?? undefined;
    const forcedSkillsId = forcedSkills?.id;
    const contextText = buildContextText();
    setValue("");
    setAttachments([]);
    setComposerImages([]);
    setContextFiles([]);
    setComposerAttachmentError(null);
    requestAnimationFrame(adjustComposerHeight);
    onSubmit(effectivePrompt, attachmentInputs, {
      model: modelOverride,
      mode: chatMode === "agent" ? undefined : chatMode,
      forcedSkillsId,
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

  return (
    <form
      className={`composer-surface${dragOver ? " drag-over" : ""}`}
      aria-label={t("chat.operationalPrompt")}
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
        <div className="reply-context-card" aria-label={t("chat.quotedMessage")}>
          <Reply size={14} />
          <div>
            <strong>Reply to {messageRoleLabel(replyContext.role)}</strong>
            <span>{replyContext.preview}</span>
          </div>
          <button type="button" aria-label={t("chat.removeQuote")} onClick={onClearReply}>
            <X size={14} />
          </button>
        </div>
      )}
      <textarea
        aria-label={t("chat.requestForAssistant")}
        disabled={disabled}
        onChange={handleValueChange}
        onKeyDown={handleKeyDown}
        onPaste={handleComposerPaste}
        placeholder="Send a message or add task instructions"
        ref={textareaRef}
        value={value}
      />
      {composerImages.length > 0 && (
        <div className="composer-image-tray" aria-label={t("chat.attachedImages")}>
          {composerImages.map((image) => (
            <span className="composer-image-thumb" key={image.id}>
              <img src={image.dataUrl} alt={image.name} />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => removeComposerImage(image.id)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachment-tray" aria-label={t("chat.selectedAttachments")}>
          {attachments.map((attachment) => (
            <span className="composer-attachment-item" key={attachment.id}>
              <Paperclip size={13} />
              <span>{attachment.name}</span>
              <small>{formatFileSize(attachment.size)}</small>
              {!attachment.localPath && <small>{t("chat.pathUnavailable")}</small>}
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      {forcedSkills && (
        <div className="composer-forced-skill" aria-label={t("chat.forcedCapabilityNextMessage")}>
          <Puzzle size={13} />
          <span>{forcedSkills.name}</span>
          <button type="button" aria-label="Remove capability" onClick={() => setForcedSkills(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {contextFiles.length > 0 && (
        <div className="composer-context-files" aria-label={t("chat.filesAttachedAsContext")}>
          {contextFiles.map((file) => (
            <span className="composer-file-chip" key={file.path} title={file.path}>
              <AtSign size={12} />
              <span>{file.path.split("/").pop()}</span>
              <button
                type="button"
                aria-label={`Remove ${file.path}`}
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
          {/* One add menu gathers every input action while keeping the composer compact.
              Folder and capability popovers stay anchored to this same wrap. */}
          <div className="composer-pop-wrap">
            <button
              className={`composer-add-button${
                addMenuOpen || contextFiles.length > 0 || linkedFolder || forcedSkills
                  ? " active"
                  : ""
              }`}
              type="button"
              disabled={disabled}
              aria-label="Add"
              aria-expanded={addMenuOpen}
              title={t("chat.addMenuTitle")}
              onClick={() => {
                setAddMenuOpen((open) => !open);
                setFileMenuOpen(false);
                setSkillsMenuOpen(false);
                setModelMenuOpen(false);
              }}
            >
              <Plus size={18} />
            </button>
            {addMenuOpen && (
              <div className="composer-pop composer-add-pop" role="menu">
                <div className="composer-add-eyebrow">
                  {t("chat.addContextCapabilities")}
                </div>
                {CHAT_MODES.filter((m) => !m.projectOnly || linkedFolder != null).map((m) => {
                  const I = m.icon;
                  const active = m.key === chatMode;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      role="menuitem"
                      className={active ? "active" : ""}
                      onClick={() => {
                        setChatMode(m.key);
                        setAddMenuOpen(false);
                      }}
                    >
                      <I size={16} />
                      <span className="composer-mode-text">
                        <strong>{m.label}</strong>
                        {m.desc && <small>{m.desc}</small>}
                      </span>
                      {active && <Check size={14} className="composer-add-check" />}
                    </button>
                  );
                })}
                <div className="composer-add-divider" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <Paperclip size={16} />
                  <span>Attach file</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={contextFiles.length > 0 || linkedFolder ? "active" : ""}
                  onClick={() => {
                    setAddMenuOpen(false);
                    setFileMenuOpen(true);
                  }}
                >
                  <AtSign size={16} />
                  <span>{linkedFolder ? "Mention a file" : "Link a folder"}</span>
                </button>
                {skills.length > 0 && (
                  <button
                    type="button"
                    role="menuitem"
                    className={forcedSkills ? "active" : ""}
                    onClick={() => {
                      setAddMenuOpen(false);
                      setSkillsMenuOpen(true);
                    }}
                  >
                    <Puzzle size={16} />
                    <span>{forcedSkills ? `Capability · ${forcedSkills.name}` : t("chat.useCapability")}</span>
                  </button>
                )}
                {value.trim() && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={improving}
                    onClick={() => {
                      setAddMenuOpen(false);
                      void handleImprovePrompt();
                    }}
                  >
                    {improving ? (
                      <Loader2 size={16} className="composer-spin" />
                    ) : (
                      <WandSparkles size={16} />
                    )}
                    <span>{t("chat.improvePrompt")}</span>
                  </button>
                )}
              </div>
            )}
            {fileMenuOpen && !linkedFolder && (
              <div className="composer-pop composer-skill-pop" role="menu">
                <div className="composer-pop-link">
                  <p className="composer-pop-link-title">
                    Link a folder to this conversation
                  </p>
                  <p className="composer-pop-link-hint">
                    Then you can mention its files with <strong>@</strong>.
                  </p>
                  <button
                    type="button"
                    className="composer-link-browse"
                    disabled={folderBusy}
                    onClick={() => void browseFolder()}
                  >
                    {folderBusy ? <Loader2 size={14} className="composer-spin" /> : <Search size={14} />}
                    {t("chat.browse")}
                  </button>
                  <div className="composer-pop-search">
                    <input
                      type="text"
                      placeholder={t("chat.orPastePath")}
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
                      {t("chat.link")}
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
                  <button type="button" onClick={unlinkFolder} title={t("chat.unlinkFolder")}>
                    {t("chat.unlink")}
                  </button>
                </div>
                <div className="composer-pop-search">
                  <Search size={14} />
                  <input
                    autoFocus
                    type="text"
                    placeholder={t("chat.searchFiles")}
                    value={fileQuery}
                    onChange={(event) => setFileQuery(event.target.value)}
                  />
                </div>
                <div className="composer-pop-list">
                  {fileResults.length === 0 ? (
                    <p className="composer-pop-empty">{t("chat.noFiles")}</p>
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
            <div className="composer-pop-wrap composer-skill-anchor">
              {skillMenuOpen && (
                <div className="composer-pop composer-skill-pop" role="menu">
                  <div className="composer-pop-search">
                    <Search size={14} />
                    <input
                      autoFocus
                      type="text"
                      placeholder={t("chat.searchCapability")}
                      value={skillQuery}
                      onChange={(event) => setSkillsQuery(event.target.value)}
                    />
                  </div>
                  <div className="composer-pop-list">
                    {filteredSkillss.length === 0 ? (
                      <p className="composer-pop-empty">{t("chat.noCapabilities")}</p>
                    ) : (
                      filteredSkillss.map((skill) => (
                        <button
                          key={skill.id}
                          type="button"
                          role="menuitem"
                          className={forcedSkills?.id === skill.id ? "active" : ""}
                          onClick={() => {
                            setForcedSkills(skill);
                            setSkillsMenuOpen(false);
                            setSkillsQuery("");
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
          {(models.length > 0 || activeModel) && (
            <div className="composer-pop-wrap">
              <button
                className="composer-model-button"
                type="button"
                aria-label={t("chat.chooseModel")}
                aria-expanded={modelMenuOpen}
                onClick={() => {
                  setModelMenuOpen((open) => {
                    if (!open) void refreshModels();
                    return !open;
                  });
                  setModelQuery("");
                  setSkillsMenuOpen(false);
                }}
              >
                <span className="composer-model-chip-dot" aria-hidden="true" />
                <span>
                  {selectedModel
                    ? shortModelName(selectedModel.split("::").pop() ?? selectedModel)
                    : activeModel
                      ? shortModelName(activeModel)
                      : "Auto"}
                </span>
                <ChevronDown size={14} />
              </button>
              {modelMenuOpen && (
                <div className="composer-pop composer-model-pop" role="menu">
                  <input
                    className="composer-model-search"
                    type="text"
                    autoFocus
                    placeholder={t("chat.searchModels")}
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                  <div className="composer-pop-list">
                    <button
                      type="button"
                      role="menuitem"
                      className={`composer-model-auto ${selectedModel === null ? "active" : ""}`}
                      onClick={() => {
                        setSelectedModel(null);
                        setModelMenuOpen(false);
                        setModelQuery("");
                      }}
                    >
                      {selectedModel === null ? (
                        <Check size={14} />
                      ) : (
                        <span className="composer-model-dot" />
                      )}
                      <span className="composer-model-auto-text">
                        <strong>Auto</strong>
                        <small>
                          {t("chat.balancedQualitySpeed")}
                          {activeModel ? ` · ${shortModelName(activeModel)}` : ""}
                        </small>
                      </span>
                    </button>
                    {(() => {
                      const q = modelQuery.trim().toLowerCase();
                      const source =
                        modelGroups.length > 0
                          ? modelGroups
                          : [{ provider_id: "", label: t("chat.models"), models }];
                      const groups = source
                        .map((group) => ({
                          ...group,
                          models: q
                            ? group.models.filter(
                                (m) =>
                                  m.toLowerCase().includes(q) ||
                                  group.label.toLowerCase().includes(q),
                              )
                            : group.models,
                        }))
                        .filter((group) => group.models.length > 0);
                      if (groups.length === 0) {
                        return <p className="composer-pop-empty">{t("chat.noModels")}</p>;
                      }
                      return groups.map((group) => (
                        <div
                          key={group.provider_id || group.label}
                          className="composer-model-group"
                        >
                          <div className="composer-model-group-label">{group.label}</div>
                          {group.models.map((modelId) => {
                            const value = group.provider_id
                              ? `${group.provider_id}::${modelId}`
                              : modelId;
                            const picked = selectedModel === value;
                            return (
                              <button
                                key={value}
                                type="button"
                                role="menuitem"
                                className={picked ? "active" : ""}
                                onClick={() => {
                                  setSelectedModel(value);
                                  setModelMenuOpen(false);
                                  setModelQuery("");
                                }}
                              >
                                {picked ? (
                                  <Check size={14} />
                                ) : (
                                  <span className="composer-model-dot" />
                                )}
                                <span className="composer-model-name">{modelId}</span>
                                {(() => {
                                  const cloud = modelIsCloud(group.base_url, modelId);
                                  const base = (group.base_url ?? "").toLowerCase();
                                  const localEndpoint =
                                    base.includes("127.0.0.1") ||
                                    base.includes("localhost") ||
                                    base.includes("0.0.0.0");
                                  const localProxyCloud = cloud && localEndpoint;
                                  return (
                                    <span
                                      className={`composer-model-loc ${cloud ? "cloud" : "local"}${
                                        localProxyCloud ? " proxy" : ""
                                      }`}
                                      title={
                                        localProxyCloud
                                          ? "Cloud model routed through local Ollama"
                                          : cloud
                                            ? "Runs in the cloud"
                                            : "Runs on this machine"
                                      }
                                      aria-label={
                                        localProxyCloud ? "cloud via local Ollama" : cloud ? "cloud" : "local"
                                      }
                                    >
                                      {localProxyCloud ? "☁ via local" : cloud ? "☁️" : "💻"}
                                    </span>
                                  );
                                })()}
                                {modelId === activeModel && <small>default</small>}
                              </button>
                            );
                          })}
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="composer-actions">
          {/* Voice dictation needs the local microphone + whisper bridge — desktop only. */}
          {IS_DESKTOP && (
            <button
              className={`icon-button${recording ? " recording" : ""}`}
              type="button"
              aria-label={recording ? t("chat.stopDictation") : t("chat.voiceDictation")}
              title={recording ? t("chat.stopAndTranscribe") : t("chat.voiceDictationMultilingual")}
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
              aria-label={t("chat.interruptResponse")}
              onClick={onCancelStreaming}
            >
              <X size={17} />
            </button>
          ) : value.trim() ? (
            <button className="send-button" disabled={disabled} type="submit" aria-label={t("chat.send")}>
              <ArrowUp size={18} />
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

interface ResumeMarker {
  requestId: string;
  userText: string;
  assistantMessageId: string;
  ownerId?: string;
  createdAt?: number;
}

const RESUME_MARKER_TTL_MS = 5 * 60 * 1000;

function resumeMarkerKey(threadId: string) {
  return `lfpa.resume.${threadId}`;
}

function writeResumeMarker(threadId: string, marker: ResumeMarker) {
  try {
    window.localStorage.setItem(
      resumeMarkerKey(threadId),
      JSON.stringify({ ...marker, ownerId: CHAT_VIEW_SESSION_ID, createdAt: Date.now() }),
    );
  } catch {
    /* storage unavailable → resume simply won't be offered */
  }
}

function isOwnResumeMarker(marker: ResumeMarker): boolean {
  return marker.ownerId === CHAT_VIEW_SESSION_ID;
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
    if (!parsed.createdAt || Date.now() - parsed.createdAt > RESUME_MARKER_TTL_MS) {
      clearResumeMarker(threadId);
      return null;
    }
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
