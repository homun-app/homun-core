import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const appRoot = path.resolve(import.meta.dirname, "..");

test("desktop preparation stages a pinned PDFium runtime", async () => {
  const prepare = await readFile(path.join(appRoot, "scripts", "prepare-package.mjs"), "utf8");
  const runtime = await readFile(path.join(appRoot, "scripts", "pdfium-runtime.mjs"), "utf8").catch(
    (error) => error?.code === "ENOENT" ? null : Promise.reject(error),
  );

  assert.match(prepare, /stagePdfiumRuntime/);
  assert.notEqual(runtime, null, "the pinned PDFium staging module must exist");
  assert.match(runtime, /chromium\/7961/);
  assert.match(runtime, /sha256/i);
  assert.match(runtime, /pdfium-(?:mac-arm64|linux-x64|win-x64)\.tgz/);
  assert.match(runtime, /LICENSE/);
  assert.match(runtime, /licenses/);
});

test("desktop runtime passes the staged PDFium path to the gateway", async () => {
  const electron = await readFile(path.join(appRoot, "electron", "main.cjs"), "utf8");
  const dev = await readFile(path.join(appRoot, "scripts", "electron-dev.mjs"), "utf8");

  assert.match(electron, /HOMUN_PDFIUM_LIB/);
  assert.match(electron, /path\.join\(RESOURCES_ROOT, "pdfium"\)/);
  assert.match(dev, /ensureDevPdfiumRuntime/);
});

test("PDF preview never falls back to an unauthorizable blob iframe", async () => {
  const messageArtifacts = await readFile(path.join(appRoot, "src", "components", "MessageArtifacts.tsx"), "utf8");

  assert.doesNotMatch(messageArtifacts, /kind:\s*"pdf"/);
  assert.doesNotMatch(messageArtifacts, /title="Preview PDF"/);
  assert.match(messageArtifacts, /artifactPdfPages/);
});

test("development does not reload when package resources are staged", async () => {
  const vite = await readFile(path.join(appRoot, "vite.config.ts"), "utf8");

  assert.match(vite, /watch:\s*\{[\s\S]*ignored:[\s\S]*\.package/s);
});
