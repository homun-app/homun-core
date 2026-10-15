/**
 * Un errore reale del motore (upload materiale oltre il limite) mostrato dal
 * catalogo condiviso nella lingua dell'utente: italiano, poi inglese dopo il
 * cambio lingua in Impostazioni — l'avviso già a schermo si aggiorna.
 *
 * Il motore è intercettato con page.route (stessa convenzione degli altri
 * test browser): la risposta d'errore è quella vera del motore, con
 * `reason` + `params` stabili (docs/development/2026-10-15-errori-multilingua.md).
 */
import { expect, test } from "@playwright/test";
import { MAX_BYTES, mockEngine } from "./error-language-mocks.ts";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("homun.engine.dataSource", "engine");
  });
});

test("l'errore del motore parla la lingua dell'utente e cambia con le Impostazioni", async ({
  page,
}) => {
  await mockEngine(page);
  await page.goto("/");

  // raccolta materiali dalla schermata iniziale
  await page.getByRole("button", { name: "Consulta materiali" }).click();
  const materials = page.locator('section[aria-label="Materiali"]');
  await expect(materials).toBeVisible();

  // un progetto reale, poi l'upload che il motore rifiuta col suo limite
  await page.getByRole("combobox", { name: "Progetto dei materiali" }).click();
  await page.getByRole("option", { name: "Listini" }).click();
  await page
    .locator('section[aria-label="Materiali"] input[type="file"]')
    .first()
    .setInputFiles({
      name: "listino.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("sku,name,price,currency\n1,Listino,1.00,EUR\n", "utf-8"),
    });

  // copia di prodotto in italiano, composta dal catalogo con i params
  const notice = materials.locator(".homun-error-notice__text").first();
  await expect(notice).toContainText(`Il file supera il limite di caricamento (${MAX_BYTES} byte)`);

  // la reason stabile vive nei dettagli tecnici, chiusi di default
  const details = materials.locator("details[data-homun-error-details]").first();
  await details.locator("summary").click();
  await expect(details.locator('[data-homun-error-detail="reason"]')).toHaveText(
    "materials.upload.too_large",
  );

  // cambio lingua in Impostazioni: lo stesso avviso già mostrato diventa inglese
  await page.locator('button[title="Impostazioni dello spazio"]').first().click();
  await page.getByRole("button", { name: "Aspetto e lingua" }).click();
  await page.getByRole("combobox", { name: "Lingua dell’interfaccia" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await page.keyboard.press("Escape");

  await expect(notice).toContainText(`The file exceeds the upload limit (${MAX_BYTES} bytes)`);
});
