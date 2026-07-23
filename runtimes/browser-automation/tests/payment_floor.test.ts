import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

// Real node:http server + real headless BrowserSessionManager, following the
// pattern in browser_fixture.test.ts — no mocking of Playwright internals.
let server: Server;
let baseUrl: string;
let manager: BrowserSessionManager;

beforeEach(async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "checkout.html");
  const html = await readFile(fixture, "utf8");
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not start");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  manager = new BrowserSessionManager({
    headless: true,
    allowPrivateNetwork: true,
  });
});

afterEach(async () => {
  await manager?.stop();
  if (server) {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("machine payment floor", () => {
  it("marks the cc-form submit but not the search submit", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "checkout" });

    const snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    const conferma = snapshot.refs.find((ref) => ref.name === "Conferma");
    const cerca = snapshot.refs.find((ref) => ref.name === "Cerca");

    expect(conferma?.ref).toBeDefined();
    expect(cerca?.ref).toBeDefined();
    expect((snapshot as never as { paymentFloorRefs: string[] }).paymentFloorRefs).toContain(conferma!.ref);
    expect((snapshot as never as { paymentFloorRefs: string[] }).paymentFloorRefs).not.toContain(cerca!.ref);
  });
});
