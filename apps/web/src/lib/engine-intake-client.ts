/** Durable work briefs; none of these reads implies assignment or execution. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch } from "./engine-domain-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";
export type WorkIntakeChange = {
  field: string;
  from_value?: string | string[] | null;
  to_value?: string | string[] | null;
};
export type WorkIntakePlanStep = {
  title: string;
  capability: "compare_csv" | "read_material" | "synthesize" | "general";
  expected_materials: string[];
  output_expected: string;
  assignee: string;
};
export type WorkIntake = {
  id: string;
  work_id: string;
  status: "pending_confirmation" | "confirmed" | "failed";
  expected_version: number;
  digest: string;
  title: string;
  objective: string;
  output: string;
  constraints: string[];
  missing_information: string[];
  suggested_agent: { id: string; name: string; role: string; revision: number } | null;
  new_agent: { name: string; role: string; instructions: string } | null;
  rationale: string;
  capability: "compare_csv" | "read_material" | "synthesize" | "general";
  original_request: string;
  /** Fields the model declared as changed; older proposals may not carry them. */
  changed_fields?: string[];
  changes?: WorkIntakeChange[];
  error_code?: string;
  /** Declared phases (raccolta → confronto → sintesi); older proposals lack them. */
  plan_steps?: WorkIntakePlanStep[];
};
async function request<T>(
  workId: string,
  suffix: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await domainFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/intake${suffix}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": defaultLocalActor().id,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    },
    ENGINE_DEFAULT_BASE_URL,
    180_000,
  );
  const result = await response.json();
  if (!response.ok)
    throw homunErrorFromHttp(response.status, result, "Proposta di lavoro non disponibile");
  return result as T;
}
export async function listWorkIntakes(workId: string, signal?: AbortSignal): Promise<WorkIntake[]> {
  return (await request<{ items: WorkIntake[] }>(workId, "", undefined, signal)).items;
}
export function confirmWorkIntake(
  workId: string,
  proposal: WorkIntake,
  commandId: string,
  createAgent: boolean,
): Promise<WorkIntake> {
  return request(workId, `/${encodeURIComponent(proposal.id)}/confirm`, {
    command_id: commandId,
    digest: proposal.digest,
    expected_version: proposal.expected_version,
    create_agent: createAgent,
  });
}

export type WorkIntakeKind = "work_request" | "question";
export type WorkIntakeClassification = { kind: WorkIntakeKind; language?: string | null };

/** Stateless routing aid: the engine stores nothing, so failures are simply retried or ignored. */
export async function classifyWorkIntake(
  workId: string,
  text: string,
  signal?: AbortSignal,
): Promise<WorkIntakeClassification> {
  return request<{ kind: WorkIntakeKind; language?: string | null }>(
    workId,
    "/classify",
    { text },
    signal,
  );
}

export function proposeWorkIntake(
  workId: string,
  text: string,
  expectedVersion: number,
  commandId: string,
  signal?: AbortSignal,
  language?: string,
): Promise<WorkIntake> {
  return request(
    workId,
    "",
    {
      command_id: commandId,
      text,
      expected_version: expectedVersion,
      ...(language ? { language } : {}),
    },
    signal,
  );
}

/**
 * Where a chat message goes while no agreement is confirmed: an open question
 * stays in the conversation, everything else keeps the durable intake path.
 */
export function resolveFirstMessageRoute(input: {
  hasIntake: boolean;
  intakeConfirmed: boolean;
  isNewRequest: boolean;
  classification?: WorkIntakeKind;
}): "chat" | "propose" {
  const needsAgreement =
    (input.hasIntake && !input.intakeConfirmed) ||
    (!input.hasIntake && input.isNewRequest);
  if (!needsAgreement) return "chat";
  return input.classification === "question" ? "chat" : "propose";
}
