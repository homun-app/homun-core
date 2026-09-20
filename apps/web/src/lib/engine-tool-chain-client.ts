/** Typed transport for tool chains: one approval enumerating every effect. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  domainFetch,
  listEngineWorks,
} from "./engine-domain-client.ts";
import { HomunClientError, homunErrorFromHttp } from "./homun-errors.ts";
import type { Work } from "../components/builder/conversation-types.ts";

export type ChainStep = {
  id?: string;
  capability: "read_material" | "compare_csv";
  tool_version?: string;
  materials: Array<{ id: string; title: string; sha256: string; version: number }>;
  proposal_id?: string;
};

export type ToolChain = {
  id: string;
  work_id: string;
  status: "pending_approval" | "queued" | "running" | "completed" | "failed" | "blocked";
  digest: string;
  expected_version: number;
  steps: ChainStep[];
  error_code?: string | null;
};

async function request(workId: string, suffix = "", body?: unknown): Promise<any> {
  const response = await domainFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/tool-chains${suffix}`,
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
    throw homunErrorFromHttp(response.status, result, "Catena di strumenti non disponibile");
  return result;
}

export async function listToolChains(workId: string, signal?: AbortSignal): Promise<ToolChain[]> {
  return (await request(workId, "", undefined)).items;
}

export async function proposeToolChain(
  work: Work,
  materialIds: string[],
  operationId: string,
): Promise<ToolChain> {
  const existing = (await listToolChains(work.id)).find((item) => item.id === operationId);
  if (existing) return existing;
  const current = (await listEngineWorks()).find((w) => w["id"] === work.id);
  if (!current) throw new HomunClientError("not_found", "Lavoro non accessibile");
  return request(work.id, "", {
    command_id: operationId,
    steps: materialIds.map((materialId) => ({
      capability: "read_material",
      material_id: materialId,
    })),
    expected_version: current["version"],
  });
}

export async function approveToolChain(
  workId: string,
  chain: ToolChain,
  commandId: string,
): Promise<ToolChain> {
  return request(workId, `/${encodeURIComponent(chain.id)}/approve`, {
    command_id: commandId,
    digest: chain.digest,
    expected_version: chain.expected_version,
  });
}
