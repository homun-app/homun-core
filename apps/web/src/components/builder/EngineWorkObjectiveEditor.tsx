/** Readable objective with an explicit, confirmed versioned patch edit. */
import { useId, useState } from "react";
import { WorkPatchPreviewCard } from "./WorkPatchPreviewCard";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";

type Props = {
  currentObjective: string;
  busy?: boolean;
  onPreviewApply?: ((nextObjective: string) => Promise<void>) | undefined;
};

export function EngineWorkObjectiveEditor({
  currentObjective,
  busy = false,
  onPreviewApply,
}: Props) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentObjective);
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const trimmed = draft.trim();
  const changed = trimmed.length > 0 && trimmed !== currentObjective.trim();
  const locked = busy || saving;

  return (
    <section className="cw-engine-objective">
      <div className="cw-engine-summary__section-heading">
        <h3>Risultato atteso</h3>
        {!editing && onPreviewApply && (
          <button
            type="button"
            className="cs-link"
            disabled={busy}
            onClick={() => {
              setDraft(currentObjective);
              setPending(null);
              setError(null);
              setEditing(true);
            }}
          >
            Modifica
          </button>
        )}
      </div>
      {!editing ? (
        <div className="cw-engine-objective__reading">
          <p>{currentObjective || "Da definire nella conversazione."}</p>
          {currentObjective.length > 240 && (
            <details>
              <summary>Leggi obiettivo completo</summary>
              <p>{currentObjective}</p>
            </details>
          )}
        </div>
      ) : (
        <>
          <label className="sr-only" htmlFor={inputId}>
            Modifica risultato atteso
          </label>
          <textarea
            id={inputId}
            rows={5}
            value={draft}
            disabled={locked || pending !== null}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          {pending ? (
            <WorkPatchPreviewCard
              summaryLines={[`Obiettivo: «${currentObjective}» → «${pending}»`]}
              busy={locked}
              onConfirm={() => {
                if (!onPreviewApply) return;
                setSaving(true);
                setError(null);
                void onPreviewApply(pending)
                  .then(() => {
                    setPending(null);
                    setEditing(false);
                  })
                  .catch(setError)
                  .finally(() => setSaving(false));
              }}
              onCancel={() => setPending(null)}
            />
          ) : (
            <div className="cs-actions">
              <button
                type="button"
                className="cw-secondary"
                disabled={!changed || locked}
                onClick={() => setPending(trimmed)}
              >
                Proponi modifica
              </button>
              <button
                type="button"
                className="cs-link"
                disabled={locked}
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                Annulla
              </button>
            </div>
          )}
          <HomunErrorNotice error={error} />
        </>
      )}
    </section>
  );
}
