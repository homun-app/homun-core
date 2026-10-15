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
import {
  errorLabelText,
  errorUserText,
  formatErrorPlaceholders,
} from "../apps/web/src/lib/i18n/error-catalog.ts";
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
  const error = new HomunClientError("validation_error", "left: CSV must be UTF-8", {
    reason: "comparison.csv.not_utf8",
    params: { side: "comparison.previous" },
  });
  const it = homunErrorUserMessage(error);
  assert.ok(it.includes("listino precedente"));
  assert.ok(it.includes("UTF-8"));
  assert.ok(it.startsWith("«"));
  assert.ok(!it.includes("left"));

  setLanguage("en");
  const en = homunErrorUserMessage(error);
  assert.ok(en.includes("previous price list"));
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
    errorUserText("comparison.csv.not_utf8", { side: "comparison.previous" }, "fr"),
    errorUserText("comparison.csv.not_utf8", { side: "comparison.previous" }, "en"),
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
        reason: "work.transition_invalid",
        params: { from: "work.status.draft", to: "work.status.running" },
        message: "Cannot transition work from draft to running",
      },
    },
    "fallback",
  );
  assert.equal(error.code, "validation_error");
  assert.equal(error.reason, "work.transition_invalid");
  assert.deepEqual(error.params, { from: "work.status.draft", to: "work.status.running" });
  assert.equal(
    homunErrorUserMessage(error),
    "Il lavoro non può passare da «bozza» a «in esecuzione».",
  );
  setLanguage("en");
  assert.equal(homunErrorUserMessage(error), "The work cannot move from “draft” to “running”.");
});

test("homunErrorFromEngineEvent porta reason e params dall'evento SSE", () => {
  const error = homunErrorFromEngineEvent(
    "validation_error",
    "right: CSV must be UTF-8",
    "fallback",
    "comparison.csv.not_utf8",
    { side: "comparison.updated" },
  );
  assert.equal(error.reason, "comparison.csv.not_utf8");
  assert.equal(
    homunErrorUserMessage(error),
    "«listino aggiornato»: il CSV deve essere salvato in UTF-8.",
  );
});

test("i dettagli tecnici mostrano anche reason e restano copiabili", () => {
  const error = homunErrorFromHttp(
    400,
    {
      detail: {
        code: "validation_error",
        reason: "comparison.csv.not_utf8",
        params: { side: "comparison.previous" },
        message: "left: CSV must be UTF-8",
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
  assert.deepEqual(Object.keys(it.labels).sort(), Object.keys(en.labels).sort());
  assert.deepEqual(Object.keys(it.codes).sort(), Object.keys(en.codes).sort());
});

test("il meccanismo {param@label} è unico: il client risolve le chiavi come il motore", () => {
  assert.equal(errorLabelText("comparison.previous", "it"), "listino precedente");
  assert.equal(errorLabelText("comparison.previous", "en"), "previous price list");
  assert.equal(
    formatErrorPlaceholders("Lato: {side@label}", { side: "comparison.updated" }, "it"),
    "Lato: listino aggiornato",
  );
  assert.equal(
    formatErrorPlaceholders("Lato: {side@label}", { side: "comparison.updated" }, "en"),
    "Lato: updated price list",
  );
});

// Stessa garanzia del test motore: la frase italiana non contiene valori di
// enum interni, left/right, id di attori, né chiavi di catalogo non risolte.
const FORBIDDEN_IN_ITALIAN = [
  "left",
  "right",
  "Material",
  "Grant",
  "note",
  "link",
  "file_ref",
  "active",
  "archived",
  "draft",
  "ready",
  "running",
  "waiting_input",
  "waiting_approval",
  "paused",
  "review",
  "completed",
  "failed",
  "cancelled",
];
const FORBIDDEN_PATTERNS = [
  /\b(person|agent)_[A-Za-z0-9_-]+\b/,
  /\b(comparison|materials\.kind|work\.status|policy\.entity)\.\w/,
  /\{\w+/,
];

test("ogni frase italiana si compone senza etichette interne né id", async () => {
  const { errorCatalog } = await import("../apps/web/src/lib/i18n/error-catalog.ts");
  const samples: Record<string, Record<string, string | number>> = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../contracts/i18n/errors.samples.json", import.meta.url)),
      "utf-8",
    ),
  ).params;
  const reasons = Object.keys(errorCatalog("it").errors);
  assert.ok(reasons.length > 0, "catalogo vuoto");
  for (const reason of reasons) {
    const sentence = errorUserText(reason, samples[reason] ?? {}, "it");
    assert.ok(sentence, `${reason}: frase mancante nel catalogo it`);
    for (const token of FORBIDDEN_IN_ITALIAN) {
      assert.ok(
        !new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(sentence!),
        `${reason}: etichetta interna \`${token}\` nella frase italiana: ${sentence}`,
      );
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(!pattern.test(sentence!), `${reason}: pattern ${pattern} nella frase: ${sentence}`);
    }
  }
});

test("ogni frase inglese si compone con le etichette tradotte", async () => {
  const { errorCatalog } = await import("../apps/web/src/lib/i18n/error-catalog.ts");
  const samples: Record<string, Record<string, string | number>> = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../contracts/i18n/errors.samples.json", import.meta.url)),
      "utf-8",
    ),
  ).params;
  for (const reason of Object.keys(errorCatalog("en").errors)) {
    const sentence = errorUserText(reason, samples[reason] ?? {}, "en");
    assert.ok(
      sentence && !sentence.includes("{"),
      `${reason}: segnaposto non risolto: ${sentence}`,
    );
  }
});
