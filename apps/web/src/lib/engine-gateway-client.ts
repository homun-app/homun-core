/** Gateway client: remote platform pairing (Telegram, Slack, Discord) following NIST SP 800-63-4. */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { defaultLocalActor, domainFetch, type EngineActor } from "./engine-domain-client.ts";
import { homunErrorFromHttp, HomunClientError } from "./homun-errors.ts";

export type GatewayPairingRequest = {
  code: string;
  platform: string;
  user_id: string;
  username: string | null;
  created_at: number;
  expires_at: number;
  status: "pending" | "approved" | "declined" | "expired";
  approved_by?: string | null;
  approved_at?: number | null;
};

export type GatewayPairingInput = {
  platform: string;
  userId: string;
  username?: string | undefined;
};

const DEFAULT_TIMEOUT_MS = 15_000;

export async function listGatewayPairings(
  filter?: { platform?: string; status?: string },
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<GatewayPairingRequest[]> {
  const params = new URLSearchParams();
  if (filter?.platform) params.set("platform", filter.platform);
  if (filter?.status) params.set("status", filter.status);
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await domainFetch(
    `/v1/gateway/pairing${query}`,
    { method: "GET", headers: { Accept: "application/json", "X-Homun-Actor-Id": actor.id } },
    baseUrl,
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, err, `Impossibile recuperare gli accoppiamenti: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { requests: GatewayPairingRequest[] };
  return body.requests ?? [];
}

export async function requestGatewayPairing(
  input: GatewayPairingInput,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<GatewayPairingRequest> {
  const response = await domainFetch(
    "/v1/gateway/pairing/request",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Homun-Actor-Id": actor.id },
      body: JSON.stringify({
        platform: input.platform,
        user_id: input.userId,
        ...(input.username ? { username: input.username } : {}),
      }),
    },
    baseUrl,
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, err, `Richiesta di accoppiamento fallita: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { pairing: GatewayPairingRequest };
  return body.pairing;
}

export async function approveGatewayPairing(
  code: string,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<GatewayPairingRequest> {
  const response = await domainFetch(
    "/v1/gateway/pairing/approve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Homun-Actor-Id": actor.id },
      body: JSON.stringify({ code: code.trim().toUpperCase() }),
    },
    baseUrl,
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, err, "Codice non valido o scaduto");
  }
  const body = (await response.json()) as { pairing: GatewayPairingRequest };
  return body.pairing;
}

export async function declineGatewayPairing(
  code: string,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<GatewayPairingRequest> {
  const response = await domainFetch(
    "/v1/gateway/pairing/decline",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Homun-Actor-Id": actor.id },
      body: JSON.stringify({ code: code.trim().toUpperCase() }),
    },
    baseUrl,
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, err, "Rifiuto accoppiamento non riuscito");
  }
  const body = (await response.json()) as { pairing: GatewayPairingRequest };
  return body.pairing;
}

export async function revokeGatewayPairing(
  input: { platform: string; userId: string },
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
  actor: EngineActor = defaultLocalActor(),
): Promise<{ status: string }> {
  const response = await domainFetch(
    "/v1/gateway/pairing/revoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Homun-Actor-Id": actor.id },
      body: JSON.stringify({ platform: input.platform, user_id: input.userId }),
    },
    baseUrl,
    DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw homunErrorFromHttp(response.status, err, "Revoca canale non riuscita");
  }
  return (await response.json()) as { status: string };
}
