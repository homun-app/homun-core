/**
 * Il MOTORE VERO come processo di prova per i test browser: data dir
 * temporanea, provider `fake` (deterministico, senza rete), `--dev-insecure`
 * (solo loopback). Ogni file di test lo avvia sulla SUA porta e dice al
 * browser dove trovarlo (`window.homunDesktop.engineBaseUrl`, la stessa
 * leva del desktop), così i file girano in parallelo senza contendersi 8765.
 *
 * Mai usare il motore o la data dir della persona: se la porta è occupata il
 * test si ferma subito.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, type Page } from "@playwright/test";

export const ENGINE_DIR = resolve("engine");

// Come i test desktop che avviano il motore: interprete configurabile e,
// quando nessun python sa importare homun (job CI senza motore), salto
// pulito invece di fallire — il flusso del motore resta coperto lì.
export const ENGINE_PYTHON =
  process.env.HOMUN_TEST_PYTHON || join(ENGINE_DIR, ".venv", "bin", "python");
export const engineImportable = spawnSync(ENGINE_PYTHON, ["-c", "import homun"]).status === 0;
export const ENGINE_SKIP_REASON = `nessun interprete con homun (${ENGINE_PYTHON}): motore non installato`;

export type TestEngine = {
  url: string;
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
};

/** Avvia un motore di prova su `port` con il provider fake e attende la salute. */
export async function startTestEngine(port: number, prefix = "homun-e2e-"): Promise<TestEngine> {
  const url = `http://127.0.0.1:${port}`;
  const occupied = await fetch(`${url}/v1/health`).then(
    (response) => response.ok,
    () => false,
  );
  if (occupied) throw new Error(`la porta ${port} è già occupata da un altro motore`);
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  // Il provider fake è esplicito: un profilo offline/CI rispettato dal motore.
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, "models.json"),
    `${JSON.stringify({ active_provider_id: "fake" }, null, 2)}\n`,
  );
  const child: ChildProcess = spawn(
    ENGINE_PYTHON,
    ["-m", "homun", "serve", "--host", "127.0.0.1", "--port", String(port), "--dev-insecure"],
    {
      cwd: ENGINE_DIR,
      env: { ...process.env, HOMUN_DATA_DIR: dataDir, HOMUN_LOG_LEVEL: "WARNING" },
      stdio: "ignore",
    },
  );
  const stop = async () => {
    child.kill();
    await new Promise((wait) => setTimeout(wait, 500));
    await rm(dataDir, { recursive: true, force: true });
  };
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/v1/health`);
      if (response.ok) return { url, port, dataDir, stop };
    } catch {
      /* il motore sta ancora aprendo il socket */
    }
    await new Promise((sleep) => setTimeout(sleep, 500));
  }
  await stop();
  throw new Error("il motore di prova non è diventato raggiungibile su " + url);
}

/** Il browser parla con QUESTO motore (non con quello predefinito su 8765). */
export async function pointBrowserAtEngine(page: Page, url: string): Promise<void> {
  await page.addInitScript((engineBaseUrl) => {
    (window as unknown as { homunDesktop: { engineBaseUrl: string } }).homunDesktop = {
      engineBaseUrl,
    };
  }, url);
}

/** Intestazioni della persona locale, come le manda la UI. */
export const PERSON_HEADERS = {
  "Content-Type": "application/json",
  "X-Homun-Actor-Id": "person_fabio",
};

/** Un comando del motore come lo manda la UI (`/commands`). */
export async function postCommand(
  url: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/v1/workspaces/ws_local/commands`, {
    method: "POST",
    headers: PERSON_HEADERS,
    body: JSON.stringify({ command_id: crypto.randomUUID(), type, payload }),
  });
  if (!response.ok) throw new Error(`${type} rifiutato: ${await response.text()}`);
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

/** Una lettura del motore (`GET /v1/workspaces/ws_local/...`) come la fa la UI. */
export async function readEngine<T = Record<string, unknown>>(
  url: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${url}/v1/workspaces/ws_local/${path}`, {
    headers: PERSON_HEADERS,
  });
  if (!response.ok) throw new Error(`GET ${path} rifiutato: ${await response.text()}`);
  return (await response.json()) as T;
}

/** I messaggi della persona salvati dal motore, per TUTTE le conversazioni. */
export async function personMessagesInEngine(url: string): Promise<string[]> {
  const conversations = await readEngine<{ items: Array<{ id: string }> }>(url, "conversations");
  const texts: string[] = [];
  for (const conversation of conversations.items) {
    const messages = await readEngine<{ items: Array<{ author_id: string; text: string }> }>(
      url,
      `conversations/${encodeURIComponent(conversation.id)}/messages`,
    );
    for (const message of messages.items)
      if (message.author_id === "person_fabio") texts.push(message.text);
  }
  return texts;
}

/** Scrive nel composer della chat e invia con Invio, come la persona. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder("Chiedi, crea o assegna un compito…");
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await composer.press("Enter");
}

/** Sceglie la modalità di autonomia dal composer, come la persona. */
export async function selectMode(page: Page, label: string): Promise<void> {
  await page.getByTitle(/^Modalità:/).click();
  // L'opzione del popover, non l'etichetta del bottone: possono coincidere
  // quando la modalità scelta è già quella attiva.
  await page.getByRole("option", { name: new RegExp(`^${label}(\\s|$)`) }).click();
  await expect(page.getByTitle(new RegExp(`^Modalità: ${label}`))).toBeVisible();
}
