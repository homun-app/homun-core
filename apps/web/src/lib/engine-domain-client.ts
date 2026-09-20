/**
 * Homun engine domain client (F2).
 * Explicit engine path only — never falls back to IndexedDB simulation.
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import { HomunClientError, homunErrorFromHttp } from "./homun-errors.ts";

export const DEFAULT_WORKSPACE_ID = "ws_local";

/** Default wait for domain commands that may call the model (post_message). */
export const ENGINE_COMMAND_TIMEOUT_MS = 130_000;

export type EngineActor = {
  id: string;
  displayName: string;
};

export type CommandResult = {
  command_id: string;
  type: string;
  status: string;
  result: Record<string, unknown>;
};

function newCommandId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

export async function domainFetch(
  path: string,
  init: RequestInit,
  baseUrl: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = init.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (cause) {
    if (isAbortError(cause) || controller.signal.aborted) {
      if (external?.aborted) {
        throw new HomunClientError("request_cancelled", "Richiesta annullata", {
          retryable: false,
          cause,
        });
      }
      throw new HomunClientError(
        "request_timeout",
        `Engine request timed out after ${Math.round(timeoutMs / 1000)}s`,
        { retryable: true, cause },
      );
    }
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

async function readError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  throw homunErrorFromHttp(response.status, body, fallback);
}

export async function postEngineCommand(input: {
  type: string;
  payload?: Record<string, unknown>;
  commandId?: string;
  workspaceId?: string;
  actor: EngineActor;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  const baseUrl = input.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const commandId = input.commandId ?? newCommandId("cmd");
  const timeoutMs = input.timeoutMs ?? ENGINE_COMMAND_TIMEOUT_MS;
  const response = await domainFetch(
    `/v1/workspaces/${workspaceId}/commands`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": input.actor.id,
        "X-Homun-Actor-Name": input.actor.displayName,
      },
      body: JSON.stringify({
        command_id: commandId,
        type: input.type,
        payload: input.payload ?? {},
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    baseUrl,
    timeoutMs,
  );
  if (!response.ok) {
    await readError(response, `Engine command failed with HTTP ${response.status}`);
  }
  return (await response.json()) as CommandResult;
}

export type StreamCommandHandlers = {
  onPhase?: (phase: string) => void;
  onToken?: (text: string) => void;
};

/** SSE post_message path — falls back to JSON commands if stream unavailable. */
export async function postEngineCommandStream(
  input: {
    type: string;
    payload?: Record<string, unknown>;
    commandId?: string;
    workspaceId?: string;
    actor: EngineActor;
    baseUrl?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
  handlers: StreamCommandHandlers = {},
): Promise<CommandResult> {
  const baseUrl = input.baseUrl ?? ENGINE_DEFAULT_BASE_URL;
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const commandId = input.commandId ?? newCommandId("cmd");
  const timeoutMs = input.timeoutMs ?? ENGINE_COMMAND_TIMEOUT_MS;
  const response = await domainFetch(
    `/v1/workspaces/${workspaceId}/commands/stream`,
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": input.actor.id,
        "X-Homun-Actor-Name": input.actor.displayName,
      },
      body: JSON.stringify({
        command_id: commandId,
        type: input.type,
        payload: input.payload ?? {},
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    baseUrl,
    timeoutMs,
  );
  if (response.status === 404) {
    return postEngineCommand(input);
  }
  if (!response.ok) {
    await readError(response, `Engine stream failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new HomunClientError("unknown", "Engine stream returned an empty body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: CommandResult | null = null;
  let streamError: HomunClientError | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n");
      let event = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (!dataLines.length) continue;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event === "phase" && typeof data["phase"] === "string") {
        handlers.onPhase?.(data["phase"]);
      } else if (event === "token" && typeof data["text"] === "string") {
        handlers.onToken?.(data["text"]);
      } else if (event === "result") {
        finalResult = data as CommandResult;
      } else if (event === "error") {
        const code = typeof data["code"] === "string" ? data["code"] : "stream_error";
        const message =
          typeof data["message"] === "string" ? data["message"] : "Engine stream error";
        streamError = new HomunClientError("unknown", message, {
          retryable: code === "provider_unavailable",
        });
      }
    }
  }

  if (streamError) {
    throw streamError;
  }
  if (!finalResult) {
    throw new HomunClientError("unknown", "Engine stream ended without a result");
  }
  return finalResult;
}

export type EngineFollowupNotice = {
  commandId: string;
  status: "processing" | "retry_scheduled" | "failed";
  errorCode: string | null;
  attempts: number;
};

function parseFollowupNotices(raw: unknown): EngineFollowupNotice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: Record<string, unknown>) => {
    if (!item || !["processing", "retry_scheduled", "failed"].includes(String(item["status"]))) return [];
    return [{ commandId: String(item["command_id"] ?? ""),
      status: item["status"] as EngineFollowupNotice["status"],
      errorCode: typeof item["error_code"] === "string" ? item["error_code"] : null,
      attempts: typeof item["attempts"] === "number" ? item["attempts"] : 0 }];
  });
}

export async function listEngineConversations(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<Array<{ id: string; title: string; project_id: string | null; version: number; followups: EngineFollowupNotice[] }>> {
  const response = await domainFetch(
    `/v1/workspaces/${workspaceId}/conversations`,
    { method: "GET", headers: { Accept: "application/json", "X-Homun-Actor-Id": actor.id } },
    baseUrl,
    15_000,
  );
  if (!response.ok) {
    await readError(response, `List conversations failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: Array<Record<string, unknown>> };
  return (body.items ?? []).map((item) => ({
    followups: parseFollowupNotices(item["followups"]),
    id: String(item["id"] ?? ""),
    title: String(item["title"] ?? ""),
    project_id: item["project_id"] != null ? String(item["project_id"]) : null,
    version: typeof item["version"] === "number" ? item["version"] : 1,
  }));
}

export async function listEngineWorks(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<Array<Record<string, unknown>>> {
  const response = await domainFetch(
    `/v1/workspaces/${workspaceId}/works`,
    { method: "GET", headers: { Accept: "application/json", "X-Homun-Actor-Id": actor.id } },
    baseUrl,
    15_000,
  );
  if (!response.ok) {
    await readError(response, `List works failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { items: Array<Record<string, unknown>> };
  return body.items;
}

export function defaultLocalActor(): EngineActor {
  return { id: "person_fabio", displayName: "Fabio" };
}
