/** F5 pilot — spazi remoti di QUESTA installazione (lato peer). */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { HomunClientError, homunErrorFromHttp } from "./homun-errors.ts";

export type PeerConnection = {
  host: string;
  workspace_id: string;
  person_id: string;
  device_id: string;
  key_fingerprint: string;
  display_name: string;
  paired_at: string;
};

export type PeerProjection = {
  host: string;
  project_id: string;
  cursor: number;
  source: "remote-engine";
  project: { id: string; name: string; status: string } | null;
};

async function peersFetch(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${ENGINE_DEFAULT_BASE_URL}${path}`, {
    ...init,
    headers: { Accept: "application/json",
               "X-Homun-Actor-Id": "person_fabio",
               ...(init?.body ? { "Content-Type": "application/json" } : {}),
               ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw homunErrorFromHttp(response.status, body, "Richiesta spazi remoti fallita");
  return body;
}

export async function listEnginePeerConnections(): Promise<PeerConnection[]> {
  const body = await peersFetch("/v1/peers/connections");
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new HomunClientError("validation_error", "Elenco connessioni non valido");
  return items as PeerConnection[];
}

export async function listEnginePeerProjections(): Promise<PeerProjection[]> {
  const body = await peersFetch("/v1/peers/projections");
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new HomunClientError("validation_error", "Elenco proiezioni non valido");
  return items as PeerProjection[];
}

export async function connectEnginePeer(input: {
  host: string; inviteToken: string; displayName: string; deviceName?: string;
}): Promise<{ host: string; person_id: string; key_fingerprint: string }> {
  const body = await peersFetch("/v1/peers/connect", {
    method: "POST",
    body: JSON.stringify({
      host: input.host, invite_token: input.inviteToken,
      display_name: input.displayName, device_name: input.deviceName ?? "",
    }),
  });
  const record = body as { host?: unknown; person_id?: unknown; key_fingerprint?: unknown };
  if (typeof record.host !== "string" || typeof record.person_id !== "string") {
    throw new HomunClientError("validation_error", "Connessione remota non valida");
  }
  return { host: record.host, person_id: record.person_id,
           key_fingerprint: String(record.key_fingerprint ?? "") };
}

export async function syncEnginePeerProject(host: string, projectId: string): Promise<void> {
  await peersFetch(`/v1/peers/connections/${encodeURIComponent(host)}/sync`, {
    method: "POST", body: JSON.stringify({ project_id: projectId }),
  });
}
