import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

// Real node:http server + real headless BrowserSessionManager, following the
// pattern in browser_fixture.test.ts — no mocking of Playwright internals.
//
// Pins the fix for confirmAutocomplete's non-ARIA bail: inputComboboxInfo only
// recognizes role=combobox / aria-autocomplete / aria-expanded / aria-controls
// / aria-owns / [list] — a typeahead with NONE of those (like Trenitalia's real
// station picker) used to make confirmAutocomplete return `{ options: [] }`
// immediately and leave the field holding just the typed text, unselected.
let server: Server;
let baseUrl: string;
let manager: BrowserSessionManager;

beforeEach(async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "non_aria_autocomplete.html");
  const noListFixture = path.join(import.meta.dirname, "fixtures", "plain_typeahead_no_list.html");
  const trenitaliaFixture = path.join(import.meta.dirname, "fixtures", "trenitalia_style_autocomplete.html");
  const html = await readFile(fixture, "utf8");
  const noListHtml = await readFile(noListFixture, "utf8");
  const trenitaliaHtml = await readFile(trenitaliaFixture, "utf8");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url?.startsWith("/no-list")) {
      res.end(noListHtml);
      return;
    }
    if (req.url?.startsWith("/trenitalia")) {
      res.end(trenitaliaHtml);
      return;
    }
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

describe("non-ARIA autocomplete fallback", () => {
  it("selects the matching suggestion from a non-ARIA typeahead with autoComplete=true (explicit opt-in)", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "station" });

    // autoComplete=true explicitly opts in to auto-confirmation (default is now false).
    const typed = await manager.act({
      targetId: "station",
      kind: "type",
      selector: "#station",
      text: "Napoli Centrale",
      autoComplete: true,
    } as Parameters<typeof manager.act>[0]);

    expect(typed.committedOption).toBe("Napoli Centrale");

    const value = await manager.act({
      targetId: "station",
      kind: "evaluate",
      fn: "() => document.querySelector('#station').value",
    });
    expect(value.result).toBe("Napoli Centrale");
  });

  it("leaves the field uncommitted when no suggestion list ever appears (no misfire)", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/no-list`, label: "plain" });

    const typed = await manager.act({
      targetId: "plain",
      kind: "type",
      selector: "#note",
      text: "Napoli Centrale",
    });

    expect(typed.committedOption).toBeUndefined();

    const value = await manager.act({
      targetId: "plain",
      kind: "evaluate",
      fn: "() => document.querySelector('#note').value",
    });
    expect(value.result).toBe("Napoli Centrale");
  });

  it("clicks the inner <button class=\"el-choice\"> when the option is <li role=\"option\"><button> (Trenitalia DOM, autoComplete=true)", async () => {
    await manager.start();
    await manager.open({ url: `${baseUrl}/trenitalia`, label: "trenitalia" });

    // Type "Milano" with autoComplete=true (explicit opt-in, default is now false).
    // The fixture filters by includes(), so several options appear.
    // The best match for "Milano Centrale" should be selected by clicking the
    // INNER <button class="el-choice">, NOT the outer <li role="option">.
    const typed = await manager.act({
      targetId: "trenitalia",
      kind: "type",
      selector: "#station",
      text: "Milano Centrale",
      autoComplete: true,
    } as Parameters<typeof manager.act>[0]);

    expect(typed.committedOption).toBe("Milano Centrale");

    const value = await manager.act({
      targetId: "trenitalia",
      kind: "evaluate",
      fn: "() => document.querySelector('#station').value",
    });
    expect(value.result).toBe("Milano Centrale");
  });

  it("autoComplete=false: skips confirmAutocomplete, leaves dropdown open, returns extract observation", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "station" });

    // Type with autoComplete=false — confirmAutocomplete must NOT run,
    // so committedOption stays undefined and the suggestion list remains visible.
    const typed = await manager.act({
      targetId: "station",
      kind: "type",
      selector: "#station",
      text: "Napoli Centrale",
      autoComplete: false,
    } as Parameters<typeof manager.act>[0]);

    // No automatic selection should have occurred.
    expect(typed.committedOption).toBeUndefined();

    // Post-action snapshot should use extract mode so the dropdown is visible.
    expect(typed.observationMode).toBe("extract");

    // The field should still hold the typed text (not cleared by confirmAutocomplete).
    const value = await manager.act({
      targetId: "station",
      kind: "evaluate",
      fn: "() => document.querySelector('#station').value",
    });
    expect(value.result).toBe("Napoli Centrale");
  });

  it("default (no auto_complete set): skips confirmAutocomplete, returns extract observation", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "station" });

    // Type without setting auto_complete — the new default is false, so
    // confirmAutocomplete must NOT run.
    const typed = await manager.act({
      targetId: "station",
      kind: "type",
      selector: "#station",
      text: "Napoli Centrale",
    });

    expect(typed.committedOption).toBeUndefined();
    expect(typed.observationMode).toBe("extract");

    // The field should still hold the typed text.
    const value = await manager.act({
      targetId: "station",
      kind: "evaluate",
      fn: "() => document.querySelector('#station').value",
    });
    expect(value.result).toBe("Napoli Centrale");
  });

  it("auto_complete=false (snake_case): same behavior as camelCase autoComplete=false", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "station" });

    const typed = await manager.act({
      targetId: "station",
      kind: "type",
      selector: "#station",
      text: "Napoli Centrale",
      auto_complete: false,
    } as Parameters<typeof manager.act>[0]);

    expect(typed.committedOption).toBeUndefined();
  });
});
