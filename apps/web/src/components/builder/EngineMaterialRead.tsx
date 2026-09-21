/** Unified material reading: one card for single and multi-read, upload or pick. */
import { useEffect, useState } from "react";
import type { Work } from "./conversation-types";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useMaterialRead } from "@/hooks/useMaterialRead";
import { useToolChain } from "@/hooks/useToolChain";
import { eligibleForRead, materialOptionLabel } from "@/lib/engine-material-selection";
import { resolveEngineProjectForWork } from "@/lib/engine-work-project";
import { listEngineMaterials, type EngineMaterial } from "@/lib/engine-projects-client";
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
  const [materials, setMaterials] = useState<EngineMaterial[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<"project" | "upload">("project");
  const [loadError, setLoadError] = useState<unknown>(null);
  const single = useMaterialRead(work, onChanged);
  const chain = useToolChain(work, onChanged);
  const p = single.proposal;
  const c = chain.chain;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const projectId = await resolveEngineProjectForWork(work, "Materiali del lavoro");
        const items = (await listEngineMaterials({ projectId })).filter(eligibleForRead);
        if (live) setMaterials(items);
      } catch (cause) {
        if (live) setLoadError(cause);
      }
    })();
    return () => {
      live = false;
    };
  }, [work.id, work.projectId]);

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
          progetto, oppure carica un file. Nessuna interpretazione automatica, nessun invio a
          servizi esterni.
        </p>

        {idle && (
          <>
            <div className="cs-actions">
              <button
                type="button"
                className={source === "project" ? "cw-secondary" : "cs-link"}
                onClick={() => setSource("project")}
              >
                Materiali del progetto
              </button>
              <button
                type="button"
                className={source === "upload" ? "cw-secondary" : "cs-link"}
                onClick={() => setSource("upload")}
              >
                Carica un file
              </button>
            </div>
            {source === "project" ? (
              <>
                <ul className="cw-chain-picker">
                  {materials.map((material) => (
                    <li key={material.id} title={`SHA-256: ${material.content_hash}`}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.includes(material.id)}
                          disabled={single.busy || chain.busy}
                          onChange={(event) => {
                            single.newFiles();
                            chain.newChain();
                            setSelected((current) =>
                              event.target.checked
                                ? current.length >= 8
                                  ? current
                                  : [...current, material.id]
                                : current.filter((id) => id !== material.id),
                            );
                          }}
                        />
                        {materialOptionLabel(material)}
                      </label>
                    </li>
                  ))}
                  {materials.length === 0 && (
                    <li className="cw-hint">
                      Nessun documento idoneo nel progetto: carica un file oppure usa la chat.
                    </li>
                  )}
                </ul>
                <p className="cw-hint">
                  {selected.length === 0
                    ? "Seleziona un documento per la lettura singola, o due o più per leggerli tutti con una sola approvazione."
                    : multi
                      ? `${selected.length} documenti selezionati: un'unica approvazione copre tutte le letture.`
                      : "1 documento selezionato."}
                </p>
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
                    onClick={() => void single.prepareFromMaterial(selected[0]!)}
                  >
                    Prepara la lettura
                  </button>
                )}
              </>
            ) : (
              <>
                <label>
                  File da leggere
                  <input
                    type="file"
                    accept=".txt,.md,.csv,.tsv,.json,.log,.pdf"
                    disabled={single.busy}
                    onChange={(e) => {
                      setFile(e.target.files?.[0] ?? null);
                      single.newFiles();
                    }}
                  />
                </label>
                <p>Testo, CSV o PDF fino a 2 MB. Estratto limitato ai primi 8.000 caratteri.</p>
                <button
                  type="button"
                  className="cw-secondary"
                  disabled={single.busy || !file}
                  onClick={() => file && void single.prepare(file)}
                >
                  Prepara la lettura
                </button>
              </>
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
        <HomunErrorNotice error={single.error ?? chain.error ?? loadError} />
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
