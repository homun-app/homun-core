import { MessageResponse } from "../ai-elements/message";
import { Check } from "lucide-react";
import { useState } from "react";
import type { Work } from "./conversation-types";
import { usePriceComparison } from "@/hooks/usePriceComparison";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { EngineMaterialSelection } from "./EngineMaterialSelection";
import {
  COMPARISON_UPLOAD_EXTENSIONS,
  eligibleForComparison,
} from "@/lib/engine-material-selection";
import { reviewEngineWork } from "@/lib/engine-work-review";
import "./engine-price-comparison.css";

function download(text: string, extension: string) {
  const url = URL.createObjectURL(
    new Blob([text], {
      type: extension === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `confronto-listini.${extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function EnginePriceComparison({
  work,
  onChanged,
  initiallyOpen = false,
}: {
  initiallyOpen?: boolean;
  work: Work;
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<unknown>(null);
  const tool = usePriceComparison(work, onChanged);
  const p = tool.proposal;

  async function concludeWork() {
    if (!p?.artifact_id) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      await reviewEngineWork({
        workId: work.id,
        expectedVersion: work.revision,
        artifactVersionId: p.artifact_id,
        decision: "approve",
      });
      await onChanged();
    } catch (cause) {
      setReviewError(cause);
    } finally {
      setReviewBusy(false);
    }
  }
  return (
    <section className="cw-price-tool" aria-label="Confronto listini">
      <details open={p !== null || initiallyOpen || undefined}>
        <summary>Confronta due listini</summary>
        <p>
          Confronto locale per SKU. I file restano nel progetto; nessun invio a servizi esterni.
        </p>
        {(!p ||
          ["failed", "blocked"].includes(p.status) ||
          (p.status === "pending_approval" && Boolean(tool.error))) && (
          <>
            <EngineMaterialSelection
              work={work}
              filter={eligibleForComparison}
              uploadExtensions={COMPARISON_UPLOAD_EXTENSIONS}
              selected={selected}
              maxSelected={2}
              orderedRoles={["precedente", "aggiornato"]}
              disabled={tool.busy}
              emptyHint="Nessun listino CSV nel progetto. Aggiungi due file, oppure la cartella che li contiene."
              onSelectionChange={(next) => {
                tool.newFiles();
                setSelected(next);
              }}
            />
            <p className="cw-hint">
              {selected.length === 2
                ? "Pronto: il primo selezionato è il listino precedente, il secondo quello aggiornato."
                : "Seleziona due CSV: il primo è il listino precedente, il secondo quello aggiornato."}
            </p>
            <p>
              CSV con colonne sku, name, price, currency. Massimo 2 MB per file e 10.000 righe
              complessive.
            </p>
            <button
              type="button"
              className="cw-secondary"
              disabled={tool.busy || selected.length !== 2}
              onClick={() =>
                void tool.prepareFromMaterials(selected[0] ?? "", selected[1] ?? "")
              }
            >
              Prepara il confronto
            </button>
          </>
        )}
        {p && (
          <>
            <p>
              <strong>{p.left.title}</strong> → <strong>{p.right.title}</strong>
            </p>
            {p.status === "pending_approval" && (
              <>
                <p>
                  Confronterò prezzi, prodotti nuovi e rimossi. Duplicati, dati mancanti e valute
                  diverse saranno segnalati, senza abbinamenti arbitrari.
                </p>
                <p>
                  Limiti: {p.limits.max_rows.toLocaleString("it-IT")} righe ·{" "}
                  {p.limits.max_attempts} tentativi. Nessuna chiamata a pagamento per il confronto.
                </p>
                <button
                  className="cw-primary"
                  disabled={tool.busy}
                  onClick={() => void tool.approve()}
                >
                  Approva ed esegui confronto
                </button>
              </>
            )}
            {["queued", "running"].includes(p.status) && (
              <p role="status">
                Confronto approvato, elaborazione in corso. Puoi riaprire questa conversazione dopo
                il riavvio.
              </p>
            )}
            {["failed", "blocked"].includes(p.status) && (
              <p role="alert">
                Confronto non completato: {p.error_code ?? p.status}. Nessun report è stato
                dichiarato pronto.
              </p>
            )}
            {p.status === "completed" && (
              <>
                <p role="status">
                  <strong>Report pronto per la tua verifica.</strong>
                </p>
                <div className="cs-actions">
                  <button
                    className="cw-secondary"
                    onClick={() => download(p.report_markdown ?? "", "md")}
                  >
                    Scarica report
                  </button>
                  <button
                    className="cw-secondary"
                    onClick={() => download(p.report_csv ?? "", "csv")}
                  >
                    Scarica confronto CSV
                  </button>
                </div>
                <details>
                  <summary>Leggi il report completo</summary>
                  <div className="cw-price-report">
                    <MessageResponse>{p.report_markdown ?? ""}</MessageResponse>
                  </div>
                </details>
                {p.artifact_id && work.engineStatus === "review" ? (
                  <>
                    <button
                      className="cw-primary"
                      disabled={reviewBusy}
                      onClick={() => void concludeWork()}
                    >
                      Approva il risultato e concludi il lavoro
                    </button>
                    <p className="cw-hint">
                      Approvando chiudi la revisione: il report resta disponibile e il lavoro
                      risulta completato. Per chiedere modifiche, scrivi in chat cosa correggere.
                    </p>
                  </>
                ) : (
                  work.engineStatus === "completed" && (
                    <p role="status">
                      <Check size={15} /> Risultato approvato: lavoro completato.
                    </p>
                  )
                )}
              </>
            )}
          </>
        )}
        {tool.busy && <p role="status">Preparazione in corso…</p>}
        <HomunErrorNotice error={tool.error ?? reviewError} />
      </details>
    </section>
  );
}
