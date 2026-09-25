/** Multi-turn persistent goals & verification contracts dashboard (H25). */
import { useEffect, useState } from "react";
import { Target, CheckCircle2, Clock, XCircle, ShieldCheck, RefreshCw, Trash2 } from "lucide-react";
import { listEngineGoals, deleteEngineGoal, type GoalState } from "@/lib/engine-goals-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { t, formatString } from "@/lib/i18n";
import "./engine-goal-dashboard.css";

export function EngineGoalDashboard() {
  const [goals, setGoals] = useState<GoalState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const items = await listEngineGoals();
      setGoals(items);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleDelete = async (sessionId: string) => {
    try {
      await deleteEngineGoal(sessionId);
      await load();
    } catch (cause) {
      setError(cause);
    }
  };

  return (
    <div className="cw-goal-dashboard" aria-label={t("goals.title")}>
      <div className="cw-goal-dashboard__header">
        <div>
          <h3>{t("goals.title")}</h3>
          <p className="cw-hint">{t("goals.subtitle")}</p>
        </div>
        <button
          type="button"
          className="cw-secondary"
          disabled={loading}
          onClick={() => void load()}
          title={t("common.refresh")}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          <span>{t("common.refresh")}</span>
        </button>
      </div>

      <HomunErrorNotice error={error} />

      {goals.length === 0 && !loading && (
        <div className="cw-goal-empty">
          <p>{t("goals.no_goals")}</p>
        </div>
      )}

      <div className="cw-goal-cards">
        {goals.map((g) => (
          <article key={g.session_id} className="cw-goal-card">
            <div className="cw-goal-card__top">
              <div>
                <h4 className="cw-goal-card__title">
                  <Target size={16} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />
                  {g.goal}
                </h4>
                <div className="cw-goal-card__session">ID: {g.session_id}</div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`cw-goal-badge cw-goal-badge--${g.status}`}>
                  {g.status === "active" && <Clock size={12} />}
                  {g.status === "completed" && <CheckCircle2 size={12} />}
                  {g.status === "cleared" && <XCircle size={12} />}
                  {g.status}
                </span>
                <button
                  type="button"
                  className="cw-secondary"
                  style={{ padding: "4px 8px" }}
                  onClick={() => void handleDelete(g.session_id)}
                  title={t("common.cancel")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            <div style={{ fontSize: "0.85rem", color: "#4a5568", marginTop: 4 }}>
              {formatString(t("goals.turns"), {
                used: g.turns_used,
                max: g.max_turns ?? "∞",
              })}
            </div>

            {g.contract && (
              <div className="cw-goal-contract">
                <div style={{ fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
                  <ShieldCheck size={14} />
                  <span>{t("goals.contract")}</span>
                </div>
                {g.contract.outcome && (
                  <div className="cw-goal-contract__row">
                    <strong>{t("goals.outcome")}:</strong> {g.contract.outcome}
                  </div>
                )}
                {g.contract.verification && (
                  <div className="cw-goal-contract__row">
                    <strong>{t("goals.verification")}:</strong> {g.contract.verification}
                  </div>
                )}
                {g.contract.constraints && (
                  <div className="cw-goal-contract__row">
                    <strong>{t("goals.constraints")}:</strong> {g.contract.constraints}
                  </div>
                )}
                {g.contract.stop_when && (
                  <div className="cw-goal-contract__row">
                    <strong>{t("goals.stop_when")}:</strong> {g.contract.stop_when}
                  </div>
                )}
              </div>
            )}

            {g.gates && g.gates.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <strong style={{ fontSize: "0.8rem", color: "#4a5568" }}>{t("goals.gates")}:</strong>
                <ul className="cw-goal-gates">
                  {g.gates.map((gate) => (
                    <li key={gate.gate_id}>
                      <code>{gate.command}</code> {gate.passed ? "✓ superato" : "in attesa"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
