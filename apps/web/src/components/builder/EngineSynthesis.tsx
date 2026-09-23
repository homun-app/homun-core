/** Supervised model synthesis: the assignee's model writes the phase draft. */
import { useState } from "react";
import type { Work } from "./conversation-types";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { HomunGuidanceNotice } from "@/components/HomunGuidanceNotice";
import { useSynthesis } from "@/hooks/useSynthesis";
import { eligibleForRead, READ_UPLOAD_EXTENSIONS } from "@/lib/engine-material-selection";
import { EngineMaterialSelection } from "./EngineMaterialSelection";

export function EngineSynthesis({
  work,
  onChanged,
  initiallyOpen = false,
}: {
  initiallyOpen?: boolean;
  work: Work;
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const synth = useSynthesis(work, onChanged);
  const p = synth.proposal;
  const idle = !p || ["failed", "blocked"].includes(p.status);

  return (
    <section className="cw-price-tool" aria-label="Sintesi del collaboratore">
      <details open={!idle || initiallyOpen || undefined}>
        <summary>Scrivi la sintesi</summary>
        <p>
          Il collaboratore assegnato scriverà la bozza con il suo modello, a partire da obiettivo,
          vincoli, procedure approvate e i documenti che scegli. La bozza arriva in revisione:
          nessun invio esterno, nessuna approvazione automatica.
        </p>

        {idle && (
          <>
            <EngineMaterialSelection
              work={work}
              filter={eligibleForRead}
              uploadExtensions={READ_UPLOAD_EXTENSIONS}
              selected={selected}
              maxSelected={6}
              disabled={synth.busy}
              emptyHint="Nessun documento idoneo nel progetto: la sintesi può nascere anche senza materiali, oppure aggiungi file."
              onSelectionChange={(next) => {
                synth.renew();
                setSelected(next);
              }}
            />
            <p className="cw-hint">
              {selected.length === 0
                ? "Senza materiali la bozza nasce da obiettivo e vincoli dichiarati."
                : `${selected.length} ${selected.length === 1 ? "documento selezionato" : "documenti selezionati"}: fino a 24.000 caratteri di contesto, bozza entro 8.000.`}
            </p>
            <button
              type="button"
              className="cw-secondary"
              disabled={synth.busy}
              onClick={() => void synth.prepare(selected)}
            >
              Prepara la sintesi
            </button>
          </>
        )}

        {p && p.status === "pending_approval" && (
          <>
            <p>
              <strong>{p.step_title}</strong> · {p.materials.length === 0
                ? "nessun materiale: obiettivo e vincoli"
                : p.materials.map((m) => m.title).join(", ")}
            </p>
            <p className="cw-hint">
              Scriverà la bozza il modello del collaboratore assegnato (o la connessione attiva
              dello spazio, se non ne ha una dedicata — l'artifact lo dichiara). Approvando,
              autorizzi questa esecuzione e questa fase.
            </p>
            <button className="cw-primary" disabled={synth.busy} onClick={() => void synth.approve()}>
              Approva ed esegui sintesi
            </button>
          </>
        )}
        {p && ["queued", "running"].includes(p.status) && (
          <p role="status">Sintesi approvata: il modello sta scrivendo la bozza.</p>
        )}
        {p && p.status === "completed" && p.summary && (
          <p role="status">
            <strong>Bozza pronta per la tua verifica.</strong> Modello {p.summary.model_id ?? "del collaboratore"},{" "}
            connessione {p.summary.connection === "collaboratore" ? "dedicata del collaboratore" : "attiva dello spazio"}
            {p.summary.truncated ? ", bozza troncata al limite di caratteri" : ""}. Il risultato è in
            revisione nella conversazione.
          </p>
        )}
        {p && ["failed", "blocked"].includes(p.status) && (
          <p role="alert">
            Sintesi non completata: {p.error_code ?? p.status}. Nessuna bozza dichiarata pronta; puoi
            preparare una nuova proposta.
          </p>
        )}
        {synth.busy && <p role="status">Preparazione in corso…</p>}
        <HomunGuidanceNotice message={synth.recovery} />
        <HomunErrorNotice error={synth.error} />
      </details>
    </section>
  );
}
