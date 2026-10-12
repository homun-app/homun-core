/** Authoritative material operations shared by the library and work tool pickers. */
import {
  archiveEngineMaterial,
  ingestEngineMaterial,
  listEngineMaterials,
  type EngineMaterial,
} from "./engine-projects-client.ts";
import { HomunClientError, isHomunClientError } from "./homun-errors.ts";
import { ingestMaterialFiles, notifyMaterialChange } from "./project-materials-lifecycle.ts";

export async function loadEngineMaterialLibrary(projectIds: string[]): Promise<EngineMaterial[]> {
  const groups = await Promise.all(
    [...new Set(projectIds)].map((projectId) => listEngineMaterials({ projectId })),
  );
  return groups.flat();
}

/** Load-state contract for consumers that index engine materials (⌘K). */
export type EngineMaterialsStatus = "ok" | "loading" | "unavailable";

export type EngineMaterialsState = {
  items: EngineMaterial[];
  status: EngineMaterialsStatus;
  /** Typed client error, present only when status is "unavailable". */
  error?: HomunClientError;
};

/** One probe of the source: ok with items, or unavailable with the client's
 * typed error — never a silent empty. */
export async function probeEngineMaterials(projectIds: string[]): Promise<EngineMaterialsState> {
  try {
    return { items: await loadEngineMaterialLibrary(projectIds), status: "ok" };
  } catch (cause) {
    return {
      items: [],
      status: "unavailable",
      error: isHomunClientError(cause)
        ? cause
        : new HomunClientError(
            "unknown",
            cause instanceof Error ? cause.message : "Errore imprevisto.",
          ),
    };
  }
}

export async function uploadEngineMaterialFiles(projectId: string, files: File[]) {
  const outcome = await ingestMaterialFiles(files, (file) =>
    ingestEngineMaterial({
      projectId,
      file,
      ...(file.webkitRelativePath ? { relativePath: file.webkitRelativePath } : {}),
    }),
  );
  // The write already succeeded even if a later refresh fails.
  if (outcome.addedIds.length) notifyMaterialChange(projectId);
  return outcome;
}

export async function archiveLibraryMaterial(
  material: Pick<EngineMaterial, "id" | "project_id" | "version">,
) {
  await archiveEngineMaterial({ materialId: material.id, expectedVersion: material.version });
  notifyMaterialChange(material.project_id);
}
