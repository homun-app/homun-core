/**
 * Homun engine projects + teams + grants + materials client (B1–B3).
 * Membership is organizational only; AccessGrant is deny-by-default for projects.
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  postEngineCommand,
  type EngineActor,
} from "./engine-domain-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type EngineProject = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  version: number;
  team_ids: string[];
  member_ids: string[];
  conversation_ids: string[];
  status: string;
};

export type EngineTeam = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  revision: number;
  member_ids: string[];
  coordinator_id: string | null;
  status: string;
};

export type EngineGrant = {
  id: string;
  workspace_id: string;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  capability: string;
  issuer_id: string;
  status: string;
  expires_at: string | null;
};

export type EngineMaterial = {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  kind: string;
  text: string;
  source_uri: string | null;
  content_hash: string | null;
  mime_type: string | null;
  origin_name?: string | null;
  relative_path?: string | null;
  storage_relpath?: string | null;
  byte_size?: number | null;
  extract_status?: string;
  version: number;
  status: string;
  created_by: string;
};

export type GrantCapability = "read" | "write" | "admin";
export type MaterialKind = "note" | "link" | "file_ref";

async function orgFetch(path: string, init: RequestInit, baseUrl: string): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }
}

function actorHeaders(actor: EngineActor): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Homun-Actor-Id": actor.id,
    "X-Homun-Actor-Name": actor.displayName,
  };
}

async function readError(response: Response, fallback: string): Promise<never> {
  const body = await response.json().catch(() => null);
  throw homunErrorFromHttp(response.status, body, fallback);
}

export async function listEngineProjects(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<EngineProject[]> {
  const response = await orgFetch(
    `/v1/workspaces/${workspaceId}/projects`,
    { method: "GET", headers: actorHeaders(actor) },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List projects failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: EngineProject[] };
  return body.items ?? [];
}

export async function listEngineTeams(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<EngineTeam[]> {
  const response = await orgFetch(
    `/v1/workspaces/${workspaceId}/teams`,
    { method: "GET", headers: { Accept: "application/json" } },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List teams failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: EngineTeam[] };
  return body.items ?? [];
}

export async function listEngineGrants(input: {
  projectId: string;
  workspaceId?: string;
  baseUrl?: string;
  actor?: EngineActor;
}): Promise<EngineGrant[]> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const baseUrl = input.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const actor = input.actor ?? defaultLocalActor();
  const response = await orgFetch(
    `/v1/workspaces/${workspaceId}/grants?project_id=${encodeURIComponent(input.projectId)}`,
    { method: "GET", headers: actorHeaders(actor) },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List grants failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: EngineGrant[] };
  return body.items ?? [];
}

export async function listEngineMaterials(input: {
  projectId: string;
  includeArchived?: boolean;
  workspaceId?: string;
  baseUrl?: string;
  actor?: EngineActor;
}): Promise<EngineMaterial[]> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const baseUrl = input.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const actor = input.actor ?? defaultLocalActor();
  const qs = input.includeArchived ? "?include_archived=true" : "";
  const response = await orgFetch(
    `/v1/workspaces/${workspaceId}/projects/${encodeURIComponent(input.projectId)}/materials${qs}`,
    { method: "GET", headers: actorHeaders(actor) },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `List materials failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: EngineMaterial[] };
  return body.items ?? [];
}

export async function createEngineProject(input: {
  name: string;
  description?: string;
  memberIds?: string[];
  teamIds?: string[];
  actor?: EngineActor;
}): Promise<{ projectId: string; version: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "project.create",
    payload: {
      name: input.name,
      description: input.description ?? "",
      member_ids: input.memberIds ?? [],
      team_ids: input.teamIds ?? [],
    },
    actor,
  });
  return {
    projectId: String(result.result["project_id"] ?? ""),
    version: typeof result.result["version"] === "number" ? result.result["version"] : 1,
  };
}

export async function updateEngineProject(input: {
  projectId: string;
  expectedVersion: number;
  name?: string;
  description?: string;
  memberIds?: string[];
  teamIds?: string[];
  status?: string;
  actor?: EngineActor;
}): Promise<{ version: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const payload: Record<string, unknown> = {
    project_id: input.projectId,
    expected_version: input.expectedVersion,
  };
  if (input.name !== undefined) payload["name"] = input.name;
  if (input.description !== undefined) payload["description"] = input.description;
  if (input.memberIds !== undefined) payload["member_ids"] = input.memberIds;
  if (input.teamIds !== undefined) payload["team_ids"] = input.teamIds;
  if (input.status !== undefined) payload["status"] = input.status;
  const result = await postEngineCommand({ type: "project.update", payload, actor });
  return {
    version:
      typeof result.result["version"] === "number"
        ? result.result["version"]
        : input.expectedVersion + 1,
  };
}

export async function issueEngineGrant(input: {
  projectId: string;
  subjectId: string;
  capability: GrantCapability;
  expiresAt?: string | null;
  actor?: EngineActor;
}): Promise<{ grantId: string }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "grant.issue",
    payload: {
      project_id: input.projectId,
      subject_id: input.subjectId,
      capability: input.capability,
      expires_at: input.expiresAt ?? null,
    },
    actor,
  });
  return { grantId: String(result.result["grant_id"] ?? "") };
}

export async function revokeEngineGrant(input: {
  grantId: string;
  actor?: EngineActor;
}): Promise<void> {
  const actor = input.actor ?? defaultLocalActor();
  await postEngineCommand({
    type: "grant.revoke",
    payload: { grant_id: input.grantId },
    actor,
  });
}

export async function createEngineMaterial(input: {
  projectId: string;
  title: string;
  kind: MaterialKind;
  text?: string;
  sourceUri?: string | null;
  actor?: EngineActor;
}): Promise<{ materialId: string; version: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "material.create",
    payload: {
      project_id: input.projectId,
      title: input.title,
      kind: input.kind,
      text: input.text ?? "",
      source_uri: input.sourceUri ?? null,
    },
    actor,
  });
  return {
    materialId: String(result.result["material_id"] ?? ""),
    version: typeof result.result["version"] === "number" ? result.result["version"] : 1,
  };
}

export async function ingestEngineMaterial(input: {
  projectId: string;
  /** Reuse this identity when retrying the same upload after a lost response. */
  commandId?: string;
  file: File;
  title?: string;
  relativePath?: string;
  workspaceId?: string;
  baseUrl?: string;
  actor?: EngineActor;
}): Promise<{
  materialId: string;
  extractStatus: string;
  title: string;
  version: number;
  /** False when identical bytes were already in the project (idempotent re-ingest). */
  created: boolean;
}> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const baseUrl = input.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const actor = input.actor ?? defaultLocalActor();
  const form = new FormData();
  form.append("file", input.file, input.file.name);
  if (input.title) form.append("title", input.title);
  if (input.relativePath) form.append("relative_path", input.relativePath);
  const response = await orgFetch(
    `/v1/workspaces/${workspaceId}/projects/${encodeURIComponent(input.projectId)}/materials/ingest`,
    {
      method: "POST",
      headers: {
        "X-Homun-Command-Id": input.commandId ?? `cmd_ingest_${crypto.randomUUID()}`,
        "X-Homun-Actor-Id": actor.id,
        "X-Homun-Actor-Name": actor.displayName,
      },
      body: form,
    },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Material ingest failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  return {
    materialId: String(body["material_id"] ?? ""),
    extractStatus: String(body["extract_status"] ?? "none"),
    title: String(body["title"] ?? input.file.name),
    version: typeof body["version"] === "number" ? body["version"] : 1,
    created: body["created"] !== false,
  };
}

export async function getEngineMaterialContent(input: {
  materialId: string;
  workspaceId?: string;
  baseUrl?: string;
  actor?: EngineActor;
}): Promise<{
  materialId: string;
  title: string;
  extractStatus: string;
  text: string;
  mimeType: string | null;
}> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const baseUrl = input.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const actor = input.actor ?? defaultLocalActor();
  const response = await orgFetch(
    `/v1/workspaces/${workspaceId}/materials/${encodeURIComponent(input.materialId)}/content`,
    { method: "GET", headers: actorHeaders(actor) },
    baseUrl,
  );
  if (!response.ok) {
    await readError(response, `Material content failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  return {
    materialId: String(body["material_id"] ?? input.materialId),
    title: String(body["title"] ?? ""),
    extractStatus: String(body["extract_status"] ?? "none"),
    text: String(body["text"] ?? ""),
    mimeType: body["mime_type"] != null ? String(body["mime_type"]) : null,
  };
}

export async function provideEngineContribution(input: {
  requestId: string;
  expectedVersion: number;
  text?: string;
  materialIds?: string[];
  actor?: EngineActor;
}): Promise<{ version: number; status: string; materialIds: string[] }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "work.provide_contribution",
    payload: {
      request_id: input.requestId,
      expected_version: input.expectedVersion,
      text: input.text ?? "",
      material_ids: input.materialIds ?? [],
    },
    actor,
  });
  const materialIds = Array.isArray(result.result["material_ids"])
    ? result.result["material_ids"].map(String)
    : [];
  return {
    version:
      typeof result.result["version"] === "number"
        ? result.result["version"]
        : input.expectedVersion + 1,
    status: String(result.result["status"] ?? ""),
    materialIds,
  };
}

export async function ensureEngineProjectForConversation(input: {
  conversationId: string;
  expectedVersion: number;
  name?: string;
  actor?: EngineActor;
}): Promise<{ projectId: string }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "project.create_from_conversation",
    payload: {
      conversation_id: input.conversationId,
      expected_version: input.expectedVersion,
      name: input.name ?? "Materiali",
    },
    actor,
  });
  return { projectId: String(result.result["project_id"] ?? "") };
}

export async function archiveEngineMaterial(input: {
  materialId: string;
  expectedVersion: number;
  actor?: EngineActor;
}): Promise<void> {
  const actor = input.actor ?? defaultLocalActor();
  await postEngineCommand({
    type: "material.archive",
    payload: {
      material_id: input.materialId,
      expected_version: input.expectedVersion,
    },
    actor,
  });
}

export async function createEngineTeam(input: {
  name: string;
  description?: string;
  memberIds?: string[];
  coordinatorId?: string | null;
  actor?: EngineActor;
}): Promise<{ teamId: string; revision: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const result = await postEngineCommand({
    type: "team.create",
    payload: {
      name: input.name,
      description: input.description ?? "",
      member_ids: input.memberIds ?? [],
      coordinator_id: input.coordinatorId ?? null,
    },
    actor,
  });
  return {
    teamId: String(result.result["team_id"] ?? ""),
    revision: typeof result.result["revision"] === "number" ? result.result["revision"] : 1,
  };
}

export async function updateEngineTeam(input: {
  teamId: string;
  expectedVersion: number;
  name?: string;
  description?: string;
  memberIds?: string[];
  coordinatorId?: string | null;
  status?: string;
  actor?: EngineActor;
}): Promise<{ revision: number }> {
  const actor = input.actor ?? defaultLocalActor();
  const payload: Record<string, unknown> = {
    team_id: input.teamId,
    expected_version: input.expectedVersion,
  };
  if (input.name !== undefined) payload["name"] = input.name;
  if (input.description !== undefined) payload["description"] = input.description;
  if (input.memberIds !== undefined) payload["member_ids"] = input.memberIds;
  if (input.coordinatorId !== undefined) payload["coordinator_id"] = input.coordinatorId;
  if (input.status !== undefined) payload["status"] = input.status;
  const result = await postEngineCommand({ type: "team.update", payload, actor });
  return {
    revision:
      typeof result.result["revision"] === "number"
        ? result.result["revision"]
        : input.expectedVersion + 1,
  };
}

