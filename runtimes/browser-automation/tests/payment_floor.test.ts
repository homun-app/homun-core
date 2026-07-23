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

function floorRefs(snapshot: unknown): string[] {
  return (snapshot as { paymentFloorRefs: string[] }).paymentFloorRefs;
}

describe("machine payment floor", () => {
  it("marks the cc-form submit but not the search submit", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "checkout" });

    const snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    const conferma = snapshot.refs.find((ref) => ref.name === "Conferma");
    const cerca = snapshot.refs.find((ref) => ref.role === "button" && ref.name === "Cerca");

    expect(conferma?.ref).toBeDefined();
    expect(cerca?.ref).toBeDefined();
    expect(floorRefs(snapshot)).toContain(conferma!.ref);
    expect(floorRefs(snapshot)).not.toContain(cerca!.ref);
  });

  it("also marks the cc-autocomplete input ref itself, not just its submit button", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "checkout" });

    const snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    const ccInput = snapshot.refs.find((ref) => ref.name === "Card number");

    expect(ccInput?.ref).toBeDefined();
    expect(ccInput?.role).toBe("textbox");
    // A `type` with `submit: true` on this ref is a committing action on a
    // cc-form; it must be floor-eligible even though the ref itself is an
    // input, not the button that ultimately submits the form.
    expect(floorRefs(snapshot)).toContain(ccInput!.ref);
  });

  it("does not mark a normal (non-cc) form's text input", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "checkout" });

    const snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    const searchInput = snapshot.refs.find((ref) => ref.name === "Termine ricerca");

    expect(searchInput?.ref).toBeDefined();
    expect(searchInput?.role).toBe("textbox");
    expect(floorRefs(snapshot)).not.toContain(searchInput!.ref);
  });

  it("focusPaymentContext is true when a cc-form field is focused, false for the search field", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "checkout" });

    let snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    const ccInput = snapshot.refs.find((ref) => ref.name === "Card number");
    expect(ccInput?.ref).toBeDefined();
    await manager.act({ targetId: "checkout", kind: "click", ref: ccInput!.ref } as never);

    snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    expect((snapshot as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(true);

    const searchInput = snapshot.refs.find((ref) => ref.name === "Termine ricerca");
    expect(searchInput?.ref).toBeDefined();
    await manager.act({ targetId: "checkout", kind: "click", ref: searchInput!.ref } as never);

    snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    expect((snapshot as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(false);
  });

  it("floors nothing on a page with no cc-form and no PSP frame (train fixture)", async () => {
    const trainFixture = path.join(import.meta.dirname, "fixtures", "train.html");
    const trainHtml = await readFile(trainFixture, "utf8");
    const trainServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(trainHtml);
    });
    await new Promise<void>((resolve) => trainServer.listen(0, "127.0.0.1", resolve));
    const address = trainServer.address();
    if (!address || typeof address === "string") {
      throw new Error("train fixture server did not start");
    }
    const trainBaseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await manager.start();
      await manager.open({ url: trainBaseUrl, label: "train" });
      const snapshot = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
      expect(floorRefs(snapshot)).toEqual([]);
    } finally {
      trainServer.closeAllConnections();
      await new Promise<void>((resolve) => trainServer.close(() => resolve()));
    }
  });
});
