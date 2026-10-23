/**
 * Best-effort sync of the preferences of the CURRENT session person to the
 * engine: the language (person → workspace → English chain) and the chat
 * autonomy mode. The engine uses the language ONLY for the texts it
 * generates by itself; the autonomy mode is the person's default for new
 * conversations, kept in the engine so it survives any browser. A down
 * engine never blocks the UI switch (the preference goes out again later).
 */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { DEFAULT_WORKSPACE_ID, defaultLocalActor } from "./engine-domain-client.ts";
import {
  isAutonomyLevel,
  type AutonomyLevel,
} from "@/components/builder/conversation-preferences.ts";

function personPreferenceUrl(baseUrl: string, name: string): { url: string; personId: string } {
  const personId = defaultLocalActor().id;
  return {
    url: `${baseUrl}/v1/workspaces/${DEFAULT_WORKSPACE_ID}/people/${personId}/${name}`,
    personId,
  };
}

async function putPreference(baseUrl: string, name: string, body: object): Promise<void> {
  const { url, personId } = personPreferenceUrl(baseUrl, name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Homun-Actor-Id": personId },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // best-effort: il motore può essere spento; la UI ha già cambiato
  } finally {
    clearTimeout(timer);
  }
}

export async function setEngineLanguage(
  language: string,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<void> {
  await putPreference(baseUrl, "language", { language });
}

/** L'ultima modalità scelta dalla persona, come la custodisce il motore. */
export async function setEngineAutonomy(
  level: AutonomyLevel,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<void> {
  await putPreference(baseUrl, "autonomy", { autonomy: level });
}

/**
 * La modalità della persona letta dal motore; `null` quando il motore non
 * risponde o non conosce ancora la persona (nessuna invenzione: resta il
 * valore locale).
 */
export async function fetchEngineAutonomy(
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<AutonomyLevel | null> {
  const { url, personId } = personPreferenceUrl(baseUrl, "autonomy");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Homun-Actor-Id": personId },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { autonomy?: unknown };
    return isAutonomyLevel(body.autonomy) ? body.autonomy : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
