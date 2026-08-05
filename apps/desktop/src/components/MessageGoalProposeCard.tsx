import { Check, Target } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";

/** Saves model-proposed project goals from an inline assistant message card. */
export function GoalProposeCard({
  objectives,
  threadId,
}: {
  objectives: string[];
  threadId: string;
}) {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void coreBridge.projectGoals(threadId).then((d) => {
      if (!cancelled) setWorkspace(d?.workspace ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  const save = (i: number, text: string) => {
    if (!workspace || saved.has(i)) return;
    setBusy(i);
    void coreBridge
      .addGoal(workspace, text)
      .then((ok) => {
        if (ok) setSaved((prev) => new Set(prev).add(i));
      })
      .finally(() => setBusy(null));
  };
  return (
    <div className="goal-propose-card">
      <div className="goal-propose-head">
        <Target size={14} />
        <span>{t("chat.proposedGoalsHint")}</span>
      </div>
      <div className="goal-propose-list">
        {objectives.map((o, i) => (
          <div key={i} className="goal-propose-item">
            <span>{o}</span>
            <button
              className="goals-btn goals-btn-sm"
              disabled={busy !== null || saved.has(i) || !workspace}
              onClick={() => save(i, o)}
            >
              {saved.has(i) ? (
                <>
                  <Check size={13} /> Saveto
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
