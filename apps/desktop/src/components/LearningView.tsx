import {
  Check,
  Clock3,
  Eye,
  Pencil,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { AutomationProposal, LearningInsight } from "../types";

interface LearningViewProps {
  insights: LearningInsight[];
  proposals: AutomationProposal[];
}

export function LearningView({ insights, proposals }: LearningViewProps) {
  const confirmed = insights.filter((item) => item.status === "confirmed").length;
  const review = insights.filter((item) => item.status !== "confirmed").length;
  const ready = proposals.filter((item) => item.status === "ready").length;

  return (
    <section className="learning-view" aria-labelledby="learning-title">
      <header className="learning-header">
        <div>
          <p className="eyebrow">Auto-apprendimento locale</p>
          <h2 id="learning-title">Cosa ho imparato</h2>
          <p className="lead-copy">
            Abitudini, preferenze e automatismi restano leggibili e correggibili
            prima di diventare azioni autonome.
          </p>
        </div>
        <div className="learning-summary" aria-label="Sintesi apprendimento">
          <span>
            <strong>{confirmed}</strong>
            confermate
          </span>
          <span>
            <strong>{review}</strong>
            da rivedere
          </span>
          <span>
            <strong>{ready}</strong>
            automatismi pronti
          </span>
        </div>
      </header>

      <div className="learning-overview">
        <section aria-labelledby="habits-title">
          <div className="learning-section-title">
            <div>
              <h3 id="habits-title">Abitudini apprese</h3>
              <small>Ogni insight mostra perche' esiste e come controllarlo.</small>
            </div>
          </div>

          <div className="habit-list">
            {insights.map((insight) => (
              <article className="habit-card" key={insight.id}>
                <header>
                  <span className={`learning-status ${insight.status}`}>
                    {insight.status === "confirmed" ? <Check size={14} /> : <Clock3 size={14} />}
                    {statusLabel(insight.status)}
                  </span>
                  <span>{Math.round(insight.confidence * 100)}%</span>
                </header>
                <h4>{insight.title}</h4>
                <p>{insight.summary}</p>
                <div className="learning-meta">
                  <span>{insight.domain}</span>
                  <span>{insight.cadence}</span>
                </div>
                <ul className="evidence-list" aria-label={`Prove per ${insight.title}`}>
                  {insight.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="privacy-control" aria-label={`Controlli privacy per ${insight.title}`}>
                  <button type="button">
                    <Check size={14} />
                    Conferma
                  </button>
                  <button type="button">
                    <Pencil size={14} />
                    Correggi
                  </button>
                  <button type="button">
                    <X size={14} />
                    Ignora
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="automation-title">
          <div className="learning-section-title">
            <div>
              <h3 id="automation-title">Automatismi possibili</h3>
              <small>Proposte create da pattern ricorrenti, mai attivate al buio.</small>
            </div>
          </div>

          <div className="automation-list">
            {proposals.map((proposal) => (
              <article className="automation-proposal" key={proposal.id}>
                <header>
                  <span className={`risk-badge ${proposal.risk}`}>{riskLabel(proposal.risk)}</span>
                  <span>Autonomia {proposal.autonomyLevel}</span>
                </header>
                <h4>{proposal.title}</h4>
                <p>{proposal.summary}</p>
                <div className="automation-trigger">
                  <Sparkles size={15} />
                  <span>{proposal.trigger}</span>
                </div>
                <ul>
                  {proposal.actions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
                <div className="automation-actions">
                  <span className={`proposal-state ${proposal.status}`}>
                    {proposalStatusLabel(proposal.status)}
                  </span>
                  <button className="secondary-button" type="button">
                    <Eye size={14} />
                    Rivedi
                  </button>
                  <button className="primary-button" type="button">
                    <ShieldCheck size={14} />
                    Prepara
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function statusLabel(status: LearningInsight["status"]) {
  if (status === "confirmed") return "Confermata";
  if (status === "needs_review") return "Da rivedere";
  return "Candidata";
}

function riskLabel(risk: AutomationProposal["risk"]) {
  if (risk === "high") return "rischio alto";
  if (risk === "medium") return "rischio medio";
  return "rischio basso";
}

function proposalStatusLabel(status: AutomationProposal["status"]) {
  if (status === "ready") return "Pronto";
  if (status === "needs_connector") return "Serve connettore";
  return "Serve approvazione";
}
