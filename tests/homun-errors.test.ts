import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HomunClientError,
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
    const message = homunErrorUserMessage(
      new HomunClientError("request_cancelled", "cancelled"),
    );
    assert.match(message, /annullata/i);
  });
});

it("preserves command, provider and storage error codes with actionable copy", () => {
  for (const code of ["command_in_progress", "provider_unavailable", "storage_unavailable"] as const) {
    const error = homunErrorFromHttp(code === "command_in_progress" ? 409 : 503,
      { detail: { code, message: "detail" } }, "fallback");
    assert.equal(error.code, code);
    assert.notEqual(homunErrorUserMessage(error), "detail");
  }
});
