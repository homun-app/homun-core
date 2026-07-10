import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  FileImage,
  ListTodo,
  Loader2,
  MoreHorizontal,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentStepIndex, threeStepWindow } from "../lib/islandPlan";
import type { ChatStreamStatus, PlanStep, WorkbenchTab } from "./ChatView";

// Single-row renderer shared by the before/window/after segments of the 3-step
// plan window: status drives the icon (done = Check, doing = spinner, blocked =
// AlertTriangle, bare todo = hollow circle) so the three segments stay visually
// consistent even though only `window` is always-visible and before/after collapse.
// `isCurrent` flags the row the plan is on RIGHT NOW — which may be a step the model
// never marked "doing" (currentStepIndex falls back to the first still-open step) —
// so it gets the accent highlight + trailing arrow even while showing its todo icon.
// `live` gates the "in progress" affordances (spinner + active highlight + arrow): only
// a STREAMING turn has a step actively running. On a concluded turn nothing is in
// progress, so those affordances are suppressed — otherwise a step the model left marked
// "doing" would spin forever and read as "still working" after the turn already ended.
function renderPlanStepRow(step: PlanStep, key: string, isCurrent: boolean, live: boolean) {
  const active = live && (isCurrent || step.status === "doing");
  return (
    <li key={key} className={`${step.status}${active ? " current" : ""}`}>
      <span>
        {step.status === "done" ? (
          <Check size={12} />
        ) : step.status === "doing" && live ? (
          <Loader2 size={12} className="composer-spin" />
        ) : step.status === "blocked" ? (
          <AlertTriangle size={12} />
        ) : (
          <span />
        )}
      </span>
      <em>{step.title}</em>
      {active && <ArrowRight size={12} className="wi-step-active-arrow" />}
    </li>
  );
}

type WorkspaceIslandMode = "auto" | "expanded" | "collapsed";

const WORKSPACE_ISLAND_MODE_KEY = "homun.workspaceIsland.mode";

function loadWorkspaceIslandMode(): WorkspaceIslandMode {
  if (typeof window === "undefined") return "auto";
  const raw = window.localStorage.getItem(WORKSPACE_ISLAND_MODE_KEY);
  return raw === "expanded" || raw === "collapsed" || raw === "auto" ? raw : "auto";
}

export function WorkspaceIsland({
  threadId,
  objective,
  activitySteps,
  computerActivity,
  computerLive,
  planSteps,
  streaming,
  status,
  threadHasMessages,
  onCaptureScreenshot,
  onExportChat,
  onOpenWorkbench,
}: {
  threadId: string;
  /** North-star objective text (top of the Objective → Plan → Activity hierarchy).
   *  null/undefined when the workspace has none — the block stays hidden. */
  objective?: string | null;
  activitySteps: string[];
  computerActivity: string | null;
  computerLive: boolean;
  planSteps: PlanStep[];
  streaming: boolean;
  status: ChatStreamStatus | null;
  threadHasMessages: boolean;
  onCaptureScreenshot?: () => void;
  onExportChat: () => void;
  onOpenWorkbench: (tab: WorkbenchTab) => void;
}) {
  const { t } = useTranslation();
  const [mode, setModeState] = useState<WorkspaceIslandMode>(() => loadWorkspaceIslandMode());
  const [expanded, setExpanded] = useState(() => loadWorkspaceIslandMode() === "expanded");
  const [menuOpen, setMenuOpen] = useState(false);
  // Collapse toggles for the two collapsed segments flanking the always-visible
  // 3-step window (threeStepWindow): completed steps before it, waiting steps after.
  const [beforeExpanded, setBeforeExpanded] = useState(false);
  const [afterExpanded, setAfterExpanded] = useState(false);
  // Activity reveals its accumulated steps INLINE (like the transcript's MessageActivity):
  // the old row opened the Workbench "activity" tab, which is bound to background TASKS
  // (activeTasks), not these conversation activity steps — so clicking showed nothing.
  const [activityOpen, setActivityOpen] = useState(false);
  // Latch: once the island has shown work this thread, keep it AROUND (collapsed) after
  // the run instead of unmounting the moment the live state empties — so the user can
  // review what the agent did ("it disappears and doesn't stay"). Reset per thread.
  const [hadWorkspaceState, setHadWorkspaceState] = useState(false);
  const doneCount = planSteps.filter((step) => step.status === "done").length;
  const runningPlan = planSteps.find((step) => step.status === "doing");
  const blockedPlan = planSteps.find((step) => step.status === "blocked");
  // Auto-focus window: always show the 3 steps around "now", collapse the rest.
  // currentIdx is the absolute index of the step being worked on (falls back to the
  // first still-open step when the model never marked one "doing"), used to highlight
  // the current row inside the window even when its status is still "todo".
  const planWin = threeStepWindow(planSteps);
  const currentIdx = currentStepIndex(planSteps);
  const latestActivity = activitySteps[activitySteps.length - 1] ?? null;
  const hasWorkspaceState =
    (threadHasMessages || streaming || computerLive) &&
    (streaming || computerLive || planSteps.length > 0 || activitySteps.length > 0);
  useEffect(() => setHadWorkspaceState(false), [threadId]);
  useEffect(() => {
    if (hasWorkspaceState) setHadWorkspaceState(true);
  }, [hasWorkspaceState]);
  // Headline precedence: REAL work signals first (the running/blocked plan step,
  // the live ‹‹ACT›› activity, the computer activity) so the task's title shows up
  // IMMEDIATELY as the agent works — the generic phase label ("thinking"/"writing")
  // is only a fallback for the brief moment before any concrete activity exists.
  // Previously `status?.title` sat above the activity signals, so the island showed
  // "thinking"/"writing" for the whole turn and the real title appeared only at the end.
  const headline =
    blockedPlan?.title ??
    runningPlan?.title ??
    latestActivity ??
    computerActivity ??
    status?.title ??
    (computerLive ? "Computer" : null) ??
    t("chat.panel");
  const progressLabel =
    planSteps.length > 0
      ? `${doneCount}/${planSteps.length}`
      : streaming
        ? status?.phase ?? "live"
        : computerLive
          ? "live"
          : "";

  const setMode = (next: WorkspaceIslandMode) => {
    setModeState(next);
    window.localStorage.setItem(WORKSPACE_ISLAND_MODE_KEY, next);
    setMenuOpen(false);
    if (next === "expanded") {
      setExpanded(true);
    } else if (next === "collapsed") {
      setExpanded(false);
    }
  };

  useEffect(() => {
    if (mode === "expanded") {
      setExpanded(true);
      return undefined;
    }
    if (mode === "collapsed") {
      return undefined;
    }
    if (streaming || blockedPlan) {
      setExpanded(true);
      return undefined;
    }

    const timer = window.setTimeout(() => setExpanded(false), 3200);
    return () => window.clearTimeout(timer);
  }, [
    activitySteps.length,
    blockedPlan,
    doneCount,
    mode,
    planSteps.length,
    streaming,
    computerLive,
  ]);

  const menuOptions: Array<{ value: WorkspaceIslandMode; label: string }> = [
    { value: "auto", label: "Auto expand" },
    { value: "expanded", label: "Always expanded" },
    { value: "collapsed", label: "Always collapsed" },
  ];

  if (!hasWorkspaceState && !hadWorkspaceState) return null;

  return (
    <div className={`workspace-island${expanded ? " expanded" : ""}${streaming ? " live" : ""}`}>
      {!expanded ? (
        <button
          className="workspace-island-pill"
          type="button"
          title="Expand status"
          aria-label="Expand status"
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          <span className="workspace-island-icon">
            {streaming ? <Loader2 size={14} className="composer-spin" /> : <ListTodo size={14} />}
          </span>
          <span className="workspace-island-label">{headline}</span>
          {progressLabel && <span className="workspace-island-count">{progressLabel}</span>}
        </button>
      ) : (
        <div className="workspace-island-panel" role="group" aria-label="Workspace status">
          <div className="wi-head">
            <span>
              <strong>Workspace</strong>
              <small>{streaming ? "live" : "thread"}</small>
            </span>
            <span className="wi-head-actions">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Workspace island options"
                onClick={() => setMenuOpen((value) => !value)}
              >
                <MoreHorizontal size={14} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  if (mode === "expanded") {
                    setMode("auto");
                  }
                  setExpanded(false);
                }}
                aria-label="Collapse status"
              >
                <ChevronUp size={14} />
              </button>
            </span>
            {menuOpen && (
              <div className="wi-menu" role="menu">
                {menuOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === option.value}
                    onClick={() => setMode(option.value)}
                  >
                    <span>{option.label}</span>
                    {mode === option.value && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Objective sits above Plan/Activity in the hierarchy — shown as plain text,
              never an empty block: the server returns null when there's no confirmed
              goal memory for this workspace (personal/threads chats included). */}
          {objective ? (
            <div className="wi-goal">
              <span className="wi-goal-label">{t("projectContext.objective")}</span>
              <p className="wi-goal-text">{objective}</p>
            </div>
          ) : null}

          {planSteps.length > 0 && (
            <button
              className="wi-row wi-row-button"
              type="button"
              onClick={() => onOpenWorkbench("plan")}
            >
              <ListTodo size={14} />
              <span>Plan</span>
              <strong>{doneCount}/{planSteps.length}</strong>
            </button>
          )}
          {planSteps.length > 0 && (
            <div className="wi-progress">
              <div className="wi-progress-head">
                <span>Progress</span>
                <strong>{doneCount}/{planSteps.length}</strong>
              </div>
              {planWin.before.length > 0 && (
                <button
                  className="wi-completed-toggle"
                  type="button"
                  aria-expanded={beforeExpanded}
                  onClick={() => setBeforeExpanded((value) => !value)}
                >
                  {beforeExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{planWin.before.length} completati</span>
                </button>
              )}
              {beforeExpanded && planWin.before.length > 0 && (
                <ol className="wi-steps wi-steps-completed">
                  {planWin.before.map((step: PlanStep, index: number) =>
                    renderPlanStepRow(step, `before-${index}-${step.title}`, false, streaming)
                  )}
                </ol>
              )}
              {/* The 3-step window: always visible regardless of collapse state, so the
                  current step (and its immediate neighbors) never disappears from view.
                  A window step's absolute index is before.length + j, so it's the current
                  one when that equals currentIdx. */}
              <ol className="wi-steps">
                {planWin.window.map((step: PlanStep, index: number) =>
                  renderPlanStepRow(
                    step,
                    `win-${index}-${step.title}`,
                    planWin.before.length + index === currentIdx,
                    streaming
                  )
                )}
              </ol>
              {planWin.after.length > 0 && (
                <button
                  className="wi-completed-toggle"
                  type="button"
                  aria-expanded={afterExpanded}
                  onClick={() => setAfterExpanded((value) => !value)}
                >
                  {afterExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{planWin.after.length} in attesa</span>
                </button>
              )}
              {afterExpanded && planWin.after.length > 0 && (
                <ol className="wi-steps">
                  {planWin.after.map((step: PlanStep, index: number) =>
                    renderPlanStepRow(step, `after-${index}-${step.title}`, false, streaming)
                  )}
                </ol>
              )}
            </div>
          )}

          {activitySteps.length > 0 && (
            <div className="wi-activity">
              <button
                className="wi-row wi-row-button"
                type="button"
                aria-expanded={activityOpen}
                onClick={() => setActivityOpen((value) => !value)}
              >
                <SquareTerminal size={14} />
                <span>Activity</span>
                <strong>{activitySteps.length}</strong>
                <ChevronDown
                  size={13}
                  className={`wi-activity-caret${activityOpen ? " open" : ""}`}
                />
              </button>
              {activityOpen ? (
                <ol className="wi-activity-list">
                  {activitySteps.slice(-40).map((step, index) => (
                    <li key={`${index}-${step.slice(0, 24)}`}>
                      {step.replace(/^(?:\p{Extended_Pictographic}|️|‍|\s)+/u, "")}
                    </li>
                  ))}
                </ol>
              ) : (
                latestActivity && <p className="wi-latest">{latestActivity}</p>
              )}
            </div>
          )}

          <div className="wi-actions">
            {onCaptureScreenshot && (
              <button type="button" onClick={onCaptureScreenshot}>
                <FileImage size={13} />
                <span>{t("chat.captureScreenshot")}</span>
              </button>
            )}
            <button type="button" onClick={onExportChat}>
              <Download size={13} />
              <span>{t("chat.exportChat")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
