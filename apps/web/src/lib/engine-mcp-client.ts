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

export type ExternalToolCall = {
  id: string;
  status: "pending_approval" | "running" | "completed" | "failed";
  work_id: string;
  server_id: string;
  server_name: string;
  tool: string;
  arguments: Record<string, unknown>;
  digest: string;
  artifact_id?: string | null;
  error?: string | null;
};

export async function proposeEngineToolCall(input: {
  workId: string;
  serverId: string;
  tool: string;
  argsJson: string;
}): Promise<ExternalToolCall> {
  let arguments_: Record<string, unknown> = {};
  if (input.argsJson.trim()) {
    arguments_ = JSON.parse(input.argsJson) as Record<string, unknown>;
  }
  const response = await mcpFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/mcp/tools/propose`, {
    method: "POST",
    headers: { ...jsonHeaders },
    body: JSON.stringify({
      command_id: crypto.randomUUID(),
      work_id: input.workId,
      server_id: input.serverId,
      tool: input.tool,
      arguments: arguments_,
    }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(detail?.detail?.message ?? `Propose failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ExternalToolCall;
}

export async function approveEngineToolCall(proposalId: string, digest: string): Promise<ExternalToolCall> {
  const response = await mcpFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/mcp/tools/${encodeURIComponent(proposalId)}/approve`,
    {
      method: "POST",
      headers: { ...jsonHeaders },
      body: JSON.stringify({ command_id: crypto.randomUUID(), digest }),
    });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(detail?.detail?.message ?? `Approve failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ExternalToolCall;
}

export async function listEngineToolCalls(workId: string): Promise<ExternalToolCall[]> {
  const response = await mcpFetch(
    `/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/mcp/tools`,
    { method: "GET", headers: jsonHeaders });
  if (!response.ok) throw new Error(`List tool calls failed: HTTP ${response.status}`);
  return ((await response.json()) as { items: ExternalToolCall[] }).items ?? [];
}

export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  command: string;
  args_prefix: string[];
  needs_path: string | null;
  tools_include: string[];
  tools_exclude: string[];
  source: string;
  notes: string;
};

export async function listEngineCatalog(): Promise<CatalogEntry[]> {
  const response = await mcpFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/mcp/catalog`,
    { method: "GET", headers: jsonHeaders });
  if (!response.ok) throw new Error(`Catalog failed: HTTP ${response.status}`);
  return ((await response.json()) as { items: CatalogEntry[] }).items ?? [];
}

export async function declareCatalogEntry(input: {
  entry: CatalogEntry;
  path?: string | undefined;
}): Promise<{ server_id: string }> {
  const args = [...input.entry.args_prefix];
  if (input.entry.needs_path && input.path?.trim()) {
    if (input.entry.args_prefix.length > 0 && input.entry.args_prefix[input.entry.args_prefix.length - 1]?.startsWith("--")) {
      args.push(input.path.trim());
    } else {
      args.push(input.path.trim());
    }
  }
  return createEngineServer({
    name: input.entry.name,
    transport: input.entry.transport,
    command: input.entry.command,
    args,
    toolsInclude: input.entry.tools_include,
    toolsExclude: input.entry.tools_exclude,
  });
}
