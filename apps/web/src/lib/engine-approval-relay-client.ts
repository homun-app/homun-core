/** Approval relay bindings: il canale messaging che riceve le autorizzazioni. */
import { homunErrorFromHttp } from "./homun-errors.ts";
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import {
  DEFAULT_WORKSPACE_ID,
  defaultLocalActor,
  domainFetch,
} from "./engine-domain-client.ts";

export type RelayBinding = {
  person_id: string;
  platform: string;
  user_id: string;
  target: string;
};

export type RelayStatus = {
  bindings: RelayBinding[];
  pending_codes: number;
};

export type RelayEnroll = {
  code: string;
  expires_in_minutes: number;
  hint: string;
};

async function relayFetch(path: string, init?: RequestInit): Promise<Response> {
  return domainFetch(
    path,
    {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Homun-Actor-Id": defaultLocalActor().id,
      },
    },
    ENGINE_DEFAULT_BASE_URL,
    15_000,
  );
}

export async function listEngineRelay(): Promise<RelayStatus> {
  const response = await relayFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/approval-relay`);
  if (!response.ok) {
    throw homunErrorFromHttp(response.status, await response.json().catch(() => null),
      "Relay autorizzazioni non disponibile");
  }
  return (await response.json()) as RelayStatus;
}

export async function enrollEngineRelay(): Promise<RelayEnroll> {
  const response = await relayFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/approval-relay/enroll`, {
    method: "POST",
  });
  if (!response.ok) {
    throw homunErrorFromHttp(response.status, await response.json().catch(() => null),
      "Generazione del codice non riuscita");
  }
  return (await response.json()) as RelayEnroll;
}
