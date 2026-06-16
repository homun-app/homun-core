import {
  AlertCircle,
  Check,
  Clock3,
  Globe2,
  Loader2,
  PauseCircle,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ApprovelItem,
  TaskDetailItem,
  TaskItem,
  TaskResourceUsage,
} from "../types";

interface TasksViewProps {
  tasks: TaskItem[];
  approvals: ApprovelItem[];
  resourceUsage: TaskResourceUsage[];
  selectedTaskDetail: TaskDetailItem | null;
  taskDetailLoading: boolean;
  approvalBusyId: string | null;
  selectedTaskId: string;
  onApproveApprovel: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void;
  onRejectApprovel: (approvalId: string) => void;
  onSelectTask: (taskId: string) => void;
}

export function TasksView({
  tasks,
  approvals,
  resourceUsage,
  selectedTaskDetail,
  taskDetailLoading,
  approvalBusyId,
  selectedTaskId,
  onApproveApprovel,
  onRejectApprovel,
  onSelectTask,
}: TasksViewProps) {
  const { t } = useTranslation();
  return (
    <section className="tasks-view" aria-labelledby="tasks-title">
      <header className="topbar">
        <div>
          <h2 id="tasks-title">{t("tasksView.title")}</h2>
        </div>
        <div className="summary-strip">
          <strong>{tasks.filter((task) => task.status === "running").length}</strong>
          <span>{t("tasksView.running")}</span>
          <strong>{approvals.length}</strong>
          <span>{t("tasksView.approval")}</span>
        </div>
      </header>

      <div className="task-columns">
        <section className="task-column" aria-label={t("tasksView.queueAria")}>
          <h3>{t("tasksView.queue")}</h3>
          <div className="task-list">
            {tasks.map((task) => (
              <button
                type="button"
                className={`task-row ${selectedTaskId === task.id ? "selected" : ""}`}
                key={task.id}
                onClick={() => onSelectTask(task.id)}
              >
                {statusIcon(task.status)}
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.kind}</small>
                </span>
                <em>{task.updated}</em>
              </button>
            ))}
          </div>
          <TaskDetailPanel
            detail={selectedTaskDetail}
            loading={taskDetailLoading}
          />
        </section>

        <section className="task-column" aria-label={t("tasksView.approvalCenterAria")}>
          <h3>{t("tasksView.approvalCenter")}</h3>
          {approvals.map((approval) => (
            <article className="approval-card" key={approval.id}>
              <div className="approval-header">
                <span className={`risk-badge ${approval.risk}`}>
                  {approval.risk}
                </span>
                {approval.action === "browser.manual_action" && (
                  <span className="approval-surface">
                    <Globe2 size={14} />
                    Browser
                  </span>
                )}
              </div>
              <h4>{approval.title}</h4>
              <p className="approval-reason">{approval.reason}</p>
              <div className="approval-meta">
                <span>
                  <ShieldCheck size={14} />
                  {approval.boundary}
                </span>
                <span>{approval.requestedBy}</span>
              </div>
              <div className="approval-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={approvalBusyId === approval.id}
                  onClick={() => onRejectApprovel(approval.id)}
                >
                  {t("tasksView.reject")}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={approvalBusyId === approval.id}
                  onClick={() => onApproveApprovel(approval.id)}
                >
                  {t("tasksView.approveAndContinue")}
                </button>
              </div>
            </article>
          ))}
          {!approvals.length && (
            <div className="approval-empty">
              <Check size={17} />
              <span>{t("tasksView.noApprovals")}</span>
            </div>
          )}

          <div className="resource-usage-panel" aria-label={t("tasksView.resourceUsageAria")}>
            <h3>{t("tasksView.resources")}</h3>
            {resourceUsage.length ? (
              resourceUsage.map((usage) => (
                <span className="resource-usage-row" key={usage.resourceClass}>
                  <strong>{usage.resourceClass}</strong>
                  <em>{usage.units}</em>
                </span>
              ))
            ) : (
              <p>{t("tasksView.noResources")}</p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function TaskDetailPanel({
  detail,
  loading,
}: {
  detail: TaskDetailItem | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <aside className="task-detail-panel" aria-label={t("tasksView.detailAria")}>
      <h3>{t("tasksView.redactedDetail")}</h3>
      {loading && <p>{t("common.loading")}</p>}
      {!loading && !detail && <p>{t("tasksView.selectTaskHint")}</p>}
      {!loading && detail && (
        <dl>
          <div>
            <dt>{t("tasksView.status")}</dt>
            <dd>{detail.status}</dd>
          </div>
          <div>
            <dt>{t("tasksView.priority")}</dt>
            <dd>{detail.priority}</dd>
          </div>
          <div>
            <dt>{t("tasksView.checkpoint")}</dt>
            <dd>{detail.checkpointSummary}</dd>
          </div>
          <div>
            <dt>{t("tasksView.metadata")}</dt>
            <dd>{detail.metadataSummary}</dd>
          </div>
          <div>
            <dt>{t("tasksView.rawPayload")}</dt>
            <dd>{detail.exposesRawInput ? t("tasksView.blocked") : t("tasksView.notExposed")}</dd>
          </div>
          {detail.blockedReason && (
            <div>
              <dt>{t("tasksView.block")}</dt>
              <dd>{detail.blockedReason}</dd>
            </div>
          )}
        </dl>
      )}
    </aside>
  );
}

function statusIcon(status: TaskItem["status"]) {
  if (status === "running") return <Loader2 className="spin" size={17} />;
  if (status === "waiting_user_approval") return <AlertCircle size={17} />;
  if (status === "waiting_resource") return <PauseCircle size={17} />;
  if (status === "completed") return <Check size={17} />;
  return <Clock3 size={17} />;
}
