import { useState } from "react";
import type { Work } from "./conversation-types";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { reviewEngineWork, type WorkReviewDecision } from "@/lib/engine-work-review";

/** One human review action for every engine result; execution approval stays separate. */
export function EngineResultReview({ work, artifactId, onChanged }: {
  work: Work;
  artifactId?: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [recorded, setRecorded] = useState<WorkReviewDecision | null>(null);
  async function review(decision: WorkReviewDecision) {
    if (!artifactId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await reviewEngineWork({ workId: work.id, expectedVersion: work.revision,
        artifactVersionId: artifactId, decision, comment });
      setRecorded(decision);
      await onChanged();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  if (!artifactId) return null;
  if (work.engineStatus === "completed" || recorded === "approve")
    return <p role="status">Risultato approvato: lavoro completato.</p>;
  if (work.engineStatus === "ready" || recorded === "request_changes")
    return <><p role="status">Correzioni richieste. Seleziona i materiali aggiornati e prepara una nuova proposta da approvare.</p><HomunErrorNotice error={error} /></>;
  if (work.engineStatus !== "review") return null;
  return <div className="cw-result-review" aria-label="Revisione del risultato">
    <p className="cw-hint">Verifica tutti gli output prima di concludere. Le correzioni riaprono il lavoro; la nuova esecuzione richiede una nuova proposta e approvazione.</p>
    <label>Correzioni richieste
      <textarea className="cw-input" value={comment} disabled={busy} onChange={(event) => setComment(event.target.value)} placeholder="Descrivi cosa correggere nei materiali o nel risultato" />
    </label>
    <div className="cs-actions">
      <button className="cw-primary" disabled={busy || recorded !== null} onClick={() => void review("approve")}>Approva il risultato e concludi il lavoro</button>
      <button className="cw-secondary" disabled={busy || recorded !== null || !comment.trim()} onClick={() => void review("request_changes")}>Richiedi correzioni</button>
    </div>
    <HomunErrorNotice error={error} />
  </div>;
}
