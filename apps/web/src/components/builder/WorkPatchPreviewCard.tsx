/**
 * Confirm/cancel card for a versioned work patch preview (F3.4).
 */

type Props = {
  summaryLines: string[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function WorkPatchPreviewCard({ summaryLines, busy = false, onConfirm, onCancel }: Props) {
  return (
    <div className="cw-patch-preview" role="group" aria-label="Anteprima modifica lavoro">
      <strong>Modifica proposta</strong>
      <ul>
        {summaryLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="cs-actions">
        <button type="button" className="cw-primary" disabled={busy} onClick={onConfirm}>
          Conferma
        </button>
        <button type="button" className="cw-secondary" disabled={busy} onClick={onCancel}>
          Annulla
        </button>
      </div>
    </div>
  );
}
