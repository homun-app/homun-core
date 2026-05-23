import { describe, expect, it } from "vitest";
import { handleRequestLine } from "../src/server.js";

describe("browser sidecar server dispatch", () => {
  it("preserves request id in health responses", async () => {
    const line = await handleRequestLine(JSON.stringify({ id: "req_1", method: "browser.health" }));

    expect(JSON.parse(line)).toEqual({
      id: "req_1",
      ok: true,
      result: {
        status: "ready",
        transport: "stdio",
      },
    });
  });

  it("turns invalid request lines into typed error responses", async () => {
    const line = await handleRequestLine("{");

    expect(JSON.parse(line)).toEqual({
      id: "unknown",
      ok: false,
      error: {
        code: "BROWSER_INVALID_JSON",
        message: "request line is not valid JSON",
        retryable: false,
        manual_action_required: false,
      },
    });
  });
});
