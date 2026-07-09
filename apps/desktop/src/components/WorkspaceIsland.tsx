import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  FileImage,
  FileText,
  FolderOpen,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Share2,
  SquareTerminal,
  Target,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatStreamStatus, ParsedArtifact, PlanStep, WorkbenchTab } from "./ChatView";

type WorkspaceIslandMode = "auto" | "expanded" | "collapsed";

const WORKSPACE_ISLAND_MODE_KEY = "homun.workspaceIsland.mode";

function loadWorkspaceIslandMode(): WorkspaceIslandMode {
  if (typeof window === "undefined") return "auto";
  const raw = window.localStorage.getItem(WORKSPACE_ISLAND_MODE_KEY);
  return raw === "expanded" || raw === "collapsed" || raw === "auto" ? raw : "auto";
}

export function WorkspaceIsland({
  threadId,
  activitySteps,
  artifacts,
  computerActivity,
  computerLive,
  fileCount,
  goalCount,
  memoryCount,
  planSteps,
  streaming,
  status,
  threadHasMessages,
  onCaptureScreenshot,
  onExportChat,
  onOpenWorkbench,
}: {
  threadId: string;
  activitySteps: string[];
  artifacts: ParsedArtifact[];
  computerActivity: string | null;
  computerLive: boolean;
  fileCount: number;
  goalCount: number;
  memoryCount: number;
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
  const [completedExpanded, setCompletedExpanded] = useState(false);
  // Latch: once the island has shown work this thread, keep it AROUND (collapsed) after
  // the run instead of unmounting the moment the live state empties — so the user can
  // review what the agent did ("it disappears and doesn't stay"). Reset per thread.
  const [hadWorkspaceState, setHadWorkspaceState] = useState(false);
  const doneCount = planSteps.filter((step) => step.status === "done").length;
  const completedSteps = planSteps.filter((step) => step.status === "done");
  const openSteps = planSteps.filter((step) => step.status !== "done");
  const runningPlan = planSteps.find((step) => step.status === "doing");
  const blockedPlan = planSteps.find((step) => step.status === "blocked");
  // The step being worked on RIGHT NOW. Models (esp. weak ones) often forget to mark a
  // step "doing" — they just flip steps to "done" as they go — so fall back to the first
  // still-open step. Guarantees the island always highlights "which one is it on".
  const activeStep = runningPlan ?? openSteps.find((step) => step.status === "todo") ?? null;
  const latestActivity = activitySteps[activitySteps.length - 1] ?? null;
  const artifactsCount = artifacts.length;
  const hasWorkspaceState =
    (threadHasMessages || streaming || computerLive) &&
    (streaming ||
      computerLive ||
      planSteps.length > 0 ||
      activitySteps.length > 0 ||
      artifactsCount > 0 ||
      fileCount > 0 ||
      goalCount > 0 ||
      memoryCount > 0);
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
    (artifactsCount > 0
      ? `${artifactsCount} artifact`
      : fileCount > 0
        ? `${fileCount} file`
        : goalCount > 0
          ? `${goalCount} goal`
          : memoryCount > 0
            ? "Memory"
            : t("chat.panel"));
  const progressLabel =
    planSteps.length > 0
      ? `${doneCount}/${planSteps.length}`
      : streaming
        ? status?.phase ?? "live"
        : computerLive
          ? "live"
        : artifactsCount > 0
          ? `${artifactsCount}`
          : goalCount > 0
            ? `${goalCount}`
            : memoryCount > 0
              ? `${memoryCount}`
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
    artifactsCount,
    blockedPlan,
    doneCount,
    fileCount,
    goalCount,
    memoryCount,
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
              {completedSteps.length > 0 && (
                <button
                  className="wi-completed-toggle"
                  type="button"
                  aria-expanded={completedExpanded}
                  onClick={() => setCompletedExpanded((value) => !value)}
                >
                  {completedExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{completedExpanded ? "Hide" : "Show"} {completedSteps.length} completed</span>
                </button>
              )}
              {openSteps.length > 0 && (
                <ol className="wi-steps">
                  {openSteps.slice(0, 5).map((step, index) => {
                    const isActive = step === activeStep;
                    return (
                      <li
                        key={`open-${index}-${step.title}`}
                        className={`${step.status}${isActive ? " active" : ""}`}
                      >
                        <span>
                          {step.status === "blocked" ? (
                            <AlertTriangle size={12} />
                          ) : isActive ? (
                            <ArrowRight size={12} />
                          ) : (
                            <span />
                          )}
                        </span>
                        <em>{step.title}</em>
                      </li>
                    );
                  })}
                </ol>
              )}
              {completedExpanded && completedSteps.length > 0 && (
                <ol className="wi-steps wi-steps-completed">
                  {completedSteps.slice(0, 8).map((step, index) => (
                    <li key={`done-${index}-${step.title}`} className="done">
                      <span><Check size={12} /></span>
                      <em>{step.title}</em>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {activitySteps.length > 0 && (
            <>
              <button
                className="wi-row wi-row-button"
                type="button"
                onClick={() => onOpenWorkbench("activity")}
              >
                <SquareTerminal size={14} />
                <span>Activity</span>
                <strong>{activitySteps.length}</strong>
              </button>
              {latestActivity && <p className="wi-latest">{latestActivity}</p>}
            </>
          )}

          {artifactsCount > 0 && (
            <button
              className="wi-row wi-row-button"
              type="button"
              onClick={() => onOpenWorkbench("artifacts")}
            >
              <FileText size={14} />
              <span>Artifacts</span>
              <strong>{artifactsCount}</strong>
            </button>
          )}

          {fileCount > 0 && (
            <button
              className="wi-row wi-row-button"
              type="button"
              onClick={() => onOpenWorkbench("files")}
            >
              <FolderOpen size={14} />
              <span>Files</span>
              <strong>{fileCount}</strong>
            </button>
          )}

          {goalCount > 0 && (
            <button
              className="wi-row wi-row-button"
              type="button"
              onClick={() => onOpenWorkbench("goals")}
            >
              <Target size={14} />
              <span>Goals</span>
              <strong>{goalCount}</strong>
            </button>
          )}

          {memoryCount > 0 && (
            <button
              className="wi-row wi-row-button"
              type="button"
              onClick={() => onOpenWorkbench("memoria")}
            >
              <Share2 size={14} />
              <span>Memory</span>
              <strong>{memoryCount}</strong>
            </button>
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
