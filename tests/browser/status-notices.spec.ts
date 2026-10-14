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

type EngineMockState = {
  online: boolean;
  /** Alla riconnessione il motore restituisce anche la conversazione «Logs». */
  extraConversation: boolean;
  /** …e un messaggio in più nella trascrizione di «Listini». */
  extraMessage: boolean;
};

const transcript = (extraMessage: boolean) => ({
  items: [
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `m-${index}`,
      text:
        index % 2 === 0
          ? `Domanda numero ${index} della conversazione, con un po' di testo per occupare righe.`
          : `Risposta numero ${index}: testo sufficientemente lungo da occupare più di una riga nel thread.`,
      author_id: index % 2 === 0 ? "person_fabio" : "homun_engine",
    })),
    ...(extraMessage
      ? [
          {
            id: "m-30",
            text: "Risposta numero 30, arrivata dopo la riconnessione.",
            author_id: "homun_engine",
          },
        ]
      : []),
  ],
  cursor: extraMessage ? 31 : 30,
  has_more: false,
});

/** Motore intercettato: online/offline e contenuti dipendono dallo stato. */
async function mockEngine(
  page: import("@playwright/test").Page,
  state: EngineMockState,
): Promise<void> {
  await page.route("**/v1/**", async (route: Route) => {
    if (!state.online) return route.abort();
    const path = new URL(route.request().url()).pathname;
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
          ...(state.extraConversation
            ? [
                {
                  id: "conv-logs",
                  title: "Logs",
                  project_id: null,
                  version: 1,
                  followups: [],
                },
              ]
            : []),
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
          ...(state.extraConversation
            ? [
                {
                  id: "work-logs",
                  title: "Logs",
                  objective: "Mettere ordine nei log",
                  status: "draft",
                  version: 1,
                  primary_conversation_id: "conv-logs",
                },
              ]
            : []),
        ],
      });
    }
    if (path.includes(`/conversations/${CONVERSATION_ID}/messages`)) {
      return json(transcript(state.extraMessage));
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
  await mockEngine(page, { online: true, extraConversation: false, extraMessage: false });
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

  // l'avviso sopra il campo di scrittura è l'unica dichiarazione
  const composerNotice = page.locator('[data-chat-status="engine-unreachable"]');
  await expect(composerNotice).toBeVisible();
  await expect(composerNotice).toHaveCount(1);

  // nessuna scheda di benvenuto ripete la condizione: una sola fonte
  const welcomeCard = page.locator(".cw-first-run", { hasText: "raggiungibile" });
  await expect(welcomeCard).toHaveCount(0);

  // in tutta la pagina un solo elemento-notizia dichiara la condizione
  // (il dettaglio tipizzato dentro l'avviso non è una seconda dichiarazione)
  const saying = page
    .locator("[data-chat-status], .cw-first-run")
    .filter({ hasText: "raggiungibile" });
  await expect(saying).toHaveCount(1);
});

test("P4: la conversazione aperta sopravvive alla caduta del motore e si ricarica alla riconnessione", async ({
  page,
}) => {
  const state = { online: true, extraConversation: false, extraMessage: false };
  await mockEngine(page, state);
  await page.goto("/");
  await page.locator(".cw-sb-row", { hasText: "Listini" }).click();

  // snapshot caricato: la conversazione aperta mostra i suoi messaggi
  const thread = page.locator('[data-slot="aui_thread-viewport"]');
  await expect(thread).toContainText("Risposta numero 29");
  const composer = page.locator(".cw-composer textarea");
  await expect(composer).toBeEnabled();

  // il motore cade: avviso sopra il campo di scrittura, in sola lettura
  state.online = false;
  const notice = page.locator('[data-chat-status="engine-unreachable"]');
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(composer).toBeDisabled();

  // l'elenco delle conversazioni NON si svuota e il thread resta leggibile
  await expect(page.locator(".cw-sb-row", { hasText: "Listini" })).toBeVisible();
  await expect(thread).toContainText("Risposta numero 29");

  // un «Riprova» mentre è giù non svuota il thread
  await notice.getByRole("button", { name: "Riprova" }).click();
  await expect(thread).toContainText("Risposta numero 29");

  // riconnessione: il motore ha una conversazione e un messaggio in più
  state.online = true;
  state.extraConversation = true;
  state.extraMessage = true;
  await expect(notice).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".cw-sb-row", { hasText: "Logs" })).toBeVisible({ timeout: 10_000 });
  await expect(composer).toBeEnabled();

  // il thread aperto si ricarica normalmente riaprendo la conversazione
  await page.locator(".cw-sb-row", { hasText: "Logs" }).click();
  // il followup di Listini non entra nel thread di un'altra conversazione
  await expect(page.locator('[data-chat-status="followup"]')).toBeHidden({ timeout: 10_000 });
  await page.locator(".cw-sb-row", { hasText: "Listini" }).click();
  await expect(thread).toContainText("arrivata dopo la riconnessione", { timeout: 10_000 });
});

test("P5: la caduta del motore durante un invio produce UN solo avviso, senza testo grezzo", async ({
  page,
}) => {
  const state = { online: true, extraConversation: false, extraMessage: false };
  await mockEngine(page, state);
  // Il motore cade mentre il messaggio viaggia: il comando in corso fallisce
  // con un errore di connessione (la stessa causa del gate) e da lì in poi
  // tutte le chiamate cadono. Un guasto, un avviso.
  await page.route("**/v1/**", (route) => {
    if (new URL(route.request().url()).pathname.includes("/commands/")) {
      state.online = false;
      return route.abort();
    }
    if (!state.online) return route.abort();
    return route.fallback();
  });
  await page.goto("/");
  await page.locator(".cw-sb-row", { hasText: "Listini" }).click();

  const composer = page.locator(".cw-composer textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("Aggiorna i listini dei fornitori");
  await composer.press("Enter");

  // il gate dichiara l'irraggiungibile…
  const gate = page.locator('[data-chat-status="engine-unreachable"]');
  await expect(gate).toBeVisible({ timeout: 15_000 });
  // …e l'errore della stessa caduta NON raddoppia l'avviso
  await expect(page.locator('[data-chat-status="engine-error"]')).toHaveCount(0);
  // nessun testo tecnico grezzo in pagina
  await expect(page.locator("body")).not.toContainText("Errno");
  await expect(page.locator("body")).not.toContainText("L'ultima operazione verso il motore");
});

test("P6: a motore fermo i dettagli tecnici dell'avviso sono chiusi e si aprono su richiesta", async ({
  page,
}) => {
  await page.route("**/v1/**", (route) => route.abort());
  await page.goto("/");

  const notice = page.locator('[data-chat-status="engine-unreachable"]');
  await expect(notice).toBeVisible();

  // un solo blocco dettagli, chiuso di default
  const details = notice.locator("details[data-homun-error-details]");
  await expect(details).toHaveCount(1);
  await expect(details).not.toHaveAttribute("open");
  await expect(details.locator("summary")).toHaveText("Dettagli tecnici");
  await expect(details.locator('[data-homun-error-detail="code"]')).toBeHidden();
  await expect(details.locator('[data-homun-error-detail="message"]')).toBeHidden();

  // il testo principale è copia di prodotto, senza il messaggio originale
  const mainText = notice.locator(".cw-chat-status__error p");
  await expect(mainText).toContainText("App locale non raggiungibile");
  await expect(mainText).not.toContainText("Engine");

  // il blocco non allarga l'avviso: resta nel limite del contenitore chat
  const box = await notice.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(461);

  // aprendo il blocco: codice e messaggio originale, con copia disponibile
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open");
  await expect(details.locator('[data-homun-error-detail="code"]')).toHaveText(
    "engine_unavailable",
  );
  const message = details.locator('[data-homun-error-detail="message"]');
  await expect(message).toBeVisible();
  await expect(message).not.toHaveText("");
  await expect(details.getByRole("button", { name: "Copia" })).toBeVisible();
  // e il messaggio originale resta confinato nel blocco, non nel testo principale
  await expect(mainText).not.toContainText(await message.textContent().then((text) => text ?? ""));
});
