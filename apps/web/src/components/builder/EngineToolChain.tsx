/** Multi-read chain: pick existing materials, one approval for every effect. */
import { useEffect, useState } from "react";
import type { Work } from "./conversation-types";
import { useToolChain } from "@/hooks/useToolChain";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { eligibleForRead, materialOptionLabel } from "@/lib/engine-material-selection";
import { resolveEngineProjectForWork } from "@/lib/engine-work-project";
import { listEngineMaterials, type EngineMaterial } from "@/lib/engine-projects-client";
import "./engine-tool-chain.css";

const STEP_LABELS: Record<string, string> = {
  completed: "Letto",
  queued: "In attesa",
  running: "Lettura in corso",
  pending_approval: "Da approvare",
  failed: "Non riuscito",
  blocked: "Bloccato da un passo precedente",
};

export function EngineToolChain({
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
  const [loadError, setLoadError] = useState<unknown>(null);
  const tool = useToolChain(work, onChanged);
  const chain = tool.chain;

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

  const idle = !chain || ["failed", "blocked"].includes(chain.status);
  const pending = chain?.status === "pending_approval";

  return (
    <section className="cw-price-tool" aria-label="Letture multiple sul motore">
      <details open={chain != null || initiallyOpen || undefined}>
        <summary>Leggi più materiali in una volta</summary>
        <p>
          Una sola approvazione per tutte le letture: ogni documento produce il proprio artifact
          con estratto e provenienza, in revisione umana. Se un passo fallisce, i già completati
          restano e i successivi si fermano.
        </p>
        {idle && (
          <>
            <ul className="cw-chain-picker">
              {materials.map((material) => (
                <li key={material.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(material.id)}
                      disabled={tool.busy}
                      onChange={(event) => {
                        tool.newChain();
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
                  Nessun materiale idoneo nel progetto: carica prima un documento con la scheda di
                  lettura.
                </li>
              )}
            </ul>
            <p className="cw-hint">
              Seleziona da 2 a 8 documenti già registrati ({selected.length} scelti).
            </p>
            <button
              type="button"
              className="cw-secondary"
              disabled={tool.busy || selected.length < 2}
              onClick={() => void tool.propose(selected)}
            >
              Prepara le letture ({selected.length})
            </button>
          </>
        )}
        {chain && pending && (
          <>
            <strong>Propongo {chain.steps.length} letture</strong>
            <ol className="cw-chain-steps">
              {chain.steps.map((step, index) => (
                <li key={step.proposal_id ?? index}>
                  {step.materials[0]?.title} · v{step.materials[0]?.version} ·{" "}
                  <span title={step.materials[0]?.sha256}>
                    sha:{step.materials[0]?.sha256.slice(0, 8)}…
                  </span>
                </li>
              ))}
            </ol>
            <p className="cw-hint">
              L’approvazione copre esattamente questi documenti con queste versioni: se uno cambia
              prima dell’avvio, la proposta non è più valida.
            </p>
            <button className="cw-primary" disabled={tool.busy} onClick={() => void tool.approve()}>
              Approva le {chain.steps.length} letture
            </button>
          </>
        )}
        {chain && ["queued", "running"].includes(chain.status) && (
          <>
            <p role="status">Catena approvata, esecuzione in corso.</p>
            <ol className="cw-chain-steps">
              {chain.steps.map((step, index) => (
                <li key={step.proposal_id ?? index} className="cw-chain-step-live">
                  {step.materials[0]?.title}
                </li>
              ))}
            </ol>
          </>
        )}
        {chain && chain.status === "completed" && (
          <>
            <p role="status">
              <strong>{chain.steps.length} letture completate.</strong> Ogni artifact è in
              revisione umana; gli estratti sono nelle singole schede di lettura.
            </p>
            <ol className="cw-chain-steps cw-chain-done">
              {chain.steps.map((step, index) => (
                <li key={step.proposal_id ?? index}>
                  ✓ {step.materials[0]?.title}
                </li>
              ))}
            </ol>
          </>
        )}
        {chain && ["failed", "blocked"].includes(chain.status) && (
          <p role="alert">
            Catena non completata ({chain.error_code ?? chain.status}): le letture già ultimate
            restano in revisione, le altre non sono state eseguite.
          </p>
        )}
        {tool.busy && <p role="status">Preparazione in corso…</p>}
        <HomunErrorNotice error={tool.error ?? loadError} />
      </details>
    </section>
  );
}
