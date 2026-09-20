/**
 * Build the unified materials library from explicit materials + work attachments.
 */

import type { ConversationMaterial } from "./ConversationMaterials";
import type { Work } from "./conversation-types";

export function buildMaterialLibrary(
  materials: ConversationMaterial[],
  works: Work[],
  attachmentIds: WeakMap<File, string>,
  materialDates: WeakMap<File, string>,
): ConversationMaterial[] {
  const library = [...materials];
  for (const w of works) {
    for (const file of w.files) {
      if (!materialDates.has(file)) materialDates.set(file, new Date().toISOString());
      if (!attachmentIds.has(file)) attachmentIds.set(file, crypto.randomUUID());
      if (!library.some((m) => m.file === file)) {
        library.push({
          id: attachmentIds.get(file)!,
          name: file.name,
          addedAt: materialDates.get(file)!,
          file,
          path: file.webkitRelativePath || file.name,
          projectIds: w.projectId ? [w.projectId] : [],
        });
      }
    }
  }
  return library;
}
