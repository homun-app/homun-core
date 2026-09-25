import type { WorkIntake } from "@/lib/engine-intake-client";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { Check, Sparkles, Bot, Globe, Layers, ArrowRight } from "lucide-react";

export function EngineIntakeCoordinatorCard({
  proposal,
  intake,
}: {
  proposal: WorkIntake;
  intake: WorkIntakeState;
}) {
  const steps = proposal.plan_steps ?? [];
  const reqs = proposal.missing_information ?? [];
  const isBusy = intake.busy;

  const hasCompetitorReq = reqs.some((r) => /competitor|concorren/i.test(r));
  const hasVaultReq = reqs.some((r) => /vault|material|dataset|report preesistent/i.test(r));

  return (
    <article className="cw-intake-coordinator-card" aria-label="Proposta di lavoro e coordinamento Homun">
      <div className="cw-intake-coordinator-card__head">
        <span className="cw-intake-coordinator-card__badge">PROPOSTA DI LAVORO</span>
        <h3 className="cw-intake-coordinator-card__title">{proposal.title}</h3>
        <p className="cw-intake-coordinator-card__objective">
          <strong>Risultato concordato:</strong> {proposal.output || proposal.objective}
        </p>
      </div>

      {/* Staffetta Fasi Operative */}
      {steps.length > 0 && (
        <div className="cw-intake-coordinator-card__relay">
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
                    <span>Esecutore: <strong>{step.assignee || "Homun"}</strong></span>
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
        <div className="cw-intake-coordinator-card__intelligence">
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
              Scegli come impostare la squadra e la ricerca:
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
          </div>
        </div>
      )}

      {/* Confirmation & CTA */}
      <div className="cw-intake-coordinator-card__footer">
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
      </div>

      {isBusy && <p className="cw-intake-note" role="status">Aggiornamento proposta in corso…</p>}
      <HomunErrorNotice error={intake.error} />
    </article>
  );
}
