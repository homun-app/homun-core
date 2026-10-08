/** Ingest chat file attachments as engine project materials for a work. */
import type { Work } from "@/components/builder/conversation-types.ts";
import { defaultLocalActor } from "./engine-domain-client.ts";
import { ingestEngineMaterial } from "./engine-projects-client.ts";
import { resolveEngineProjectForWork } from "./engine-work-project.ts";

export type IngestedAttachment = {
  materialId: string;
  name: string;
  size: number;
};

export async function ingestWorkAttachments(
  work: Work,
  files: File[],
): Promise<IngestedAttachment[]> {
  if (!files || files.length === 0) return [];
  const actor = defaultLocalActor();
  const projectId = await resolveEngineProjectForWork(work, work.title || "Progetto Homun");
  const ingested: IngestedAttachment[] = [];

  for (const file of files) {
    const relativePath =
      "webkitRelativePath" in file && file.webkitRelativePath
        ? String(file.webkitRelativePath)
        : undefined;
    const res = await ingestEngineMaterial({
      projectId,
      file,
      ...(relativePath ? { relativePath } : {}),
      actor,
    });
    ingested.push({
      materialId: res.materialId,
      name: file.name,
      size: file.size,
    });
  }

  return ingested;
}
