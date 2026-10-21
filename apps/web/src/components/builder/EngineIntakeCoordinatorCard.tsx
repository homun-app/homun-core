/**
 * LA scheda della proposta di accordo (porta d'ingresso unica): la stessa in
 * trascrizione e nel pannello. Conferma usa l'endpoint di conferma; Modifica
 * passa dalla chat (il turno di ingresso produce la revisione); Annulla
 * chiude la scheda e lascia il record del motore com'è.
 */
import { useState } from "react";
import type { WorkIntake } from "@/lib/engine-intake-client";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { briefChangeLines, preservedFieldLabels } from "@/lib/engine-intake-display";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { Check, Sparkles, Bot, Globe, Layers, ArrowRight, CornerDownLeft } from "lucide-react";

export function EngineIntakeCoordinatorCard({
  proposal,
  intake,
  onInspectAgent,
  onSendMessage,
  onDismiss,
}: {
  proposal: WorkIntake;
  intake: WorkIntakeState;
  onInspectAgent?: ((agentIdOrName: string) => void) | undefined;
  /** La modifica passa dalla chat: la porta d'ingresso produce la revisione. */
  onSendMessage?: ((text: string) => void) | undefined;
  /** Annulla chiude la scheda in questo client; il record nel motore resta. */
  onDismiss?: (() => void) | undefined;
}) {
  const [customClarify, setCustomClarify] = useState("");
  const steps = proposal.plan_steps ?? [];
  const reqs = proposal.missing_information ?? [];
  const changes = proposal.changes ?? [];
  const isBusy = intake.busy;

  if (proposal.status === "confirmed") {
    return (
      <article
        className="cw-intake-coordinator-card is-confirmed"
        aria-label="Accordo di lavoro confermato"
      >
        <div className="cw-intake-coordinator-card__head">
          <span className="cw-intake-coordinator-card__badge">ACCORDO CONFERMATO</span>
          <h3 className="cw-intake-coordinator-card__title">{proposal.title}</h3>
          <p className="cw-intake-coordinator-card__objective">
            <strong>Risultato concordato:</strong> {proposal.output || proposal.objective}
          </p>
        </div>
        {(proposal.constraints?.length ?? 0) > 0 && (
          <p className="cw-intake-note">Vincoli: {proposal.constraints.join(" · ")}</p>
        )}
      </article>
    );
  }

  const hasCompetitorReq = reqs.some((r) => /competitor|concorren/i.test(r));
  const hasVaultReq = reqs.some((r) => /vault|material|dataset|report preesistent/i.test(r));
  const canSendModification = Boolean(onSendMessage) && !isBusy;

  function sendModification(text: string) {
    if (!onSendMessage || !text.trim() || isBusy) return;
    onSendMessage(text.trim());
    setCustomClarify("");
  }

  return (
    <article
      className="cw-intake-coordinator-card"
      aria-label="Proposta di lavoro e coordinamento Homun"
    >
      <div className="cw-intake-coordinator-card__head" id="cw-intake-head">
        <span className="cw-intake-coordinator-card__badge">PROPOSTA DI LAVORO</span>
        <h3 className="cw-intake-coordinator-card__title">{proposal.title}</h3>
        <p className="cw-intake-coordinator-card__objective">
          <strong>Risultato concordato:</strong> {proposal.output || proposal.objective}
        </p>
      </div>

      {changes.length > 0 && (
        <div className="cw-intake-changes" data-intake-changes>
          <strong>Cosa cambia rispetto all'accordo precedente</strong>
          <ul>
            {briefChangeLines(changes).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {preservedFieldLabels(changes).length > 0 && (
            <p className="cw-intake-note">
              Restano invariati: {preservedFieldLabels(changes).join(", ")}.
            </p>
          )}
        </div>
      )}

      {/* Staffetta Fasi Operative */}
      {steps.length > 0 && (
        <div className="cw-intake-coordinator-card__relay" id="cw-intake-relay">
          <span className="cw-intake-coordinator-card__section-title">
            <Layers size={13} />
            Staffetta operativa proposta ({steps.length} fasi)
          </span>
          <ol className="cw-intake-coordinator-card__steps">
            {steps.map((step, idx) => (
              <li key={idx} className="cw-intake-coordinator-card__step">
                <span className="cw-intake-coordinator-card__num">{idx + 1}</span>
                <div className="cw-intake-coordinator-card__step-content">
                  <strong>{step.title}</strong>
                  <div className="cw-intake-coordinator-card__step-meta">
                    <span>
                      Esecutore:{" "}
                      {onInspectAgent ? (
                        <button
                          type="button"
                          className="cw-agent-link"
                          title="Visualizza scheda collaboratore"
                          onClick={() => onInspectAgent(step.assignee || "Homun")}
                        >
                          <strong>{step.assignee || "Homun"}</strong>
                        </button>
                      ) : (
                        <strong>{step.assignee || "Homun"}</strong>
                      )}
                    </span>
                    {step.output_expected && (
                      <span>
                        {" "}
                        · Consegna: <em>{step.output_expected}</em>
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* La Potenza di Homun: Nodi aperti e creazione agenti */}
      {reqs.length > 0 && (
        <div className="cw-intake-coordinator-card__intelligence" id="cw-intake-needs">
          <div className="cw-intake-coordinator-card__intel-header">
            <Sparkles size={14} className="text-[#687a59]" />
            <strong>Nodi aperti rilevati da Homun prima di iniziare:</strong>
          </div>
          <ul className="cw-intake-coordinator-card__reqs-list">
            {reqs.map((req, idx) => (
              <li key={idx}>{req}</li>
            ))}
          </ul>

          {onSendMessage && (
            <div className="cw-intake-coordinator-card__chips-container">
              <span className="cw-intake-coordinator-card__chips-label">
                Scegli come impostare la squadra o la ricerca (la risposta va in chat, come ogni
                messaggio):
              </span>
              <div className="cw-intake-coordinator-card__chips">
                {hasCompetitorReq && (
                  <>
                    <button
                      type="button"
                      className="cw-coordinator-chip"
                      disabled={isBusy}
                      onClick={() =>
                        sendModification(
                          "Crea un agente specializzato 'Ricercatore di Mercato' con l'istruzione di scandagliare il web per identificare i 3 competitor chiave e assegnagli la fase di ricerca iniziale.",
                        )
                      }
                    >
                      <Bot size={13} />
                      Crea agente «Ricercatore di Mercato»
                    </button>
                    <button
                      type="button"
                      className="cw-coordinator-chip"
                      disabled={isBusy}
                      onClick={() =>
                        sendModification(
                          "Seleziona tu autonomamente i 3 principali competitor di riferimento nel settore dell'orchestrazione agenti e avvia l'analisi.",
                        )
                      }
                    >
                      <Globe size={13} />
                      Cerca autonomamente online i 3 leader
                    </button>
                  </>
                )}
                {hasVaultReq && (
                  <button
                    type="button"
                    className="cw-coordinator-chip"
                    disabled={isBusy}
                    onClick={() =>
                      sendModification(
                        "Procedi partendo da zero senza file o dataset pregressi nel Vault.",
                      )
                    }
                  >
                    <ArrowRight size={13} />
                    Procedi da zero senza dati nel Vault
                  </button>
                )}
                {!hasCompetitorReq && !hasVaultReq && (
                  <button
                    type="button"
                    className="cw-coordinator-chip"
                    disabled={isBusy}
                    onClick={() =>
                      sendModification(
                        "Procedi autonomamente raccogliendo tutte le informazioni necessarie.",
                      )
                    }
                  >
                    <Sparkles size={13} />
                    Risolvi autonomamente e aggiorna piano
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirmation & CTA */}
      <div className="cw-intake-coordinator-card__footer" id="cw-intake-footer">
        {reqs.length > 0 ? (
          <div className="cw-intake-coordinator-card__gated-box">
            <div className="cw-intake-coordinator-card__gated-cta">
              <button
                type="button"
                className="cw-intake-coordinator-card__btn is-gated"
                disabled
                title="Scegli un'opzione sopra o scrivi in chat per impostare il lavoro."
              >
                <Sparkles size={14} />
                Scegli una modalità per avviare la staffetta
              </button>
              <span className="cw-intake-coordinator-card__note">
                Risolvi i nodi aperti per impostare correttamente gli esecutori e i dati di
                partenza.
              </span>
            </div>
            <button
              type="button"
              className="cw-intake-coordinator-card__skip-link"
              disabled={isBusy}
              onClick={() => void intake.confirm()}
            >
              Procedi subito con impostazioni predefinite →
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="cw-primary cw-intake-coordinator-card__btn"
              disabled={isBusy}
              onClick={() => void intake.confirm()}
            >
              <Check size={14} />
              Conferma accordo e avvia staffetta operativa
            </button>
            <span className="cw-intake-coordinator-card__note">
              Tutte le fasi critiche richiedono il tuo esplicito via libera prima dell'esecuzione.
            </span>
          </>
        )}
        <div className="cs-actions cw-intake-coordinator-card__secondary">
          <form
            className="cw-intake-coordinator-card__inline-clarify"
            onSubmit={(e) => {
              e.preventDefault();
              sendModification(customClarify);
            }}
          >
            <input
              type="text"
              className="cw-intake-coordinator-card__inline-input"
              placeholder={
                canSendModification
                  ? "Modifica: scrivi qui cosa cambiare (va in chat, come ogni messaggio)…"
                  : "Per modificare l'accordo scrivi in chat cosa vuoi cambiare…"
              }
              value={customClarify}
              disabled={!canSendModification}
              onChange={(e) => setCustomClarify(e.target.value)}
            />
            <button
              type="submit"
              className="cw-intake-coordinator-card__inline-submit"
              disabled={!canSendModification || !customClarify.trim()}
              aria-label="Invia la modifica in chat"
            >
              <CornerDownLeft size={12} />
              Modifica
            </button>
          </form>
          {onDismiss && (
            <button
              type="button"
              className="cs-link"
              disabled={isBusy}
              onClick={onDismiss}
              aria-label="Annulla la proposta"
            >
              Annulla
            </button>
          )}
        </div>
      </div>

      {isBusy && (
        <p className="cw-intake-note" role="status">
          Aggiornamento proposta in corso…
        </p>
      )}
      <HomunErrorNotice error={intake.error} />
    </article>
  );
}
