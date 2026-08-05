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

interface WorkspaceIslandSectionsProps {
  section: WorkspaceSectionId;
  projectObjective: string | null;
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
  onOpenComputer: () => void;
  onOpenSource: (source: IslandSource) => void;
}

export function WorkspaceIslandSections({
  section,
  projectObjective,
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
  onOpenComputer,
  onOpenSource,
}: WorkspaceIslandSectionsProps) {
  const { t } = useTranslation();

  if (section === "activity") {
    return (
      <div className="workspace-island-activity">
        {projectObjective ? (
          <div className="workspace-island-objective">
            <span>{t("projectContext.objective")}</span>
            <p>{projectObjective}</p>
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
              {planSteps.map((step, index) => (
                <li key={`${index}-${step.title}`} className={`status-${step.status}`}>
                  <span className="workspace-island-state" aria-hidden="true" />
                  <span>{step.title}</span>
                </li>
              ))}
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
        <button type="button" onClick={onOpenComputer}>
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
