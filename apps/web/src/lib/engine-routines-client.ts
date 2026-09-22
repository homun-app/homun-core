/** Engine routines client: the automation repeats the assignment, never the approval. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  postEngineCommand,
  domainFetch,
  type EngineActor,
} from "./engine-domain-client.ts";

export type RoutineTemplateStep = {
  title: string;
  assignee_id: string;
  capability: string;
  output_expected: string;
};

export type EngineRoutine = {
  id: string;
  name: string;
  cron: string;
  cron_timezone: string;
  conversation_id: string;
  template: { title: string; objective: string; plan_steps: RoutineTemplateStep[] };
  status: "active" | "paused" | "stopped";
  last_run_work_id: string | null;
  last_scheduled_for: string | null;
  revision: number;
};

async function routinesFetch(path: string, init: RequestInit, baseUrl: string): Promise<Response> {
  return domainFetch(path, init, baseUrl, 15_000);
}

export async function listEngineRoutines(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<EngineRoutine[]> {
  const response = await routinesFetch(
    `/v1/workspaces/${workspaceId}/routines`,
    { method: "GET", headers: { Accept: "application/json", "X-Homun-Actor-Id": actor.id } },
    baseUrl,
  );
  if (!response.ok) throw new Error(`List routines failed: HTTP ${response.status}`);
  const body = (await response.json()) as { items: EngineRoutine[] };
  return body.items ?? [];
}

export async function createEngineRoutine(input: {
  name: string;
  cron: string;
  cronTimezone?: string;
  conversationId: string;
  template: EngineRoutine["template"];
  commandId?: string;
  actor?: EngineActor;
}): Promise<{ routine_id: string }> {
  const result = await postEngineCommand({
    type: "routine.create",
    payload: {
      name: input.name,
      cron: input.cron,
      cron_timezone: input.cronTimezone ?? "Europe/Rome",
      conversation_id: input.conversationId,
      template: input.template,
    },
    actor: input.actor ?? defaultLocalActor(),
  });
  return { routine_id: String(result.result["routine_id"] ?? "") };
}

export async function routineEngineAction(input: {
  routineId: string;
  action: "pause" | "resume" | "stop";
  expectedVersion: number;
  actor?: EngineActor;
}): Promise<void> {
  await postEngineCommand({
    type: `routine.${input.action}`,
    payload: { routine_id: input.routineId, expected_version: input.expectedVersion },
    actor: input.actor ?? defaultLocalActor(),
  });
}

export async function previewEngineCron(
  cron: string,
  timezone = "Europe/Rome",
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<string[]> {
  const url = `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/routines/preview?cron=${encodeURIComponent(cron)}&tz=${encodeURIComponent(timezone)}`;
  const response = await routinesFetch(
    url, { method: "GET", headers: { Accept: "application/json" } }, baseUrl,
  );
  if (!response.ok) throw new Error(`Cron preview failed: HTTP ${response.status}`);
  const body = (await response.json()) as { next: string[] };
  return body.next ?? [];
}
