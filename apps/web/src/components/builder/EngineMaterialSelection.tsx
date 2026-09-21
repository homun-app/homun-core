/**
 * One management surface for tool sources: eligible project materials with
 * inline ingestion (single files or a whole folder). Uploads land in the
 * project first, then the person selects — no separate upload mode.
 */
import { useRef, useState } from "react";
import type { Work } from "./conversation-types";
import type { EngineMaterial } from "@/lib/engine-projects-client";
import { materialOptionLabel } from "@/lib/engine-material-selection";
import { useProjectMaterials } from "@/hooks/useProjectMaterials";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import "./engine-tool-chain.css";
import "./engine-material-selection.css";

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
    const { addedIds, eligibleIds, skipped } = await sources.ingest(files, uploadExtensions);
    if (!addedIds.length && !skipped) return;
    // Fresh uploads that pass the tool's eligibility become the selection,
    // keeping earlier picks only when there is room for them.
    const merged = [...selected.filter((id) => !eligibleIds.includes(id)), ...eligibleIds];
    onSelectionChange(merged.length > maxSelected ? eligibleIds.slice(0, maxSelected) : merged);
    const parts: string[] = [];
    if (eligibleIds.length) parts.push(`${eligibleIds.length} file aggiunti al progetto e selezionati.`);
    const rejected = addedIds.length - eligibleIds.length;
    if (rejected) parts.push(`${rejected} caricati ma non idonei a questo strumento.`);
    if (skipped) parts.push(`${skipped} ignorati (formato non previsto).`);
    setNotice(parts.join(" "));
  }

  return (
    <div className="cw-material-selection">
      <ul className="cw-chain-picker">
        {sources.materials.map((material) => {
          const index = selected.indexOf(material.id);
          const checked = index >= 0;
          const role = checked && orderedRoles?.[index] ? orderedRoles[index] : undefined;
          return (
            <li key={material.id} title={`SHA-256: ${material.content_hash}`}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || sources.busy || (!checked && full)}
                  onChange={(event) => toggle(material.id, event.target.checked)}
                />
                <span>{materialOptionLabel(material)}</span>
                {role && <em className="cw-material-role">{role}</em>}
              </label>
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
            Caricamento nel progetto…
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
