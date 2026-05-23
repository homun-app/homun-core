import { AlertTriangle, CheckCircle2, Clock3, Cpu, ListChecks } from "lucide-react";
import type { ApprovalItem, BrainRunDetail, RuntimeHealth, TaskItem, ViewId } from "../types";

interface InspectorProps {
  activeView: ViewId;
  brainRun: BrainRunDetail;
  task: TaskItem;
  approvals: ApprovalItem[];
  health: RuntimeHealth[];
}

export function Inspector({ activeView, brainRun, task, approvals, health }: InspectorProps) {
  return (
    <aside className="inspector" aria-label="Pannello contestuale">
      <header>
        <p className="eyebrow">Contesto</p>
        <h2>{activeView === "settings" ? "Sistema" : "Esecuzione"}</h2>
      </header>

      <section className="inspector-section">
        <div className="section-title">
          <ListChecks size={17} />
          <h3>Brain plan</h3>
        </div>
        <div className="step-list">
          {brainRun.steps.map((step) => (
            <div className="step-item" key={step.id}>
              <span className={`step-state ${step.status}`} />
              <div>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="inspector-section">
        <div className="section-title">
          <Clock3 size={17} />
          <h3>Task selezionato</h3>
        </div>
        <div className="task-summary">
          <strong>{task.title}</strong>
          <span>{task.kind}</span>
          <dl>
            <div>
              <dt>Stato</dt>
              <dd>{statusLabel(task.status)}</dd>
            </div>
            <div>
              <dt>Risorsa</dt>
              <dd>{task.resource}</dd>
            </div>
            <div>
              <dt>Rischio</dt>
              <dd>{task.risk}</dd>
            </div>
          </dl>
          {task.blockedReason && <p className="notice">{task.blockedReason}</p>}
        </div>
      </section>

      <section className="inspector-section">
        <div className="section-title">
          <AlertTriangle size={17} />
          <h3>Approvazioni</h3>
        </div>
        {approvals.map((approval) => (
          <div className="approval-row" key={approval.id}>
            <div>
              <strong>{approval.title}</strong>
              <small>{approval.reason}</small>
            </div>
            <button className="small-button" type="button">
              Rivedi
            </button>
          </div>
        ))}
      </section>

      <section className="inspector-section">
        <div className="section-title">
          <Cpu size={17} />
          <h3>Runtime</h3>
        </div>
        <div className="health-list">
          {health.map((item) => (
            <div className="health-row" key={item.label}>
              <CheckCircle2 size={16} />
              <div>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </div>
              <span className={`status-dot ${item.status}`} />
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

function statusLabel(status: TaskItem["status"]) {
  return status.replaceAll("_", " ");
}
