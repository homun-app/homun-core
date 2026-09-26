import { useState } from "react";
import type { WorkIntake } from "@/lib/engine-intake-client";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { Check, Sparkles, Bot, Globe, Layers, ArrowRight, CornerDownLeft } from "lucide-react";

export function EngineIntakeCoordinatorCard({
  proposal,
  intake,
  onInspectAgent,
}: {
  proposal: WorkIntake;
  intake: WorkIntakeState;
  onInspectAgent?: ((agentIdOrName: string) => void) | undefined;
}) {
  const [customClarify, setCustomClarify] = useState("");
  const steps = proposal.plan_steps ?? [];
  const reqs = proposal.missing_information ?? [];
  const isBusy = intake.busy;

  const hasCompetitorReq = reqs.some((r) => /competitor|concorren/i.test(r));
  const hasVaultReq = reqs.some((r) => /vault|material|dataset|report preesistent/i.test(r));

  return (
    <article className="cw-intake-coordinator-card" aria-label="Proposta di lavoro e coordinamento Homun">
      <div className="cw-intake-coordinator-card__head" id="cw-intake-head">
        <span className="cw-intake-coordinator-card__badge">PROPOSTA DI LAVORO</span>
        <h3 className="cw-intake-coordinator-card__title">{proposal.title}</h3>
        <p className="cw-intake-coordinator-card__objective">
          <strong>Risultato concordato:</strong> {proposal.output || proposal.objective}
        </p>
      </div>

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
                    {step.output_expected && <span> · Consegna: <em>{step.output_expected}</em></span>}
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

          <div className="cw-intake-coordinator-card__chips-container">
            <span className="cw-intake-coordinator-card__chips-label">
              Scegli come impostare la squadra o la ricerca:
            </span>
            <div className="cw-intake-coordinator-card__chips">
              {hasCompetitorReq && (
                <>
                  <button
                    type="button"
                    className="cw-coordinator-chip"
                    disabled={isBusy}
                    onClick={() =>
                      void intake.refine(
                        "Crea un agente specializzato 'Ricercatore di Mercato' con l'istruzione di scandagliare il web per identificare i 3 competitor chiave e assegnagli la fase di ricerca iniziale."
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
                      void intake.refine(
                        "Seleziona tu autonomamente i 3 principali competitor di riferimento nel settore dell'orchestrazione agenti e avvia l'analisi."
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
                    void intake.refine("Procedi partendo da zero senza file o dataset pregressi nel Vault.")
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
                    void intake.refine("Procedi autonomamente raccogliendo tutte le informazioni necessarie.")
                  }
                >
                  <Sparkles size={13} />
                  Risolvi autonomamente e aggiorna piano
                </button>
              )}
            </div>

            {/* Direct Inline Clarification Input */}
            <form
              className="cw-intake-coordinator-card__inline-clarify"
              onSubmit={(e) => {
                e.preventDefault();
                if (!customClarify.trim() || isBusy) return;
                void intake.refine(customClarify.trim());
                setCustomClarify("");
              }}
            >
              <input
                type="text"
                className="cw-intake-coordinator-card__inline-input"
                placeholder="Oppure scrivi qui i competitor o chiarimenti (es: CrewAI, AutoGen, LangGraph)…"
                value={customClarify}
                disabled={isBusy}
                onChange={(e) => setCustomClarify(e.target.value)}
              />
              <button
                type="submit"
                className="cw-intake-coordinator-card__inline-submit"
                disabled={isBusy || !customClarify.trim()}
              >
                <CornerDownLeft size={12} />
                Applica
              </button>
            </form>
          </div>
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
                title="Scegli un'opzione sopra o rispondi ai chiarimenti per avviare il lavoro."
              >
                <Sparkles size={14} />
                Scegli una modalità per avviare la staffetta
              </button>
              <span className="cw-intake-coordinator-card__note">
                Risolvi i nodi aperti per impostare correttamente gli esecutori e i dati di partenza.
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
      </div>

      {isBusy && <p className="cw-intake-note" role="status">Aggiornamento proposta in corso…</p>}
      <HomunErrorNotice error={intake.error} />
    </article>
  );
}
