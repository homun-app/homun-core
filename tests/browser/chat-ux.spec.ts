/**
 * I difetti della chat visti nel giro dell'interfaccia, verificati nella UI
 * vera con il MOTORE VERO in provider `fake` (deterministico, senza rete) su
 * una porta propria (8766): il file gira in parallelo a front-door.spec.ts.
 *
 * Ogni test enuncia l'invariante che garantisce. Il motore vive per tutto il
 * file; i test sono seriali perché condividono la stessa data dir temporanea.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  ENGINE_SKIP_REASON,
  engineImportable,
  personMessagesInEngine,
  pointBrowserAtEngine,
  postCommand,
  readEngine,
  selectMode,
  sendMessage,
  startTestEngine,
  type TestEngine,
} from "./engine-harness";

const ENGINE_PORT = 8766;

test.skip(!engineImportable, ENGINE_SKIP_REASON);

let engine: TestEngine | null = null;

test.beforeAll(async () => {
  engine = await startTestEngine(ENGINE_PORT, "homun-chat-ux-e2e-");
});

test.afterAll(async () => {
  await engine?.stop();
});

test.beforeEach(async ({ page }) => {
  await pointBrowserAtEngine(page, engine!.url);
});

/** Le bolle della persona nel thread, nell'ordine in cui si leggono. */
function userBubbles(page: Page) {
  return page.locator('[data-slot="aui_user-message-root"] .aui-user-message-content');
}

test.describe.serial("difetti della chat", () => {
  // Ogni passo è un giro vero del motore (processo + provider fake).
  test.describe.configure({ timeout: 90_000 });
  test("1 · il messaggio scritto nel campo del progetto arriva VERBATIM come messaggio della persona", async ({
    page,
  }) => {
    // Invariante: ciò che la persona scrive nel campo «Chiedi o assegna un
    // compito in questo progetto…» è il suo messaggio, parola per parola,
    // attraverso la stessa porta della chat. Mai un segnaposto come messaggio.
    const project = await postCommand(engine!.url, "project.create", {
      name: "Rinnovi 2026",
      description: "",
      member_ids: [],
      team_ids: [],
    });
    expect(project["project_id"]).toBeTruthy();

    await page.goto("/");
    await page.getByRole("button", { name: "Rinnovi 2026" }).click();
    const field = page.getByPlaceholder("Chiedi o assegna un compito in questo progetto...");
    await expect(field).toBeVisible();

    const text = "Quali rinnovi scadono a marzo?";
    await field.fill(text);
    await field.press("Enter");

    // La conversazione del progetto si apre e la bolla della persona è
    // esattamente il testo scritto: una sola bolla, nessun segnaposto.
    await expect(userBubbles(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(userBubbles(page).first()).toHaveText(text);
    await expect(page.getByText("Descrivi l'obiettivo di questa attività")).toHaveCount(0);
    // Il turno di ingresso risponde al messaggio vero (il fake risponde con testo).
    await expect(page.getByText("Sono Homun in modalità deterministica")).toBeVisible({
      timeout: 30_000,
    });

    // Il motore ha salvato QUEL testo come messaggio della persona, e nessun
    // segnaposto: la prova sta nel motore, non solo nello schermo.
    const saved = await personMessagesInEngine(engine!.url);
    expect(saved).toEqual([text]);
  });

  test("3 · un messaggio inviato = una bolla, senza selettore di versioni «2 / 2»", async ({
    page,
  }) => {
    // Invariante: l'eco locale del messaggio viene SOSTITUITO dal messaggio
    // del motore (stesso nodo del thread), mai aggiunto come secondo ramo. Il
    // selettore di versioni compare solo per rigenerazioni vere.
    const picker = page.locator('[data-slot="aui_user-branch-picker"]');
    await page.goto("/");

    // 1. Primo messaggio di una conversazione nuova: il caso del giro.
    await sendMessage(page, "Cosa sai fare?");
    await expect(page.getByText("Sono Homun in modalità deterministica").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(userBubbles(page)).toHaveCount(1);
    await expect(userBubbles(page).first()).toHaveText("Cosa sai fare?");
    await expect(picker).toHaveCount(0);
    await expect(page.getByText(/^\s*\d+\s*\/\s*\d+\s*$/)).toHaveCount(0);

    // 2. Messaggio successivo nella stessa conversazione: idem.
    await sendMessage(page, "E con i documenti?");
    await expect(page.getByText("Sono Homun in modalità deterministica")).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(userBubbles(page)).toHaveCount(2);
    await expect(userBubbles(page).nth(1)).toHaveText("E con i documenti?");
    await expect(picker).toHaveCount(0);
  });

  test("6 · l'ultima modalità scelta resta il default per le conversazioni nuove e sopravvive al ricaricamento", async ({
    page,
    browser,
  }) => {
    // Invariante: l'ultima modalità scelta dalla persona (Autonomo /
    // Supervisionato / Con guardrail) è il SUO default per le conversazioni
    // nuove, e persiste come preferenza della persona NEL MOTORE — non solo
    // in questo browser: un browser nuovo (senza IndexedDB né localStorage)
    // la ritrova.
    await page.goto("/");
    await selectMode(page, "Autonomo");

    // Una conversazione nuova parte con la stessa modalità.
    await page.locator(".cw-sb-new-btn").click();
    await expect(page.getByTitle(/^Modalità: Autonomo/)).toBeVisible();

    // Il motore custodisce la preferenza della persona.
    await expect
      .poll(() => readEngine(engine!.url, "people/person_fabio/autonomy"), { timeout: 10_000 })
      .toEqual({ autonomy: "autonomous" });

    // Un browser nuovo di zecca: la modalità arriva dal motore.
    const fresh = await browser.newContext();
    try {
      const other = await fresh.newPage();
      await pointBrowserAtEngine(other, engine!.url);
      await other.goto("/");
      await expect(other.getByTitle(/^Modalità: Autonomo/)).toBeVisible({ timeout: 30_000 });
    } finally {
      await fresh.close();
    }
  });
});
