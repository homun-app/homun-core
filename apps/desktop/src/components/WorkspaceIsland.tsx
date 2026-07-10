import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Copy,
  FileText,
  Image as ImageIcon,
  Layers,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentStepIndex, threeStepWindow } from "../lib/islandPlan";
import type { ChatStreamStatus, IslandSource, PlanStep, WorkbenchTab } from "./ChatView";

// Single checklist row (Progress). Monochrome: the ONLY color is the done check.
// `live` gates the "in progress" affordances — a concluded turn has no active step, so
// the spinner and the current-step arrow are suppressed (otherwise a step the model left
// marked "doing" would spin forever and read as still-working after the turn ended).
function renderPlanStepRow(step: PlanStep, key: string, isCurrent: boolean, live: boolean) {
  const active = live && (isCurrent || step.status === "doing");
  const icon =
    step.status === "done" ? (
      <Check size={14} className="wi-step-icon-done" />
    ) : step.status === "blocked" ? (
      <AlertTriangle size={13} className="wi-step-icon-blocked" />
    ) : step.status === "doing" && live ? (
      <Loader2 size={13} className="composer-spin" />
    ) : active ? (
      <ArrowRight size={14} className="wi-step-icon-current" />
    ) : (
      <Circle size={12} className="wi-step-icon-todo" />
    );
  return (
    <li key={key} className={`${step.status}${active ? " current" : ""}`}>
      <span className="wi-step-icon">{icon}</span>
      <em>{step.title}</em>
    </li>
  );
}

function sourceIcon(kind: IslandSource["kind"]) {
  if (kind === "image") return <ImageIcon size={15} />;
  return <FileText size={15} />;
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
  sources,
  backgroundCount,
  streaming,
  status,
  threadHasMessages,
  onCaptureScreenshot,
  onExportChat,
  onOpenWorkbench,
}: {
  threadId: string;
  /** North-star objective text (top of the Objective → Progress hierarchy). null when
   *  the workspace has none — the block stays hidden. */
  objective?: string | null;
  activitySteps: string[];
  computerActivity: string | null;
  computerLive: boolean;
  planSteps: PlanStep[];
  /** Generated artifacts + uploaded files for the "Sources" section (already deduped). */
  sources?: IslandSource[];
  /** Background tasks running elsewhere (other threads/automations) — surfaced in the menu. */
  backgroundCount?: number;
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
  // Collapse toggles for the two segments flanking the always-visible 3-step window.
  const [beforeExpanded, setBeforeExpanded] = useState(false);
  const [afterExpanded, setAfterExpanded] = useState(false);
  // Activity reveals its accumulated steps INLINE (the old row opened the Workbench
  // "activity" tab, which is bound to background TASKS — not these conversation steps).
  const [activityOpen, setActivityOpen] = useState(false);
  // Latch: keep the island around (collapsed) after a run so the user can review the work.
  const [hadWorkspaceState, setHadWorkspaceState] = useState(false);
  const sourceList = sources ?? [];
  const doneCount = planSteps.filter((step) => step.status === "done").length;
  const runningPlan = planSteps.find((step) => step.status === "doing");
  const blockedPlan = planSteps.find((step) => step.status === "blocked");
  // Auto-focus window: always show the 3 steps around "now", collapse the rest.
  const planWin = threeStepWindow(planSteps);
  const currentIdx = currentStepIndex(planSteps);
  const latestActivity = activitySteps[activitySteps.length - 1] ?? null;
  const hasWorkspaceState =
    (threadHasMessages || streaming || computerLive) &&
    (streaming ||
      computerLive ||
      planSteps.length > 0 ||
      activitySteps.length > 0 ||
      sourceList.length > 0);
  useEffect(() => setHadWorkspaceState(false), [threadId]);
  useEffect(() => {
    if (hasWorkspaceState) setHadWorkspaceState(true);
  }, [hasWorkspaceState]);
  // Headline (collapsed pill): real work signals first so the task title shows immediately.
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
  }, [activitySteps.length, blockedPlan, doneCount, mode, planSteps.length, streaming, computerLive]);

  const modeOptions: Array<{ value: WorkspaceIslandMode; label: string }> = [
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
            {streaming ? <Loader2 size={13} className="composer-spin" /> : <Circle size={7} />}
          </span>
          <span className="workspace-island-label">{headline}</span>
          {progressLabel && <span className="workspace-island-count">{progressLabel}</span>}
        </button>
      ) : (
        <div className="workspace-island-panel" role="group" aria-label={t("chat.panel")}>
          {/* Header: state + menu only (no "Workspace" title — there is one workspace). */}
          <div className="wi-head">
            <span className="wi-status">
              {streaming ? (
                <>
                  <Loader2 size={13} className="composer-spin" />
                  <span>Working</span>
                </>
              ) : (
                <span className="wi-status-idle">Idle</span>
              )}
            </span>
            <span className="wi-head-actions">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Options"
                onClick={() => setMenuOpen((value) => !value)}
              >
                <MoreHorizontal size={15} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  if (mode === "expanded") setMode("auto");
                  setExpanded(false);
                }}
                aria-label="Collapse status"
              >
                <ChevronUp size={15} />
              </button>
            </span>
            {menuOpen && (
              <div className="wi-menu" role="menu">
                <div className="wi-menu-label">Panel mode</div>
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === option.value}
                    className="wi-menu-item"
                    onClick={() => setMode(option.value)}
                  >
                    <span>{option.label}</span>
                    {mode === option.value && <Check size={15} />}
                  </button>
                ))}
                <div className="wi-menu-sep" />
                {onCaptureScreenshot && (
                  <button
                    type="button"
                    className="wi-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onCaptureScreenshot();
                    }}
                  >
                    <Camera size={15} />
                    <span>{t("chat.captureScreenshot")}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="wi-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onExportChat();
                  }}
                >
                  <Copy size={15} />
                  <span>{t("chat.exportChat")}</span>
                </button>
                {backgroundCount && backgroundCount > 0 ? (
                  <button
                    type="button"
                    className="wi-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenWorkbench("activity");
                    }}
                  >
                    <Layers size={15} />
                    <span>Background activity</span>
                    <em className="wi-menu-count">{backgroundCount}</em>
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {/* Objective → Progress → Activity → Sources. Each section renders only when full. */}
          {objective ? (
            <div className="wi-goal">
              <span className="wi-goal-label">{t("projectContext.objective")}</span>
              <p className="wi-goal-text">{objective}</p>
            </div>
          ) : null}

          {planSteps.length > 0 && (
            <div className="wi-section wi-progress">
              <div className="wi-section-head">
                <span>Progress</span>
                <em>{doneCount}/{planSteps.length}</em>
              </div>
              {planWin.before.length > 0 && (
                <button
                  className="wi-completed-toggle"
                  type="button"
                  aria-expanded={beforeExpanded}
                  onClick={() => setBeforeExpanded((value) => !value)}
                >
                  {beforeExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{planWin.before.length} completed</span>
                </button>
              )}
              {beforeExpanded && planWin.before.length > 0 && (
                <ol className="wi-steps wi-steps-completed">
                  {planWin.before.map((step: PlanStep, index: number) =>
                    renderPlanStepRow(step, `before-${index}-${step.title}`, false, streaming),
                  )}
                </ol>
              )}
              <ol className="wi-steps">
                {planWin.window.map((step: PlanStep, index: number) =>
                  renderPlanStepRow(
                    step,
                    `win-${index}-${step.title}`,
                    planWin.before.length + index === currentIdx,
                    streaming,
                  ),
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
                  <span>{planWin.after.length} waiting</span>
                </button>
              )}
              {afterExpanded && planWin.after.length > 0 && (
                <ol className="wi-steps">
                  {planWin.after.map((step: PlanStep, index: number) =>
                    renderPlanStepRow(step, `after-${index}-${step.title}`, false, streaming),
                  )}
                </ol>
              )}
            </div>
          )}

          {activitySteps.length > 0 && (
            <div className="wi-section wi-activity">
              <button
                className="wi-section-head wi-section-toggle"
                type="button"
                aria-expanded={activityOpen}
                onClick={() => setActivityOpen((value) => !value)}
              >
                <span>Activity</span>
                <em>{activitySteps.length}</em>
                <ChevronDown
                  size={14}
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

          {sourceList.length > 0 && (
            <div className="wi-section wi-sources">
              <div className="wi-section-head">
                <span>Sources</span>
                <em>{sourceList.length}</em>
              </div>
              {sourceList.slice(0, 6).map((source, index) => (
                <button
                  key={`${index}-${source.name}`}
                  type="button"
                  className="wi-source"
                  onClick={() => onOpenWorkbench(source.kind === "file" ? "files" : "artifacts")}
                >
                  <span className="wi-source-icon">{sourceIcon(source.kind)}</span>
                  <span className="wi-source-name">{source.name}</span>
                  {source.meta && <em>{source.meta}</em>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
