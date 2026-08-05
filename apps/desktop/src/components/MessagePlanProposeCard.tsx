import { CalendarClock, Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** A plan the model proposes before executing: the card gates execution behind accept/edit. */
export interface PlanProposal {
  summary: string;
  steps: string[];
}

export function PlanProposeCard({
  plan,
  onAnswer,
}: {
  plan: PlanProposal;
  onAnswer: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"idle" | "editing" | "sent">("idle");
  const [feedback, setFeedback] = useState("");
  const [decision, setDecision] = useState("");
  if (phase === "sent") {
    return (
      <div className="plan-card done">
        <Check size={14} />
        <span>{decision}</span>
      </div>
    );
  }
  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <CalendarClock size={15} />
        <strong>{t("chat.proposedPlan")}</strong>
        <span className="plan-card-gate">{t("chat.awaitingConfirmation")}</span>
      </div>
      {plan.summary && <p className="plan-card-summary">{plan.summary}</p>}
      <ol className="plan-card-steps">
        {plan.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {phase === "editing" ? (
        <div className="plan-card-edit">
          <textarea
            autoFocus
            placeholder={t("chat.whatToChangeInPlan")}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="plan-card-actions">
            <button type="button" className="plan-btn ghost" onClick={() => setPhase("idle")}>
              Cancel
            </button>
            <button
              type="button"
              className="plan-btn primary"
              disabled={!feedback.trim()}
              onClick={() => {
                setDecision(t("chat.changesRequested"));
                setPhase("sent");
                onAnswer(`Review the plan before proceeding: ${feedback.trim()}`);
              }}
            >
              {t("chat.sendChanges")}
            </button>
          </div>
        </div>
      ) : (
        <div className="plan-card-actions">
          <button
            type="button"
            className="plan-btn primary"
            onClick={() => {
              setDecision(t("chat.planAccepted"));
              setPhase("sent");
              onAnswer("I approve the plan: proceed with execution.");
            }}
          >
            Accetta ed esegui
          </button>
          <button type="button" className="plan-btn ghost" onClick={() => setPhase("editing")}>
            Edit / Ridiscuti
          </button>
        </div>
      )}
    </div>
  );
}
