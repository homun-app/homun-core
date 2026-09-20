/** Typed transport for an explicitly approved local price comparison. */
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
export type PriceComparison = {
  id: string;
  work_id: string;
  digest: string;
  expected_version: number;
  status: "pending_approval" | "queued" | "running" | "completed" | "failed" | "blocked";
  tool_version: string;
  left: Source;
  right: Source;
  limits: { max_rows: number; max_attempts: number };
  report_markdown?: string;
  report_csv?: string;
  error_code?: string;
  artifact_id?: string;
};

async function request(workId: string, suffix = "", body?: unknown): Promise<any> {
  const response = await domainFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/price-comparisons${suffix}`,
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
    throw homunErrorFromHttp(response.status, result, "Confronto listini non disponibile");
  return result;
}
export async function listPriceComparisons(workId: string): Promise<PriceComparison[]> {
  return (await request(workId)).items;
}
export async function approvePriceComparison(
  workId: string,
  proposal: PriceComparison,
  commandId: string,
): Promise<PriceComparison> {
  return request(workId, `/${encodeURIComponent(proposal.id)}/approve`, {
    command_id: commandId,
    digest: proposal.digest,
    expected_version: proposal.expected_version,
  });
}
export async function preparePriceComparison(
  work: Work,
  left: File,
  right: File,
  operationId: string,
): Promise<PriceComparison> {
  if (!work.engineConversationId)
    throw new HomunClientError("validation_error", "Apri prima una conversazione del motore");
  for (const file of [left, right])
    if (!file.name.toLowerCase().endsWith(".csv") || file.size > 2 * 1024 * 1024) {
      throw new HomunClientError("validation_error", "Seleziona due CSV, ciascuno fino a 2 MB");
    }
  // A lost POST response must recover the durable proposal before reading a newer revision.
  const existing = (await listPriceComparisons(work.id)).find((item) => item.id === operationId);
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
        name: "Confronto listini",
      })
    ).projectId;
  const oldFile = await ingestEngineMaterial({
    projectId,
    file: left,
    commandId: operationId + ":left",
  });
  const newFile = await ingestEngineMaterial({
    projectId,
    file: right,
    commandId: operationId + ":right",
  });
  const current = (await listEngineWorks()).find((w) => w["id"] === work.id);
  if (!current) throw new HomunClientError("not_found", "Lavoro non accessibile");
  return request(work.id, "", {
    command_id: operationId,
    left_material_id: oldFile.materialId,
    right_material_id: newFile.materialId,
    expected_version: current["version"],
    max_rows: 10000,
  });
}
