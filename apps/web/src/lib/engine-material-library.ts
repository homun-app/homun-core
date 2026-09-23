/** Authoritative material operations shared by the library and work tool pickers. */
import {
  archiveEngineMaterial,
  ingestEngineMaterial,
  listEngineMaterials,
  type EngineMaterial,
} from "./engine-projects-client.ts";
import { ingestMaterialFiles, notifyMaterialChange } from "./project-materials-lifecycle.ts";

export async function loadEngineMaterialLibrary(projectIds: string[]): Promise<EngineMaterial[]> {
  const groups = await Promise.all(
    [...new Set(projectIds)].map((projectId) => listEngineMaterials({ projectId })),
  );
  return groups.flat();
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
