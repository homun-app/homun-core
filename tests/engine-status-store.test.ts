/**
 * Il budget richieste della chat: una sola sonda dello stato per tutta l'app.
 *
 * Invariante (punto 7 del giro): in una conversazione con un lavoro, quattro
 * minuti d'uso stanno sotto le 80 richieste. La cadenza è dichiarata qui:
 * mai più frequente di ogni 10 secondi, e solo con la scheda visibile.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_POLL_INTERVAL_MS } from "../apps/web/src/lib/engine-status-store.ts";

test("la sonda dello stato non è più frequente di ogni 10 secondi", () => {
  assert.ok(STATUS_POLL_INTERVAL_MS >= 10_000, `got ${STATUS_POLL_INTERVAL_MS}ms`);
});
