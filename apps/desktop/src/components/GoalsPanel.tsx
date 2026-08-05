import { Sparkles, Target, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge, type ProjectGoalsData } from "../lib/coreBridge";

function normalizeGoalText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupeGoalDrafts(drafts: string[], existingGoals: Set<string>): string[] {
  const seen = new Set(existingGoals);
  const out: string[] = [];
  for (const draft of drafts) {
    const clean = draft.trim();
    const normalized = normalizeGoalText(clean);
    if (!clean || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(clean);
  }
  return out;
}

export function GoalsPanel({
  data,
  threadId,
  seed,
  onSeedConsumed,
  onRefresh,
}: {
  data: ProjectGoalsData;
  threadId: string;
  seed?: string | null;
  onSeedConsumed?: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [newGoal, setNewGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const existingGoalTexts = useMemo(
    () => new Set(data.goals.map((goal) => normalizeGoalText(goal.text))),
    [data.goals],
  );

  useEffect(() => {
    if (seed && seed.trim()) {
      setNewGoal(seed);
      onSeedConsumed?.();
    }
  }, [seed, onSeedConsumed]);

  useEffect(() => {
    setDrafts((current) => (current ? dedupeGoalDrafts(current, existingGoalTexts) : current));
  }, [existingGoalTexts]);

  const consumeDraft = (text: string) => {
    const normalized = normalizeGoalText(text);
    setDrafts((current) =>
      current ? current.filter((draft) => normalizeGoalText(draft) !== normalized) : current,
    );
  };

  const add = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const normalized = normalizeGoalText(clean);
    if (existingGoalTexts.has(normalized)) {
      setNewGoal("");
      consumeDraft(clean);
      return;
    }
    setBusy(true);
    void coreBridge.addGoal(data.workspace, clean)
      .then(() => {
        setNewGoal("");
        consumeDraft(clean);
        onRefresh();
      })
      .finally(() => setBusy(false));
  };

  const deleteGoal = (g: ProjectGoalsData["goals"][number]) => {
    setBusy(true);
    void coreBridge.decideMemory(g.reference, "delete")
      .then(() => {
        onRefresh();
      })
      .finally(() => setBusy(false));
  };

  const suggest = () => {
    setSuggesting(true);
    void coreBridge.suggestGoals(threadId)
      .then((objs) => setDrafts(dedupeGoalDrafts(objs, existingGoalTexts)))
      .finally(() => setSuggesting(false));
  };

  const promote = () => {
    if (sel.size === 0) return;
    setBusy(true);
    void coreBridge.promoteGoals(data.workspace, Array.from(sel))
      .then(() => {
        setSel(new Set());
        onRefresh();
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="goals-manager" aria-label={t("chat.projectGoal")}>
      <header className="goals-head">
        <span className="goals-head-title">
          <Target size={16} />
          <strong>{t("chat.projectGoal")}</strong>
        </span>
        {data.goals.length > 0 && (
          <small>
            {data.goals.length}{" "}
            {data.goals.length === 1 ? t("chat.goalsCount_one") : t("chat.goalsCount_other")}
          </small>
        )}
      </header>

      {data.goals.length > 0 ? (
        <div className="goals-steps">
          {data.goals.map((g) => (
            <div className="goals-step" key={g.reference}>
              <span className="timeline-state" aria-hidden="true">
                <Target size={12} />
              </span>
              <div>{g.text}</div>
              <button
                type="button"
                className="goals-delete"
                aria-label="Delete goal"
                title="Delete goal"
                disabled={busy}
                onClick={() => deleteGoal(g)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="goals-empty">{t("chat.noGoalsYet")}</p>
      )}

      <textarea
        className="goals-compose"
        placeholder={t("chat.goalPlaceholder")}
        rows={2}
        value={newGoal}
        onChange={(event) => setNewGoal(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) add(newGoal);
        }}
        disabled={busy}
      />
      <div className="goals-actions">
        <button
          className="goals-btn goals-btn-accent"
          onClick={() => add(newGoal)}
          disabled={busy || !newGoal.trim() || existingGoalTexts.has(normalizeGoalText(newGoal))}
        >
          {t("chat.addGoal")}
        </button>
        <button className="goals-btn" onClick={suggest} disabled={suggesting || busy}>
          <span className="goals-spark" aria-hidden="true">
            <Sparkles size={13} />
          </span>
          {suggesting ? t("chat.proposing") : t("chat.propose")}
        </button>
      </div>

      {drafts && (
        <div className="goals-section">
          {drafts.length === 0 ? (
            <p className="goals-empty">{t("chat.noProposals")}</p>
          ) : (
            <>
              <div className="goals-section-label">{t("chat.projectProposalsEditable")}</div>
              <div className="goals-steps">
                {drafts.map((draft, index) => (
                  <div key={index} className="goals-draft-card">
                    <textarea
                      className="goals-draft-text"
                      rows={2}
                      value={draft}
                      onChange={(event) => {
                        const next = [...drafts];
                        next[index] = event.target.value;
                        setDrafts(next);
                      }}
                      disabled={busy}
                    />
                    <div className="goals-draft-foot">
                      <button
                        className="goals-btn goals-btn-sm"
                        onClick={() => add(draft)}
                        disabled={
                          busy || !draft.trim() || existingGoalTexts.has(normalizeGoalText(draft))
                        }
                      >
                        Add
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {data.decisions.length > 0 && (
        <details className="goals-promote">
          <summary>
            {t("chat.elevateDecisionToGoal")} ({data.decisions.length})
          </summary>
          <div className="goals-promote-list">
            {data.decisions.slice(0, 50).map((decision) => (
              <label key={decision.reference} className="goals-promote-item">
                <input
                  type="checkbox"
                  checked={sel.has(decision.reference)}
                  onChange={(event) => {
                    const next = new Set(sel);
                    if (event.target.checked) next.add(decision.reference);
                    else next.delete(decision.reference);
                    setSel(next);
                  }}
                />
                <span>{decision.text.split("\n")[0].slice(0, 120)}</span>
              </label>
            ))}
          </div>
          <button
            className="goals-btn goals-btn-sm"
            onClick={promote}
            disabled={busy || sel.size === 0}
          >
            {t("chat.elevateToGoal")} {sel.size > 0 ? `(${sel.size})` : ""}
          </button>
        </details>
      )}
    </section>
  );
}
