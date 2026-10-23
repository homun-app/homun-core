/**
 * Il selettore modello del composer racconta la CONNESSIONE ATTIVA del motore:
 * il suo display_name e il modello vero (per esempio «Ollama locale ·
 * qwen3.5:4b»), mai l'id tecnico. Motore intercettato con `page.route`: la
 * connessione attiva è una qualunque creata dalla persona (id senza preset).
 */
import { expect, test, type Page, type Route } from "@playwright/test";

async function mockEngine(page: Page): Promise<void> {
  await page.route("**/v1/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body as object });
    if (path === "/v1/health") return json({ status: "ok", version: "test", uptime_seconds: 5 });
    if (path === "/v1/capabilities") {
      return json({
        api_version: "v1",
        version: "test",
        features: {
          domain: true,
          agents: true,
          materials: true,
          memory: true,
          automations: true,
          peers: true,
          backup: true,
          models: true,
        },
      });
    }
    // Una connessione della persona, attiva: id tecnico senza preset noto.
    if (path === "/v1/models/providers") {
      return json({
        items: [
          {
            id: "ollama_local",
            kind: "openai_compatible",
            configured: true,
            credential_present: false,
            base_url: "http://127.0.0.1:11434/v1",
          },
        ],
        active_provider_id: "ollama_local",
      });
    }
    if (path === "/v1/models/connections") {
      return json({
        active_connection_id: "ollama_local",
        items: [
          {
            id: "ollama_local",
            kind: "openai_compatible",
            display_name: "Ollama locale",
            model_id: "qwen3.5:4b",
            base_url: "http://127.0.0.1:11434/v1",
            configured: true,
            credential_present: false,
            active: true,
            notes: [],
          },
        ],
      });
    }
    if (path.endsWith("/conversations")) return json({ items: [] });
    if (path.endsWith("/works")) return json({ items: [] });
    if (path.includes("/events")) {
      return route.fulfill({ contentType: "text/event-stream", body: ": quiet\n\n" });
    }
    return json({ items: [] });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("homun.engine.dataSource", "engine");
  });
});

test("5 · il selettore modello mostra display_name e modello della connessione attiva, non l'id tecnico", async ({
  page,
}) => {
  await mockEngine(page);
  await page.goto("/");

  const selector = page.locator('[aria-label="Seleziona modello per il prompt"]');
  await expect(selector).toBeVisible({ timeout: 10_000 });
  // Il nome della persona e il modello vero, letti dal motore.
  await expect(selector).toContainText("Ollama locale", { timeout: 10_000 });
  await expect(selector).toContainText("qwen3.5:4b");
  await expect(selector).not.toContainText("ollama_local");
  await expect(selector).not.toContainText("golden_lo");
  // Anche il titolo del bottone li dichiara per intero.
  await expect(selector).toHaveAttribute("title", /Ollama locale/);
  await expect(selector).toHaveAttribute("title", /qwen3\.5:4b/);
});
