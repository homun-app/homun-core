/**
 * Porta d'ingresso unica, verificata nella UI vera con il MOTORE VERO in
 * provider `fake` (deterministico, senza rete): conversazione nuova →
 * domanda → richiesta di lavoro → la scheda della proposta compare NELLA
 * TRASCRIZIONE senza ricaricare → Conferma → il lavoro sta in Compiti →
 * «grazie» risponde e non crea proposte nuove.
 *
 * Questo test copre ciò che il banco di prova golden NON vede: la UI.
 * Il motore gira come processo reale su 127.0.0.1:8765 (porta della UI in
 * sviluppo) con data dir temporanea e `--dev-insecure` (solo loopback).
 */
import { expect, test } from "@playwright/test";

import {
  ENGINE_SKIP_REASON,
  engineImportable,
  selectMode,
  sendMessage,
  startTestEngine,
  type TestEngine,
} from "./engine-harness";

const ENGINE_PORT = 8765;
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

test.skip(!engineImportable, ENGINE_SKIP_REASON);

// Percorso d'oro NELLA UI con un modello vero (come il banco golden): con
// HOMUN_GOLDEN_PROVIDER=local|cloud il motore usa Ollama (locale o «:cloud») e
// gira solo il test del lavoro completo; gli altri dipendono dal fake.
const GOLDEN = process.env.HOMUN_GOLDEN_PROVIDER ?? "";
const GOLDEN_MODEL =
  GOLDEN === "cloud"
    ? process.env.HOMUN_GOLDEN_CLOUD_MODEL || "glm-5.3-flash:cloud"
    : process.env.HOMUN_GOLDEN_LOCAL_MODEL || "qwen3.5:4b";

async function useGoldenModel() {
  const headers = { "Content-Type": "application/json", "X-Homun-Actor-Id": "person_fabio" };
  const connection = await fetch(`${ENGINE_URL}/v1/models/connections`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      connection_id: `golden_${GOLDEN}`,
      kind: "openai_compatible",
      display_name: `Golden ${GOLDEN}`,
      model_id: GOLDEN_MODEL,
      base_url: "http://127.0.0.1:11434/v1",
      context_window: 16384,
      max_output_tokens: 8192,
    }),
  });
  if (!connection.ok) throw new Error(`connessione golden rifiutata: ${await connection.text()}`);
  const active = await fetch(`${ENGINE_URL}/v1/models/providers/active`, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider_id: `golden_${GOLDEN}` }),
  });
  if (!active.ok) throw new Error(`connessione golden non attivata: ${await active.text()}`);
}

let engine: TestEngine | null = null;

test.beforeAll(async () => {
  // Porta predefinita della UI (8765): nessun `homunDesktop` da iniettare, così
  // il percorso golden gira esattamente come l'app.
  engine = await startTestEngine(ENGINE_PORT, "homun-front-door-e2e-");
  if (GOLDEN) await useGoldenModel();
});

test.afterAll(async () => {
  await engine?.stop();
});

/** Lo stile calcolato di un elemento: la scheda deve avere la sua grafica. */
async function computedStyle(
  page: import("@playwright/test").Page,
  selector: string,
  properties: string[],
): Promise<Record<string, string>> {
  return page
    .locator(selector)
    .first()
    .evaluate((element, props) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
    }, properties);
}

test.describe.serial("porta d'ingresso unica nella chat del motore", () => {
  // Ogni passo è un giro vero del motore; gli altri file di test girano in
  // parallelo con il loro motore, quindi il margine di tempo è generoso.
  test.describe.configure({ timeout: 90_000 });
  test("domanda, proposta in chat, conferma, Compiti e «grazie»", async ({ page }) => {
    test.skip(Boolean(GOLDEN), "dipende dal provider fake deterministico");
    await page.goto("/");

    // 1. Domanda di apertura: risposta testuale, nessuna proposta.
    await sendMessage(page, "Cosa sai fare?");
    await expect(page.getByText("Sono Homun in modalità deterministica").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("PROPOSTA DI LAVORO")).toHaveCount(0);

    // 2. Richiesta di lavoro: la scheda della proposta compare nella
    //    trascrizione, vicino al messaggio, senza ricaricare la pagina.
    await sendMessage(
      page,
      "Prepara una nota operativa: rinnovo contratto Rossi entro il 30 novembre.",
    );
    const card = page.getByRole("article", { name: "Proposta di lavoro e coordinamento Homun" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("PROPOSTA DI LAVORO")).toBeVisible();
    await expect(card.getByRole("button", { name: /Conferma accordo/ })).toBeEnabled();

    // 3. Conferma: l'accordo risulta confermato e il lavoro compare in Compiti.
    await card.getByRole("button", { name: /Conferma accordo/ }).click();
    const confirmed = page.getByRole("article", { name: "Accordo di lavoro confermato" });
    await expect(confirmed).toBeVisible({ timeout: 30_000 });
    await expect(confirmed.getByText("ACCORDO CONFERMATO")).toBeVisible();
    await expect(page.getByText("Nota operativa (fake)").first()).toBeVisible({ timeout: 15_000 });

    // 4. «grazie»: risposta testuale, NESSUNA nuova scheda.
    const proposalsBefore = await page.getByText("PROPOSTA DI LAVORO").count();
    await sendMessage(page, "grazie");
    await expect(page.getByText("Sono Homun in modalità deterministica").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("PROPOSTA DI LAVORO")).toHaveCount(proposalsBefore);
  });

  test("le schede (proposta, modifica, chiarimento) hanno il loro stile, non testo grezzo", async ({
    page,
  }) => {
    test.skip(Boolean(GOLDEN), "dipende dal provider fake deterministico");
    await page.goto("/");

    // 1. Proposta: la scheda nella trascrizione ha la sua grafica (badge,
    //    separatore, bottone), non è testo grezzo.
    await sendMessage(
      page,
      "Prepara una nota operativa: rinnovo contratto Rossi entro il 30 novembre.",
    );
    const card = page.getByRole("article", { name: "Proposta di lavoro e coordinamento Homun" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    expect(
      await computedStyle(page, ".cw-intake-coordinator-card__badge", ["text-transform"]),
    ).toEqual({
      "text-transform": "uppercase",
    });
    expect(
      await computedStyle(page, ".cw-intake-coordinator-card__footer", [
        "border-top-width",
        "border-top-style",
      ]),
    ).toEqual({ "border-top-width": "1px", "border-top-style": "solid" });
    expect(
      await computedStyle(page, ".cw-intake-coordinator-card__btn", ["border-radius"]),
    ).toEqual({ "border-radius": "10px" });

    // 2. Conferma, poi revisione: la scheda del cambiamento (cw-intake-changes)
    //    ha bordo e sfondo propri, diversi dalla trascrizione. In Supervisionato
    //    l'accordo confermato non è ancora partito, quindi si può ancora rivedere
    //    (con guardrail «Conferma accordo e avvia» lo avvia subito).
    await selectMode(page, "Supervisionato");
    await card.getByRole("button", { name: /Conferma accordo/ }).click();
    await expect(page.getByRole("article", { name: "Accordo di lavoro confermato" })).toBeVisible({
      timeout: 30_000,
    });
    await sendMessage(page, "Sposta la consegna al 15 dicembre.");
    const changes = page.locator(".cw-intake-changes");
    await expect(changes).toBeVisible({ timeout: 30_000 });
    expect(
      await computedStyle(page, ".cw-intake-changes", [
        "background-color",
        "border-top-width",
        "border-top-style",
        "border-radius",
      ]),
    ).toEqual({
      "background-color": "rgb(255, 255, 255)",
      "border-top-width": "1px",
      "border-top-style": "solid",
      "border-radius": "12px",
    });

    // 3. Chiarimento: la scheda delle domande ha il suo bordo e sfondo.
    await sendMessage(page, "Crea una relazione sui fornitori 2027");
    const clarify = page.locator(".cw-clarify-card");
    await expect(clarify).toBeVisible({ timeout: 30_000 });
    expect(
      await computedStyle(page, ".cw-clarify-card", ["border-top-width", "border-top-style"]),
    ).toEqual({ "border-top-width": "1px", "border-top-style": "solid" });
  });

  test("il messaggio che annuncia una scheda è una frase nella lingua della persona, senza ripeterla", async ({
    page,
  }) => {
    test.skip(Boolean(GOLDEN), "dipende dal provider fake deterministico");
    await page.goto("/");

    /** Il testo del messaggio assistente che porta una certa scheda. */
    async function messageTextWith(has: import("@playwright/test").Locator) {
      const root = page.locator('[data-slot="aui_assistant-message-root"]', { has }).last();
      await expect(root).toBeVisible({ timeout: 30_000 });
      const content = root.locator('[data-slot="aui_assistant-message-content"]');
      // La scheda può comparire prima del testo del messaggio: si aspetta il testo.
      await expect(content).not.toHaveText(/^\s*$/, { timeout: 30_000 });
      return (await content.innerText()).trim();
    }

    // 1. Proposta (persona che scrive in italiano, senza preferenze): il
    //    messaggio è UNA frase in italiano che rimanda alla scheda; non ripete
    //    titolo né contenuto e non dà istruzioni in voce motore.
    await sendMessage(
      page,
      "Prepara una nota operativa: rinnovo contratto Rossi entro il 30 novembre.",
    );
    const proposalMessage = await messageTextWith(
      page.getByRole("article", { name: "Proposta di lavoro e coordinamento Homun" }),
    );
    expect(proposalMessage).toBe("Ho preparato una proposta: controllala e confermala qui sotto.");
    expect(proposalMessage).not.toContain("Nota operativa");
    expect(proposalMessage).not.toMatch(/Usa |Use /);

    // 2. Chiarimento: stessa regola — le domande stanno nella scheda.
    await sendMessage(page, "Crea una relazione sui fornitori 2027");
    const clarifyMessage = await messageTextWith(page.locator(".cw-clarify-card"));
    expect(clarifyMessage).toBe(
      "Ho alcune domande prima di proporti il lavoro: rispondi qui sotto.",
    );
    expect(clarifyMessage).not.toContain("relazione sui fornitori?");
  });

  test("il lavoro confermato parte, il risultato sta in chat, si corregge, si approva", async ({
    page,
  }) => {
    // Con un modello vero ogni passo dura secondi o minuti.
    if (GOLDEN) test.setTimeout(30 * 60_000);
    await page.goto("/");

    // 1. Richiesta e conferma, nella modalità predefinita («Con guardrail»):
    //    «Conferma accordo e avvia» avvia davvero, la UI non sceglie l'esecutore.
    await sendMessage(
      page,
      "Prepara una nota operativa: rinnovo contratto Rossi entro il 30 novembre.",
    );
    const card = page.getByRole("article", { name: "Proposta di lavoro e coordinamento Homun" });
    await expect(card).toBeVisible({ timeout: GOLDEN ? 5 * 60_000 : 30_000 });
    if (GOLDEN) await page.screenshot({ path: "docs/screenshots/confirmed-work/01-proposta.png" });
    // Un modello vero può proporre l'accordo con «nodi aperti» (domande prima
    // di iniziare): la persona conferma lo stesso con «Procedi subito con
    // impostazioni predefinite», che è la stessa conferma della UI.
    await card
      .getByRole("button", { name: /Conferma accordo|Procedi subito con impostazioni predefinite/ })
      .click();

    // 2. Sotto l'accordo, la scheda dell'esecuzione: dallo stato «in corso»
    //    al risultato da rivedere, senza ricaricare la pagina.
    const execution = page.getByTestId("work-execution-card");
    await expect(execution).toBeVisible({ timeout: 30_000 });
    const work = GOLDEN ? 8 * 60_000 : 60_000;
    await expect(execution).toHaveAttribute("data-status", "completed", { timeout: work });
    await expect(execution.getByText(/Risultato da rivedere · v1/)).toBeVisible();
    await expect(execution.getByTestId("work-execution-result")).not.toBeEmpty();
    if (GOLDEN) await page.screenshot({ path: "docs/screenshots/confirmed-work/02-risultato.png" });

    // 3. «Chiedi correzione» con un motivo: riparte e arriva la versione 2.
    await execution.getByRole("button", { name: "Chiedi correzione" }).click();
    await execution.getByLabel("Cosa correggere").fill("Aggiungi una sezione Rischi.");
    await execution.getByRole("button", { name: "Invia la correzione" }).click();
    await expect(execution.getByText(/Risultato da rivedere · v2/)).toBeVisible({ timeout: work });

    // 4. «Approva»: il lavoro è approvato e il risultato sta in Documenti.
    await execution.getByRole("button", { name: "Approva" }).click();
    await expect(execution.getByText("Approvato · in Documenti")).toBeVisible({ timeout: 30_000 });
    if (GOLDEN) await page.screenshot({ path: "docs/screenshots/confirmed-work/03-approvato.png" });
    await expect(page.getByText("Invio al motore non riuscito")).toHaveCount(0);
  });
});
