import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HomunClientError,
  homunErrorDetailsText,
  homunErrorFromEngineEvent,
  homunErrorFromHttp,
  homunErrorTechnicalDetails,
  homunErrorUserMessage,
  looksLikeRawException,
} from "../apps/web/src/lib/homun-errors.ts";

describe("homunErrorFromHttp", () => {
  it("maps version_conflict from engine detail", () => {
    const error = homunErrorFromHttp(
      409,
      { detail: { code: "version_conflict", message: "stale" } },
      "fallback",
    );
    assert.equal(error.code, "version_conflict");
    assert.equal(error.message, "stale");
    assert.equal(error.httpStatus, 409);
  });

  it("falls back to status mapping when detail is missing", () => {
    const error = homunErrorFromHttp(404, null, "missing");
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "missing");
  });
});

describe("homunErrorUserMessage", () => {
  it("returns Italian copy for request cancelled", () => {
    const message = homunErrorUserMessage(new HomunClientError("request_cancelled", "cancelled"));
    assert.match(message, /annullata/i);
  });

  it("never surfaces raw exception text for unknown codes or plain errors", () => {
    const raw = "Local model interpret failed: [Errno 61] Connection refused";
    assert.equal(homunErrorUserMessage(new HomunClientError("unknown", raw)), "Errore imprevisto.");
    assert.equal(homunErrorUserMessage(new HomunClientError("unknown", "")), "Errore imprevisto.");
    assert.equal(homunErrorUserMessage(new Error(raw)), "Errore imprevisto.");
  });
});

describe("homunErrorFromEngineEvent", () => {
  it("keeps the engine event code so product copy wins over the raw message", () => {
    const error = homunErrorFromEngineEvent(
      "provider_unavailable",
      "Local model interpret failed: [Errno 61] Connection refused",
      "fallback",
    );
    assert.equal(error.code, "provider_unavailable");
    assert.equal(error.retryable, true);
    assert.equal(
      homunErrorUserMessage(error),
      "Il modello non è disponibile. Il messaggio resta salvato: puoi riprovare.",
    );
  });

  it("maps unrecognized event codes to unknown without leaking the raw message", () => {
    const error = homunErrorFromEngineEvent("stream_error", "boom [Errno 61]", "fallback");
    assert.equal(error.code, "unknown");
    assert.equal(homunErrorUserMessage(error), "Errore imprevisto.");
  });

  it("falls back when the event carries no message", () => {
    const error = homunErrorFromEngineEvent(null, "", "Engine stream error");
    assert.equal(error.code, "unknown");
    assert.equal(error.message, "Engine stream error");
  });
});

it("preserves command, provider and storage error codes with actionable copy", () => {
  for (const code of [
    "command_in_progress",
    "provider_unavailable",
    "storage_unavailable",
  ] as const) {
    const error = homunErrorFromHttp(
      code === "command_in_progress" ? 409 : 503,
      { detail: { code, message: "detail" } },
      "fallback",
    );
    assert.equal(error.code, code);
    assert.notEqual(homunErrorUserMessage(error), "detail");
  }
});

describe("looksLikeRawException", () => {
  it("riconosce il testo grezzo di eccezione del motore", () => {
    const rawMessages = [
      "Local model interpret failed: [Errno 61] Connection refused",
      "ValueError: invalid literal for int() with base 10: 'x'",
      "Traceback (most recent call last)",
      "TypeError: 'NoneType' object is not iterable",
      "homun.core.interpret failed while parsing the objective",
      "pydantic.v1.ValidationError: field required",
      "RuntimeError: worker died",
    ];
    for (const message of rawMessages) {
      assert.equal(looksLikeRawException(message), true, message);
    }
  });

  it("lascia passare le frasi di prodotto scritte dal motore", () => {
    const productPhrases = [
      "Il campo scadenza non può essere nel passato.",
      "Errore di validazione: manca il titolo del lavoro.",
      "Non puoi chiudere un lavoro mai avviato.",
      "La risposta non può essere recuperata automaticamente.",
      "Riprova tra poco.",
    ];
    for (const message of productPhrases) {
      assert.equal(looksLikeRawException(message), false, message);
    }
  });

  it("i nomi di file e i domini non sono eccezioni grezze", () => {
    const productPhrases = [
      "Il file report.pdf supera la dimensione massima.",
      "Il materiale listino_ottobre.csv è già nel progetto",
      "Il dominio homun.app non è raggiungibile",
      "Usa un file .csv o .xlsx",
      "Scrivi a supporto@homun.app",
    ];
    for (const message of productPhrases) {
      assert.equal(looksLikeRawException(message), false, message);
    }
  });

  it("riconosce i percorsi di modulo dei moduli reali del motore", () => {
    const rawMessages = [
      "ValueError: invalid literal for int()",
      "[Errno 61] Connection refused",
      "Traceback (most recent call last)",
      "KeyError: 'step_id'",
      "pydantic.error_wrappers.ValidationError: 1 validation error",
      "homun.models.native_turn failed",
    ];
    for (const message of rawMessages) {
      assert.equal(looksLikeRawException(message), true, message);
    }
  });
});

describe("homunErrorUserMessage: validation_error e invalid_transition", () => {
  it("una frase di prodotto del motore resta il testo principale", () => {
    const phrase = "Il campo scadenza non può essere nel passato.";
    const validation = new HomunClientError("validation_error", phrase);
    assert.equal(homunErrorUserMessage(validation), phrase);
    const transition = new HomunClientError(
      "invalid_transition",
      "Non puoi chiudere un lavoro mai avviato.",
    );
    assert.equal(homunErrorUserMessage(transition), "Non puoi chiudere un lavoro mai avviato.");
  });

  it("un'eccezione grezza diventa copia di prodotto, mai testo grezzo", () => {
    const raw = "ValueError: invalid literal for int() with base 10: 'x'";
    const validation = homunErrorFromEngineEvent("validation_error", raw, "fallback");
    assert.equal(
      homunErrorUserMessage(validation),
      "La richiesta non è valida. Verifica i dati e riprova.",
    );
    const transition = homunErrorFromEngineEvent("invalid_transition", raw, "fallback");
    assert.equal(
      homunErrorUserMessage(transition),
      "L'azione non è possibile nello stato attuale. Ricarica e riprova.",
    );
  });

  it("un messaggio col nome di un file resta il testo principale", () => {
    const phrase = "Il file report.pdf supera la dimensione massima.";
    const error = homunErrorFromEngineEvent("validation_error", phrase, "fallback");
    assert.equal(homunErrorUserMessage(error), phrase);
  });
});

describe("homunErrorTechnicalDetails", () => {
  it("errore senza testo di prodotto: dettagli con codice e messaggio originale", () => {
    const raw = "Local model interpret failed: [Errno 61] Connection refused";
    const error = new HomunClientError("unknown", raw);
    assert.equal(homunErrorUserMessage(error), "Errore imprevisto.");
    const details = homunErrorTechnicalDetails(error);
    assert.equal(details?.code, "unknown");
    assert.equal(details?.message, raw);
    assert.equal(details?.engineCode, null);
  });

  it("errore con testo di prodotto: il messaggio originale resta nei dettagli", () => {
    const raw = "Local model interpret failed: [Errno 61] Connection refused";
    const error = homunErrorFromEngineEvent("provider_unavailable", raw, "fallback");
    assert.equal(
      homunErrorUserMessage(error),
      "Il modello non è disponibile. Il messaggio resta salvato: puoi riprovare.",
    );
    const details = homunErrorTechnicalDetails(error);
    assert.equal(details?.code, "provider_unavailable");
    assert.equal(details?.message, raw);
  });

  it("se il messaggio coincide col testo di prodotto, il blocco mostra solo il codice", () => {
    const phrase = "Il campo scadenza non può essere nel passato.";
    const error = new HomunClientError("validation_error", phrase);
    const details = homunErrorTechnicalDetails(error);
    assert.ok(details);
    assert.equal(details.message, null);
    assert.equal(homunErrorDetailsText(details), "codice: validation_error");
  });

  it("porta il codice del motore quando differisce da quello mappato", () => {
    const error = homunErrorFromEngineEvent("stream_error", "boom", "fallback");
    const details = homunErrorTechnicalDetails(error);
    assert.ok(details);
    assert.equal(details.code, "unknown");
    assert.equal(details.engineCode, "stream_error");
    const text = homunErrorDetailsText(details);
    assert.match(text, /codice: unknown/);
    assert.match(text, /codice motore: stream_error/);
  });

  it("errori non tipizzati: codice unknown, messaggio originale disponibile", () => {
    const details = homunErrorTechnicalDetails(new Error("Failed to fetch"));
    assert.equal(details?.code, "unknown");
    assert.equal(details?.message, "Failed to fetch");
  });

  it("il testo grezzo non finisce mai nel testo principale, solo nei dettagli", () => {
    const raw = "homun.core.interpret failed: [Errno 61] Connection refused";
    const errors = [
      new HomunClientError("unknown", raw),
      new HomunClientError("validation_error", raw),
      new HomunClientError("invalid_transition", raw),
      homunErrorFromEngineEvent("stream_error", raw, "fallback"),
    ];
    for (const error of errors) {
      const main = homunErrorUserMessage(error);
      assert.ok(!main.includes(raw), `testo principale contaminato: ${main}`);
      assert.equal(homunErrorTechnicalDetails(error)?.message, raw);
    }
  });
});
