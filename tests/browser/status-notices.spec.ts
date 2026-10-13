/**
 * Stato del motore nella chat, verificato nel browser.
 *
 * Il motore non serve un processo reale: le risposte di
 * `http://127.0.0.1:8765` sono intercettate con `page.route` così la caduta
 * e gli stati di followup sono riproducibili. Gli avvisi devono essere
 * VISIBILI nell'area del thread dove si legge, non soltanto presenti nel
 * DOM: il controllo geometrico contro il contenitore scorrevole è la prova.
 */
import { expect, test, type Locator, type Route } from "@playwright/test";

const CONVERSATION_ID = "conv-listini";
const WORK_ID = "work-listini";

const transcript = () => ({
  items: Array.from({ length: 30 }, (_, index) => ({
    id: `m-${index}`,
    text:
      index % 2 === 0
        ? `Domanda numero ${index} della conversazione, con un po' di testo per occupare righe.`
        : `Risposta numero ${index}: testo sufficientemente lungo da occupare più di una riga nel thread.`,
    author_id: index % 2 === 0 ? "person_fabio" : "homun_engine",
  })),
  cursor: 30,
  has_more: false,
});

/** Motore raggiungibile, con una conversazione apribile e un followup attivo. */
async function mockEngineOnline(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body as object });
    if (path === "/v1/health") {
      return json({ status: "ok", version: "test", uptime_seconds: 5 });
    }
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
    if (path === "/v1/models/providers") {
      return json({
        items: [
          {
            id: "ollama",
            kind: "ollama",
            configured: true,
            credential_present: false,
            base_url: "http://127.0.0.1:11434",
          },
        ],
        active_provider_id: "ollama",
      });
    }
    if (path.endsWith("/conversations")) {
      return json({
        items: [
          {
            id: CONVERSATION_ID,
            title: "Listini",
            project_id: null,
            version: 1,
            followups: [
              {
                command_id: "cmd-1",
                status: "retry_scheduled",
                error_code: null,
                attempts: 1,
              },
            ],
          },
        ],
      });
    }
    if (path.endsWith("/works")) {
      return json({
        items: [
          {
            id: WORK_ID,
            title: "Listini",
            objective: "Aggiornare i listini",
            status: "running",
            version: 1,
            primary_conversation_id: CONVERSATION_ID,
          },
        ],
      });
    }
    if (path.includes(`/conversations/${CONVERSATION_ID}/messages`)) {
      return json(transcript());
    }
    if (path.includes("/events")) {
      return route.fulfill({ contentType: "text/event-stream", body: ": quiet\n\n" });
    }
    return json({ items: [] });
  });
}

/** Un elemento è dentro l'area VISIBILE del contenitore scorrevole. */
async function insideVisibleArea(inner: Locator, outer: Locator): Promise<boolean> {
  const innerBox = await inner.boundingBox();
  const outerBox = await outer.boundingBox();
  if (!innerBox || !outerBox) return false;
  return (
    innerBox.y >= outerBox.y - 1 && innerBox.y + innerBox.height <= outerBox.y + outerBox.height + 1
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("homun.engine.dataSource", "engine");
  });
});

test("P1: l'avviso di fine thread è visibile dentro l'area scorrevole del thread", async ({
  page,
}) => {
  await mockEngineOnline(page);
  await page.goto("/");
  await page.locator(".cw-sb-row", { hasText: "Listini" }).click();

  const notice = page.locator('[data-chat-status="followup"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Risposta interrotta");

  // dentro il viewport del thread, non oltre la sua area visibile
  const viewport = page.locator('[data-slot="aui_thread-viewport"]');
  await expect(viewport).toBeVisible();
  await expect.poll(async () => insideVisibleArea(notice, viewport), { timeout: 5_000 }).toBe(true);

  // e resta una sola dichiarazione, mai tra i messaggi del runtime
  await expect(page.locator('[data-chat-status-slot="thread-end"]')).toHaveCount(1);
});

test("P2: a motore fermo la schermata iniziale ha UN solo avviso di motore irraggiungibile", async ({
  page,
}) => {
  await page.route("**/v1/**", (route) => route.abort());
  await page.goto("/");

  const composerNotice = page.locator('[data-chat-status="engine-unreachable"]');
  await expect(composerNotice).toBeVisible();

  // la scheda di benvenuto non ripete la condizione: una sola fonte
  const welcomeCard = page.locator(".cw-first-run", { hasText: "raggiungibile" });
  await expect(welcomeCard).toHaveCount(0);
  const saying = page.getByText(/raggiungibile/);
  await expect(saying).toHaveCount(1);
});
