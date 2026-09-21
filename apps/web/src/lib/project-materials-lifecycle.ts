/** Shared invalidation and batch ingestion for every project material surface. */
export type MaterialFailure = { fileName: string; error: unknown };

export async function ingestMaterialFiles(
  files: File[],
  ingest: (file: File) => Promise<{ materialId: string; created: boolean }>,
) {
  const addedIds: string[] = [];
  const failures: MaterialFailure[] = [];
  let existing = 0;
  for (const file of files) {
    try {
      const added = await ingest(file);
      addedIds.push(added.materialId);
      if (!added.created) existing += 1;
    } catch (error) {
      failures.push({ fileName: file.webkitRelativePath || file.name, error });
    }
  }
  return { addedIds, existing, failures, failed: failures.length };
}

const listeners = new Set<(projectId: string) => void>();
export function subscribeMaterialChanges(listener: (projectId: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyMaterialChange(projectId: string) {
  for (const listener of listeners) listener(projectId);
}

export function createMaterialRequestGuard() {
  let revision = 0;
  return {
    begin() {
      const request = ++revision;
      return () => revision === request;
    },
    invalidate() { revision += 1; },
  };
}
