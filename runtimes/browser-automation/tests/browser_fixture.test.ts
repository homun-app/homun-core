import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

let server: Server;
let baseUrl: string;
let manager: BrowserSessionManager;

beforeEach(async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "form.html");
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("browser sidecar engine", () => {
  it("opens a fixture page, snapshots refs, fills and submits", async () => {
    await manager.start();
    const opened = await manager.open({ url: baseUrl, label: "booking" });

    expect(opened.targetId).toBe("booking");

    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const input = firstSnapshot.refs.find((ref) => ref.name === "Name");
    const submit = firstSnapshot.refs.find((ref) => ref.name === "Submit");

    expect(input?.ref).toMatch(/^e/);
    expect(submit?.ref).toMatch(/^e/);

    await manager.act({
      targetId: "booking",
      kind: "fill",
      fields: [{ ref: input!.ref, value: "Ada" }],
    });
    await manager.act({ targetId: "booking", kind: "click", ref: submit!.ref });

    const secondSnapshot = await manager.snapshot({ targetId: "booking" });
    expect(secondSnapshot.snapshot).toContain("Submitted Ada");
  });

  it("fails stale refs after navigation", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "booking" });
    const firstSnapshot = await manager.snapshot({ targetId: "booking" });
    const submit = firstSnapshot.refs.find((ref) => ref.name === "Submit");

    await manager.navigate({ targetId: "booking", url: `${baseUrl}/next` });

    await expect(
      manager.act({ targetId: "booking", kind: "click", ref: submit!.ref }),
    ).rejects.toMatchObject({
      code: "BROWSER_STALE_REF",
    });
  });
});
