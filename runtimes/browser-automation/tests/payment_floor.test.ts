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

  it("focusPaymentContext is true when a cc-form field is focused, false for the search field (via act() and snapshot())", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "checkout" });

    let snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    const ccInput = snapshot.refs.find((ref) => ref.name === "Card number");
    expect(ccInput?.ref).toBeDefined();

    // act()'s own returned result embeds a fresh post-action snapshot (see
    // shouldSnapshotAfterAction for "click"); assert the field is carried
    // there directly, not only via a follow-up snapshot() call.
    let actResult = await manager.act({ targetId: "checkout", kind: "click", ref: ccInput!.ref } as never);
    expect((actResult as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(true);

    snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    expect((snapshot as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(true);

    const searchInput = snapshot.refs.find((ref) => ref.name === "Termine ricerca");
    expect(searchInput?.ref).toBeDefined();

    actResult = await manager.act({ targetId: "checkout", kind: "click", ref: searchInput!.ref } as never);
    expect((actResult as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(false);

    snapshot = await manager.snapshot({ targetId: "checkout", observationMode: "interact" } as never);
    expect((snapshot as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(false);
  });

  it("focusPaymentContext is true when focus is inside a nested cc-form iframe (frame-aware; fails on a main-frame-only check)", async () => {
    // Outer document has NO cc-form of its own; the cc-autocomplete input
    // lives only in a separate document loaded via <iframe src="/psp-frame.html">.
    // computeFocusPaymentContext must be frame-aware: with focus inside the
    // iframe, the main frame's own document.activeElement is just the
    // <iframe> host element, so a main-frame-only page.evaluate() check would
    // report false here (fail-open on the ref-less payment floor) — this is
    // the exact bug this fix addresses. Cross-origin PSP hostname matching
    // (frameMatchesPspHost / hostMatchesPspSuffix) is covered separately by a
    // direct unit test below, since binding a local node:http server to a
    // real PSP hostname would require system-level DNS/hosts changes that are
    // out of scope for this harness.
    const outerFixture = path.join(import.meta.dirname, "fixtures", "checkout-iframe.html");
    const innerFixture = path.join(import.meta.dirname, "fixtures", "psp-frame.html");
    const outerHtml = await readFile(outerFixture, "utf8");
    const innerHtml = await readFile(innerFixture, "utf8");
    const iframeServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url === "/psp-frame.html" ? innerHtml : outerHtml);
    });
    await new Promise<void>((resolve) => iframeServer.listen(0, "127.0.0.1", resolve));
    const address = iframeServer.address();
    if (!address || typeof address === "string") {
      throw new Error("iframe fixture server did not start");
    }
    const iframeBaseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await manager.start();
      await manager.open({ url: iframeBaseUrl, label: "iframe-checkout" });

      // The "ai" aria snapshot includes iframe content with its own refs
      // (Playwright's aria-ref locators resolve across frames via CDP), the
      // same mechanism computePaymentFloorRefs already relies on.
      let snapshot = await manager.snapshot({ targetId: "iframe-checkout", observationMode: "interact" } as never);
      const ccInput = snapshot.refs.find((ref) => ref.name === "Card number");
      expect(ccInput?.ref).toBeDefined();

      const actResult = await manager.act({
        targetId: "iframe-checkout",
        kind: "click",
        ref: ccInput!.ref,
      } as never);
      expect((actResult as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(true);

      snapshot = await manager.snapshot({ targetId: "iframe-checkout", observationMode: "interact" } as never);
      expect((snapshot as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(true);
    } finally {
      iframeServer.closeAllConnections();
      await new Promise<void>((resolve) => iframeServer.close(() => resolve()));
    }
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
      // Explicit focusPaymentContext assertion on a page with no cc-form and
      // no PSP frame anywhere: whatever holds focus after load, it must not
      // be floored.
      expect((snapshot as unknown as { focusPaymentContext: boolean }).focusPaymentContext).toBe(false);
    } finally {
      trainServer.closeAllConnections();
      await new Promise<void>((resolve) => trainServer.close(() => resolve()));
    }
  });
});

describe("hostMatchesPspSuffix (exact/`.`-suffix host matching used by frameMatchesPspHost)", () => {
  // Direct unit coverage of the PSP hostname-matching predicate itself,
  // independent of any real network/DNS resolution — binding a local
  // node:http test server to an actual PSP hostname (e.g. js.stripe.com)
  // would require system-level hosts-file/DNS changes that are out of scope
  // for this harness. The predicate is the only part of
  // computeFocusPaymentContext's PSP-origin branch that isn't already
  // exercised end-to-end by the iframe test above.
  it("matches an exact PSP host and any subdomain of it, never a substring/fuzzy suffix", async () => {
    const { hostMatchesPspSuffix } = await import("../src/browser/snapshot.js");
    expect(hostMatchesPspSuffix("js.stripe.com")).toBe(true);
    expect(hostMatchesPspSuffix("checkout.stripe.com")).toBe(true);
    expect(hostMatchesPspSuffix("stripe.com")).toBe(true);
    expect(hostMatchesPspSuffix("sub.checkout.stripe.com")).toBe(true);
    expect(hostMatchesPspSuffix("notstripe.com")).toBe(false);
    expect(hostMatchesPspSuffix("stripe.com.evil.example")).toBe(false);
    expect(hostMatchesPspSuffix("")).toBe(false);
  });
});
