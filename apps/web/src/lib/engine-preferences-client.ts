/**
 * Best-effort sync of the workspace language preference to the engine.
 * The engine uses it ONLY for the texts it generates by itself; a down
 * engine never blocks the UI switch (the preference goes out again at
 * startup).
 */
import { ENGINE_DEFAULT_BASE_URL } from "./engine-client.ts";
import { DEFAULT_WORKSPACE_ID } from "./engine-domain-client.ts";

export async function setEngineLanguage(
  language: string,
  baseUrl: string = ENGINE_DEFAULT_BASE_URL,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(`${baseUrl}/v1/workspaces/${DEFAULT_WORKSPACE_ID}/language`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
      signal: controller.signal,
    });
  } catch {
    // best-effort: il motore può essere spento; la UI ha già cambiato lingua
  } finally {
    clearTimeout(timer);
  }
}
