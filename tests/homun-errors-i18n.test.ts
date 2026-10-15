/**
 * Errori multilingua lato client: il testo di prodotto si compone dal catalogo
 * condiviso (contracts/i18n) con reason+params; il codice resta il fallback;
 * «Dettagli tecnici» sempre disponibili, con reason.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setLanguage } from "../apps/web/src/lib/i18n/index.ts";
import { errorUserText } from "../apps/web/src/lib/i18n/error-catalog.ts";
import {
  HomunClientError,
  homunErrorDetailsText,
  homunErrorFromHttp,
  homunErrorFromEngineEvent,
  homunErrorTechnicalDetails,
  homunErrorUserMessage,
} from "../apps/web/src/lib/homun-errors.ts";

test.beforeEach(() => setLanguage("it"));

test("lo stesso errore si compone in italiano e in inglese dal catalogo", () => {
  const error = new HomunClientError("validation_error", "listino.csv: CSV must be UTF-8", {
    reason: "comparison.csv.not_utf8",
    params: { source: "listino.csv" },
  });
  const it = homunErrorUserMessage(error);
  assert.ok(it.includes("listino.csv"));
  assert.ok(it.includes("UTF-8"));
  assert.ok(it.startsWith("«"));

  setLanguage("en");
  const en = homunErrorUserMessage(error);
  assert.ok(en.includes("listino.csv"));
  assert.ok(en.includes("UTF-8"));
  assert.notEqual(en, it);
});

test("reason sconosciuta → frase generica del code nella lingua corrente", () => {
  const error = new HomunClientError("validation_error", "whatever", {
    reason: "not.migrated.yet",
  });
  assert.equal(
    homunErrorUserMessage(error),
    "La richiesta non è valida. Verifica i dati e riprova.",
  );
  setLanguage("en");
  assert.equal(
    homunErrorUserMessage(error),
    "The request is not valid. Check the data and try again.",
  );
});

test("lingua non supportata → inglese (catena di fallback del catalogo)", () => {
  assert.equal(
    errorUserText("comparison.csv.not_utf8", { source: "x.csv" }, "fr"),
    errorUserText("comparison.csv.not_utf8", { source: "x.csv" }, "en"),
  );
});

test("errori non migrati: il messaggio italiano del motore passa ancora, il grezzo no", () => {
  const human = new HomunClientError("validation_error", "Il titolo del materiale è obbligatorio");
  assert.equal(homunErrorUserMessage(human), "Il titolo del materiale è obbligatorio");

  const raw = new HomunClientError("validation_error", "ValueError: bad input");
  assert.equal(homunErrorUserMessage(raw), "La richiesta non è valida. Verifica i dati e riprova.");
});

test("homunErrorFromHttp porta reason e params dal corpo del motore", () => {
  const error = homunErrorFromHttp(
    400,
    {
      detail: {
        code: "validation_error",
        reason: "budget.exhausted.delegate",
        params: { delegate: "agent_analyst" },
        message: "Delegate budget exhausted for agent_analyst",
      },
    },
    "fallback",
  );
  assert.equal(error.code, "validation_error");
  assert.equal(error.reason, "budget.exhausted.delegate");
  assert.deepEqual(error.params, { delegate: "agent_analyst" });
  setLanguage("en");
  assert.ok(homunErrorUserMessage(error).includes("agent_analyst"));
});

test("homunErrorFromEngineEvent porta reason e params dall'evento SSE", () => {
  const error = homunErrorFromEngineEvent(
    "validation_error",
    "listino.csv: CSV must be UTF-8",
    "fallback",
    "comparison.csv.not_utf8",
    { source: "listino.csv" },
  );
  assert.equal(error.reason, "comparison.csv.not_utf8");
  assert.equal(homunErrorUserMessage(error), "«listino.csv»: il CSV deve essere salvato in UTF-8.");
});

test("i dettagli tecnici mostrano anche reason e restano copiabili", () => {
  const error = homunErrorFromHttp(
    400,
    {
      detail: {
        code: "validation_error",
        reason: "comparison.csv.not_utf8",
        params: { source: "listino.csv" },
        message: "listino.csv: CSV must be UTF-8",
      },
    },
    "fallback",
  );
  const details = homunErrorTechnicalDetails(error);
  assert.equal(details?.reason, "comparison.csv.not_utf8");
  const text = homunErrorDetailsText(details!);
  assert.match(text, /comparison\.csv\.not_utf8/);
  assert.match(text, /codice: validation_error/);
});

test("nessuna stringa per l'utente resta scritta in homun-errors.ts", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../apps/web/src/lib/homun-errors.ts", import.meta.url)),
    "utf-8",
  );
  const forbidden = [
    "Errore imprevisto",
    "La richiesta non è valida",
    "L'azione non è possibile",
    "App locale non raggiungibile",
    "Il motore non ha risposto",
    "Richiesta annullata",
    "Non hai i permessi",
    "Oggetto non trovato",
    "I dati sono cambiati",
    "già in elaborazione",
    "Il modello non è disponibile",
    "Il salvataggio non è disponibile",
    "Questa capacità del motore",
    "codice motore: ",
  ];
  for (const literal of forbidden) {
    assert.ok(!source.includes(literal), `user-facing literal still in code: ${literal}`);
  }
});

test("il catalogo errori ha le stesse chiavi in italiano e inglese", async () => {
  const { it, en } = await import("../apps/web/src/lib/i18n/error-catalog.ts").then((m) => ({
    it: m.errorCatalog("it"),
    en: m.errorCatalog("en"),
  }));
  assert.deepEqual(Object.keys(it.errors).sort(), Object.keys(en.errors).sort());
  assert.deepEqual(Object.keys(it.codes).sort(), Object.keys(en.codes).sort());
});
