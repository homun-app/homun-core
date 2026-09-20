/** Pick an existing project material as a tool source (Fonte=motore). */
import { useEffect, useState } from "react";
import type { Work } from "./conversation-types";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { listEngineMaterials, type EngineMaterial } from "@/lib/engine-projects-client";
import { materialOptionLabel } from "@/lib/engine-material-selection";
import { resolveEngineProjectForWork } from "@/lib/engine-work-project";

export function EngineMaterialPicker({
  work,
  filter,
  label,
  value,
  onChange,
  disabled = false,
}: {
  work: Work;
  filter: (material: EngineMaterial) => boolean;
  label: string;
  value: string;
  onChange: (materialId: string) => void;
  disabled?: boolean;
}) {
  const [materials, setMaterials] = useState<EngineMaterial[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const projectId = await resolveEngineProjectForWork(work, "Materiali del lavoro");
        const items = (await listEngineMaterials({ projectId })).filter(filter);
        if (!live) return;
        setMaterials(items);
        setLoaded(true);
      } catch (cause) {
        if (live) setError(cause);
      }
    })();
    return () => {
      live = false;
    };
    // Reload when the conversation or project changes; the filter is stable per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.id, work.projectId]);
  return (
    <label>
      {label}
      <select
        value={value}
        disabled={disabled || materials.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {!loaded
            ? "Carico i materiali del progetto…"
            : materials.length === 0
              ? "Nessun materiale idoneo nel progetto"
              : "Scegli un materiale…"}
        </option>
        {materials.map((material) => (
          <option key={material.id} value={material.id}>
            {materialOptionLabel(material)}
          </option>
        ))}
      </select>
    </label>
  );
}
