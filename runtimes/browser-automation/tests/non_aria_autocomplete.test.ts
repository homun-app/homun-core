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
  const html = await readFile(fixture, "utf8");
  const noListHtml = await readFile(noListFixture, "utf8");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url?.startsWith("/no-list")) {
      res.end(noListHtml);
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
  it("selects the matching suggestion from a non-ARIA typeahead (no role/aria-*/list on the input)", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "station" });

    const typed = await manager.act({
      targetId: "station",
      kind: "type",
      selector: "#station",
      text: "Napoli Centrale",
    });

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
});
