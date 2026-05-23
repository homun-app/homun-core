import { describe, expect, it } from "vitest";
import {
  BrowserAutomationError,
  makeErrorResponse,
  makeSuccessResponse,
  parseRequestLine,
  serializeResponseLine,
} from "../src/contracts.js";

describe("browser sidecar contracts", () => {
  it("parses a JSON-line request envelope", () => {
    const request = parseRequestLine(
      JSON.stringify({
        id: "req_1",
        method: "browser.health",
        params: { profile: "assistant" },
      }),
    );

    expect(request).toEqual({
      id: "req_1",
      method: "browser.health",
      params: { profile: "assistant" },
    });
  });

  it("serializes success responses as single JSON lines", () => {
    const line = serializeResponseLine(
      makeSuccessResponse("req_1", {
        status: "ready",
      }),
    );

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      id: "req_1",
      ok: true,
      result: { status: "ready" },
    });
  });

  it("serializes typed errors without losing retry metadata", () => {
    const error = new BrowserAutomationError({
      code: "BROWSER_STALE_REF",
      message: "ref is stale",
      retryable: true,
      manualActionRequired: false,
    });

    const line = serializeResponseLine(makeErrorResponse("req_1", error));

    expect(JSON.parse(line)).toEqual({
      id: "req_1",
      ok: false,
      error: {
        code: "BROWSER_STALE_REF",
        message: "ref is stale",
        retryable: true,
        manual_action_required: false,
      },
    });
  });
});
