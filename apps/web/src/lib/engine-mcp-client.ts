/** MCP server declarations and skills: person-approved, never silent. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  postEngineCommand,
  domainFetch,
  type EngineActor,
} from "./engine-domain-client.ts";

export type ExternalServer = {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  tools_include: string[];
  tools_exclude: string[];
  status: "enabled" | "disabled";
  revision: number;
};

export type ProbeResult = {
  ok: true;
  server_info: { name?: string; version?: string };
  tools: string[];
  tool_count_total: number;
};

export type Skill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  status: "staged" | "approved" | "archived";
  author_type: "person" | "agent";
  revision: number;
  body: string | null;
};

async function mcpFetch(path: string, init: RequestInit): Promise<Response> {
  return domainFetch(path, init, ENGINE_DEFAULT_BASE_URL, 15_000);
}

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Homun-Actor-Id": defaultLocalActor().id,
};

export async function listEngineServers(): Promise<ExternalServer[]> {
  const response = await mcpFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/mcp/servers`,
    { method: "GET", headers: jsonHeaders });
  if (!response.ok) throw new Error(`List MCP servers failed: HTTP ${response.status}`);
  return ((await response.json()) as { items: ExternalServer[] }).items ?? [];
}

export async function createEngineServer(input: {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  toolsInclude?: string[];
  toolsExclude?: string[];
}): Promise<{ server_id: string }> {
  const result = await postEngineCommand({
    type: "external.create",
    payload: {
      name: input.name,
      transport: input.transport,
      command: input.command ?? "",
      args: input.args ?? [],
      url: input.url ?? "",
      tools_include: input.toolsInclude ?? [],
      tools_exclude: input.toolsExclude ?? [],
    },
    actor: defaultLocalActor(),
  });
  return { server_id: String(result.result["server_id"] ?? "") };
}

export async function removeEngineServer(serverId: string, expectedVersion: number): Promise<void> {
  await postEngineCommand({
    type: "external.remove",
    payload: { server_id: serverId, expected_version: expectedVersion },
    actor: defaultLocalActor(),
  });
}

export async function probeEngineServer(serverId: string): Promise<ProbeResult> {
  const response = await mcpFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/mcp/servers/${encodeURIComponent(serverId)}/test`,
    { method: "POST", headers: jsonHeaders });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(detail?.detail?.message ?? `Probe failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ProbeResult;
}

export async function listEngineSkills(): Promise<Skill[]> {
  const response = await mcpFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/skills`,
    { method: "GET", headers: jsonHeaders });
  if (!response.ok) throw new Error(`List skills failed: HTTP ${response.status}`);
  return ((await response.json()) as { items: Skill[] }).items ?? [];
}

export async function createEngineSkill(input: {
  name: string;
  description: string;
  body: string;
  authorType?: "person" | "agent";
}): Promise<{ skill_id: string; status: string }> {
  const result = await postEngineCommand({
    type: "skill.create",
    payload: {
      name: input.name,
      description: input.description,
      body: input.body,
      author_type: input.authorType ?? "person",
    },
    actor: defaultLocalActor(),
  });
  return {
    skill_id: String(result.result["skill_id"] ?? ""),
    status: String(result.result["status"] ?? "staged"),
  };
}

export async function skillEngineAction(input: {
  skillId: string;
  action: "approve" | "reject" | "archive";
  expectedVersion: number;
}): Promise<void> {
  await postEngineCommand({
    type: `skill.${input.action}`,
    payload: { skill_id: input.skillId, expected_version: input.expectedVersion },
    actor: defaultLocalActor(),
  });
}
