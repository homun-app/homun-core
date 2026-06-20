import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assistantUserDataDir } from "../src/browser/profiles.js";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

describe("assistant profile location", () => {
  const keys = [
    "BROWSER_AUTOMATION_PERSIST_PROFILE",
    "BROWSER_AUTOMATION_ISOLATED_CONTEXT",
    "BROWSER_AUTOMATION_PROFILE_ROOT",
  ];
  afterEach(() => {
    for (const key of keys) delete process.env[key];
  });

  it("defaults to an EPHEMERAL per-process dir under the OS temp (no carried-over bot flag)", () => {
    const dir = assistantUserDataDir();
    expect(dir).toBe(
      path.join(os.tmpdir(), "local-first-browser-automation", `assistant-${process.pid}`),
    );
  });

  it("uses a STABLE persistent dir only when persistence is opted in", () => {
    process.env.BROWSER_AUTOMATION_PERSIST_PROFILE = "1";
    process.env.BROWSER_AUTOMATION_PROFILE_ROOT = "/data/profiles";
    expect(assistantUserDataDir()).toBe(path.join("/data/profiles", "assistant"));
  });

  it("stays ephemeral for isolated workers even with persistence on (SingletonLock safety)", () => {
    process.env.BROWSER_AUTOMATION_PERSIST_PROFILE = "1";
    process.env.BROWSER_AUTOMATION_ISOLATED_CONTEXT = "1";
    expect(assistantUserDataDir()).toContain(`assistant-${process.pid}`);
  });
});

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
