import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HomunClientError,
  homunErrorFromEngineEvent,
  homunErrorFromHttp,
  homunErrorUserMessage,
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
