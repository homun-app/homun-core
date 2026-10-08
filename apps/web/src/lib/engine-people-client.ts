/** F5.1 — persone e inviti dello spazio (Fonte: motore). */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { HomunClientError, homunErrorFromHttp } from "./homun-errors.ts";

export type EnginePersonDevice = {
  id: string;
  name: string;
  status: string;
  last_seen_at: string | null;
};

export type EnginePerson = {
  id: string;
  display_name: string;
  role: "owner" | "admin" | "member";
  status: "active" | "revoked";
  created_at: string;
  devices: EnginePersonDevice[];
};

export type EnginePersonInvite = {
  id: string;
  role: "admin" | "member";
  note: string;
  status: "active" | "used" | "revoked";
  expired: boolean;
  expires_at: string | null;
  person_id: string | null;
};

const HEADERS = { Accept: "application/json" };

async function peopleFetch(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${ENGINE_DEFAULT_BASE_URL}${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw homunErrorFromHttp(response.status, body, "Richiesta persone fallita");
  return body;
}

export async function listEnginePeople(actorId: string, signal?: AbortSignal): Promise<EnginePerson[]> {
  const body = await peopleFetch(`/v1/workspaces/ws_local/people`, {
    headers: { "X-Homun-Actor-Id": actorId }, ...(signal ? { signal } : {}),
  });
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new HomunClientError("validation_error", "Elenco persone non valido");
  return items as EnginePerson[];
}

export async function listEnginePeopleInvites(actorId: string, signal?: AbortSignal): Promise<EnginePersonInvite[]> {
  const body = await peopleFetch(`/v1/workspaces/ws_local/people/invites`, {
    headers: { "X-Homun-Actor-Id": actorId }, ...(signal ? { signal } : {}),
  });
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new HomunClientError("validation_error", "Elenco inviti non valido");
  return items as EnginePersonInvite[];
}

export async function createEnginePersonInvite(
  actorId: string, input: { role: "admin" | "member"; note?: string },
): Promise<{ token: string; expires_at: string }> {
  const body = await peopleFetch(`/v1/workspaces/ws_local/people/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Homun-Actor-Id": actorId },
    body: JSON.stringify(input),
  });
  const token = (body as { token?: unknown }).token;
  const expires_at = (body as { expires_at?: unknown }).expires_at;
  if (typeof token !== "string" || typeof expires_at !== "string") {
    throw new HomunClientError("validation_error", "Invito non valido dal motore");
  }
  return { token, expires_at };
}

export async function revokeEnginePerson(actorId: string, personId: string): Promise<void> {
  await peopleFetch(`/v1/workspaces/ws_local/people/${encodeURIComponent(personId)}/revoke`, {
    method: "POST", headers: { "X-Homun-Actor-Id": actorId },
  });
}

export async function revokeEnginePersonInvite(actorId: string, inviteId: string): Promise<void> {
  await peopleFetch(`/v1/workspaces/ws_local/people/invites/${encodeURIComponent(inviteId)}/revoke`, {
    method: "POST", headers: { "X-Homun-Actor-Id": actorId },
  });
}

export async function revokeEngineDevice(actorId: string, deviceId: string): Promise<void> {
  await peopleFetch(`/v1/workspaces/ws_local/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: "POST", headers: { "X-Homun-Actor-Id": actorId },
  });
}
