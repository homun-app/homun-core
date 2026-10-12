/**
 * Engine material library for the global search index (Fonte: motore).
 * Same source as the Materiali view; a failed load leaves the index empty —
 * the Materiali view remains the error surface, nothing simulated is shown.
 */

import { useEffect, useState } from "react";
import { loadEngineMaterialLibrary } from "@/lib/engine-material-library";
import { type EngineMaterial } from "@/lib/engine-projects-client";
import { subscribeMaterialChanges } from "@/lib/project-materials-lifecycle";

export function useEngineMaterials(projects: Array<{ id: string }>): EngineMaterial[] {
  const [materials, setMaterials] = useState<EngineMaterial[]>([]);
  const projectKey = JSON.stringify([...new Set(projects.map((p) => p.id))].sort());
  useEffect(() => {
    let active = true;
    const reload = () => {
      loadEngineMaterialLibrary(JSON.parse(projectKey) as string[]).then(
        (items) => {
          if (active) setMaterials(items);
        },
        () => {
          if (active) setMaterials([]);
        },
      );
    };
    const stop = subscribeMaterialChanges(reload);
    reload();
    return () => {
      active = false;
      stop();
    };
  }, [projectKey]);
  return materials;
}
