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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

const ENGINE_PORT = 8765;
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
const ENGINE_DIR = resolve("engine");

// Come i test desktop che avviano il motore: interprete configurabile e,
// quando nessun python sa importare homun (job CI senza motore), salto
// pulito invece di fallire — il flusso del motore resta coperto lì.
const ENGINE_PYTHON = process.env.HOMUN_TEST_PYTHON || join(ENGINE_DIR, ".venv", "bin", "python");
const engineImportable = spawnSync(ENGINE_PYTHON, ["-c", "import homun"]).status === 0;
test.skip(!engineImportable, `nessun interprete con homun (${ENGINE_PYTHON}): motore non installato`);

let engine: ChildProcess | null = null;
let dataDir: string | null = null;

test.beforeAll(async () => {
  // Mai usare un motore estraneo: se la porta è occupata, fermo subito.
  const occupied = await fetch(`${ENGINE_URL}/v1/health`).then(
    (response) => response.ok,
    () => false,
  );
  if (occupied) throw new Error("la porta 8765 è già occupata da un altro motore");
  dataDir = await mkdtemp(join(tmpdir(), "homun-front-door-e2e-"));
  // Il provider fake è esplicito: un profilo offline/CI rispettato dal motore.
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, "models.json"),
    `${JSON.stringify({ active_provider_id: "fake" }, null, 2)}\n`,
  );
  engine = spawn(
    ENGINE_PYTHON,
    [
      "-m",
      "homun",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(ENGINE_PORT),
      "--dev-insecure",
    ],
    {
      cwd: ENGINE_DIR,
      env: { ...process.env, HOMUN_DATA_DIR: dataDir, HOMUN_LOG_LEVEL: "WARNING" },
      stdio: "ignore",
    },
  );
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ENGINE_URL}/v1/health`);
      if (response.ok) return;
    } catch {
      /* il motore sta ancora aprendo il socket */
    }
    await new Promise((sleep) => setTimeout(sleep, 500));
  }
  throw new Error("il motore di prova non è diventato raggiungibile su " + ENGINE_URL);
});

test.afterAll(async () => {
  engine?.kill();
  await new Promise((wait) => setTimeout(wait, 500));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function sendMessage(page: import("@playwright/test").Page, text: string) {
  const composer = page.getByPlaceholder("Chiedi, crea o assegna un compito…");
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await composer.press("Enter");
}

test.describe.serial("porta d'ingresso unica nella chat del motore", () => {
  test("domanda, proposta in chat, conferma, Compiti e «grazie»", async ({ page }) => {
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
});
