/** Project materials as tool sources; reading never creates a project. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Work } from "@/components/builder/conversation-types";
import { archiveEngineMaterial, ingestEngineMaterial, listEngineMaterials, type EngineMaterial } from "@/lib/engine-projects-client";
import { findEngineProjectForWork, resolveEngineProjectForWork } from "@/lib/engine-work-project";
import { createMaterialRequestGuard, ingestMaterialFiles, notifyMaterialChange, subscribeMaterialChanges, type MaterialFailure } from "@/lib/project-materials-lifecycle";

export type IngestOutcome = {
  addedIds: string[];
  eligibleIds: string[];
  existing: number;
  failed: number;
  failures: MaterialFailure[];
};
export type ProjectMaterials = {
  materials: EngineMaterial[];
  loaded: boolean;
  busy: boolean;
  error: unknown;
  failures: MaterialFailure[];
  reload: () => Promise<EngineMaterial[]>;
  ingest: (files: File[]) => Promise<IngestOutcome>;
  remove: (material: EngineMaterial) => Promise<boolean>;
};

export function useProjectMaterials(work: Work, filter: (material: EngineMaterial) => boolean): ProjectMaterials {
  const [materials, setMaterials] = useState<EngineMaterial[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [failures, setFailures] = useState<MaterialFailure[]>([]);
  const workRef = useRef(work);
  workRef.current = work;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const scope = useMemo(() => ({ guard: createMaterialRequestGuard(), live: true }), [work.id, work.projectId, work.engineConversationId]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const active = () => scope.live && scopeRef.current === scope;

  const reload = useCallback(async (): Promise<EngineMaterial[]> => {
    const current = scope.guard.begin();
    try {
      const projectId = await findEngineProjectForWork(workRef.current);
      const items = projectId ? (await listEngineMaterials({ projectId })).filter(filterRef.current) : [];
      if (scope.live && scopeRef.current === scope && current()) {
        setMaterials(items);
        setLoaded(true);
        setError(null);
      }
      return items;
    } catch (cause) {
      if (scope.live && scopeRef.current === scope && current()) setError(cause);
      throw cause;
    }
  }, [scope]);

  useEffect(() => {
    scope.live = true;
    setMaterials([]);
    setLoaded(false);
    setBusy(false);
    setError(null);
    setFailures([]);
    const refresh = () => { void reload().catch(() => { /* reload preserves the typed error */ }); };
    const unsubscribe = subscribeMaterialChanges(refresh);
    refresh();
    return () => { scope.live = false; scope.guard.invalidate(); unsubscribe(); };
  }, [reload, scope]);

  async function ingest(files: File[]): Promise<IngestOutcome> {
    if (!files.length) return { addedIds: [], eligibleIds: [], existing: 0, failed: 0, failures: [] };
    const targetWork = workRef.current;
    setBusy(true);
    setError(null);
    setFailures([]);
    try {
      const projectId = await resolveEngineProjectForWork(targetWork, "Materiali del lavoro");
      const outcome = await ingestMaterialFiles(files, (file) => ingestEngineMaterial({
        projectId, file,
        ...(file.webkitRelativePath ? { relativePath: file.webkitRelativePath } : {}),
      }));
      if (active()) setFailures(outcome.failures);
      // Notify even if the following refresh fails: persistence already succeeded.
      if (outcome.addedIds.length) notifyMaterialChange(projectId);
      let reloaded: EngineMaterial[] = [];
      if (active()) {
        try { reloaded = await reload(); } catch { /* preserve successes and reload's typed error */ }
      }
      return { ...outcome, eligibleIds: outcome.addedIds.filter((id) => reloaded.some((m) => m.id === id)) };
    } catch (cause) {
      if (active()) setError(cause);
      return { addedIds: [], eligibleIds: [], existing: 0, failed: files.length, failures: [] };
    } finally {
      if (active()) setBusy(false);
    }
  }

  async function remove(material: EngineMaterial): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await archiveEngineMaterial({ materialId: material.id, expectedVersion: material.version });
      notifyMaterialChange(material.project_id);
      if (active()) {
        try { await reload(); } catch { /* archive succeeded; reload preserves error */ }
      }
      return true;
    } catch (cause) {
      if (active()) setError(cause);
      return false;
    } finally {
      if (active()) setBusy(false);
    }
  }
  return { materials, loaded, busy, error, failures, reload, ingest, remove };
}
