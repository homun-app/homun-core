/**
 * What a confirmed preparation-phase agreement needs from the person: the
 * missing information as an explicit ask, plus collecting the files into the
 * project — visible in the conversation, not buried in a panel.
 */
import { useRef, useState } from "react";
import type { Work } from "./conversation-types";
import { useProjectMaterials } from "@/hooks/useProjectMaterials";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import {
  eligibleForPreparation,
  READ_UPLOAD_EXTENSIONS,
} from "@/lib/engine-material-selection";
import "./engine-tool-chain.css";
import "./engine-material-selection.css";

function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null) return "dimensione n/d";
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export function EngineWorkNeedsCard({
  work,
  items,
  onChanged,
}: {
  work: Work;
  /** Missing information declared by the confirmed brief. */
  items: string[];
  onChanged: () => Promise<void>;
}) {
  const sources = useProjectMaterials(work, eligibleForPreparation);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");

  async function add(files: File[]) {
    if (!files.length) return;
    const { addedIds, existing, failed } = await sources.ingest(files);
    if (!addedIds.length && !failed) return;
    const fresh = addedIds.length - existing;
    const parts: string[] = [];
    if (fresh === 1) parts.push("1 file aggiunto al progetto.");
    if (fresh > 1) parts.push(`${fresh} file aggiunti al progetto.`);
    if (existing === 1) parts.push("1 file era già nel progetto.");
    if (existing > 1) parts.push(`${existing} file erano già nel progetto.`);
    if (failed === 1) parts.push("1 non caricato per un errore.");
    if (failed > 1) parts.push(`${failed} non caricati per un errore.`);
    setNotice(parts.join(" "));
    await onChanged();
  }

  async function remove(name: string, materialId: string) {
    const material = sources.materials.find((m) => m.id === materialId);
    if (!material) return;
    if (!window.confirm(`Rimuovere «${name}» dal progetto? Non sarà più selezionabile.`)) return;
    if (await sources.remove(material)) setNotice(`«${name}» rimosso dal progetto.`);
  }

  return (
    <section className="cw-intake-card cw-needs-card" aria-label="Cosa serve ora">
      <div className="cw-intake-eyebrow">COSA SERVE ORA</div>
      <h3>Prima di procedere servono</h3>
      {items.length > 0 ? (
        <ul className="cw-needs-list">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>I file che il lavoro userà: portali nel progetto quando li hai.</p>
      )}
      {sources.materials.length > 0 && (
        <ul className="cw-chain-picker cw-material-list">
          {sources.materials.map((material) => {
            const name = material.origin_name ?? material.title;
            return (
              <li key={material.id} className="cw-material-row" title={`SHA-256: ${material.content_hash}`}>
                <span className="cw-material-row__text">
                  <span className="cw-material-row__name">{name}</span>
                  <small className="cw-material-row__meta">
                    v{material.version} · {sizeLabel(material.byte_size)}
                  </small>
                </span>
                <button
                  type="button"
                  className="cw-material-remove"
                  aria-label={`Rimuovi ${name} dal progetto`}
                  disabled={sources.busy}
                  onClick={() => void remove(name, material.id)}
                >
                  Rimuovi
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="cw-material-add">
        <button
          type="button"
          className="cw-secondary"
          disabled={sources.busy}
          onClick={() => filesInput.current?.click()}
        >
          Aggiungi file
        </button>
        <button
          type="button"
          className="cw-secondary"
          disabled={sources.busy}
          onClick={() => folderInput.current?.click()}
        >
          Aggiungi cartella
        </button>
        {sources.busy && (
          <span role="status" className="cw-hint">
            Caricamento nel progetto…
          </span>
        )}
      </div>
      {notice && <p className="cw-hint">{notice}</p>}
      <p className="cw-intake-note">
        I file restano nel progetto. Quando sono pronti, rivedi l'accordo in chat dicendo cosa
        fare: per esempio «ora confronta i due listini».
      </p>
      <input
        ref={filesInput}
        hidden
        type="file"
        multiple
        accept={READ_UPLOAD_EXTENSIONS.join(",")}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void add(files);
        }}
      />
      <input
        ref={folderInput}
        hidden
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void add(files);
        }}
      />
      <HomunErrorNotice error={sources.error} />
    </section>
  );
}
