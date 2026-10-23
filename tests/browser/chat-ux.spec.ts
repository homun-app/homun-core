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
});
