import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");

test("packaged contained computer uses native gateway bootstrap", async () => {
  const prepare = await readFile(
    path.join(appRoot, "scripts", "prepare-package.mjs"),
    "utf8",
  );
  const sandbox = await readFile(
    path.join(repoRoot, "crates", "desktop-gateway", "src", "sandbox.rs"),
    "utf8",
  );
  assert.match(prepare, /contained-computer/);
  assert.match(sandbox, /build_contained_computer_image/);
  assert.doesNotMatch(sandbox, /Command::new\("bash"\).*up_script/s);
});

test("architecture documents the cross-platform setup contract", async () => {
  const architecture = await readFile(
    path.join(repoRoot, "docs", "architecture", "contained-computer.md"),
    "utf8",
  );
  assert.match(architecture, /`POST \/api\/setup\/computer\/prepare`/);
  assert.match(architecture, /Windows, macOS, and Linux/);
  assert.match(architecture, /CDP.*noVNC/s);
});
