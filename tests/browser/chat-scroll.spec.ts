/**
 * Lo scorrimento della chat del motore, verificato nel browser con una
 * trascrizione lunga (motore intercettato con `page.route`, SSE a cancello
 * così ogni arrivo è deterministico).
 *
 * Invarianti (punto 4 del giro dell'interfaccia):
 * - l'apertura di una conversazione porta in fondo;
 * - un messaggio o una scheda nuovi portano in fondo SE la persona era già in
 *   fondo; se è salita a leggere, la vista non si muove;
 * - «Vai in fondo» porta sempre in fondo, schede comprese (vivono fuori dai
 *   messaggi del runtime, dentro il viewport).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { insideVisibleArea, scrolledToBottom } from "./geometry";

const CONVERSATION_ID = "conv-listini";
const WORK_ID = "work-listini";

/** Cosa c'è in coda alla trascrizione, oltre ai 30 messaggi iniziali. */
type Tail = "none" | "message" | "card";

type MockState = { tail: Tail };

const baseMessages = Array.from({ length: 30 }, (_, index) => ({
  id: `m-${index}`,
  text:
    index % 2 === 0
      ? `Domanda numero ${index} della conversazione, con un po' di testo per occupare righe.`
      : `Risposta numero ${index}: testo sufficientemente lungo da occupare più di una riga nel thread.`,
  author_id: index % 2 === 0 ? "person_fabio" : "homun_engine",
}));

const tailMessages = (tail: Tail) => {
  if (tail === "none") return [];
  const message = [
    { id: "m-30", text: "Domanda numero 30: e adesso?", author_id: "person_fabio" },
    {
      id: "m-31",
      text: "Risposta numero 31: arrivata mentre leggevi sopra.",
      author_id: "homun_engine",
    },
  ];
  if (tail === "message") return message;
  return [
    ...message,
    { id: "m-32", text: "Domanda numero 32: prepara la relazione.", author_id: "person_fabio" },
    {
      id: "m-33",
      text: "Ho alcune domande prima di proporti il lavoro: rispondi qui sotto.",
      author_id: "homun_engine",
      front_door: {
        kind: "clarification",
        language: "it",
        questions: [
          { question: "Per quando ti serve la relazione?", choices: ["Domani", "Entro il 30"] },
          { question: "Quali fornitori ti interessano?", choices: ["Diretti", "Indiretti"] },
        ],
      },
    },
  ];
};

/** Un cancello: la risposta SSE parte solo quando il test lo apre. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

/** Motore intercettato con trascrizione variabile e SSE a cancello. */
async function mockEngine(page: Page, state: MockState) {
  let sse = gate();
  const releaseSse = () => {
    const current = sse;
    sse = gate();
    current.release();
  };
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
          { id: CONVERSATION_ID, title: "Listini", project_id: null, version: 1, followups: [] },
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
            status: "draft",
            version: 1,
            primary_conversation_id: CONVERSATION_ID,
          },
        ],
      });
    }
    if (path.includes(`/conversations/${CONVERSATION_ID}/messages`)) {
      const items = [...baseMessages, ...tailMessages(state.tail)];
      return json({ items, cursor: items.length, has_more: false });
    }
    if (path.includes("/chat-agent/") && path.includes("/events")) {
      // Ogni connessione aspetta il cancello, poi consegna UN evento
      // «message» e chiude: EventSource si ricollega (retry breve) e si
      // rimette in attesa del cancello successivo.
      await sse.opened;
      return route.fulfill({
        contentType: "text/event-stream",
        body: "retry: 100\nevent: message\ndata: {}\n\n",
      });
    }
    return json({ items: [] });
  });
  return { releaseSse };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("homun.engine.dataSource", "engine");
  });
});

test("4 · il thread segue il fondo solo se ci sei, non ti sposta mentre leggi, e «Vai in fondo» funziona anche con le schede", async ({
  page,
}) => {
  const state: MockState = { tail: "none" };
  const { releaseSse } = await mockEngine(page, state);
  await page.goto("/");
  await page.locator(".cw-sb-row", { hasText: "Listini" }).click();

  const viewport = page.locator('[data-slot="aui_thread-viewport"]');
  await expect(viewport).toContainText("Risposta numero 29");

  // A. L'apertura porta in fondo: l'ultimo messaggio è nell'area visibile.
  await expect
    .poll(() => insideVisibleArea(page.getByText("Risposta numero 29"), viewport), {
      timeout: 5_000,
    })
    .toBe(true);
  expect(await scrolledToBottom(viewport)).toBe(true);

  // B. La persona sale a leggere; arriva un messaggio nuovo: la vista NON si muove.
  await viewport.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(2);
  state.tail = "message";
  releaseSse();
  await expect(viewport).toContainText("Risposta numero 31");
  // la vista è rimasta dove stava leggendo
  await page.waitForTimeout(400);
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeLessThan(2);
  expect(await insideVisibleArea(page.getByText("Risposta numero 31"), viewport)).toBe(false);

  // C. «Vai in fondo» porta in fondo: l'ultimo messaggio è visibile.
  const toBottom = page.getByRole("button", { name: "Vai in fondo" });
  await expect(toBottom).toBeVisible();
  await toBottom.click();
  await expect
    .poll(() => insideVisibleArea(page.getByText("Risposta numero 31"), viewport), {
      timeout: 5_000,
    })
    .toBe(true);
  await expect.poll(() => scrolledToBottom(viewport)).toBe(true);

  // D. Già in fondo: arriva un messaggio CON SCHEDA (fuori dai messaggi del
  //    runtime) e la vista segue fino alla scheda intera.
  state.tail = "card";
  releaseSse();
  const card = page.locator(".cw-clarify-card");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => insideVisibleArea(card, viewport), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => scrolledToBottom(viewport)).toBe(true);

  // E. Il contenitore che scorre è il viewport del thread, non un antenato:
  //    altrimenti «Vai in fondo» (che scorre il viewport) sarebbe un bottone morto.
  const outerOverflow = await page
    .locator(".cw-history")
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(outerOverflow).toBeLessThanOrEqual(1);
});
