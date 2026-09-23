/** Typed transport for a supervised model synthesis phase. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch, listEngineWorks } from "./engine-domain-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";
import type { Work } from "../components/builder/conversation-types.ts";

type Source = { id: string; title: string; sha256: string; version: number };
type SkillBinding = { id: string; name: string; revision: number };

export type SynthesisProposal = {
  id: string;
  work_id: string;
  digest: string;
  expected_version: number;
  status: "pending_approval" | "queued" | "running" | "completed" | "failed" | "blocked";
  tool_version: string;
  materials: Source[];
  skills: SkillBinding[];
  assignee_id: string;
  step_title: string;
  limits: {
    max_materials: number;
    max_context_characters: number;
    max_output_characters: number;
    max_attempts: number;
  };
  artifact_id?: string;
  error_code?: string;
  summary?: {
    characters?: number;
    model_id?: string | null;
    connection?: "collaboratore" | "spazio";
    truncated?: boolean;
  };
};

async function request(workId: string, suffix = "", body?: unknown): Promise<any> {
  const response = await domainFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/syntheses${suffix}`,
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
    throw homunErrorFromHttp(response.status, result, "Sintesi non disponibile");
  return result;
}

export async function listSyntheses(workId: string): Promise<SynthesisProposal[]> {
  return (await request(workId)).items;
}

export async function approveSynthesis(
  workId: string,
  proposal: SynthesisProposal,
  commandId: string,
): Promise<SynthesisProposal> {
  return request(workId, `/${encodeURIComponent(proposal.id)}/approve`, {
    command_id: commandId,
    digest: proposal.digest,
    expected_version: proposal.expected_version,
  });
}

export async function prepareSynthesis(
  work: Work,
  materialIds: string[],
  operationId: string,
  skillIds: string[] = [],
): Promise<SynthesisProposal> {
  // A lost POST response must recover the durable proposal before reading a newer revision.
  const existing = (await listSyntheses(work.id)).find((item) => item.id === operationId);
  if (existing) return existing;
  const current = (await listEngineWorks()).find((w) => w["id"] === work.id);
  if (!current) throw homunErrorFromHttp(404, { detail: "Lavoro non accessibile" }, "Lavoro non accessibile");
  return request(work.id, "", {
    command_id: operationId,
    material_ids: materialIds,
    skill_ids: skillIds,
    expected_version: current["version"],
  });
}
