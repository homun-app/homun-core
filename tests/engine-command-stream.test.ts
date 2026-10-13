/**
 * Errori del flusso SSE dei comandi: il codice del motore sopravvive al client.
 *
 * Il motore manda gli errori dei comandi come eventi `error` con
 * `{code, message}` (per esempio `provider_unavailable` con il testo grezzo
 * dell'eccezione Python). Il client deve conservare il codice — così la copia
 * di prodotto del mapping vince — e mai far arrivare il testo grezzo all'utente.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  postEngineCommandStream,
  defaultLocalActor,
} from "../apps/web/src/lib/engine-domain-client.ts";
import { homunErrorUserMessage, isHomunClientError } from "../apps/web/src/lib/homun-errors.ts";

const sse = (events: string[]) =>
  new Response(`${events.join("\n\n")}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

test("l'evento error del motore conserva il codice: copia di prodotto, niente testo grezzo", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      'event: error\ndata: {"code":"provider_unavailable","message":"Local model interpret failed: [Errno 61] Connection refused"}',
    ]);
  try {
    await assert.rejects(
      postEngineCommandStream({ type: "conversation.post_message", actor: defaultLocalActor() }),
      (cause: unknown) => {
        assert.ok(isHomunClientError(cause));
        assert.equal(cause.code, "provider_unavailable");
        const shown = homunErrorUserMessage(cause);
        assert.equal(
          shown,
          "Il modello non è disponibile. Il messaggio resta salvato: puoi riprovare.",
        );
        assert.doesNotMatch(shown, /Errno/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("un codice non riconosciuto non trascina il messaggio grezzo all'utente", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    sse(['event: error\ndata: {"code":"stream_error","message":"boom [Errno 61]"}']);
  try {
    await assert.rejects(
      postEngineCommandStream({ type: "conversation.post_message", actor: defaultLocalActor() }),
      (cause: unknown) => {
        assert.ok(isHomunClientError(cause));
        assert.equal(cause.code, "unknown");
        assert.equal(homunErrorUserMessage(cause), "Errore imprevisto.");
        return true;
      },
    );
  } finally {
    globalThis.fetch = previous;
  }
});
