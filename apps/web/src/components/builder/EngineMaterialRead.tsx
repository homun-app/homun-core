/** Unified material reading: one card for single and multi-read, pick or upload. */
import { useState } from "react";
import type { Work } from "./conversation-types";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { HomunGuidanceNotice } from "@/components/HomunGuidanceNotice";
import { useMaterialRead } from "@/hooks/useMaterialRead";
import { useToolChain } from "@/hooks/useToolChain";
import {
  eligibleForRead,
  READ_UPLOAD_EXTENSIONS,
} from "@/lib/engine-material-selection";
import { EngineMaterialSelection } from "./EngineMaterialSelection";
import "./engine-material-read.css";

export function EngineMaterialRead({
  work,
  onChanged,
  initiallyOpen = false,
}: {
  initiallyOpen?: boolean;
  work: Work;
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const single = useMaterialRead(work, onChanged);
  const chain = useToolChain(work, onChanged);
  const p = single.proposal;
  const c = chain.chain;

  const idle =
    (!p || ["failed", "blocked"].includes(p.status)) &&
    (!c || ["failed", "blocked"].includes(c.status));
  const multi = selected.length > 1;

  return (
    <section className="cw-price-tool" aria-label="Lettura materiali">
      <details open={!idle || initiallyOpen || undefined}>
        <summary>
          {c && c.steps.length > 1
            ? `Letture multiple (${c.steps.length})`
            : "Leggi i materiali"}
        </summary>
        <p>
          Lettura locale con estratto limitato e provenienza. Seleziona uno o più documenti già nel
          progetto, oppure aggiungine di nuovi. Nessuna interpretazione automatica, nessun invio a
          servizi esterni.
        </p>

        {idle && (
          <>
            <EngineMaterialSelection
              work={work}
              filter={eligibleForRead}
              uploadExtensions={READ_UPLOAD_EXTENSIONS}
              selected={selected}
              maxSelected={8}
              disabled={single.busy || chain.busy}
              emptyHint="Nessun documento idoneo nel progetto: aggiungi file oppure una cartella."
              onSelectionChange={(next) => {
                single.newFiles();
                chain.newChain();
                setSelected(next);
              }}
            />
            <p className="cw-hint">
              {selected.length === 0
                ? "Seleziona un documento per la lettura singola, o due o più per leggerli tutti con una sola approvazione."
                : multi
                  ? `${selected.length} documenti selezionati: un'unica approvazione copre tutte le letture.`
                  : "1 documento selezionato."}
            </p>
            <p className="cw-hint">Testo, CSV o PDF fino a 2 MB. Estratto limitato ai primi 8.000 caratteri.</p>
            {multi ? (
              <button
                type="button"
                className="cw-secondary"
                disabled={chain.busy || selected.length < 2}
                onClick={() => void chain.propose(selected)}
              >
                Prepara le {selected.length} letture
              </button>
            ) : (
              <button
                type="button"
                className="cw-secondary"
                disabled={single.busy || selected.length !== 1}
                onClick={() => void single.prepareFromMaterial(selected[0] ?? "")}
              >
                Prepara la lettura
              </button>
            )}
          </>
        )}

        {/* Single-read proposal and states */}
        {p && !multi && (
          <>
            {p.status === "pending_approval" && (
              <>
                <p>
                  <strong>{p.material.title}</strong> · v{p.material.version}
                </p>
                <p>
                  Produrrò un artifact di lettura con estratto limitato e provenienza. Il materiale
                  non viene modificato.
                </p>
                <button
                  className="cw-primary"
                  disabled={single.busy}
                  onClick={() => void single.approve()}
                >
                  Approva ed esegui lettura
                </button>
              </>
            )}
            {["queued", "running"].includes(p.status) && (
              <p role="status">Lettura approvata, elaborazione in corso.</p>
            )}
            {["failed", "blocked"].includes(p.status) && (
              <p role="alert">
                Lettura non completata: {p.error_code ?? p.status}. Nessun artifact dichiarato pronto.
              </p>
            )}
            {p.status === "completed" && <ReadResult extract={p.extract ?? ""} />}
          </>
        )}

        {/* Chain proposal and states */}
        {c && c.steps.length > 1 && (
          <>
            {c.status === "pending_approval" && (
              <>
                <strong>Propongo {c.steps.length} letture</strong>
                <ol className="cw-chain-steps">
                  {c.steps.map((step, index) => (
                    <li key={step.proposal_id ?? index} title={`SHA-256: ${step.materials[0]?.sha256}`}>
                      {step.materials[0]?.title} · v{step.materials[0]?.version}
                    </li>
                  ))}
                </ol>
                <p className="cw-hint">
                  Un'unica approvazione copre esattamente queste versioni (passa il mouse per
                  l'impronta): se un documento cambia, la proposta non è più valida.
                </p>
                <button className="cw-primary" disabled={chain.busy} onClick={() => void chain.approve()}>
                  Approva le {c.steps.length} letture
                </button>
              </>
            )}
            {["queued", "running"].includes(c.status) && (
              <p role="status">Letture approvate, esecuzione in corso.</p>
            )}
            {c.status === "completed" && (
              <>
                <p role="status">
                  <strong>{c.steps.length} letture completate.</strong>
                </p>
                <ol className="cw-chain-steps cw-chain-done">
                  {c.steps.map((step, index) => (
                    <li key={step.proposal_id ?? index}>✓ {step.materials[0]?.title}</li>
                  ))}
                </ol>
              </>
            )}
            {["failed", "blocked"].includes(c.status) && (
              <p role="alert">
                Catena non completata ({c.error_code ?? c.status}): le letture già ultimate restano
                in revisione, le altre non sono state eseguite.
              </p>
            )}
          </>
        )}

        {single.busy && <p role="status">Preparazione in corso…</p>}
        {chain.busy && <p role="status">Preparazione delle letture…</p>}
        <HomunGuidanceNotice message={single.recovery ?? chain.recovery} />
        <HomunErrorNotice error={single.error ?? chain.error} />
      </details>
    </section>
  );
}

/** Expandable extract with a clear label, not a wall of text. */
function ReadResult({ extract }: { extract: string }) {
  const [open, setOpen] = useState(false);
  if (!extract) return null;
  return (
    <>
      <p role="status">
        <strong>Artifact di lettura pronto per la tua verifica.</strong>
      </p>
      <button type="button" className="cs-link" onClick={() => setOpen(!open)}>
        {open ? "Nascondi l'estratto" : "Leggi l'estratto"}
      </button>
      {open && (
        <div className="cw-read-extract">
          <pre>{extract}</pre>
        </div>
      )}
    </>
  );
}
