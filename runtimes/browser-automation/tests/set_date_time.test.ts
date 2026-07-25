import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

// Real http server + real headless sidecar (browser_fixture.test.ts pattern). Exercises the
// set_date / set_time "widget work in the system" drivers against a calendar + time-list shaped like
// Trenitalia's: role=grid month + prev/next + day gridcells, and HH:MM time buttons.
let server: Server;
let baseUrl: string;
let manager: BrowserSessionManager;

beforeEach(async () => {
  const html = await readFile(path.join(import.meta.dirname, "fixtures", "date_time_pickers.html"), "utf8");
  server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
  manager = new BrowserSessionManager({ headless: true, allowPrivateNetwork: true });
  await manager.start();
  await manager.open({ url: baseUrl, label: "p" });
});
afterEach(async () => {
  await manager?.stop();
  if (server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const dateText = async () =>
  (await manager.act({ targetId: "p", kind: "evaluate", fn: "() => document.querySelector('#dateControl').textContent" } as any)).result as string;
const timeText = async () =>
  (await manager.act({ targetId: "p", kind: "evaluate", fn: "() => document.querySelector('#timeControl').textContent" } as any)).result as string;

describe("set_date / set_time drivers", () => {
  it("set_date navigates the calendar forward and selects the target day in ONE action", async () => {
    // A date two months ahead forces real forward navigation (the calendar starts on the current month).
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + 2, 15);
    const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-15`;

    const res = await manager.act({ targetId: "p", kind: "set_date", selector: "#dateControl", date: iso } as any);
    expect(res.ok).toBe(true);
    const text = await dateText();
    expect(text).toMatch(/\b15\b/);
    const MONTHS = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
    expect(text.toLowerCase()).toContain(MONTHS[target.getMonth()]);
    expect(text).toContain(String(target.getFullYear()));
  });

  it("set_time picks the exact time option when offered", async () => {
    const res = await manager.act({ targetId: "p", kind: "set_time", selector: "#timeControl", time: "08:30" } as any);
    expect(res.ok).toBe(true);
    expect(await timeText()).toBe("08:30");
  });

  it("set_time falls back to the CLOSEST offered slot when the exact minute isn't available", async () => {
    // The fixture only offers :00 and :30 — 08:15 must resolve to 08:00 or 08:30, not fail.
    const res = await manager.act({ targetId: "p", kind: "set_time", selector: "#timeControl", time: "08:15" } as any);
    expect(res.ok).toBe(true);
    expect(["08:00", "08:30"]).toContain(await timeText());
  });

  it("set_date rejects a non-ISO date (so the model gets a clear, actionable error)", async () => {
    await expect(
      manager.act({ targetId: "p", kind: "set_date", selector: "#dateControl", date: "18 agosto" } as any),
    ).rejects.toThrow(/set_date/i);
  });
});
