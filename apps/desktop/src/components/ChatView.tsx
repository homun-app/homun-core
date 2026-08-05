import {
  ArrowUp,
  AlertCircle,
  AtSign,
  BookMarked,
  ClipboardList,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Bot,
  Bug,
  Clock3,
  ExternalLink,
  FileImage,
  FileText,
  FolderOpen,
  GitMerge,
  AlertTriangle,
  HardDrive,
  ListTodo,
  Loader2,
  MessageCircle,
  Mic,
  Monitor,
  Plus,
  Play,
  PanelLeftOpen,
  Search,
  ScanSearch,
  Share2,
  Tag,
  Target,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeContext } from "../lib/useRuntimeContext";
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
  SteeringQueuedDuringSubmissionError,
  type ActiveModelInfo,
  type AppEvent,
  type ChatAttachmentInput,
  type CoreBranchPoint,
  type CoreChatStreamEvent,
  type CoreComputerSessionSnapshot,
  type CoreTaskQueueSnapshot,
  type CoreUncertainEffectOutcome,
  type ProjectGoalsData,
  type FsEntry,
  type FsFilePayload,
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
  type RoutingBindingInput,
  type RuntimeContextResponse,
  type SkillsSummary,
} from "../lib/coreBridge";
import { wsSubscription } from "../lib/wsSubscription";
import { ExecutionInspector } from "./ExecutionInspector";
import {
  cancelTurn,
  deleteSteering,
  enqueueTurn,
  fetchThreadActivity,
  fetchThreadSteering,
  sendSteeringNow,
  SteeringConflictError,
  updateSteering,
  type SubagentInfo,
  type TurnSteeringRecord,
} from "../lib/chatApi";
import {
  applySteeringChange,
  createSteeringQueueState,
  reconcileSteering,
  type SteeringQueueState,
} from "../lib/chatSteeringState";
import {
  applyTurnEvent,
  createTurnReplayState,
  prepareHitlResumeMessages,
  type TurnReplayState,
  type TurnReplayStatus,
} from "../lib/turnReplayState";
import { deriveTurnLifecycle } from "../lib/chat-runtime/lifecycle";
import { deriveComposerMode } from "../lib/chat-runtime/composerMode";
import { visiblePendingSteeringRows } from "../lib/chat-runtime/steering";
import {
  createLoadingComputerSession,
  createUnavailableComputerSession,
  mapCoreComputerSession,
} from "../lib/localComputerViewModel";
import { captureAppScreenshot, IS_DESKTOP } from "../lib/gatewayConfig";
import { copyText } from "../lib/clipboard";
import {
  isLocalOllamaProvider,
  RUNTIME_MODELS_CHANGED_EVENT,
} from "../lib/providerPresets";
import {
  filterInspectorState,
  inspectorWorkspaceReducer,
  loadInspectorState,
  loadInspectorWidthRatio,
  saveInspectorState,
  saveInspectorWidthRatio,
  type InspectorTab,
  type InspectorTabKind,
} from "../lib/inspectorWorkspace";
import { reconcileMemoryArtifacts } from "../lib/uiSnapshot";
import {
  effectiveModelFromGateway,
  latestAssistantEffectiveModel,
  selectedModelAfterSubmission,
} from "../lib/composerTurnContract";
import {
  blobToBase64,
  chatMessageFromAssistantResult,
  createReplyPreview,
  currentTimestampSeconds,
  describeBridgeError,
  fileLocalPath,
  formatChatDuration,
  formatContextTokens,
  formatFileSize,
  formatMessageTimestamp,
  isLikelyIncompleteMessage,
  isPlaceholderThreadTitle,
  isUserVisibleComputerEvent,
  languageForPath,
  messageContentKind,
  messageRoleLabel,
  shortModelName,
  toMessageAttachment,
  visibleMessageMetadata,
  withChatMetrics,
  type MessageContentKind,
} from "../lib/chatViewMessages";
// Persisted artifact rows need a storage-aware projection before previewing.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as artifactProjection from "../lib/artifactProjection.mjs";
// Transcript indexes live in a plain .mjs sibling so `node --test` can exercise
// them without a build step, which is why they carry no type declaration.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as messageIndex from "../lib/messageIndex.mjs";
import {
  STRUCTURED_MARKER_DELTA_RE,
  COMPOSIO_CONFIRM_RE,
  MCP_CONFIRM_RE,
  FS_AUTHORIZE_RE,
  SANDBOX_ESCALATE_RE,
  SANDBOX_READONLY_RE,
  CONNECT_SUGGEST_RE,
  COMPOSIO_DONE_RE,
  COMPOSIO_RECONNECT_RE,
  VAULT_PROPOSE_RE,
  VAULT_REVEAL_RE,
  PAYMENT_APPROVAL_RE,
  CHOICES_RE,
  AWAIT_USER_RE,
  PLAN_PROPOSE_RE,
  GOAL_PROPOSE_RE,
  UNCLOSED_PROPOSE_RE,
  COMPOSIO_MARKERS_RE,
  PROPOSE_MARKERS_VISIBLE_RE,
  PLAN_RE,
} from "../lib/markers";
import { MarkdownEditor } from "./MarkdownEditor";
import { RichMessage } from "./RichMessage";
import { CodeView, DiffView } from "./CodeView";
import {
  MessageArtifacts,
  parseArtifacts,
  artifactExt,
  isMissingFsError,
  ARTIFACT_IMAGE_EXT,
  type ParsedArtifact,
} from "./MessageArtifacts";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ChatComputerPanel } from "./ChatComputerPanel";
import { AdaptiveWorkspaceIsland } from "./AdaptiveWorkspaceIsland";
import { ActiveTurnStatus } from "./ActiveTurnStatus";
import { PendingSteeringQueue } from "./PendingSteeringQueue";
import { ChatHeaderMenu } from "./ChatHeaderMenu";
import { InspectorWorkspace } from "./InspectorWorkspace";
import { MemoryUsagePopover } from "./MemoryUsagePopover";
import { ComposerContainer } from "./ComposerContainer";
import { ComputerDetailPanel } from "./ComputerDetailPanel";
import { ChatEmptyHero } from "./ChatEmptyHero";
import { MessageAttachmentList } from "./MessageAttachmentList";
import { MessageActionBar } from "./MessageActionBar";
import { MessageActivity, parseActivitySteps } from "./MessageActivity";
import { AssistantThinkingState, type ChatStreamStatus } from "./AssistantThinkingState";
import {
  OperationalPlanPreview,
  parseOperationalPlanItems,
} from "./OperationalPlanPreview";
import { ChoicesCard, type ChoicePrompt } from "./MessageChoiceCard";
import { PlanProposeCard, type PlanProposal } from "./MessagePlanProposeCard";
import { DiffCard } from "./MessageDiffCard";
import { GoalProposeCard } from "./MessageGoalProposeCard";
import { VaultRevealCard, type VaultRevealProposal } from "./MessageVaultRevealCard";
import { SandboxReadOnlyCard } from "./MessageSandboxReadOnlyCard";
import { ComposioReconnectCard } from "./MessageComposioReconnectCard";
import { InlineUncertainEffectPanel } from "./InlineUncertainEffectPanel";
import { InlineApprovelPanel } from "./InlineApprovelPanel";
import {
  PaymentApprovalCard,
  type PaymentApprovalProposal,
} from "./MessagePaymentApprovalCard";
import { FsAuthorizeCard } from "./MessageFsAuthorizeCard";
import { SandboxEscalateCard } from "./MessageSandboxEscalateCard";
import {
  ComposioConfirmCard,
  humanizeToolName,
  type ComposioPendingAction,
} from "./MessageComposioConfirmCard";
import {
  ConnectSuggestCard,
  type ConnectSuggest,
} from "./MessageConnectSuggestCard";
import {
  VaultProposeCard,
  type VaultProposal,
} from "./MessageVaultProposeCard";
import { GoalsPanel } from "./GoalsPanel";
import {
  projectWorkspaceSections,
  type WorkspaceSectionId,
} from "../lib/workspaceIslandSections";
import type {
  ChatMessage,
  ChatEventPart,
  ChatAttachment,
  ChatThread,
  ComputerSession,
  ComputerSurfaceKind,
  ApprovelItem,
  RuntimeHealth,
  TaskItem,
  UncertainEffectItem,
} from "../types";

const buildPreviousUserMessageIndex = messageIndex.buildPreviousUserMessageIndex as (
  messages: ChatMessage[],
) => Map<string, ChatMessage | null>;

const buildBranchIndex = messageIndex.buildBranchIndex as (
  branches: CoreBranchPoint[],
) => Map<string, CoreBranchPoint>;

const projectMemoryArtifact = artifactProjection.projectMemoryArtifact as (
  artifact: MemoryArtifactView,
  currentThread: string,
) => ParsedArtifact;

const CHAT_VIEW_SESSION_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat_view_${Date.now()}_${Math.random().toString(36).slice(2)}`;

interface ChatViewProps {
  // When the sidebar is collapsed, the chat header hosts the reopen + search controls (as
  // no-drag children of the drag titlebar, so their clicks aren't swallowed).
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onOpenSearch?: () => void;
  onOpenUsageSettings: () => void;
  approvals: ApprovelItem[];
  approvalBusyId: string | null;
  uncertainEffects: UncertainEffectItem[];
  effectResolutionBusyId: string | null;
  effectResolutionError: string | null;
  computerSessionId: string;
  messages: ChatMessage[];
  health: RuntimeHealth[];
  task: TaskItem;
  thread: ChatThread;
  onMessagesChange: (
    messages: ChatMessage[],
    options?: { advanceActivity?: boolean },
  ) => void;
  onResolveEffect: (
    effect: UncertainEffectItem,
    outcome: CoreUncertainEffectOutcome,
  ) => void;
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
  /** Bumped by App on a `thread.updated` for this open thread → the working-island re-fetches
   *  its durable projection (so a BACKGROUND channel turn's finished activity folds in). */
  islandRefreshNonce?: number;
  /** Monotonic id of the latest durable terminal event for this thread. */
  runtimeContextRevision: number;
  /** Set by App on a `thread.turn_started` for this open thread that this client did NOT
   *  launch (a channel/scheduled reply, or a turn from another window). ChatView attaches to
   *  its live stream so the island + transcript update in real time, identical to an in-app
   *  turn — not just at turn end. The persisted ids let us seed without duplicating bubbles. */
  incomingBackgroundTurn?: {
    turnId: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null;
  // Pre-fill the composer (e.g. engaging a proactivity card opens a chat seeded
  // with the card's context). The nonce re-applies the same text.
  seed?: { text: string; nonce: number } | null;
  autoSubmit?: ChatAutoSubmit | null;
  onAutoSubmitConsumed?: (id: string) => void;
}

interface ReplyContext {
  messageId: string;
  role: ChatMessage["role"];
  preview: string;
}

type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

function chatEventPartFromStream(event: CoreChatStreamEvent): ChatEventPart | null {
  switch (event.type) {
    case "reasoning":
      return null;
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
        return [];
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
      case "actionable_card":
        // Gateway persists Free HITL as actionable_card; map Choice shapes to choice_prompt
        // so ChoicesCard still renders when the marker was stripped from message text.
        // Clarify stays machine-owned (prose is the UI); awaiting-user is detected from
        // the marker text / raw actionable_card kind, not a second card widget.
        if (item.kind === "CHOICES" && item.payload !== undefined) {
          const choices = parseChoicePromptPayload(item.payload);
          return choices ? [{ type: "choice_prompt", payload: choices }] : [];
        }
        if (
          item.kind === "AWAIT_USER" &&
          item.payload &&
          typeof item.payload === "object" &&
          (item.payload as { kind?: string }).kind === "choice"
        ) {
          const { kind: _k, ...choicePayload } = item.payload as Record<string, unknown>;
          const choices = parseChoicePromptPayload(choicePayload);
          return choices ? [{ type: "choice_prompt", payload: choices }] : [];
        }
        return [];
      default:
        return [];
    }
  });
}

function shouldDropStructuredMarkerDelta(delta: string) {
  return STRUCTURED_MARKER_DELTA_RE.test(delta.trim());
}

// UI-local until the durable activity projection lands in the generated client type.
// Missing backend fields stay absent; the view never invents retry/backoff metadata.
interface ActiveTurnProjection {
  turn_id: string;
  last_event_seq: number;
  status: string;
  attempt: number;
  max_attempts: number;
  not_before: number | null;
  blocked_reason: string | null;
  updated_at: number;
}

function replayStatusFromProjection(status: string): TurnReplayStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (["retrying", "retry_waiting"].includes(status)) return "retrying";
  return "running";
}

/** True when the chat frontier awaits the user (Free HITL), not a later user reply. */
function threadTailAwaitsUser(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") return false;
    if (message.role !== "assistant") continue;
    if (
      message.text.includes("‹‹CHOICES››") ||
      message.text.includes("‹‹CLARIFY››") ||
      message.text.includes("‹‹AWAIT_USER››")
    ) {
      return true;
    }
    const rawParts = message.eventParts as Array<Record<string, unknown>> | undefined;
    if (
      rawParts?.some((part) => {
        if (part.type !== "actionable_card") return false;
        if (part.kind === "CHOICES" || part.kind === "CLARIFY") return true;
        if (part.kind !== "AWAIT_USER") return false;
        const payload = part.payload as { kind?: string } | undefined;
        return payload?.kind === "choice" || payload?.kind === "clarify";
      })
    ) {
      return true;
    }
    const parts = normalizeChatEventParts(rawParts as unknown[] | undefined);
    return parts.some((part) => part.type === "choice_prompt");
  }
  return false;
}

interface ChatTurnState {
  phase: string;
  detail?: string;
  elapsedSeconds: number;
  attempt: number;
  activityCount: number;
}

interface ChatAutoSubmit {
  id: string;
  threadId: string;
  prompt: string;
  visibleText: string;
  attachments: ChatAttachmentInput[];
  visibleAttachments?: ChatAttachment[];
  mode?: string;
  // S2: deterministic routing binding for a plugin workflow launch (e.g. "Use
  // template"). Rides only this first auto-submitted turn — the gateway persists
  // it thread-scoped, so later turns in the thread don't resend it.
  routingBinding?: RoutingBindingInput;
}

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
  health,
  task,
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
  const [computerSession, setComputerSession] = useState<ComputerSession>(() =>
    createLoadingComputerSession(computerSessionId),
  );
  const [activeSurface, setActiveSurface] = useState<ComputerSurfaceKind>(
    computerSession.activeSurface,
  );
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
  // Durable cross-turn projection over turn_events (the canonical log), fetched at rest so
  // the island reflects the thread's real plan/activity after turn-end/reload/thread-switch —
  // NOT the lossy message-text markers (absent for workflow deliverables; plan emitted once).
  const [projectedActivity, setProjectedActivity] = useState<string[]>([]);
  const [projectedPlan, setProjectedPlan] = useState<string | null>(null);
  const [projectedTurnStatus, setProjectedTurnStatus] = useState<string | null>(null);
  const [projectedSubagents, setProjectedSubagents] = useState<SubagentInfo[]>([]);
  const [projectedActiveTurn, setProjectedActiveTurn] =
    useState<ActiveTurnProjection | null>(null);
  const {
    runtimeContext,
    runtimeContextLoading,
    runtimeContextError,
    refreshRuntimeContext,
  } = useRuntimeContext({
    threadId: thread.threadId,
    runtimeContextRevision,
  });
  const [activeTurnElapsedSeconds, setActiveTurnElapsedSeconds] = useState(0);
  const [pendingSteering, setPendingSteering] = useState<SteeringQueueState>(() =>
    createSteeringQueueState(),
  );
  // Once the projection has loaded for a thread we TRUST it — including a null plan (a new
  // plan-less task must clear the previous task's plan). Before it loads we fall back to the
  // text markers to avoid a blank flash. Reset per thread.
  const [projectionLoaded, setProjectionLoaded] = useState(false);
  // Track the active turn_id for WS event filtering. Set when a turn starts,
  // cleared when it ends. Used by the wsSubscription subscriber to route events.
  const activeTurnIdRef = useRef<string | null>(null);
  const turnReplayRef = useRef<TurnReplayState | null>(null);
  const streamOwnerTurnRef = useRef<string | null>(null);
  // Turn ids of background turns we've already attached to (via incomingBackgroundTurn), so a
  // re-fired `thread.turn_started` or a messages re-render never double-attaches the same turn.
  const handledBackgroundTurnsRef = useRef<Set<string>>(new Set());
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
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[] | null>(null);
  const [streamHasVisibleText, setStreamHasVisibleText] = useState(false);
  const [autoContinueMessageId, setAutoContinueMessageId] = useState<string | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Bumped when the user asks for the activity list; the adaptive island opens that exact section.
  const [activityNonce, setActivityNonce] = useState(0);
  const [inspector, dispatchInspector] = useReducer(inspectorWorkspaceReducer,
    loadInspectorState(thread.threadId,
      (tab) => isRestorableInspectorTab(tab, thread.threadId, thread.workspaceId),
    ),
  );
  const [inspectorResourcesReady, setInspectorResourcesReady] = useState(false);
  const inspectorRef = useRef(inspector);
  const inspectorRestoreScopeRef = useRef<string | null>(null);
  inspectorRef.current = inspector;
  const [inspectorRatio, setInspectorRatio] = useState(loadInspectorWidthRatio);
  const [memoryArtifacts, setMemoryArtifacts] = useState<MemoryArtifactView[]>([]);
  const [memoryArtifactsLoaded, setMemoryArtifactsLoaded] = useState(false);
  const [memoryArtifactsLoadError, setMemoryArtifactsLoadError] = useState(false);
  const [memoryArtifactsReloadNonce, setMemoryArtifactsReloadNonce] = useState(0);
  // Is this thread a project? Reliable context signal (not keyword-detection) that gates
  // the "Save as goal" message action + the Obiettivi tab. `goalSeed` pre-fills
  // the Obiettivi compose when promoting a chat message to a goal.
  const [threadIsProject, setThreadIsProject] = useState(false);
  const [projectGoalCount, setProjectGoalCount] = useState(0);
  // Task 4c: north-star objective text, rides along the same /api/memory/goals
  // fetch that already yields projectGoalCount — no separate network call.
  const [projectObjective, setProjectObjective] = useState<string | null>(null);
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
  const layoutRef = useRef<HTMLElement>(null);
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
  const refreshPendingSteering = useCallback(async () => {
    const rows = await fetchThreadSteering(thread.threadId);
    if (!isMountedRef.current) return;
    setPendingSteering((current) => reconcileSteering(current, rows));
  }, [thread.threadId]);

  useEffect(() => {
    setPendingSteering(createSteeringQueueState());
    void refreshPendingSteering().catch(() => {
      /* Queue remains empty until the endpoint is available or an event retries hydration. */
    });
  }, [refreshPendingSteering]);

  useEffect(() => {
    const unsubscribe = wsSubscription.subscribe((message) => {
      const event = message.type === "app.event"
        ? message.event as Record<string, unknown> | undefined
        : message;
      if (event?.type !== "thread.steering_changed") return;
      if (event.thread_id !== thread.threadId) return;
      void refreshPendingSteering().catch(() => undefined);
    });
    return unsubscribe;
  }, [refreshPendingSteering, thread.threadId]);
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
        setProjectedTurnStatus(next.status);
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
  // Transcript lookups, resolved ONCE per render instead of once per row. The
  // action bar asks "does this message have a user message before it?" and the
  // branch picker asks "is there a branch point on this node?" for every row of
  // the transcript, on every streaming frame: as linear scans that was O(N²) and
  // O(N·B) per frame. As indexes it is one pass plus O(1) lookups.
  const previousUserMessageIndex = useMemo(
    () => buildPreviousUserMessageIndex(threadMessages),
    [threadMessages],
  );
  const branchIndex = useMemo(() => buildBranchIndex(branches), [branches]);
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
      out.push(projectMemoryArtifact(artifact, thread.threadId));
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
  useEffect(() => {
    if (!hasActiveTurn) {
      setActiveTurnElapsedSeconds(0);
      return;
    }
    const projectedUpdatedAt = projectedActiveTurn?.updated_at;
    const startedAt = projectedUpdatedAt && projectedUpdatedAt > 0
      ? Math.min(Date.now(), projectedUpdatedAt * 1000)
      : Date.now();
    const updateElapsed = () => {
      setActiveTurnElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [activeTurnKey, hasActiveTurn, projectedActiveTurn?.updated_at]);
  // Durable wait (approval/CHOICES hold) must not keep a live "writing" owner: that hides
  // choice cards and makes the next composer send look like mid-turn steering.
  useEffect(() => {
    if (!turnAwaitingUser || !streamingAssistantId) return;
    setStreamingAssistantId(null);
    setStreamStatus(null);
  }, [turnAwaitingUser, streamingAssistantId]);
  // Island source, converged on the durable projection:
  //  - live: live WS events (current turn) layered over the projection (prior turns);
  //  - at rest: the projection alone, falling back to the lossy text markers only if the
  //    projection is empty (older turns whose events predate turn_events, or edge cases).
  // Plan: while streaming, ONLY the live plan of the CURRENT turn (never fall back to the
  // projection — a new plan-less task must not keep showing the previous task's plan). At
  // rest, trust the loaded projection (which is scoped to the latest turn), else the marker.
  const conversationPlan = isStreaming
    ? livePlanMarkdown
    : projectionLoaded
      ? projectedPlan
      : persistedPlan;
  // Activity accumulates across the thread: projection (prior turns) + live (current turn).
  const rawConversationActivity = isStreaming
    ? [...projectedActivity, ...liveActivitySteps]
    : projectionLoaded
      ? projectedActivity
      : persistedActivity;
  const rawLatestActivity = rawConversationActivity[rawConversationActivity.length - 1] ?? "";
  const browserBudgetReason = rawLatestActivity.startsWith("browser_budget_exceeded:")
    ? rawLatestActivity.slice("browser_budget_exceeded:".length)
    : null;
  const browserBudgetMessage = browserBudgetReason === "wall_clock"
    ? t("chat.browserBudget.wallClock")
    : browserBudgetReason === "failed_navigations"
      ? t("chat.browserBudget.failedNavigations")
      : browserBudgetReason === "no_progress"
        ? t("chat.browserBudget.noProgress")
        : browserBudgetReason
          ? t("chat.browserBudget.default")
          : null;
  const conversationActivity = rawConversationActivity.map((step) =>
    step.startsWith("browser_budget_exceeded:")
      ? step.endsWith(":wall_clock")
        ? t("chat.browserBudget.wallClock")
        : step.endsWith(":failed_navigations")
          ? t("chat.browserBudget.failedNavigations")
          : step.endsWith(":no_progress")
            ? t("chat.browserBudget.noProgress")
            : t("chat.browserBudget.default")
      : step,
  );
  const browserBudgetAssistantId = browserBudgetReason
    ? [...threadMessages].reverse().find((message) => message.role === "assistant")?.id ?? null
    : null;
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
  const workspacePlanSteps = useMemo(() => {
    const steps = conversationPlan ? parsePlanSteps(conversationPlan) : [];
    // A concluded successful turn has nothing actively "doing": weak local models often
    // leave the frontier step marked doing without a final done update, so the durable
    // plan still carries a `[-]` step after the turn ended. Reconcile it to done so the
    // cockpit doesn't show a perpetual in-progress step (and Progress reflects reality).
    // Only for a `completed` turn at rest — a failed/cancelled turn keeps its raw state.
    if (!isStreaming && projectedTurnStatus === "completed") {
      return steps.map((step) =>
        step.status === "doing" ? { ...step, status: "done" as const } : step,
      );
    }
    return steps;
  }, [conversationPlan, isStreaming, projectedTurnStatus]);
  // Clear the projection the instant the thread switches so a new (possibly still-streaming)
  // thread never briefly shows the previous thread's plan/activity before its own fetch lands.
  useEffect(() => {
    setProjectedActivity([]);
    setProjectedPlan(null);
    setProjectedTurnStatus(null);
    setProjectedSubagents([]);
    setProjectedActiveTurn(null);
    turnReplayRef.current = null;
    streamOwnerTurnRef.current = null;
    setProjectionLoaded(false);
  }, [thread.threadId]);
  // Load the durable island projection on thread change and when a turn ENDS (isStreaming →
  // false, so the just-finished turn folds in). Deliberately NOT during streaming: the live
  // WS events carry the active turn; fetching mid-stream would double-count it against the
  // projection. Best-effort — live + the text-marker fallback cover a failed fetch.
  useEffect(() => {
    if (isStreaming) return;
    let cancelled = false;
    fetchThreadActivity(thread.threadId)
      .then((projection) => {
        if (cancelled) return;
        setProjectedActivity(projection.activity);
        setProjectedPlan(projection.plan_markdown);
        setProjectedTurnStatus(projection.latest_turn_status);
        setProjectedSubagents(projection.subagents ?? []);
        const activeTurn = (
          projection as typeof projection & { active_turn?: ActiveTurnProjection | null }
        ).active_turn ?? null;
        setProjectedActiveTurn(activeTurn);
        if (activeTurn) {
          activeTurnIdRef.current = activeTurn.turn_id;
          const currentReplay = turnReplayRef.current;
          if (
            currentReplay?.turnId !== activeTurn.turn_id
            || currentReplay.lastSeq < activeTurn.last_event_seq
          ) {
            turnReplayRef.current = createTurnReplayState(activeTurn.turn_id, {
              lastSeq: activeTurn.last_event_seq,
              status: replayStatusFromProjection(activeTurn.status),
              text: currentReplay?.turnId === activeTurn.turn_id ? currentReplay.text : "",
            });
          }
        }
        setProjectionLoaded(true);
      })
      .catch(() => {
        /* projection unavailable → island falls back to live + persisted markers */
      });
    return () => {
      cancelled = true;
    };
    // `islandRefreshNonce` (bumped by App on a `thread.updated` for THIS open thread) so a
    // BACKGROUND turn — e.g. a channel/Telegram reply this client never streamed — re-fetches
    // the durable island projection when it finishes, instead of leaving the island frozen on
    // the previous turn's activity. (The message COUNT is stable: the assistant placeholder is
    // updated in place, so it can't be the trigger.)
  }, [thread.threadId, isStreaming, islandRefreshNonce]);
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
  // "Sources" projection for the island: generated artifacts + uploaded files, monochrome.
  // `kind` only picks the glyph (image vs document); `meta` is a one-word provenance hint.
  const islandSources = useMemo<IslandSource[]>(() => {
    const out: IslandSource[] = [];
    for (const artifact of workbenchArtifacts) {
      const name = artifact.projectRelativePath || artifact.name;
      const isImage = ARTIFACT_IMAGE_EXT.includes(artifactExt(name));
      out.push({
        name,
        kind: isImage ? "image" : "artifact",
        meta: artifact.updated ? "updated" : artifact.source === "project" ? "project" : "artifact",
        action: "artifact",
        artifactThread: artifact.thread,
        artifactName: artifact.name,
      });
    }
    for (const file of uploadedFiles) {
      out.push({
        name: file.title,
        kind: file.kind === "image" ? "image" : "file",
        meta: "uploaded",
        action: "files",
      });
    }
    return out;
  }, [workbenchArtifacts, uploadedFiles]);
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

  const openInspectorTab = useCallback(
    (
      kind: InspectorTabKind,
      title: string,
      resourceKey: string,
      payload: Record<string, string> = {},
    ) => {
      dispatchInspector({
        type: "openTab",
        tab: {
          id: crypto.randomUUID(),
          kind,
          resourceKey,
          title,
          workspaceId: thread.workspaceId ?? undefined,
          payload: { ...payload, threadId: thread.threadId },
        },
      });
    },
    [thread.threadId, thread.workspaceId],
  );

  const openUtilityTab = useCallback(
    (kind: InspectorTabKind) => {
      openInspectorTab(kind, t(INSPECTOR_VIEW_LABEL_KEY[kind]), `${kind}:${thread.threadId}`);
    },
    [openInspectorTab, t, thread.threadId],
  );

  const openFileTab = useCallback(
    (path: string) => {
      const normalizedPath = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
      openInspectorTab(
        "file",
        normalizedPath.split("/").pop() || normalizedPath,
        `file:${normalizedPath}`,
        { path: normalizedPath },
      );
    },
    [openInspectorTab],
  );

  const openArtifactTab = useCallback(
    (artifact: ParsedArtifact) => {
      openInspectorTab(
        "artifact",
        artifact.name,
        `artifact:${artifact.thread}:${artifact.name}`,
        {
          artifactThread: artifact.thread,
          name: artifact.name,
          artifactSource: artifact.source ?? "conversation",
          projectPath: artifact.projectPath || artifact.projectRelativePath || "",
        },
      );
    },
    [openInspectorTab],
  );

  useEffect(() => {
    let cancelled = false;
    const scope = `${thread.threadId}:${thread.workspaceId ?? ""}`;
    const firstValidation = inspectorRestoreScopeRef.current !== scope;
    const restored = firstValidation
      ? loadInspectorState(
          thread.threadId,
          (tab) => isRestorableInspectorTab(tab, thread.threadId, thread.workspaceId),
        )
      : inspectorRef.current;
    if (firstValidation) {
      inspectorRestoreScopeRef.current = scope;
      inspectorRef.current = restored;
      dispatchInspector({ type: "replaceState", state: restored });
    }
    if (firstValidation) setInspectorResourcesReady(false);

    void Promise.all(restored.tabs.map(async (tab): Promise<"allowed" | "denied" | "error"> => {
      if (tab.kind === "artifact") {
        if (!tab.payload.name) return "allowed";
        const artifact = workbenchArtifacts.find(
          (artifact) =>
            artifact.thread === tab.payload.artifactThread &&
            artifact.name === tab.payload.name,
        );
        const projectPath =
          artifact?.projectPath || artifact?.projectRelativePath || tab.payload.projectPath;
        const projectBacked = artifact?.source === "project" || tab.payload.artifactSource === "project";
        if (!artifact && !projectPath) {
          return memoryArtifactsLoaded && !memoryArtifactsLoadError ? "denied" : "error";
        }
        if (!projectBacked) return "allowed";
        try {
          const payload = await coreBridge.fsFile(projectPath || tab.payload.name, thread.threadId);
          return payload.authorized ? "allowed" : "denied";
        } catch {
          return "error";
        }
      }
      if (tab.kind !== "file" || !tab.payload.path) return "allowed";
      try {
        const payload = await coreBridge.fsFile(tab.payload.path, thread.threadId);
        return payload.authorized ? "allowed" : "denied";
      } catch {
        return "error";
      }
    })).then((outcomes) => {
      if (cancelled) return;
      const deniedIds = new Set(
        restored.tabs.filter((_, index) => outcomes[index] === "denied").map((tab) => tab.id),
      );
      const current = inspectorRef.current;
      dispatchInspector({
        type: "replaceState",
        state: filterInspectorState(
          current,
          (tab) => !deniedIds.has(tab.id),
        ),
      });
      setInspectorResourcesReady(true);
    });

    return () => {
      cancelled = true;
    };
    // Resource descriptors are restored once per authorization scope. Individual
    // open tabs revalidate again on window focus, without ever persisting content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryArtifacts, memoryArtifactsLoadError, memoryArtifactsLoaded, thread.threadId, thread.workspaceId]);

  useEffect(() => {
    if (!inspectorResourcesReady) return;
    saveInspectorState(thread.threadId, inspector);
  }, [inspector, inspectorResourcesReady, thread.threadId]);

  const visibleComputerSession = useMemo(
    () => ({
      ...computerSession,
      timeline: computerSession.timeline.filter(isUserVisibleComputerEvent),
    }),
    [computerSession],
  );
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

  // "instant", never "auto": per CSSOM-View, "auto" resolves to the element's computed
  // scroll-behavior, so with a smooth scroller every rAF flush started an animation the
  // next frame cancelled — the viewport trailed the text and rubber-banded for the whole
  // answer. Same reasoning for every other non-user-initiated jump below.
  function afterStreamingFramePaint() {
    scrollConversationToBottomIfPinned("instant");
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
      window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
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
        if (payload.type === "aborted") {
          streamedText = "";
          streamEventParts = [];
          setStreamStatus({
            requestId,
            phase: "thinking",
            title: t("chat.resumingResponse"),
            detail: t("chat.reattachingGeneration"),
          });
          scheduleStreamingMessage();
          return;
        }
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
        if (payload.type === "done" && payload.text !== undefined) {
          streamedText = payload.text;
          streamEventParts = [];
          scheduleStreamingMessage();
          return;
        }
        const part = chatEventPartFromStream(payload);
        if (part) {
          // ADR 0022 (Piano UI A2): quando arriva un evento recall, mostra la fase
          // "Sto controllando la memoria…" (precedenza su thinking/writing).
          if (part.type === "recall") {
            const count = part.payload?.hits?.length ?? 0;
            const memoryStatus = part.payload?.status ?? (count > 0 ? "ready" : "empty");
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
        routingBinding,
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
      setTimelineCollapsed(!result.plan);
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
      if (cancelledLocally || cancelledStreamIdsRef.current.has(requestId)) {
        return;
      }
      if (error instanceof SteeringQueuedDuringSubmissionError) {
        setPromptError(null);
        setOptimisticMessages(null);
        setProjectedActiveTurn(null);
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

  function cancelActiveStreaming() {
    cancelStreamingRequestRef.current?.();
  }

  async function stopActiveTurn() {
    if (cancelStreamingRequestRef.current) {
      cancelActiveStreaming();
      return;
    }
    const turnId = projectedActiveTurn?.turn_id ?? activeTurnIdRef.current;
    if (!turnId) return;
    try {
      await cancelTurn(turnId);
      setProjectedActiveTurn(null);
      await refreshPendingSteering().catch(() => undefined);
    } catch (error) {
      setPromptError(describeBridgeError(error));
    }
  }

  function openActivityIsland() {
    dispatchInspector({ type: "hideWorkspace" });
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
        if (payload.type === "aborted") {
          streamedText = "";
          streamEventParts = [];
          scheduleStreamingMessage();
          return;
        }
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
        if (payload.type === "done" && payload.text !== undefined) {
          streamedText = payload.text;
          streamEventParts = [];
          scheduleStreamingMessage();
          return;
        }
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
      streamingUserPinnedRef.current = false;
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
    setProjectedActiveTurn(null);
    return submitComposerPrompt(answer, [], {
      forceNewTurn: true,
      resumeAssistantMessageId: assistantMessageId,
    });
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
      setProjectedActiveTurn(null);
    }

    // A Choice/Clarify answer must start a real next turn even if the UI still thinks work is
    // in progress (streaming just ended / projected active turn lag) — otherwise the
    // answer becomes steering and the browser session context is mishandled.
    if (workInProgress && !forceNewTurn) {
      const promptWithReplyContext = activeReplyContext
        ? [
            skillPrefix,
            contextPrefix,
            "Apply this instruction to the active task while keeping the quoted context.",
            `Quoted message (${messageRoleLabel(activeReplyContext.role)}):`,
            activeReplyContext.preview,
            "",
            "User instruction:",
            prompt,
          ].join("\n")
        : `${skillPrefix}${contextPrefix}${prompt}`;
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
          setProjectedActiveTurn(null);
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
          setPendingSteering((current) => applySteeringChange(current, returnedRecord));
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
          setPendingSteering((current) => applySteeringChange(current, error.steering));
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

  function steeringPromptWithEdit(row: TurnSteeringRecord, visiblePrompt: string): string {
    if (row.visible_prompt && row.prompt.endsWith(row.visible_prompt)) {
      return `${row.prompt.slice(0, -row.visible_prompt.length)}${visiblePrompt}`;
    }
    return visiblePrompt;
  }

  async function editPendingSteering(
    row: TurnSteeringRecord,
    visiblePrompt: string,
    expectedRevision: number,
  ) {
    try {
      const updated = await updateSteering(row.steering_id, {
        expected_revision: expectedRevision,
        prompt: steeringPromptWithEdit(row, visiblePrompt),
        visible_prompt: visiblePrompt,
        images: row.images,
        attachments: row.attachments,
        mode: row.mode,
        model: row.model,
      });
      setPendingSteering((current) => applySteeringChange(current, updated));
      setPromptError(null);
    } catch (error) {
      if (error instanceof SteeringConflictError) {
        setPendingSteering((current) => applySteeringChange(current, error.steering));
      }
      setPromptError(describeBridgeError(error));
      throw error;
    }
  }

  async function deletePendingSteering(row: TurnSteeringRecord, expectedRevision: number) {
    try {
      const deleted = await deleteSteering(row.steering_id, expectedRevision);
      setPendingSteering((current) => applySteeringChange(current, deleted));
      setPromptError(null);
    } catch (error) {
      if (error instanceof SteeringConflictError) {
        setPendingSteering((current) => applySteeringChange(current, error.steering));
      }
      setPromptError(describeBridgeError(error));
      throw error;
    }
  }

  async function sendPendingSteeringNow(row: TurnSteeringRecord, expectedRevision: number) {
    try {
      await sendSteeringNow(row.steering_id, expectedRevision);
      await refreshPendingSteering();
      setPromptError(null);
      await onThreadChanged();
    } catch (error) {
      if (error instanceof SteeringConflictError) {
        setPendingSteering((current) => applySteeringChange(current, error.steering));
      }
      setPromptError(describeBridgeError(error));
      throw error;
    }
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
    window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
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
    setProjectObjective(null);
    setProjectMemoryCount(0);
    void coreBridge
      .projectGoals(thread.threadId)
      .then((d) => {
        if (cancelled) return;
        const isProject = Boolean(d?.is_project);
        setThreadIsProject(isProject);
        setProjectGoalCount(d?.goals.length ?? 0);
        setProjectObjective(d?.objective ?? null);
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
        setProjectObjective(null);
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
        if (!cancelled) {
          setMemoryArtifacts((current) => reconcileMemoryArtifacts(current, items));
          setMemoryArtifactsLoadError(false);
          setMemoryArtifactsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMemoryArtifactsLoadError(true);
          setMemoryArtifactsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [memoryArtifactsReloadNonce, messages, thread.threadId]);

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
    window.setTimeout(() => scrollConversationToBottomIfPinned("instant"), 0);
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
      const updatedMessage = chatMessageFromAssistantResult(
        result,
        streamedText,
        normalizeChatEventParts(result.assistant_message.event_parts),
      );
      const nextMessages = baseMessages.map((item) =>
        item.id === message.id ? updatedMessage : item,
      );
      setComputerSession(mapCoreComputerSession(result.computer_session));
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

  // Opening a thread lands at the bottom, it does not animate its way down: an animated
  // first-paint scroll across a long transcript is exactly the sluggishness we're removing.
  useEffect(() => {
    shouldStickToBottomRef.current = true;
    streamingUserPinnedRef.current = false;
    window.setTimeout(() => scrollConversationToBottom("instant"), 0);
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
    const previousUser = previousUserMessageIndex.get(latest.id);
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
  }, [threadMessages, previousUserMessageIndex, streamingAssistantId, followUpsFor]);

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

  useEffect(() => {
    // A resize is a continuous gesture: re-pinning must track the drag frame by frame, so it
    // is instant. While streaming the transcript grows every frame → instant for the same
    // reason. Only the settled, non-streaming case (a committed message landing) glides.
    const handleResize = () => scrollConversationToBottomIfPinned("instant");
    const behavior: ScrollBehavior = streamingAssistantId ? "instant" : "smooth";

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
  const lastAssistantEffectiveModel = useMemo(() => {
    const model = latestAssistantEffectiveModel(threadMessages);
    return model ? shortModelName(model) : t("composer.runtime.unavailable");
  }, [t, threadMessages]);
  const headerToolPolicy = thread.source ? t("chat.readOnlyChannel") : t("chat.fullLocalTools");

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
      <header className="task-topbar">
        <div className="task-title-area">
          {sidebarCollapsed && (
            <span className="task-collapsed-controls">
              <button
                type="button"
                className="task-collapsed-action"
                aria-label={t("sidebar.expandSidebar")}
                title={t("sidebar.expandSidebar")}
                onClick={() => onExpandSidebar?.()}
              >
                <PanelLeftOpen size={17} />
              </button>
              <button
                type="button"
                className="task-collapsed-action"
                aria-label={t("sidebar.search")}
                title={t("sidebar.search")}
                onClick={() => onOpenSearch?.()}
              >
                <Search size={17} />
              </button>
            </span>
          )}
          <div className="task-title-button" style={{ cursor: "default" }}>
            <span id="chat-title">{thread.title}</span>
          </div>
        </div>
        <span className="task-header-actions">
          <ChatHeaderMenu
            onOpenInspector={openUtilityTab}
            onCaptureScreenshot={IS_DESKTOP ? () => void captureScreenshot() : undefined}
          />
        </span>
      </header>

      <AdaptiveWorkspaceIsland
        threadId={thread.threadId}
        sections={workspaceSections}
        disabled={inspector.open}
        openSectionRequest={{ section: "activity", nonce: activityNonce }}
        renderSection={(section: WorkspaceSectionId) => {
          if (section === "activity") {
            return (
              <div className="workspace-island-activity">
                {projectObjective ? (
                  <div className="workspace-island-objective">
                    <span>{t("projectContext.objective")}</span>
                    <p>{projectObjective}</p>
                  </div>
                ) : null}
                {workspacePlanSteps.length > 0 ? (
                  <div className="workspace-island-block">
                    <div className="workspace-island-block-title">
                      <span>{t("chat.activityProgress")}</span>
                      <em>
                        {workspacePlanSteps.filter((step) => step.status === "done").length}/
                        {workspacePlanSteps.length}
                      </em>
                    </div>
                    <ol className="workspace-island-list">
                      {workspacePlanSteps.map((step, index) => (
                        <li key={`${index}-${step.title}`} className={`status-${step.status}`}>
                          <span className="workspace-island-state" aria-hidden="true" />
                          <span>{step.title}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                {projectedSubagents.length > 0 ? (
                  <div className="workspace-island-block">
                    <div className="workspace-island-block-title">
                      <span>{t("chat.inspector.views.subagents")}</span>
                      <em>{projectedSubagents.length}</em>
                    </div>
                    <ul className="workspace-island-list">
                      {projectedSubagents.map((subagent, index) => (
                        <li key={`${index}-${subagent.name}`} className={`status-${subagent.status}`}>
                          <span className="workspace-island-state" aria-hidden="true" />
                          <span>{subagent.name}</span>
                          <em>{subagent.status}</em>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {conversationActivity.length > 0 ? (
                  <div className="workspace-island-block">
                    <div className="workspace-island-block-title">
                      <span>{workInProgress ? t("chat.activity") : t("chat.lastActivity")}</span>
                      <em>{conversationActivity.length}</em>
                    </div>
                    <ol className="workspace-island-activity-list">
                      {conversationActivity.slice(-40).map((step, index) => (
                        <li key={`${index}-${step.slice(0, 24)}`}>
                          {step.replace(/^(?:\p{Extended_Pictographic}|️|‍|\s)+/u, "").trim()}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                {browserBudgetMessage && !workInProgress ? (
                  <div className="browser-budget-notice" role="status">
                    <AlertTriangle size={15} aria-hidden="true" />
                    <span>{browserBudgetMessage}</span>
                    <button
                      type="button"
                      disabled={!browserBudgetAssistantId}
                      onClick={() => {
                        if (browserBudgetAssistantId) regenerateAnswer(browserBudgetAssistantId);
                      }}
                    >
                      {t("chat.browserBudget.retry")}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          }
          if (section === "browser") {
            return (
              <div className="workspace-island-browser">
                {previewDataUrl ? (
                  <img src={previewDataUrl} alt={computerSession.previewTitle} />
                ) : null}
                <button type="button" onClick={() => openUtilityTab("computer")}>
                  <Monitor size={15} aria-hidden="true" />
                  <span>{t("chat.inspector.views.computer")}</span>
                </button>
              </div>
            );
          }
          const rows = section === "artifacts" ? islandArtifacts : islandFileSources;
          return (
            <div className="workspace-island-files">
              {rows.map((source, index) => (
                <button
                  type="button"
                  key={`${index}-${source.name}`}
                  onClick={() => openUtilityTab(source.action === "artifact" ? "artifact" : "file")}
                >
                  {source.kind === "image" ? <FileImage size={15} /> : <FileText size={15} />}
                  <span>{source.name}</span>
                  {source.meta ? <em>{source.meta}</em> : null}
                </button>
              ))}
            </div>
          );
        }}
      />
      <div className="chat-computer-runtime">
        <ChatComputerPanel threadId={thread.threadId} onLiveChange={setComputerLiveStatus} />
      </div>

      <div className="thread-scroll" aria-label={t("chat.activeThread")} ref={conversationRef}>
        <div className="thread-content">
          <div className="thread-message-list">
          {threadMessages.length === 0 && !promptSubmitting && (
            <ChatEmptyHero
              thread={thread}
              sessionSeed={CHAT_VIEW_SESSION_ID}
              onOpenUsageSettings={onOpenUsageSettings}
              onUseForTask={(providerId, modelId) => setUsageSuggestedModel({
                value: `${providerId}::${modelId}`,
                nonce: Date.now(),
              })}
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
            const messageSurfaceClass =
              displayMessage.role === "assistant"
                ? "message chat-message-agent"
                : displayMessage.role === "user"
                  ? "message chat-message-user-band"
                  : "message chat-message-system";

            return (
            <div
              className="thread-message-row"
              key={displayMessage.id}
            >
            <article className={messageSurfaceClass}>
              {displayMessage.role === "system" && (
                <header className="assistant-label system-label">
                  <Clock3 size={15} />
                  <strong>{t("chat.status")}</strong>
                  <span>{t("chat.roleSystem")}</span>
                </header>
              )}
              {isStreamingMessage ? (
                <>
                  {!streamHasVisibleText && !chatTurnState && (
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
                        openArtifactTab(artifact);
                      }}
                      onChoose={(answer, purpose) =>
                        purpose
                          ? void handleProactiveAnswer(displayMessage.text, answer)
                          : void submitChoiceAnswer(answer, displayMessage.id)
                      }
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
                      openArtifactTab(artifact);
                    }}
                    onChoose={(answer) => void submitChoiceAnswer(answer, displayMessage.id)}
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
                </>
              )}
              {!isStreamingMessage &&
                (() => {
                  const point = branchIndex.get(displayMessage.id);
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
              <footer className="chat-message-meta">
                <div className="chat-message-meta-copy">
                  <span>{formatMessageTimestamp(displayMessage.timestamp)}</span>
                  {displayMessage.model && <span>{displayMessage.model}</span>}
                {displayMessage.role === "assistant" ? (
                  <>
                    {/* Model provenance comes from the message-scoped effective model.
                        Duration+tokens are robust: the cloud path
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
                    {/* The button exposes message-scoped provenance on demand; recalled
                        text is never copied into a hover tooltip. */}
                    {(() => {
                      const recallHits =
                        displayMessage.eventParts?.flatMap((part) =>
                          part.type === "recall" ? part.payload.hits : [],
                        ) ?? [];
                      if (recallHits.length === 0) return null;
                      return (
                        <MemoryUsagePopover
                          hits={recallHits}
                          buttonLabel={t("chat.memoryBadge", { count: recallHits.length })}
                          consumerWorkspaceId={thread.workspaceId}
                          onPublicationApproved={refreshAfterChatSubmit}
                        />
                      );
                    })()}
                  </>
                ) : (
                  visibleMessageMetadata(displayMessage.metadata) && (
                    <span>{visibleMessageMetadata(displayMessage.metadata)}</span>
                  )
                )}
                </div>
                <div className="chat-message-actions-slot">
                  {displayMessage.text && !isStreamingMessage && (
                    <MessageActionBar
                      contentKind={contentKind}
                      copied={copiedMessageId === displayMessage.id}
                      canContinue={
                        assistantMessage && Boolean(displayMessage.text) && incompleteMessage
                      }
                      canRegenerate={
                        displayMessage.role === "assistant" &&
                        Boolean(previousUserMessageIndex.get(displayMessage.id))
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
                  )}
                </div>
              </footer>
            </article>
            </div>
            );
          })}
          </div>

          {promptSubmitting && !streamingAssistantId && !chatTurnState && (
            <div className="thread-message-row">
              <article className="message chat-message-agent pending" aria-live="polite">
                <header className="assistant-label">
                  <Sparkles size={17} />
                  <strong>assistant</strong>
                  <span>{t("chat.roleAssistant")}</span>
                </header>
                <AssistantThinkingState status={streamStatus} />
              </article>
            </div>
          )}

          <InlineApprovelPanel
            approvals={activeApprovels}
            busyId={approvalBusyId}
            session={visibleComputerSession}
            onApprove={onApproveApprovel}
            onReject={onRejectApprovel}
          />
          <InlineUncertainEffectPanel
            effects={uncertainEffects}
            busyId={effectResolutionBusyId}
            hasError={effectResolutionError !== null}
            onResolve={onResolveEffect}
          />
        </div>
      </div>

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

      <InspectorWorkspace
        layoutRef={layoutRef}
        state={inspector}
        ratio={inspectorRatio}
        addItems={availableInspectorViews.map((view) => ({
          kind: view.key,
          title: t(INSPECTOR_VIEW_LABEL_KEY[view.key]),
        }))}
        onActivate={(tabId) => dispatchInspector({ type: "activateTab", tabId })}
        onCloseTab={(tabId) => dispatchInspector({ type: "closeTab", tabId })}
        onMoveTab={(tabId, targetIndex) =>
          dispatchInspector({ type: "moveTab", tabId, targetIndex })
        }
        onAdd={openUtilityTab}
        onHide={() => dispatchInspector({ type: "hideWorkspace" })}
        onToggleFocus={() => dispatchInspector({ type: "toggleFocus" })}
        onRatioCommit={(next) => {
          setInspectorRatio(next);
          saveInspectorWidthRatio(next);
        }}
        renderTab={(tab) => (
          !inspectorResourcesReady && (tab.kind === "file" || tab.kind === "artifact") ? (
            <div className="workbench-empty">
              <Loader2 size={22} className="spin" />
              <p>{t("chat.loadingActivity")}</p>
            </div>
          ) : <InspectorView
            descriptor={tab}
            artifacts={workbenchArtifacts}
            artifactCatalogError={memoryArtifactsLoadError}
            uploadedFiles={uploadedFiles}
            threadId={thread.threadId}
            goalSeed={goalSeed}
            onGoalSeedConsumed={() => setGoalSeed(null)}
            operationalPlanMarkdown={
              conversationPlan ?? visibleComputerSession.operationalPlanMarkdown
            }
            layoutSignal={`${inspector.activeTabId}:${inspectorRatio}`}
            onOpenFile={openFileTab}
            onOpenFilesIndex={() => openUtilityTab("file")}
            onOpenArtifact={openArtifactTab}
            onRetryArtifactCatalog={() => setMemoryArtifactsReloadNonce((value) => value + 1)}
            sources={islandSources}
            subagents={projectedSubagents}
            activeSurface={activeSurface}
            controlBusy={computerControlBusy}
            controlError={computerControlError}
            onPauseComputer={() => runComputerControl(coreBridge.pauseLocalComputerSession)}
            onResumeComputer={() => runComputerControl(coreBridge.resumeLocalComputerSession)}
            onSelectSurface={setActiveSurface}
            onTakeoverComputer={() =>
              runComputerControl(coreBridge.requestLocalComputerTakeover)
            }
            previewDataUrl={previewDataUrl}
            computerSession={computerSession}
            onCloseTab={() => dispatchInspector({ type: "closeTab", tabId: tab.id })}
          />
        )}
      />

      <div className="composer-stack">
        {chatTurnState && (
          /* Band matching the composer's width so the status pill lines up with the LEFT edge of the
             input instead of floating centred above it. */
          <div className="active-turn-band">
            <ActiveTurnStatus
              {...chatTurnState}
              onOpenActivity={openActivityIsland}
              onStop={() => void stopActiveTurn()}
            />
          </div>
        )}
        <PendingSteeringQueue
          rows={visiblePendingSteeringRowsForTurn}
          onEdit={editPendingSteering}
          onDelete={deletePendingSteering}
          onSendNow={sendPendingSteeringNow}
        />
        <ComposerContainer
          activeWork={workInProgress}
          disabled={false}
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
          onCancelStreaming={cancelActiveStreaming}
          onClearReply={() => setReplyContext(null)}
          onManualModelSelection={() => setUsageSuggestedModel(null)}
          onRefreshRuntimeContext={refreshRuntimeContext}
          onSuggestedModelConsumed={() => setUsageSuggestedModel(null)}
          onSubmit={submitComposerPrompt}
        />
      </div>
    </section>
  );
}

function isLatestAssistantMessage(messages: ChatMessage[], messageId: string) {
  const latestAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && Boolean(message.text));
  return latestAssistant?.id === messageId;
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

/** One step of the live operational plan (update_plan), used by workspace plan projections. */
interface PlanStep {
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
    purpose: typeof parsed.purpose === "string" ? parsed.purpose : undefined,
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

/** Artifacts workspace: a side panel listing the conversation's generated files
 *  and rendering each by type (markdown, code, csv table, image, pdf) — the
 *  "interactive workspace alongside the chat" model. */
/** Tabs of the right-side Workbench panel. "files" = context-aware (chat uploads +
 *  project directory tree); "artifacts" = generated outputs; "activity" =
 *  background/scheduled tasks; "plan" = the orchestrator's operational plan.
 *  (Computer stays docked above the composer by design.) */
type LegacyWorkbenchTab = "files" | "artifacts" | "memoria" | "goals" | "activity" | "plan" | "execution";
type InspectorResourceStatus =
  | "loading"
  | "ready"
  | "missing"
  | "denied"
  | "unsupported"
  | "error";

/** A generated artifact or uploaded file, projected into the island's "Sources" section.
 *  `kind` only selects the (monochrome) glyph; `meta` is a one-word provenance hint. */
export interface IslandSource {
  name: string;
  kind: "artifact" | "file" | "image";
  meta?: string;
  action: "artifact" | "files";
  artifactThread?: string;
  artifactName?: string;
}

// Shared view metadata for the panel: the header dropdown (chat top-right) and the
// in-panel title both read from here, so labels/icons never drift. Mock interaction:
// toggle → dropdown menu → docked panel with that view + a clean title header.
const PANEL_VIEWS: { key: InspectorTabKind; icon: typeof FileText }[] = [
  { key: "artifact", icon: ClipboardList },
  { key: "file", icon: FolderOpen },
  { key: "activity", icon: Clock3 },
  { key: "plan", icon: ListTodo },
  { key: "execution", icon: ScanSearch },
  { key: "graph", icon: Share2 },
  { key: "goals", icon: Target },
  { key: "sources", icon: BookMarked },
  { key: "subagents", icon: Bot },
  { key: "computer", icon: Monitor },
];
const INSPECTOR_VIEW_LABEL_KEY: Record<InspectorTabKind, string> = {
  file: "chat.inspector.views.files",
  artifact: "chat.inspector.views.review",
  memory: "chat.inspector.views.memory",
  graph: "chat.inspector.views.memory",
  sources: "chat.inspector.views.sources",
  goals: "chat.inspector.views.goals",
  activity: "chat.inspector.views.activity",
  plan: "chat.inspector.views.plan",
  execution: "chat.inspector.views.execution",
  subagents: "chat.inspector.views.subagents",
  computer: "chat.inspector.views.computer",
};

function legacyTabForInspector(kind: InspectorTabKind): LegacyWorkbenchTab | null {
  if (kind === "file") return "files";
  if (kind === "artifact") return "artifacts";
  if (kind === "memory" || kind === "graph") return "memoria";
  if (kind === "goals" || kind === "activity" || kind === "plan" || kind === "execution") {
    return kind;
  }
  return null;
}

function isRestorableInspectorTab(
  tab: InspectorTab,
  threadId: string,
  workspaceId?: string | null,
) {
  return (
    tab.payload.threadId === threadId &&
    (tab.workspaceId ?? null) === (workspaceId ?? null)
  );
}

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
    // One event transport: project_graph.* rides the unified WS, wrapped by the gateway
    // in an `app.event` envelope (publish_app_event is the single producer — it fans the
    // very same event to the WS registry and to the legacy NDJSON channel, so nothing is
    // lost by dropping the latter). The socket is a process-lifetime singleton connected
    // by App at boot; here we only add and drop a handler, never touch the connection.
    const unsubscribe = wsSubscription.subscribe((msg) => {
      if (msg.type !== "app.event") return;
      const event = msg.event as AppEvent;
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

function InspectorView({
  descriptor,
  artifacts,
  artifactCatalogError,
  uploadedFiles,
  threadId,
  goalSeed,
  onGoalSeedConsumed,
  operationalPlanMarkdown,
  layoutSignal,
  onOpenFile,
  onOpenFilesIndex,
  onOpenArtifact,
  onRetryArtifactCatalog,
  sources,
  subagents,
  activeSurface,
  controlBusy,
  controlError,
  onPauseComputer,
  onResumeComputer,
  onSelectSurface,
  onTakeoverComputer,
  previewDataUrl,
  computerSession,
  onCloseTab,
}: {
  descriptor: InspectorTab;
  artifacts: ParsedArtifact[];
  artifactCatalogError: boolean;
  uploadedFiles: ChatAttachment[];
  threadId: string;
  goalSeed?: string | null;
  onGoalSeedConsumed?: () => void;
  operationalPlanMarkdown?: string;
  layoutSignal: string;
  onOpenFile: (path: string) => void;
  onOpenFilesIndex: () => void;
  onOpenArtifact: (artifact: ParsedArtifact) => void;
  onRetryArtifactCatalog: () => void;
  sources: IslandSource[];
  subagents: SubagentInfo[];
  activeSurface: ComputerSurfaceKind;
  controlBusy: boolean;
  controlError: string | null;
  onPauseComputer: () => void;
  onResumeComputer: () => void;
  onSelectSurface: (surface: ComputerSurfaceKind) => void;
  onTakeoverComputer: () => void;
  previewDataUrl: string | null;
  computerSession: ComputerSession;
  onCloseTab: () => void;
}) {
  const { t } = useTranslation();
  const open = true;
  const tab = legacyTabForInspector(descriptor.kind);
  const resourceFilePath = descriptor.kind === "file" ? descriptor.payload.path : undefined;
  const resourceArtifact =
    descriptor.kind === "artifact" && descriptor.payload.name
      ? artifacts.find(
          (artifact) =>
            artifact.name === descriptor.payload.name &&
            artifact.thread === descriptor.payload.artifactThread,
        ) ?? null
      : null;
  // Project-folder browser state (File tab): the thread's linked folder, navigable.
  const [fsRoot, setFsRoot] = useState<string | null>(null);
  const [fsCwd, setFsCwd] = useState<string | null>(null);
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  // Background/scheduled tasks (Activity tab), fetched lazily when the tab opens.
  const [tasks, setTasks] = useState<CoreTaskQueueSnapshot | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  // Project goals (Obiettivi tab): goals + promotable decisions, resolved from the thread.
  const [goalsData, setGoalsData] = useState<ProjectGoalsData | null>(null);
  // Open file viewer (File tab): content + git diff toggle.
  const [openFile, setOpenFile] = useState<FsFilePayload | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [diffOn, setDiffOn] = useState(false);
  const fileLoadGenerationRef = useRef(0);

  useEffect(() => () => {
    fileLoadGenerationRef.current += 1;
  }, []);

  const loadFileAt = useCallback(
    async (path: string) => {
      const generation = ++fileLoadGenerationRef.current;
      setFileLoading(true);
      setDiffOn(false);
      setOpenFile({ authorized: true, path, text: "", old_text: "", in_git: false, modified: false, binary: false });
      try {
        const payload = await coreBridge.fsFile(path, threadId);
        if (generation === fileLoadGenerationRef.current) setOpenFile(payload);
      } catch (error) {
        if (generation === fileLoadGenerationRef.current) {
          setOpenFile({
            authorized: true,
            path,
            text: "",
            old_text: "",
            in_git: false,
            modified: false,
            binary: false,
            error: (error as Error).message,
          });
        }
      } finally {
        if (generation === fileLoadGenerationRef.current) setFileLoading(false);
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
    if (open && tab === "files" && !resourceFilePath && fsCwd === null) void loadFs(null);
  }, [open, tab, resourceFilePath, fsCwd, loadFs]);
  useEffect(() => {
    if (tab !== "files" || !resourceFilePath) return;
    void loadFileAt(resourceFilePath);
    const revalidate = () => void loadFileAt(resourceFilePath);
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [loadFileAt, resourceFilePath, tab]);
  // No auto-redirect: every panel-open path picks a view explicitly (dropdown pick,
  // save-goal → "goals", open-artifact → "artifacts"), and every view has its own
  // empty state — so an explicitly chosen empty view stays put instead of bouncing.
  // Load project goals (Obiettivi tab) when the panel opens — resolves scope from thread.
  useEffect(() => {
    if (!open || tab !== "goals") return;
    let cancelled = false;
    void coreBridge.projectGoals(threadId).then((d) => {
      if (!cancelled) setGoalsData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [open, tab, threadId]);
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

  const fileStatus: InspectorResourceStatus = fileLoading
    ? "loading"
    : !resourceFilePath
      ? "ready"
      : !openFile
        ? "loading"
        : !openFile.authorized
          ? "denied"
          : openFile.error
            ? isMissingFsError(openFile.error)
              ? "missing"
              : "error"
            : openFile.binary
              ? "unsupported"
              : "ready";

  if (descriptor.kind === "sources") {
    return (
      <div className="workbench-files inspector-source-view">
        {sources.length > 0 ? (
          <ul className="workbench-file-list">
            {sources.map((source, index) => {
              const sourceArtifact = artifacts.find(
                (artifact) =>
                  source.action === "artifact" &&
                  artifact.thread === source.artifactThread &&
                  artifact.name === source.artifactName,
              );
              return (
                <li key={`${index}:${source.kind}:${source.name}`}>
                  {source.kind === "image" ? <FileImage size={15} /> : <FileText size={15} />}
                  {sourceArtifact ? (
                    <button
                      type="button"
                      className="wf-name wf-file"
                      title={source.name}
                      onClick={() => onOpenArtifact(sourceArtifact)}
                    >
                      {source.name}
                    </button>
                  ) : source.action === "files" ? (
                    <button
                      type="button"
                      className="wf-name wf-file"
                      title={source.name}
                      onClick={onOpenFilesIndex}
                    >
                      {source.name}
                    </button>
                  ) : (
                    <span className="wf-name" title={source.name}>{source.name}</span>
                  )}
                  {source.meta && <small>{source.meta}</small>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="workbench-empty"><BookMarked size={28} /><p>No sources yet.</p></div>
        )}
      </div>
    );
  }

  if (descriptor.kind === "subagents") {
    return (
      <div className="workbench-files inspector-subagent-view">
        {subagents.length > 0 ? (
          <ul className="workbench-file-list">
            {subagents.map((subagent, index) => (
              <li key={`${index}:${subagent.name}`}>
                <Bot size={15} />
                <span className="wf-name inspector-subagent-copy" title={subagent.name}>
                  <strong>{subagent.name}</strong>
                  {subagent.summary && <small>{subagent.summary}</small>}
                </span>
                <small>
                  {subagent.status}
                  {subagent.updated_at ? ` · ${formatMessageTimestamp(String(subagent.updated_at))}` : ""}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <div className="workbench-empty"><Bot size={28} /><p>No subagents in this activity.</p></div>
        )}
      </div>
    );
  }

  if (descriptor.kind === "computer") {
    return (
      <ComputerDetailPanel
        activeSurface={activeSurface}
        controlBusy={controlBusy}
        controlError={controlError}
        onPause={onPauseComputer}
        onResume={onResumeComputer}
        onSelectSurface={onSelectSurface}
        onTakeover={onTakeoverComputer}
        previewDataUrl={previewDataUrl}
        session={computerSession}
      />
    );
  }

  if (!tab) {
    return (
      <div className="workbench-empty">
        <p>{descriptor.title}</p>
      </div>
    );
  }
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
    <div className="workbench-body inspector-view-body" aria-label={descriptor.title}>
        {tab === "files" && resourceFilePath && openFile && (
          <div className="workbench-fileview">
            <div className="workbench-breadcrumb">
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
              {fileStatus === "denied" ? (
                <div className="workbench-empty">
                  <AlertCircle size={24} />
                  <p>{t("chat.inspector.denied")}</p>
                  <button type="button" onClick={onCloseTab}>
                    {t("chat.inspector.closeTab", { title: descriptor.title })}
                  </button>
                </div>
              ) : fileStatus === "missing" ? (
                <div className="workbench-empty">
                  <AlertCircle size={24} />
                  <p>{t("chat.inspector.missing")}</p>
                  <span className="workbench-empty-actions">
                    <button type="button" onClick={() => void loadFileAt(resourceFilePath)}>
                      {t("chat.inspector.retry")}
                    </button>
                    <button type="button" onClick={onCloseTab}>
                      {t("chat.inspector.closeTab", { title: descriptor.title })}
                    </button>
                  </span>
                </div>
              ) : fileStatus === "error" ? (
                <div className="workbench-empty">
                  <AlertCircle size={24} />
                  <p>{openFile.error}</p>
                  <span className="workbench-empty-actions">
                    <button type="button" onClick={() => void loadFileAt(resourceFilePath)}>
                      {t("chat.inspector.retry")}
                    </button>
                    <button type="button" onClick={onCloseTab}>
                      {t("chat.inspector.closeTab", { title: descriptor.title })}
                    </button>
                  </span>
                </div>
              ) : fileStatus === "unsupported" ? (
                <div className="workbench-empty">
                  <FileText size={24} />
                  <p>{t("chat.inspector.unsupported")}</p>
                  <small>{openFile.path}</small>
                  <button type="button" onClick={onCloseTab}>
                    {t("chat.inspector.closeTab", { title: descriptor.title })}
                  </button>
                </div>
              ) : diffOn && openFile.modified ? (
                <DiffView oldText={openFile.old_text} newText={openFile.text} />
              ) : (
                <CodeView code={openFile.text} language={languageForPath(openFile.path)} />
              )}
            </div>
          </div>
        )}
        {tab === "files" && resourceFilePath && !openFile && (
          <div className="workbench-empty">
            <Loader2 size={22} className="spin" />
            <p>{t("chat.loadingActivity")}</p>
          </div>
        )}
        {tab === "files" && !resourceFilePath && (
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
                          onClick={() => onOpenFile(entry.path)}
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
        {tab === "artifacts" && descriptor.payload.name &&
          (resourceArtifact ? (
            <ArtifactsPanel
              artifacts={[resourceArtifact]}
              initialName={resourceArtifact.name}
              onClose={onCloseTab}
              embedded
            />
          ) : (
            <div className="workbench-empty">
              <FileText size={28} />
              <p>
                {artifactCatalogError ? t("chat.previewUnavailable") : t("chat.inspector.missing")}
              </p>
              <span className="workbench-empty-actions">
                <button type="button" onClick={onRetryArtifactCatalog}>
                  {t("chat.inspector.retry")}
                </button>
                <button type="button" onClick={onCloseTab}>
                  {t("chat.inspector.closeTab", { title: descriptor.title })}
                </button>
              </span>
            </div>
          ))}
        {tab === "artifacts" && !descriptor.payload.name && (
          <div className="workbench-files">
            {artifacts.length > 0 ? (
              <ul className="workbench-file-list">
                {artifacts.map((artifact) => (
                  <li key={`${artifact.thread}:${artifact.name}`}>
                    <FileText size={15} />
                    <button
                      type="button"
                      className="wf-name wf-file"
                      title={artifact.name}
                      onClick={() => onOpenArtifact(artifact)}
                    >
                      {artifact.name}
                    </button>
                    <small>{artifact.source === "project" ? "project" : "artifact"}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="workbench-empty">
                <FileText size={28} />
                <p>No artifacts yet. Files generated or created by the assistant appear here.</p>
              </div>
            )}
          </div>
        )}
        {tab === "memoria" && <MemoryGraphPanel threadId={threadId} layoutSignal={layoutSignal} />}
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
        {tab === "execution" && <ExecutionInspector threadId={threadId} />}
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
  readOnlyBlocked: { target: string } | null;
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
  // ADR 0023: a file write blocked by read-only sandbox mode → informational read-only card.
  // Parsed from the PERSISTED assistant text (mirrors sandboxEscalate above). It used to ride
  // a `tool_result` event that was never persisted into `event_parts_json`, so the card
  // vanished on commit/reload; the gateway now appends a `‹‹SANDBOX_READONLY››{"target":…}`
  // marker to the message text (stripped from visible prose by COMPOSIO_MARKERS_RE).
  let readOnlyBlocked: { target: string } | null = null;
  const roMatch = text.match(SANDBOX_READONLY_RE);
  if (roMatch) {
    try {
      const p = JSON.parse(roMatch[1]) as { target?: string };
      readOnlyBlocked = { target: typeof p.target === "string" ? p.target : "" };
    } catch {
      /* malformed → hide */
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
  if (!choices) {
    const awaitMatch = text.match(AWAIT_USER_RE);
    if (awaitMatch) {
      try {
        const parsed = JSON.parse(awaitMatch[1]) as Record<string, unknown>;
        if (parsed.kind === "choice") {
          const { kind: _k, ...rest } = parsed;
          choices = parseChoicePromptPayload(rest);
        }
      } catch {
        /* malformed → just hide it */
      }
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
    readOnlyBlocked,
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
    onChoose?: (answer: string, purpose?: string) => void;
  }) {
  const {
    visible,
    action,
    doneTool,
    reconnectSlug,
    fsAuthorize,
    sandboxEscalate,
    readOnlyBlocked,
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
      {readable && <RichMessage text={readable} streaming={streaming} />}
      {!streaming && onOpenArtifact && <MessageArtifacts text={text} onOpen={onOpenArtifact} />}
      {doneTool && !streaming && (
        <details className="chat-operational-row">
          <summary>
            <ShieldCheck size={14} aria-hidden="true" />
            <span>{humanizeToolName(doneTool)}</span>
          </summary>
          <div className="chat-operational-content cmp-confirm done">
            <ShieldCheck size={15} />
            <span>Action completed: {humanizeToolName(doneTool)}</span>
          </div>
        </details>
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
      {readOnlyBlocked && !streaming && (
        <SandboxReadOnlyCard target={readOnlyBlocked.target} />
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
      {choices && onChoose && (
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
