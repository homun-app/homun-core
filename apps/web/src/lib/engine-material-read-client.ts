/** Typed transport for an explicitly approved local material read. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  domainFetch,
  listEngineConversations,
  listEngineWorks,
} from "./engine-domain-client.ts";
import {
  ensureEngineProjectForConversation,
  ingestEngineMaterial,
} from "./engine-projects-client.ts";
import { HomunClientError, homunErrorFromHttp } from "./homun-errors.ts";
import type { Work } from "../components/builder/conversation-types.ts";

type Source = { id: string; title: string; sha256: string; version: number };
export type MaterialRead = {
  id: string;
  work_id: string;
  digest: string;
  expected_version: number;
  status: "pending_approval" | "queued" | "running" | "completed" | "failed" | "blocked";
  tool_version: string;
  material: Source;
  limits: { max_extract_characters: number; max_attempts: number };
  extract?: string;
  error_code?: string;
  artifact_id?: string;
};

async function request(workId: string, suffix = "", body?: unknown): Promise<any> {
  const response = await domainFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/material-reads${suffix}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": defaultLocalActor().id,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    ENGINE_DEFAULT_BASE_URL,
    30_000,
  );
  const result = await response.json();
  if (!response.ok)
    throw homunErrorFromHttp(response.status, result, "Lettura materiale non disponibile");
  return result;
}

export async function listMaterialReads(workId: string): Promise<MaterialRead[]> {
  return (await request(workId)).items;
}

export async function approveMaterialRead(
  workId: string,
  proposal: MaterialRead,
  commandId: string,
): Promise<MaterialRead> {
  return request(workId, `/${encodeURIComponent(proposal.id)}/approve`, {
    command_id: commandId,
    digest: proposal.digest,
    expected_version: proposal.expected_version,
  });
}

const READABLE_EXTENSIONS = [".txt", ".md", ".csv", ".tsv", ".json", ".log", ".pdf"];

export async function prepareMaterialRead(
  work: Work,
  file: File,
  operationId: string,
): Promise<MaterialRead> {
  if (!work.engineConversationId)
    throw new HomunClientError("validation_error", "Apri prima una conversazione del motore");
  if (!READABLE_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext)) || file.size > 2 * 1024 * 1024) {
    throw new HomunClientError(
      "validation_error",
      "Seleziona un file leggibile (testo, CSV o PDF) fino a 2 MB",
    );
  }
  // A lost POST response must recover the durable proposal before reading a newer revision.
  const existing = (await listMaterialReads(work.id)).find((item) => item.id === operationId);
  if (existing) return existing;
  const conversations = await listEngineConversations();
  const conversation = conversations.find((c) => c.id === work.engineConversationId);
  if (!conversation) throw new HomunClientError("not_found", "Conversazione non accessibile");
  const projectId =
    conversation.project_id ??
    (
      await ensureEngineProjectForConversation({
        conversationId: conversation.id,
        expectedVersion: conversation.version,
        name: "Lettura materiali",
      })
    ).projectId;
  const ingested = await ingestEngineMaterial({
    projectId,
    file,
    commandId: operationId + ":file",
  });
  const current = (await listEngineWorks()).find((w) => w["id"] === work.id);
  if (!current) throw new HomunClientError("not_found", "Lavoro non accessibile");
  return request(work.id, "", {
    command_id: operationId,
    material_id: ingested.materialId,
    expected_version: current["version"],
  });
}

/** Read an existing project material: no upload, the durable source is reused. */
export async function prepareReadFromMaterial(
  work: Work,
  materialId: string,
  operationId: string,
): Promise<MaterialRead> {
  const existing = (await listMaterialReads(work.id)).find((item) => item.id === operationId);
  if (existing) return existing;
  const current = (await listEngineWorks()).find((w) => w["id"] === work.id);
  if (!current) throw new HomunClientError("not_found", "Lavoro non accessibile");
  return request(work.id, "", {
    command_id: operationId,
    material_id: materialId,
    expected_version: current["version"],
  });
}
