/**
 * Il budget richieste della chat verso il motore, contato nel browser vero
 * con il MOTORE VERO in provider fake: in una conversazione con un lavoro,
 * quattro minuti d'uso devono stare sotto le 80 richieste.
 *
 * Il test misura 30 secondi di quiete (nessuna azione) e pretende meno di 10
 * richieste: la stessa cadenza proiettata sui 240 secondi resta sotto le 80.
 */
import { expect, test } from "@playwright/test";

import {
  ENGINE_SKIP_REASON,
  engineImportable,
  pointBrowserAtEngine,
  sendMessage,
  startTestEngine,
  type TestEngine,
} from "./engine-harness";

const ENGINE_PORT = 8767;

test.skip(!engineImportable, ENGINE_SKIP_REASON);

let engine: TestEngine | null = null;

test.beforeAll(async () => {
  engine = await startTestEngine(ENGINE_PORT, "homun-polling-budget-e2e-");
});

test.afterAll(async () => {
  await engine?.stop();
});

test("7 · in conversazione con un lavoro, la quiete non esce dal budget (< 80 richieste in 4 minuti)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await pointBrowserAtEngine(page, engine!.url);
  await page.goto("/");

  // Una conversazione con un lavoro, come nell'uso vero: primo messaggio,
  // risposta del motore, poi la persona legge.
  await sendMessage(page, "Cosa sai fare?");
  await expect(page.getByText("Sono Homun in modalità deterministica").first()).toBeVisible({
    timeout: 30_000,
  });
  // le code delle azioni appena finite si asciugano
  await page.waitForTimeout(2_000);

  // La finestra di misura: 30 s di quiete, contando ogni richiesta /v1/.
  let requests = 0;
  const onRequest = (request: import("@playwright/test").Request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/v1/") || pathname.startsWith("/v1")) requests += 1;
  };
  page.on("request", onRequest);
  await page.waitForTimeout(30_000);
  page.off("request", onRequest);

  // < 80 in 240 s ⇒ in 30 s devono stare in meno di 10 (stessa cadenza).
  expect(requests).toBeLessThan(10);
});
