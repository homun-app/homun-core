import {
  Check,
  Clock3,
  Eye,
  Pencil,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AutomationProposal, LearningInsight } from "../types";

interface LearningViewProps {
  insights: LearningInsight[];
  proposals: AutomationProposal[];
}

export function LearningView({ insights, proposals }: LearningViewProps) {
  const { t } = useTranslation();
  const confirmed = insights.filter((item) => item.status === "confirmed").length;
  const review = insights.filter((item) => item.status !== "confirmed").length;
  const ready = proposals.filter((item) => item.status === "ready").length;

  const statusLabel = (status: LearningInsight["status"]) => {
    if (status === "confirmed") return t("learningView.status.confirmed");
    if (status === "needs_review") return t("learningView.status.needsReview");
    return t("learningView.status.candidate");
  };
  const riskLabel = (risk: AutomationProposal["risk"]) => {
    if (risk === "high") return t("learningView.risk.high");
    if (risk === "medium") return t("learningView.risk.medium");
    return t("learningView.risk.low");
  };
  const proposalStatusLabel = (status: AutomationProposal["status"]) => {
    if (status === "ready") return t("learningView.proposalStatus.ready");
    if (status === "needs_connector") return t("learningView.proposalStatus.needsConnector");
    return t("learningView.proposalStatus.needsApproval");
  };

  return (
    <section className="learning-view" aria-labelledby="learning-title">
      <header className="learning-header">
        <div>
          <p className="eyebrow">{t("learningView.eyebrow")}</p>
          <h2 id="learning-title">{t("learningView.title")}</h2>
          <p className="lead-copy">
            {t("learningView.lead")}
          </p>
        </div>
        <div className="learning-summary" aria-label={t("learningView.summaryAria")}>
          <span>
            <strong>{confirmed}</strong>
            {t("learningView.confirmed")}
          </span>
          <span>
            <strong>{review}</strong>
            {t("learningView.toReview")}
          </span>
          <span>
            <strong>{ready}</strong>
            {t("learningView.automationsReady")}
          </span>
        </div>
      </header>

      <div className="learning-overview">
        <section aria-labelledby="habits-title">
          <div className="learning-section-title">
            <div>
              <h3 id="habits-title">{t("learningView.learnedHabits")}</h3>
              <small>{t("learningView.habitsHint")}</small>
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
                <ul className="evidence-list" aria-label={t("learningView.evidenceAria", { title: insight.title })}>
                  {insight.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="privacy-control" aria-label={t("learningView.privacyAria", { title: insight.title })}>
                  <button type="button">
                    <Check size={14} />
                    {t("common.confirm")}
                  </button>
                  <button type="button">
                    <Pencil size={14} />
                    {t("common.edit")}
                  </button>
                  <button type="button">
                    <X size={14} />
                    {t("learningView.ignore")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="automation-title">
          <div className="learning-section-title">
            <div>
              <h3 id="automation-title">{t("learningView.possibleAutomations")}</h3>
              <small>{t("learningView.automationsHint")}</small>
            </div>
          </div>

          <div className="automation-list">
            {proposals.map((proposal) => (
              <article className="automation-proposal" key={proposal.id}>
                <header>
                  <span className={`risk-badge ${proposal.risk}`}>{riskLabel(proposal.risk)}</span>
                  <span>{t("learningView.autonomy")} {proposal.autonomyLevel}</span>
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
                    {t("learningView.review")}
                  </button>
                  <button className="primary-button" type="button">
                    <ShieldCheck size={14} />
                    {t("learningView.prepare")}
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
