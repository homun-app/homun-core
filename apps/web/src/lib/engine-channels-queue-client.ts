/**
 * Client for Channel Inbound Queue and Recovery (H32/H33/D1).
 */

import { ENGINE_DEFAULT_BASE_URL, EngineUnavailableError } from "./engine-client.ts";
import { homunErrorFromHttp } from "./homun-errors.ts";

export type InboundQueueItem = {
  id: string;
  platform: string;
  status: "pending" | "processing" | "completed" | "failed";
  claim_owner: string | null;
  claimed_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type InboundQueueResponse = {
  count: number;
  items: InboundQueueItem[];
};

export type RecoverQueueResponse = {
  recovered_count: number;
};

async function queueFetch(path: string, init?: RequestInit, baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    throw new EngineUnavailableError(
      `Engine unreachable at ${baseUrl}. Start it with: npm run engine:dev`,
      cause,
    );
  }
}

export async function fetchInboundQueue(params?: {
  platform?: string;
  status?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<InboundQueueResponse> {
  const query = new URLSearchParams();
  if (params?.platform) query.set("platform", params.platform);
  if (params?.status) query.set("status", params.status);
  if (params?.limit) query.set("limit", String(params.limit));

  const path = `/v1/gateway/channels/queue${query.toString() ? `?${query.toString()}` : ""}`;
  const response = await queueFetch(path, undefined, params?.baseUrl);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, body, "Failed to fetch inbound channel queue");
  }
  return (await response.json()) as InboundQueueResponse;
}

export async function recoverInboundQueue(maxAgeSeconds = 60.0, baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<RecoverQueueResponse> {
  const path = `/v1/gateway/channels/queue/recover?max_age_seconds=${maxAgeSeconds}`;
  const response = await queueFetch(path, { method: "POST" }, baseUrl);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, body, "Failed to recover inbound channel queue");
  }
  return (await response.json()) as RecoverQueueResponse;
}

export async function pollChannelOnce(platform: string, timeout = 5, baseUrl = ENGINE_DEFAULT_BASE_URL): Promise<Record<string, unknown>> {
  const path = `/v1/gateway/channels/${encodeURIComponent(platform)}/poll-once?timeout=${timeout}`;
  const response = await queueFetch(path, { method: "POST" }, baseUrl);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, body, `Failed to poll channel ${platform}`);
  }
  return (await response.json()) as Record<string, unknown>;
}
