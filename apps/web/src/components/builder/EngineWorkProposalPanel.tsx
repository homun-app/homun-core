import { useState } from "react";
import type { Work } from "./conversation-types";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import type { WorkIntake, WorkIntakePlanStep } from "@/lib/engine-intake-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { WorkTitleEditor } from "./WorkTitleEditor";
import { briefChangeLines, intakeConfirmLabel, preservedFieldLabels } from "@/lib/engine-intake-display";

export function EngineWorkProposalPanel({
  work,
  proposal,
  intake,
  busy,
  onRename,
}: {
  work: Work;
  proposal: WorkIntake;
  intake: WorkIntakeState;
  busy: boolean;
  onRename?: ((title: string) => Promise<void>) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [clarification, setClarification] = useState("");
  const agent = proposal.suggested_agent ?? proposal.new_agent;
  const isBusy = busy || intake.busy;

  return (
    <aside className="cw-workspace cw-engine-summary" aria-label="Scheda proposta di lavoro">
      <div className="cw-panel-top">
        <span className="cw-overline">PROPOSTA DI LAVORO</span>
        <span className="cw-status proposal">In attesa di conferma</span>
      </div>

      <h2 title={proposal.title}>{proposal.title}</h2>
      {onRename && (
        <WorkTitleEditor key={`title:${work.id}`} title={work.title} busy={isBusy} onRename={onRename} />
      )}

      <section className="cw-engine-objective">
        <div className="cw-engine-summary__section-heading">
          <h3>Risultato atteso</h3>
        </div>
        <p>{proposal.output || proposal.objective}</p>
      </section>

      {(proposal.changes?.length ?? 0) > 0 && (
        <div className="cw-intake-changes">
          <strong>Cosa cambia rispetto alla proposta precedente</strong>
          <ul>
            {briefChangeLines(proposal.changes).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {preservedFieldLabels(proposal.changes).length > 0 && (
            <p className="cw-intake-note">
              Restano invariati: {preservedFieldLabels(proposal.changes).join(", ")}.
            </p>
          )}
        </div>
      )}

      <dl className="cw-engine-summary__facts">
        <div>
          <dt>Responsabile</dt>
          <dd>
            <strong>{agent?.name ?? "Homun"}</strong>
            {agent?.role && <span className="cw-engine-summary__hint"> · {agent.role}</span>}
          </dd>
        </div>
      </dl>

      {(proposal.plan_steps?.length ?? 0) > 0 && (
        <section className="cw-engine-summary__phases" aria-label="Fasi del lavoro">
          <div className="cw-engine-summary__section-heading">
            <h3>Fasi previste ({proposal.plan_steps!.length})</h3>
          </div>
          <ol className="cw-engine-summary__phase-list">
            {proposal.plan_steps!.map((step, idx) => (
              <li key={step.title + idx}>
                <span className="cw-engine-summary__phase-title">
                  <span className="cw-engine-summary__phase-num">{idx + 1}</span>
                  {step.title}
                </span>
                {step.output_expected && (
                  <small className="cw-engine-summary__phase-output">{step.output_expected}</small>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {proposal.constraints.length > 0 && (
        <details className="cw-engine-summary__advanced">
          <summary>Vincoli concordati ({proposal.constraints.length})</summary>
          <ul>
            {proposal.constraints.map((constraint, idx) => (
              <li key={idx}>{constraint}</li>
            ))}
          </ul>
        </details>
      )}

      {proposal.missing_information.length > 0 && (
        <details className="cw-engine-summary__advanced" open>
          <summary>Requisiti per l'esecuzione ({proposal.missing_information.length})</summary>
          <ul>
            {proposal.missing_information.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="cw-engine-summary__proposal-actions">
        <button
          type="button"
          className="cw-primary"
          disabled={isBusy}
          onClick={() => void intake.confirm()}
        >
          {intakeConfirmLabel(proposal)}
        </button>
        <button
          type="button"
          className="cs-link"
          disabled={isBusy}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "Chiudi modifica" : "Modifica proposta"}
        </button>
      </div>

      {editing && (
        <form
          className="cw-intake-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (clarification.trim()) {
              void intake.refine(clarification).then((ok) => {
                if (ok) {
                  setEditing(false);
                  setClarification("");
                }
              });
            }
          }}
        >
          <label>
            Cosa vuoi cambiare o chiarire?
            <textarea
              rows={3}
              value={clarification}
              disabled={isBusy}
              placeholder="Es. aggiungi una fase per i test, oppure specifica una scadenza…"
              onChange={(e) => setClarification(e.target.value)}
            />
          </label>
          <button className="cw-secondary" disabled={isBusy || !clarification.trim()}>
            Aggiorna proposta
          </button>
        </form>
      )}

      {intake.busy && <p className="cw-engine-summary__hint" role="status">Sto aggiornando la proposta…</p>}
      <HomunErrorNotice error={intake.error} />
    </aside>
  );
}
