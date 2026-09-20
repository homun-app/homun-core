/**
 * Homun engine MemoryPort client (F3.5a slice A).
 * Approved notes only — never auto-captured from chat.
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import { HomunClientError, homunErrorFromHttp } from "./homun-errors.ts";
import { DEFAULT_WORKSPACE_ID } from "./engine-domain-client.ts";

export type EngineMemoryNote = {
  id: string;
  workspace_id: string;
  text: string;
  work_id: string | null;
  project_id: string | null;
  status: "approved" | "rectified" | "deleted";
  created_at: string;
  updated_at: string;
  created_by: string;
};

export type MemoryListResult = {
  memories: EngineMemoryNote[];
};

async function memoryFetch(path: string, init?: RequestInit, baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<Response> {
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

export async function listEngineMemories(options?: {
  workspaceId?: string;
  projectId?: string | null;
  workId?: string | null;
  includeDeleted?: boolean;
  baseUrl?: string;
}): Promise<EngineMemoryNote[]> {
  const workspaceId = options?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const params = new URLSearchParams();
  if (options?.projectId) params.set("project_id", options.projectId);
  if (options?.workId) params.set("work_id", options.workId);
  if (options?.includeDeleted) params.set("include_deleted", "true");
  const qs = params.toString();
  const path = `/v1/workspaces/${workspaceId}/memories${qs ? `?${qs}` : ""}`;
  const response = await memoryFetch(path, undefined, options?.baseUrl);
  if (!response.ok) {
    await readError(response, "Failed to list memories");
  }
  const body = (await response.json()) as MemoryListResult;
  return body.memories;
}

export async function addEngineMemory(options: {
  text: string;
  actorId: string;
  workspaceId?: string;
  workId?: string | null;
  projectId?: string | null;
  baseUrl?: string;
}): Promise<EngineMemoryNote> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const response = await memoryFetch(
    `/v1/workspaces/${workspaceId}/memories`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": options.actorId,
      },
      body: JSON.stringify({
        text: options.text,
        work_id: options.workId ?? null,
        project_id: options.projectId ?? null,
      }),
    },
    options.baseUrl,
  );
  if (!response.ok) {
    await readError(response, "Failed to add memory");
  }
  return (await response.json()) as EngineMemoryNote;
}

export async function deleteEngineMemory(options: {
  memoryId: string;
  actorId: string;
  workspaceId?: string;
  baseUrl?: string;
}): Promise<EngineMemoryNote> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const response = await memoryFetch(
    `/v1/workspaces/${workspaceId}/memories/${options.memoryId}`,
    {
      method: "DELETE",
      headers: { "X-Homun-Actor-Id": options.actorId },
    },
    options.baseUrl,
  );
  if (!response.ok) {
    await readError(response, "Failed to delete memory");
  }
  return (await response.json()) as EngineMemoryNote;
}

export async function rectifyEngineMemory(options: {
  memoryId: string;
  text: string;
  actorId: string;
  workspaceId?: string;
  baseUrl?: string;
}): Promise<EngineMemoryNote> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const response = await memoryFetch(
    `/v1/workspaces/${workspaceId}/memories/${options.memoryId}/rectify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": options.actorId,
      },
      body: JSON.stringify({ text: options.text }),
    },
    options.baseUrl,
  );
  if (!response.ok) {
    await readError(response, "Failed to rectify memory");
  }
  return (await response.json()) as EngineMemoryNote;
}

export async function exportEngineMemories(options?: {
  workspaceId?: string;
  projectId?: string | null;
  baseUrl?: string;
}): Promise<EngineMemoryNote[]> {
  const workspaceId = options?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const params = new URLSearchParams();
  if (options?.projectId) params.set("project_id", options.projectId);
  const qs = params.toString();
  const path = `/v1/workspaces/${workspaceId}/memories/export${qs ? `?${qs}` : ""}`;
  const response = await memoryFetch(path, undefined, options?.baseUrl);
  if (!response.ok) {
    await readError(response, "Failed to export memories");
  }
  const body = (await response.json()) as MemoryListResult;
  return body.memories;
}

export type EngineMemoryStatus = {
  backend: "sqlite" | "mem0" | string;
  ok: boolean;
  detail: string;
  ollama_url?: string;
  llm_model?: string;
  embed_model?: string;
  qdrant_host?: string;
  qdrant_port?: number;
  collection?: string;
};

export async function fetchEngineMemoryStatus(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<EngineMemoryStatus> {
  const response = await memoryFetch("/v1/memory/status", undefined, baseUrl);
  if (!response.ok) {
    await readError(response, "Failed to read memory status");
  }
  return (await response.json()) as EngineMemoryStatus;
}

export async function recallEngineMemories(options: {
  query: string;
  workspaceId?: string;
  projectId?: string | null;
  limit?: number;
  baseUrl?: string;
}): Promise<EngineMemoryNote[]> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const params = new URLSearchParams();
  params.set("q", options.query);
  if (options.projectId) params.set("project_id", options.projectId);
  if (options.limit) params.set("limit", String(options.limit));
  const path = `/v1/workspaces/${workspaceId}/memories/recall?${params.toString()}`;
  const response = await memoryFetch(path, undefined, options.baseUrl);
  if (!response.ok) {
    await readError(response, "Failed to recall memories");
  }
  const body = (await response.json()) as MemoryListResult;
  return body.memories;
}

export function assertMemoryNote(note: EngineMemoryNote): void {
  if (!note.id || !note.text) {
    throw new HomunClientError("validation_error", "Invalid memory note payload");
  }
}
