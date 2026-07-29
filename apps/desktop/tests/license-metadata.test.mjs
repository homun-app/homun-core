import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const expectedLicenseSha256 =
  "5904c160d2d93c62e0113b5cc9d20a6880e04839bff3a130bd622cc141a64429";
const workspaceCrates = [
  "browser-automation",
  "capabilities",
  "context-compression",
  "desktop-gateway",
  "engine",
  "host-computer",
  "inference-usage",
  "inference",
  "local-computer-session",
  "memory",
  "orchestrator",
  "process-manager",
  "process-skill",
  "secrets",
  "skill-runtime",
  "subagents",
  "task-runtime",
  "vault",
];
const channelManifests = [
  "runtimes/channel-telegram/Cargo.toml",
  "runtimes/channel-whatsapp/Cargo.toml",
];

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

async function read(relativePath) {
  return readFile(repoPath(relativePath), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("the canonical product license has the audited FSL text", async () => {
  assert.equal(sha256(await read("LICENSE.md")), expectedLicenseSha256);
});

test("desktop package metadata uses the FSL SPDX identifier", async () => {
  const packageJson = JSON.parse(await read("apps/desktop/package.json"));
  const packageLock = JSON.parse(await read("apps/desktop/package-lock.json"));

  assert.equal(packageJson.license, "FSL-1.1-ALv2");
  assert.equal(packageLock.packages[""].license, "FSL-1.1-ALv2");
});

test("workspace crates inherit the canonical Homun package metadata", async () => {
  const workspace = await read("Cargo.toml");
  assert.match(workspace, /\[workspace\.package\]/);
  assert.match(workspace, /license = "FSL-1\.1-ALv2"/);
  assert.match(workspace, /repository = "https:\/\/github\.com\/homun-app\/homun-core"/);
  assert.match(workspace, /homepage = "https:\/\/homun\.app"/);

  for (const crate of workspaceCrates) {
    const manifest = await read(`crates/${crate}/Cargo.toml`);
    for (const field of [
      "version",
      "edition",
      "authors",
      "license",
      "repository",
      "homepage",
    ]) {
      assert.match(
        manifest,
        new RegExp(`^${field}\\.workspace = true$`, "m"),
        `${crate} must inherit ${field}`,
      );
    }
  }
});

test("standalone channel crates declare the same FSL metadata", async () => {
  for (const manifestPath of channelManifests) {
    const manifest = await read(manifestPath);
    assert.match(manifest, /^license = "FSL-1\.1-ALv2"$/m);
    assert.match(manifest, /^authors = \["Fabio Cantone"\]$/m);
    assert.match(
      manifest,
      /^repository = "https:\/\/github\.com\/homun-app\/homun-core"$/m,
    );
    assert.match(manifest, /^homepage = "https:\/\/homun\.app"$/m);
  }
});

test("README explains the per-version Apache change date", async () => {
  assert.match(
    await read("README.md"),
    /Each FSL-licensed\s+version becomes Apache-2\.0 two years after that version is made available\./,
  );
});
