import {
  AlertCircle,
  Check,
  Clock3,
  Globe2,
  Loader2,
  PauseCircle,
  ShieldCheck,
} from "lucide-react";
import type {
  ApprovalItem,
  TaskDetailItem,
  TaskItem,
  TaskResourceUsage,
} from "../types";

interface TasksViewProps {
  tasks: TaskItem[];
  approvals: ApprovalItem[];
  resourceUsage: TaskResourceUsage[];
  selectedTaskDetail: TaskDetailItem | null;
  taskDetailLoading: boolean;
  approvalBusyId: string | null;
  selectedTaskId: string;
  onApproveApproval: (approvalId: string) => void;
  onRejectApproval: (approvalId: string) => void;
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
  onApproveApproval,
  onRejectApproval,
  onSelectTask,
}: TasksViewProps) {
  return (
    <section className="tasks-view" aria-labelledby="tasks-title">
      <header className="topbar">
        <div>
          <h2 id="tasks-title">Task e approvazioni</h2>
        </div>
        <div className="summary-strip">
          <strong>{tasks.filter((task) => task.status === "running").length}</strong>
          <span>in esecuzione</span>
          <strong>{approvals.length}</strong>
          <span>approval</span>
        </div>
      </header>

      <div className="task-columns">
        <section className="task-column" aria-label="Coda task">
          <h3>Coda</h3>
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

        <section className="task-column" aria-label="Centro approvazioni">
          <h3>Approval center</h3>
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
                  onClick={() => onRejectApproval(approval.id)}
                >
                  Rifiuta
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={approvalBusyId === approval.id}
                  onClick={() => onApproveApproval(approval.id)}
                >
                  Approva
                </button>
              </div>
            </article>
          ))}
          {!approvals.length && (
            <div className="approval-empty">
              <Check size={17} />
              <span>Nessuna approval in attesa.</span>
            </div>
          )}

          <div className="resource-usage-panel" aria-label="Uso risorse runtime">
            <h3>Risorse</h3>
            {resourceUsage.length ? (
              resourceUsage.map((usage) => (
                <span className="resource-usage-row" key={usage.resourceClass}>
                  <strong>{usage.resourceClass}</strong>
                  <em>{usage.units}</em>
                </span>
              ))
            ) : (
              <p>Nessuna risorsa prenotata.</p>
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
  return (
    <aside className="task-detail-panel" aria-label="Dettaglio task redatto">
      <h3>Dettaglio redatto</h3>
      {loading && <p>Caricamento dettaglio...</p>}
      {!loading && !detail && <p>Seleziona un task per vedere lo stato.</p>}
      {!loading && detail && (
        <dl>
          <div>
            <dt>Stato</dt>
            <dd>{detail.status}</dd>
          </div>
          <div>
            <dt>Priorita'</dt>
            <dd>{detail.priority}</dd>
          </div>
          <div>
            <dt>Checkpoint</dt>
            <dd>{detail.checkpointSummary}</dd>
          </div>
          <div>
            <dt>Metadata</dt>
            <dd>{detail.metadataSummary}</dd>
          </div>
          <div>
            <dt>Payload raw</dt>
            <dd>{detail.exposesRawInput ? "bloccato" : "non esposto"}</dd>
          </div>
          {detail.blockedReason && (
            <div>
              <dt>Blocco</dt>
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
