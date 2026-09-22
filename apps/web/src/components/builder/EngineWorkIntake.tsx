/** One conversation path: agree the brief, then expose its available capability. */
import { useState } from "react";
import type { Work } from "./conversation-types";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { EngineMaterialRead } from "./EngineMaterialRead";
import { EnginePriceComparison } from "./EnginePriceComparison";
import { EngineWorkNeedsCard } from "./EngineWorkNeedsCard";
import {
  briefChangeLines,
  intakeConfirmLabel,
  isAgreementRevisable,
  PLACEHOLDER_WORK_TITLE,
  preservedFieldLabels,
} from "@/lib/engine-intake-display";
import "./engine-work-intake.css";
export function EngineWorkIntake({
  work,
  intake,
  onChanged,
}: {
  work: Work;
  intake: WorkIntakeState;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [clarification, setClarification] = useState("");
  const p = intake.proposal;
  if (!intake.loaded)
    return (
      <p className="cw-hint" role="status">
        Recupero della proposta…
      </p>
    );
  if (intake.error && !p) return <HomunErrorNotice error={intake.error} />;
  // Legacy work keeps its existing tool and results; it is never silently reassigned.
  if (!p)
    return work.title === PLACEHOLDER_WORK_TITLE ? (
      <section className="cw-intake-card">
        {work.messages.length > 0 ? (
          <p>
            Qui stiamo scambiando domande e risposte: nessun lavoro è stato avviato e nessun
            collaboratore è stato assegnato. Quando vuoi un risultato concreto, descrivilo in chat
            e ti proporrò un accordo da confermare.
          </p>
        ) : (
          <p>La richiesta non è stata elaborata. Scrivila nuovamente nella chat per riprovare.</p>
        )}
      </section>
    ) : (
      <EnginePriceComparison work={work} onChanged={onChanged} />
    );
  const confirmed = p.status === "confirmed";
  const failed = p.status === "failed";
  const agent = p.suggested_agent ?? p.new_agent;
  // Mirrors the engine rule: an agreement can only be revised on an idle draft
  // (no plan revision, no artifact version). Never offer a backend-refused action.
  const revisable = isAgreementRevisable(work);
  const objectiveDrift =
    confirmed && p.objective.trim() !== (work.engineObjective ?? "").trim();
  const titleDrift = confirmed && p.title !== work.title;
  return (
    <>
      <section className="cw-intake-card" aria-label="Proposta di lavoro">
        <div className="cw-intake-eyebrow">
          {confirmed ? "ACCORDO DI LAVORO" : failed ? "DA RIPRENDERE" : "PRIMA DI COMINCIARE"}
        </div>
        {failed ? (
          <>
            <h3>
              {p.error_code === "intake_interrupted"
                ? "La proposta è da completare"
                : p.error_code === "budget_exhausted"
                  ? "Il budget del lavoro è esaurito"
                  : "Riprendiamo la tua richiesta"}
            </h3>
            {p.error_code === "budget_exhausted" ? (
              <p>
                Questo lavoro ha esaurito il budget di chiamate al modello concordato col motore.
                Nulla è stato eseguito. Il budget si alza solo con un comando esplicito
                (work.set_budget), mai automaticamente.
              </p>
            ) : (
              <p>
                La richiesta è conservata e il lavoro non è stato affidato. Se la preparazione si è
                interrotta, puoi riprovare; se il modello non risponde, controlla le impostazioni dei
                modelli.
              </p>
            )}
            <button
              className="cw-secondary"
              disabled={intake.busy}
              onClick={() =>
                void intake.refine("Riprova la proposta con le informazioni già fornite.")
              }
            >
              Riprova la proposta
            </button>
          </>
        ) : (
          <>
            <h3>{p.title}</h3>
            <p className="cw-intake-objective">{p.objective}</p>
            {!confirmed && (p.changes?.length ?? 0) > 0 && (
              <div className="cw-intake-changes">
                <strong>Cosa cambia rispetto alla proposta precedente</strong>
                <ul>
                  {briefChangeLines(p.changes).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {preservedFieldLabels(p.changes).length > 0 && (
                  <p className="cw-intake-note">
                    Restano invariati: {preservedFieldLabels(p.changes).join(", ")}.
                  </p>
                )}
              </div>
            )}
            <dl className="cw-intake-facts">
              <div><dt>Attività prevista</dt><dd>{p.capability === 'compare_csv' ? 'Confronto prezzi fra due CSV' : p.capability === 'read_material' ? 'Lettura autorizzata di un materiale' : 'Preparazione del lavoro, senza esecuzione automatica'}</dd></div>
              <div>
                <dt>Risultato atteso</dt>
                <dd>{p.output}</dd>
              </div>
              <div>
                <dt>{confirmed ? "Responsabile" : "Ti propongo"}</dt>
                <dd>
                  <strong>{agent?.name ?? "Nessun collaboratore selezionato"}</strong>
                  {agent && <span>{agent.role}</span>}
                </dd>
              </div>
            </dl>
            {(p.plan_steps?.length ?? 0) > 0 && (
              <div className="cw-intake-phases">
                <strong>Fasi del lavoro</strong>
                <ol>
                  {p.plan_steps!.map((step, index) => (
                    <li key={step.title + index}>
                      <span>
                        {step.title}
                        {step.output_expected && <small> · {step.output_expected}</small>}
                      </span>
                      <small>
                        {step.capability === "compare_csv"
                          ? "Confronto CSV"
                          : step.capability === "read_material"
                            ? "Lettura materiale"
                            : "Passaggio umano"}{" "}
                        · {step.assignee || agent?.name || "Homun"}
                        {(step.expected_materials?.length ?? 0) > 0 && (
                          <> · attende: {step.expected_materials.join(", ")}</>
                        )}
                      </small>
                    </li>
                  ))}
                </ol>
                <p className="cw-intake-note">
                  {confirmed
                    ? "Le fasi sono l'accordo accettato: ogni avvio te lo chiederò esplicitamente."
                    : "Confermando l'accordo confermi anche le fasi: ogni avvio te lo chiederò comunque esplicitamente."}
                </p>
              </div>
            )}
            <p>{p.rationale}</p>
            {!confirmed && p.new_agent && (
              <p className="cw-intake-note">
                È un nuovo collaboratore da creare. La conferma crea il profilo e gli affida questo
                lavoro; non aggiunge strumenti o permessi.
              </p>
            )}
            {!confirmed && p.new_agent && (
              <details>
                <summary>Istruzioni del nuovo collaboratore</summary>
                <p>{p.new_agent.instructions}</p>
              </details>
            )}
            {p.constraints.length > 0 && (
              <details>
                <summary>Vincoli concordati</summary>
                <ul>
                  {p.constraints.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </details>
            )}
            {!confirmed && p.missing_information.length > 0 && (
              <div>
                <strong>Prima dell’esecuzione serviranno</strong>
                <ul>
                  {p.missing_information.map((question, index) => (
                    <li key={index}>{question}</li>
                  ))}
                </ul>
              </div>
            )}
            {!confirmed && (
              <div className="cw-intake-actions">
                <button
                  className="cw-primary"
                  disabled={intake.busy}
                  onClick={() => void intake.confirm()}
                >
                  {intakeConfirmLabel(p)}
                </button>
                <button
                  className="cs-link"
                  disabled={intake.busy}
                  onClick={() => setEditing(!editing)}
                >
                  Modifica la proposta
                </button>
              </div>
            )}
            {confirmed && objectiveDrift && (
              <p className="cw-intake-note">
                L’obiettivo è stato modificato dopo la conferma di questo accordo: il riepilogo a
                destra mostra la versione aggiornata, questa scheda conserva l’accordo confermato.
              </p>
            )}
            {confirmed && titleDrift && !objectiveDrift && (
              <p className="cw-intake-note">
                Il titolo è stato rinominato dopo la conferma di questo accordo.
              </p>
            )}
            {confirmed && work.engineStatus === "draft" && (
              p.capability === "general" ? (
                <EngineWorkNeedsCard work={work} items={p.missing_information} onChanged={onChanged} />
              ) : (
                <p className="cw-intake-note">
                  {p.capability === "compare_csv"
                    ? "Il lavoro è concordato. Aggiungi i due listini qui sotto; ti mostrerò l’azione da approvare prima di eseguirla."
                    : "Il lavoro è concordato. Carica qui sotto il materiale da leggere; ti mostrerò l’azione da approvare prima di eseguirla."}
                </p>
              )
            )}
            {confirmed && revisable && <button className="cs-link" disabled={intake.busy} onClick={() => setEditing(!editing)}>Rivedi l’accordo</button>}
            {confirmed && !revisable && work.engineStatus === 'draft' && (
              <p className="cw-intake-note">
                L’accordo non si può rivedere qui perché il lavoro ha già un piano o dei risultati:
                usa la chat o il pannello per modifiche puntuali.
              </p>
            )}
          </>
        )}
        {editing && (!confirmed || revisable) && (
          <form
            className="cw-intake-edit"
            onSubmit={(event) => {
              event.preventDefault();
              if (clarification.trim())
                void intake.refine(clarification).then((ok) => {
                  if (ok) {
                    setEditing(false);
                    setClarification("");
                  }
                });
            }}
          >
            <label>
              Cosa vuoi cambiare o chiarire?
              <textarea
                rows={3}
                value={clarification}
                disabled={intake.busy}
                onChange={(event) => setClarification(event.target.value)}
              />
            </label>
            <button className="cw-secondary" disabled={intake.busy || !clarification.trim()}>
              Aggiorna proposta
            </button>
          </form>
        )}
        {intake.busy && <p role="status">Sto aggiornando la proposta…</p>}
        <HomunErrorNotice error={intake.error} />
      </section>
      {confirmed && p.capability === "compare_csv" && (
        <EnginePriceComparison initiallyOpen work={work} onChanged={onChanged} />
      )}
      {confirmed && p.capability === "read_material" && (
        <EngineMaterialRead initiallyOpen work={work} onChanged={onChanged} />
      )}
    </>
  );
}
