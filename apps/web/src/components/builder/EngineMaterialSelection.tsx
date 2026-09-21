/**
 * One management surface for tool sources: eligible project materials with
 * inline ingestion (single files or a whole folder) and removal. Uploads land
 * in the project first, then the person selects — no separate upload mode.
 */
import { useRef, useState } from "react";
import type { Work } from "./conversation-types";
import type { EngineMaterial } from "@/lib/engine-projects-client";
import { useProjectMaterials } from "@/hooks/useProjectMaterials";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import "./engine-tool-chain.css";
import "./engine-material-selection.css";

function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null) return "dimensione n/d";
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export function EngineMaterialSelection({
  work,
  filter,
  uploadExtensions,
  selected,
  maxSelected,
  orderedRoles,
  disabled = false,
  emptyHint,
  onSelectionChange,
}: {
  work: Work;
  filter: (material: EngineMaterial) => boolean;
  uploadExtensions: readonly string[];
  selected: string[];
  maxSelected: number;
  /** Role per selection position (compare: precedente → aggiornato). */
  orderedRoles?: readonly string[];
  disabled?: boolean;
  emptyHint: string;
  onSelectionChange: (next: string[]) => void;
}) {
  const sources = useProjectMaterials(work, filter);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const full = selected.length >= maxSelected;

  function toggle(materialId: string, checked: boolean) {
    onSelectionChange(
      checked
        ? selected.includes(materialId)
          ? selected
          : [...selected, materialId]
        : selected.filter((id) => id !== materialId),
    );
  }

  async function add(files: File[]) {
    if (!files.length) return;
    const { addedIds, eligibleIds, existing, failed } = await sources.ingest(files);
    if (!addedIds.length && !failed) return;
    // Fresh uploads that pass the tool's eligibility become the selection,
    // keeping earlier picks only when there is room for them.
    const merged = [...selected.filter((id) => !eligibleIds.includes(id)), ...eligibleIds];
    onSelectionChange(merged.length > maxSelected ? eligibleIds.slice(0, maxSelected) : merged);
    const fresh = addedIds.length - existing;
    const stored = addedIds.length - eligibleIds.length;
    const parts: string[] = [];
    if (fresh === 1) parts.push("1 file aggiunto al progetto.");
    if (fresh > 1) parts.push(`${fresh} file aggiunti al progetto.`);
    if (existing === 1) parts.push("1 file era già nel progetto.");
    if (existing > 1) parts.push(`${existing} file erano già nel progetto.`);
    if (eligibleIds.length === 1) parts.push("1 file selezionato.");
    if (eligibleIds.length > 1) parts.push(`${eligibleIds.length} file selezionati.`);
    if (stored === 1) parts.push("1 archiviato nel progetto ma non usato da questo strumento.");
    if (stored > 1) parts.push(`${stored} archiviati nel progetto ma non usati da questo strumento.`);
    if (failed === 1) parts.push("1 non caricato per un errore.");
    if (failed > 1) parts.push(`${failed} non caricati per un errore.`);
    setNotice(parts.join(" "));
  }

  async function removeMaterial(material: EngineMaterial) {
    const name = material.origin_name ?? material.title;
    if (!window.confirm(`Rimuovere «${name}» dal progetto? Non sarà più selezionabile.`)) return;
    const ok = await sources.remove(material);
    if (ok) {
      onSelectionChange(selected.filter((id) => id !== material.id));
      setNotice(`«${name}» rimosso dal progetto.`);
    }
  }

  return (
    <div className="cw-material-selection">
      <ul className="cw-chain-picker cw-material-list">
        {sources.materials.map((material) => {
          const index = selected.indexOf(material.id);
          const checked = index >= 0;
          const role = checked && orderedRoles?.[index] ? orderedRoles[index] : undefined;
          const name = material.origin_name ?? material.title;
          return (
            <li key={material.id} className="cw-material-row" title={`SHA-256: ${material.content_hash}`}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || sources.busy || (!checked && full)}
                  onChange={(event) => toggle(material.id, event.target.checked)}
                />
                <span className="cw-material-row__text">
                  <span className="cw-material-row__name">{name}</span>
                  <small className="cw-material-row__meta">
                    v{material.version} · {sizeLabel(material.byte_size)}
                    {material.extract_status === "extracted" ? "" : " · testo non estraibile"}
                  </small>
                </span>
              </label>
              {role && <em className="cw-material-role">{role}</em>}
              <button
                type="button"
                className="cw-material-remove"
                aria-label={`Rimuovi ${name} dal progetto`}
                disabled={disabled || sources.busy}
                onClick={() => void removeMaterial(material)}
              >
                Rimuovi
              </button>
            </li>
          );
        })}
        {!sources.loaded && !sources.error && (
          <li className="cw-hint">Carico i materiali del progetto…</li>
        )}
        {sources.loaded && sources.materials.length === 0 && (
          <li className="cw-hint">{emptyHint}</li>
        )}
      </ul>
      <div className="cw-material-add">
        <button
          type="button"
          className="cw-secondary"
          disabled={disabled || sources.busy}
          onClick={() => filesInput.current?.click()}
        >
          Aggiungi file
        </button>
        <button
          type="button"
          className="cw-secondary"
          disabled={disabled || sources.busy}
          onClick={() => folderInput.current?.click()}
        >
          Aggiungi cartella
        </button>
        {sources.busy && (
          <span role="status" className="cw-hint">
            Aggiornamento materiali…
          </span>
        )}
      </div>
      {notice && <p className="cw-hint">{notice}</p>}
      <input
        ref={filesInput}
        hidden
        type="file"
        multiple
        accept={uploadExtensions.join(",")}
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
    </div>
  );
}
