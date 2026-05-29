import { describe, expect, it } from "vitest";
import { isHeadlessNavigationFailure } from "../src/browser/session_manager.js";

describe("browser session manager", () => {
  it("classifies headless-only navigation failures for visible retry", () => {
    expect(
      isHeadlessNavigationFailure(
        new Error("page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.test"),
      ),
    ).toBe(true);
    expect(
      isHeadlessNavigationFailure(
        new Error("page.goto: net::ERR_CONNECTION_RESET at https://example.test"),
      ),
    ).toBe(true);
    expect(isHeadlessNavigationFailure(new Error("page.goto: Timeout 30000ms exceeded"))).toBe(
      false,
    );
  });
});
