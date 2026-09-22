/**
 * Homun engine agents client (agents foundation slice A).
 * Explicit engine path — never invents collaborators when the engine is down.
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  postEngineCommand,
  type EngineActor,
} from "./engine-domain-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type EngineAgentProfile = {
  id: string;
  workspace_id: string;
  name: string;
  revision: number;
  role: string;
  avatar?: string | null;
  instructions: string;
  preferred_connection_id?: string | null;
  status: string;
  // Professional identity (structured, versioned).
  responsibility?: string;
  specializations?: string[];
  method?: string;
  tone?: string;
  autonomy_mode?: string;
  capabilities?: string[];
  created_at?: string;
  updated_at?: string;
};

async function agentsFetch(path: string, init: RequestInit, baseUrl: string): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }
}

async function readError(response: Response, fallback: string): Promise<never> {
  const body = await response.json().catch(() => null);
  throw homunErrorFromHttp(response.status, body, fallback);
}

export async function listEngineAgents(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<EngineAgentProfile[]> {
  const response = await agentsFetch(
    `/v1/workspaces/${workspaceId}/agents`,
    { method: "GET", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List agents failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: EngineAgentProfile[] };
  return body.items ?? [];
}

export async function getEngineAgent(
  agentId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<EngineAgentProfile> {
  const response = await agentsFetch(
    `/v1/workspaces/${workspaceId}/agents/${encodeURIComponent(agentId)}`,
    { method: "GET", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Get agent failed with HTTP ${response.status}`);
  }
  return (await response.json()) as EngineAgentProfile;
}

export async function createEngineAgent(input: {
  name: string;
  role?: string;
  instructions?: string;
  preferredConnectionId?: string | null;
  status?: string;
  avatar?: string | null;
  actor?: EngineActor;
  workspaceId?: string;
}): Promise<{ agentId: string; revision: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "agent.create",
    payload: {
      name: input.name,
      role: input.role ?? "",
      instructions: input.instructions ?? "",
      preferred_connection_id: input.preferredConnectionId ?? null,
      status: input.status ?? "active",
      avatar: input.avatar ?? null,
    },
    actor,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  return {
    agentId: String(result.result["agent_id"] ?? ""),
    revision: typeof result.result["revision"] === "number" ? result.result["revision"] : 1,
  };
}

export async function updateEngineAgent(input: {
  agentId: string;
  expectedVersion: number;
  role?: string;
  instructions?: string;
  preferredConnectionId?: string | null;
  status?: string;
  avatar?: string | null;
  responsibility?: string;
  specializations?: string[];
  method?: string;
  tone?: string;
  autonomyMode?: string;
  capabilities?: string[];
  actor?: EngineActor;
  workspaceId?: string;
}): Promise<{ revision: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const payload: Record<string, unknown> = {
    agent_id: input.agentId,
    expected_version: input.expectedVersion,
  };
  if (input.role !== undefined) payload["role"] = input.role;
  if (input.instructions !== undefined) payload["instructions"] = input.instructions;
  if (input.preferredConnectionId !== undefined) {
    payload["preferred_connection_id"] = input.preferredConnectionId;
  }
  if (input.status !== undefined) payload["status"] = input.status;
  if (input.avatar !== undefined) payload["avatar"] = input.avatar;
  if (input.responsibility !== undefined) payload["responsibility"] = input.responsibility;
  if (input.specializations !== undefined) payload["specializations"] = input.specializations;
  if (input.method !== undefined) payload["method"] = input.method;
  if (input.tone !== undefined) payload["tone"] = input.tone;
  if (input.autonomyMode !== undefined) payload["autonomy_mode"] = input.autonomyMode;
  if (input.capabilities !== undefined) payload["capabilities"] = input.capabilities;
  const result = await postEngineCommand({
    type: "agent.update",
    payload,
    actor,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  return {
    revision: typeof result.result["revision"] === "number" ? result.result["revision"] : input.expectedVersion + 1,
  };
}
