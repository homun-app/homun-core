import {
  AlertTriangle,
  FileImage,
  FileText,
  Monitor,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SubagentInfo } from "../lib/chatApi";
import type { WorkspaceSectionId } from "../lib/workspaceIslandSections";
import type { PlanStep } from "./ChatPayloadParsers";
import type { IslandSource } from "./InspectorView";
import {
  derivePlanStepDisplay,
  getDoneCriterionText,
} from "../lib/chat-runtime/planStepDisplay";
import { derivePlanningDisplayState } from "../lib/chat-runtime/planningState";

interface WorkspaceIslandSectionsProps {
  section: WorkspaceSectionId;
  projectObjective: string | null;
  /** Goal parsed from the plan markdown (`**Goal**: ...`), shown when no
   *  project objective is set. */
  planGoal: string | null;
  /** Plan step id last touched by a `step_advance` event (brief pulse). */
  planStepPulseId: string | null;
  planSteps: PlanStep[];
  subagents: SubagentInfo[];
  activity: string[];
  workInProgress: boolean;
  browserBudgetMessage: string | null;
  browserBudgetAssistantId: string | null;
  previewDataUrl: string | null;
  previewTitle: string;
  artifactSources: IslandSource[];
  fileSources: IslandSource[];
  onRetryBrowserBudget: (assistantMessageId: string) => void;
  onOpenBrowserDock: () => void;
  onOpenSource: (source: IslandSource) => void;
}

export function WorkspaceIslandSections({
  section,
  projectObjective,
  planGoal,
  planStepPulseId,
  planSteps,
  subagents,
  activity,
  workInProgress,
  browserBudgetMessage,
  browserBudgetAssistantId,
  previewDataUrl,
  previewTitle,
  artifactSources,
  fileSources,
  onRetryBrowserBudget,
  onOpenBrowserDock,
  onOpenSource,
}: WorkspaceIslandSectionsProps) {
  const { t } = useTranslation();

  const { showPlanningIndicator, showBrowsingIndicator } = derivePlanningDisplayState({
    workInProgress,
    planStepCount: planSteps.length,
    activityStepCount: activity.length,
  });

  if (section === "activity") {
    // The project objective wins; the plan goal fills the same slot otherwise.
    const objectiveText = projectObjective ?? planGoal;
    const objectiveLabel = projectObjective
      ? t("projectContext.objective")
      : t("chat.planGoal");
    return (
      <div className="workspace-island-activity">
        {objectiveText ? (
          <div className="workspace-island-objective">
            <span>{objectiveLabel}</span>
            <p>{objectiveText}</p>
          </div>
        ) : null}
        {showPlanningIndicator ? (
          <div className="workspace-island-planning" role="status">
            <span className="workspace-island-planning-dot" aria-hidden="true" />
            <span>{t("chat.planningIndicator")}</span>
          </div>
        ) : null}
        {showBrowsingIndicator ? (
          <div className="workspace-island-planning" role="status">
            <span className="workspace-island-planning-dot" aria-hidden="true" />
            <span>{t("chat.browsingIndicator")}</span>
          </div>
        ) : null}
        {planSteps.length > 0 ? (
          <div className="workspace-island-block">
            <div className="workspace-island-block-title">
              <span>{t("chat.activityProgress")}</span>
              <em>
                {planSteps.filter((step) => step.status === "done").length}/{planSteps.length}
              </em>
            </div>
            <ol className="workspace-island-list">
              {planSteps.map((step, index) => {
                const display = derivePlanStepDisplay(step);
                const criterion =
                  display.showDoneCriterion && getDoneCriterionText(step);
                const pulsing = Boolean(step.id) && step.id === planStepPulseId;
                return (
                  <li
                    key={`${index}-${step.title}`}
                    className={`plan-step ${display.itemClassName}${pulsing ? " plan-step-pulse" : ""}`}
                  >
                    <span
                      className="workspace-island-state"
                      role="img"
                      aria-label={display.iconLabel}
                    >
                      {display.icon ? (
                        <span className="plan-step-icon" aria-hidden="true">
                          {display.icon}
                        </span>
                      ) : null}
                    </span>
                    <span className="plan-step-content">
                      <span className={display.titleClassName}>{step.title}</span>
                      {criterion ? (
                        <span className="plan-step-criterion">{criterion}</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}
        {subagents.length > 0 ? (
          <div className="workspace-island-block">
            <div className="workspace-island-block-title">
              <span>{t("chat.inspector.views.subagents")}</span>
              <em>{subagents.length}</em>
            </div>
            <ul className="workspace-island-list">
              {subagents.map((subagent, index) => (
                <li key={`${index}-${subagent.name}`} className={`status-${subagent.status}`}>
                  <span className="workspace-island-state" aria-hidden="true" />
                  <span>{subagent.name}</span>
                  <em>{subagent.status}</em>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {activity.length > 0 ? (
          <div className="workspace-island-block">
            <div className="workspace-island-block-title">
              <span>{workInProgress ? t("chat.activity") : t("chat.lastActivity")}</span>
              <em>{activity.length}</em>
            </div>
            <ol className="workspace-island-activity-list">
              {activity.slice(-40).map((step, index) => (
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
                if (browserBudgetAssistantId) onRetryBrowserBudget(browserBudgetAssistantId);
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
        {previewDataUrl ? <img src={previewDataUrl} alt={previewTitle} /> : null}
        <button type="button" onClick={onOpenBrowserDock}>
          <Monitor size={15} aria-hidden="true" />
          <span>{t("chat.inspector.views.computer")}</span>
        </button>
      </div>
    );
  }

  const rows = section === "artifacts" ? artifactSources : fileSources;
  return (
    <div className="workspace-island-files">
      {rows.map((source, index) => (
        <button
          type="button"
          key={`${index}-${source.name}`}
          onClick={() => onOpenSource(source)}
        >
          {source.kind === "image" ? <FileImage size={15} /> : <FileText size={15} />}
          <span>{source.name}</span>
          {source.meta ? <em>{source.meta}</em> : null}
        </button>
      ))}
    </div>
  );
}
