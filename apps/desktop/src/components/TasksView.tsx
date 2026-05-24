import { AlertCircle, Check, Clock3, Loader2, PauseCircle } from "lucide-react";
import type { ApprovalItem, TaskItem, TaskResourceUsage } from "../types";

interface TasksViewProps {
  tasks: TaskItem[];
  approvals: ApprovalItem[];
  resourceUsage: TaskResourceUsage[];
  selectedTaskId: string;
  onSelectTask: (taskId: string) => void;
}

export function TasksView({
  tasks,
  approvals,
  resourceUsage,
  selectedTaskId,
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
        </section>

        <section className="task-column" aria-label="Centro approvazioni">
          <h3>Approval center</h3>
          {approvals.map((approval) => (
            <article className="approval-card" key={approval.id}>
              <span className={`risk-badge ${approval.risk}`}>{approval.risk}</span>
              <h4>{approval.title}</h4>
              <p>{approval.reason}</p>
              <div className="approval-actions">
                <button className="secondary-button" type="button">
                  Rifiuta
                </button>
                <button className="primary-button" type="button">
                  Approva
                </button>
              </div>
            </article>
          ))}

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

function statusIcon(status: TaskItem["status"]) {
  if (status === "running") return <Loader2 className="spin" size={17} />;
  if (status === "waiting_user_approval") return <AlertCircle size={17} />;
  if (status === "waiting_resource") return <PauseCircle size={17} />;
  if (status === "completed") return <Check size={17} />;
  return <Clock3 size={17} />;
}
