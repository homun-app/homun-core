import { describe, expect, it } from "vitest";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

describe("browser profiles", () => {
  it("lists assistant and attach-only user profile states", async () => {
    const manager = new BrowserSessionManager({ headless: true });

    await expect(manager.profiles()).resolves.toEqual([
      { name: "assistant", status: "stopped", headless: true, mode: "managed" },
      { name: "user", status: "needs_cdp_endpoint", headless: false, mode: "attach_only" },
    ]);
  });

  it("requires manual user action before starting the attach-only user profile without CDP", async () => {
    const manager = new BrowserSessionManager({ headless: true });

    await expect(manager.start({ profile: "user" })).rejects.toMatchObject({
      code: "BROWSER_USER_PROFILE_UNAVAILABLE",
      manualActionRequired: true,
    });
  });
});
