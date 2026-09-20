import { useState } from "react";
import type { Work } from "./conversation-types";
import { useMaterialRead } from "@/hooks/useMaterialRead";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import "./engine-material-read.css";

/** Authorized material read: provenance-bound extract, approval before execution. */
export function EngineMaterialRead({
  work,
  onChanged,
  initiallyOpen = false,
}: {
  initiallyOpen?: boolean;
  work: Work;
  onChanged: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const tool = useMaterialRead(work, onChanged);
  const p = tool.proposal;
  return (
    <section className="cw-price-tool" aria-label="Lettura materiale sul motore">
      <details open={p !== null || initiallyOpen || undefined}>
        <summary>Leggi un materiale</summary>
        <p>
          Lettura locale con estratto limitato e provenienza (hash e versione). Il file resta nel
          progetto; nessuna interpretazione automatica, nessun invio a servizi esterni.
        </p>
        {(!p || ["failed", "blocked"].includes(p.status)) && (
          <>
            <label>
              Materiale da leggere
              <input
                type="file"
                accept=".txt,.md,.csv,.tsv,.json,.log,.pdf"
                disabled={tool.busy}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  tool.newFiles();
                }}
              />
            </label>
            <p>Testo, CSV o PDF fino a 2 MB. Estratto limitato ai primi 8.000 caratteri.</p>
            <button
              type="button"
              className="cw-secondary"
              disabled={tool.busy || !file}
              onClick={() => file && void tool.prepare(file)}
            >
              Prepara la lettura
            </button>
          </>
        )}
        {p && (
          <>
            <p>
              <strong>{p.material.title}</strong> · v{p.material.version}
            </p>
            {p.status === "pending_approval" && (
              <>
                <p>
                  Produrrò un artifact di lettura con estratto limitato, hash e provenienza. Il
                  materiale non viene modificato.
                </p>
                <button
                  className="cw-primary"
                  disabled={tool.busy}
                  onClick={() => void tool.approve()}
                >
                  Approva ed esegui lettura
                </button>
              </>
            )}
            {["queued", "running"].includes(p.status) && (
              <p role="status">
                Lettura approvata, elaborazione in corso. Puoi riaprire questa conversazione dopo
                il riavvio.
              </p>
            )}
            {["failed", "blocked"].includes(p.status) && (
              <p role="alert">
                Lettura non completata: {p.error_code ?? p.status}. Nessun artifact è stato
                dichiarato pronto.
              </p>
            )}
            {p.status === "completed" && (
              <>
                <p role="status">
                  <strong>Artifact di lettura pronto per la tua verifica.</strong>
                </p>
                <details>
                  <summary>Leggi l’estratto</summary>
                  <div className="cw-read-extract">
                    <pre>{p.extract ?? ""}</pre>
                  </div>
                </details>
              </>
            )}
          </>
        )}
        {tool.busy && <p role="status">Preparazione in corso…</p>}
        <HomunErrorNotice error={tool.error} />
      </details>
    </section>
  );
}
