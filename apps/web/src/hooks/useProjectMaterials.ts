/** Project materials as tool sources: load eligible items, ingest added files into the project. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import {
  ingestEngineMaterial,
  listEngineMaterials,
  type EngineMaterial,
} from "@/lib/engine-projects-client";
import { resolveEngineProjectForWork } from "@/lib/engine-work-project";

export type IngestOutcome = {
  /** Materials actually stored in the project. */
  addedIds: string[];
  /** Stored materials the current tool can select. */
  eligibleIds: string[];
  /** Files rejected by the engine (size, storage). */
  failed: number;
};

export type ProjectMaterials = {
  materials: EngineMaterial[];
  loaded: boolean;
  busy: boolean;
  error: unknown;
  reload: () => Promise<EngineMaterial[]>;
  ingest: (files: File[]) => Promise<IngestOutcome>;
};

export function useProjectMaterials(
  work: Work,
  filter: (material: EngineMaterial) => boolean,
): ProjectMaterials {
  const [materials, setMaterials] = useState<EngineMaterial[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const workRef = useRef(work);
  workRef.current = work;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const reload = useCallback(async (): Promise<EngineMaterial[]> => {
    const projectId = await resolveEngineProjectForWork(workRef.current, "Materiali del lavoro");
    const items = (await listEngineMaterials({ projectId })).filter(filterRef.current);
    setMaterials(items);
    setLoaded(true);
    return items;
  }, []);

  useEffect(() => {
    let live = true;
    void reload().catch((cause: unknown) => {
      if (live) setError(cause);
    });
    return () => {
      live = false;
    };
  }, [reload, work.id, work.projectId]);

  async function ingest(files: File[]): Promise<IngestOutcome> {
    setBusy(true);
    setError(null);
    try {
      const projectId = await resolveEngineProjectForWork(workRef.current, "Materiali del lavoro");
      // Everything the person picked lands in the project; per-file failures
      // never abort the rest of a folder upload.
      const addedIds: string[] = [];
      let failed = 0;
      for (const file of files) {
        const relativePath =
          "webkitRelativePath" in file && file.webkitRelativePath
            ? String(file.webkitRelativePath)
            : undefined;
        try {
          const added = await ingestEngineMaterial({
            projectId,
            file,
            ...(relativePath ? { relativePath } : {}),
          });
          addedIds.push(added.materialId);
        } catch {
          failed += 1;
        }
      }
      const reloaded = await reload();
      const eligibleIds = addedIds.filter((id) => reloaded.some((m) => m.id === id));
      return { addedIds, eligibleIds, failed };
    } catch (cause) {
      setError(cause);
      return { addedIds: [], eligibleIds: [], failed: files.length };
    } finally {
      setBusy(false);
    }
  }

  return { materials, loaded, busy, error, reload, ingest };
}
