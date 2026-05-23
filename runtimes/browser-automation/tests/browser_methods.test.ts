import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionManager } from "../src/browser/session_manager.js";

let server: Server;
let baseUrl: string;
let manager: BrowserSessionManager;
let artifactRoot: string;
let uploadRoot: string;

beforeEach(async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "advanced.html");
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
  artifactRoot = await mkdtemp(path.join(tmpdir(), "browser-artifacts-"));
  uploadRoot = await mkdtemp(path.join(tmpdir(), "browser-uploads-"));
  manager = new BrowserSessionManager({
    headless: true,
    allowPrivateNetwork: true,
    artifactRoot,
    uploadRoots: [uploadRoot],
  });
});

afterEach(async () => {
  await manager?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("browser production methods", () => {
  it("writes screenshots and pdf artifacts inside the artifact root", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "advanced" });

    const screenshot = await manager.screenshot({
      targetId: "advanced",
      fileName: "advanced.png",
      fullPage: true,
    });
    const pdf = await manager.pdf({
      targetId: "advanced",
      fileName: "advanced.pdf",
    });

    expect(screenshot.path).toContain(path.join(artifactRoot, "screenshots"));
    expect(screenshot.bytes).toBeGreaterThan(0);
    expect((await stat(screenshot.path)).size).toBe(screenshot.bytes);
    expect(pdf.path).toContain(path.join(artifactRoot, "pdf"));
    expect(pdf.bytes).toBeGreaterThan(0);
  });

  it("captures console messages and can focus and close tabs", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "advanced" });
    const snapshot = await manager.snapshot({ targetId: "advanced" });
    const logButton = snapshot.refs.find((ref) => ref.name === "Log event");
    await manager.act({ targetId: "advanced", kind: "click", ref: logButton!.ref });

    const consoleMessages = await manager.console({ targetId: "advanced", limit: 10 });
    expect(consoleMessages.messages.map((entry) => entry.text)).toContain("fixture-loaded");
    expect(consoleMessages.messages.map((entry) => entry.text)).toContain("button-log");

    await expect(manager.focus({ targetId: "advanced" })).resolves.toMatchObject({
      targetId: "advanced",
    });
    await manager.closeTab({ targetId: "advanced" });
    await expect(manager.tabs()).resolves.toEqual([]);
  });

  it("responds to dialogs raised by page actions", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "advanced" });
    const snapshot = await manager.snapshot({ targetId: "advanced" });
    const dialogButton = snapshot.refs.find((ref) => ref.name === "Open dialog");

    const action = manager.act({ targetId: "advanced", kind: "click", ref: dialogButton!.ref });
    await expect(manager.respondDialog({ targetId: "advanced", accept: true })).resolves.toEqual({
      handled: true,
      message: "confirm booking",
    });
    await expect(action).resolves.toMatchObject({ ok: true });
  });

  it("sets armed file chooser uploads from configured upload roots", async () => {
    const uploadFile = path.join(uploadRoot, "document.txt");
    await writeFile(uploadFile, "private local content", "utf8");
    await manager.start();
    await manager.open({ url: baseUrl, label: "advanced" });
    const snapshot = await manager.snapshot({ targetId: "advanced" });
    const input = snapshot.refs.find((ref) => ref.name === "Upload document");

    await manager.armFileChooser({ targetId: "advanced", files: [uploadFile] });
    await manager.act({ targetId: "advanced", kind: "click", ref: input!.ref });

    const afterUpload = await manager.snapshot({ targetId: "advanced" });
    expect(afterUpload.snapshot).toContain("Uploaded document.txt");
  });

  it("saves downloads into the artifact root after arming the download wait", async () => {
    await manager.start();
    await manager.open({ url: baseUrl, label: "advanced" });
    const snapshot = await manager.snapshot({ targetId: "advanced" });
    const download = snapshot.refs.find((ref) => ref.name === "Download note");

    const result = await manager.waitDownload({
      targetId: "advanced",
      fileName: "note.txt",
      action: { targetId: "advanced", kind: "click", ref: download!.ref },
    });

    expect(result.path).toContain(path.join(artifactRoot, "downloads"));
    expect(result.suggestedFilename).toBe("note.txt");
    expect(result.bytes).toBeGreaterThan(0);
  });
});
