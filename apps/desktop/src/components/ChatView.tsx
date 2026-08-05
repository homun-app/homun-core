import {
  ChevronDown,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeContext } from "../lib/useRuntimeContext";
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
  type ChatAttachmentInput,
  type CoreBranchPoint,
  type CoreComputerSessionSnapshot,
  type CoreUncertainEffectOutcome,
  type MemoryArtifactView,
  modelIsCloud,
  type ProviderModelsGroup,
  type RoutingBindingInput,
  type RuntimeContextResponse,
  type SkillsSummary,
} from "../lib/coreBridge";
import { wsSubscription } from "../lib/wsSubscription";
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
  isLikelyIncompleteMessage,
  isPlaceholderThreadTitle,
  isUserVisibleComputerEvent,
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
  chatEventPartFromStream,
  normalizeChatEventParts,
  replayStatusFromProjection,
  shouldDropStructuredMarkerDelta,
  threadTailAwaitsUser,
  type ActiveTurnProjection,
} from "../lib/chatEventParts";
// Persisted artifact rows need a storage-aware projection before previewing.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as artifactProjection from "../lib/artifactProjection.mjs";
// Transcript indexes live in a plain .mjs sibling so `node --test` can exercise
// them without a build step, which is why they carry no type declaration.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as messageIndex from "../lib/messageIndex.mjs";
import {
  parseArtifacts,
  artifactExt,
  ARTIFACT_IMAGE_EXT,
  type ParsedArtifact,
} from "./MessageArtifacts";
import { ChatComputerPanel } from "./ChatComputerPanel";
import { AdaptiveWorkspaceIsland } from "./AdaptiveWorkspaceIsland";
import { ActiveTurnStatus } from "./ActiveTurnStatus";
import { PendingSteeringQueue } from "./PendingSteeringQueue";
import { InspectorWorkspace } from "./InspectorWorkspace";
import {
  INSPECTOR_VIEW_LABEL_KEY,
  InspectorView,
  PANEL_VIEWS,
  isRestorableInspectorTab,
  type IslandSource,
} from "./InspectorView";
import { ComposerContainer } from "./ComposerContainer";
import { ChatEmptyHero } from "./ChatEmptyHero";
import { ChatTopbar } from "./ChatTopbar";
import { ChatMessageRow } from "./ChatMessageRow";
import { PendingAssistantMessage } from "./PendingAssistantMessage";
import { type ChatStreamStatus } from "./AssistantThinkingState";
import { InlineUncertainEffectPanel } from "./InlineUncertainEffectPanel";
import { InlineApprovelPanel } from "./InlineApprovelPanel";
import { WorkspaceIslandSections } from "./WorkspaceIslandSections";
import {
  latestActivitySteps,
  latestPlanMarkdown,
  parsePlanSteps,
} from "./ChatPayloadParsers";
import {
  projectWorkspaceSections,
} from "../lib/workspaceIslandSections";
import type {
  ChatMessage,
  ChatEventPart,
  ChatAttachment,
  ChatThread,
  ComputerSession,
  ComputerSurfaceKind,
  ApprovelItem,
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
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  // Persisted conversation branches (non-destructive edit + regenerate). Each
  // entry is a node on the active path that has alternative siblings, driving the
  // ‹ n/m › switcher. Replaces the old ephemeral, reload-lossy "variants".
  const [branches, setBranches] = useState<CoreBranchPoint[]>([]);
  const [branchBusy, setBranchBusy] = useState(false);
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
      }, CHAT_VIEW_SESSION_ID);
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

  function selectFollowUp(suggestion: string) {
    setFollowUps([]);
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
    await copyText(lines.join("\n"));
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

      <AdaptiveWorkspaceIsland
        threadId={thread.threadId}
        sections={workspaceSections}
        disabled={inspector.open}
        openSectionRequest={{ section: "activity", nonce: activityNonce }}
        renderSection={(section) => (
          <WorkspaceIslandSections
            section={section}
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
          />
        )}
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
          {threadMessages.map((message) => (
            <ChatMessageRow
              key={message.id}
              message={message}
              streamingAssistantId={streamingAssistantId}
              editingMessageId={editingMessageId}
              editingText={editingText}
              streamHasVisibleText={streamHasVisibleText}
              hasActiveTurnState={Boolean(chatTurnState)}
              streamStatus={streamStatus}
              threadId={thread.threadId}
              cancelLabel="Cancel"
              saveLabel={t("chat.saveAndSend")}
              autoContinueMessageId={autoContinueMessageId}
              branchIndex={branchIndex}
              branchBusy={branchBusy}
              followUps={followUps}
              followUpsFor={followUpsFor}
              copiedMessageId={copiedMessageId}
              previousUserMessageIndex={previousUserMessageIndex}
              threadIsProject={threadIsProject}
              consumerWorkspaceId={thread.workspaceId}
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
            />
          ))}
          </div>

          {promptSubmitting && !streamingAssistantId && !chatTurnState && (
            <PendingAssistantMessage status={streamStatus} />
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
