/**
 * L'errore del confronto listini parla la lingua dell'utente e nomina il
 * listino tradotto: «listino precedente», mai «left». Il corpo è quello vero
 * del motore (reason + params con chiave di etichetta side@label).
 *
 * Canale visivo: la sezione Materiali (l'avviso HomunErrorNotice è lo stesso
 * componente e la stessa composizione del pannello confronto; quel pannello
 * non è raggiungibile dai mock engine perché EngineWorkIntake è montato solo
 * dalla ChatStage in modalità simulazione).
 */
import { expect, test } from "@playwright/test";
import { mockEngine, PROJECT_ID } from "./error-language-mocks.ts";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("homun.engine.dataSource", "engine");
  });
});

test("l'errore del confronto nomina il listino tradotto, in italiano e in inglese", async ({
  page,
}) => {
  await mockEngine(page);
  // L'ingest del listino precedente risponde col corpo vero del confronto:
  // CSV non UTF-8, params side = chiave di etichetta del catalogo condiviso.
  await page.route(`**/projects/${PROJECT_ID}/materials/ingest`, async (route) => {
    await route.fulfill({
      json: {
        detail: {
          code: "validation_error",
          reason: "comparison.csv.not_utf8",
          params: { side: "comparison.previous" },
          message: "left: CSV must be UTF-8",
        },
      },
      status: 400,
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Consulta materiali" }).click();
  const materials = page.locator('section[aria-label="Materiali"]');
  await expect(materials).toBeVisible();

  await page.getByRole("combobox", { name: "Progetto dei materiali" }).click();
  await page.getByRole("option", { name: "Listini" }).click();
  await materials
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "listino-precedente.csv",
      mimeType: "text/csv",
      buffer: Buffer.from([0xff, 0xfe, 0x00, 0x73]), // non UTF-8
    });

  // frase italiana con il nome tradotto del listino, senza left/right
  const notice = materials.locator(".homun-error-notice__text").first();
  await expect(notice).toHaveText("«listino precedente»: il CSV deve essere salvato in UTF-8.");
  const screenshotDir = process.env.HOMUN_SCREENSHOT_DIR;
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/confronto-errore-it.png`, fullPage: false });
  }

  // cambio lingua: la stessa notifica già a schermo diventa inglese
  await page.locator('button[title="Impostazioni dello spazio"]').first().click();
  await page.getByRole("button", { name: "Aspetto e lingua" }).click();
  await page.getByRole("combobox", { name: "Lingua dell’interfaccia" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await page.keyboard.press("Escape");

  await expect(notice).toHaveText("“previous price list”: the CSV must be saved as UTF-8.");
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/confronto-errore-en.png`, fullPage: false });
  }
});
