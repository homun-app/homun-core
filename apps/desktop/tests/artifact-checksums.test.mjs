import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createArtifactChecksums } from "../scripts/create-artifact-checksums.mjs";

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), "homun-artifact-checksums-"));
}

test("writes sorted sha256 lines for installer artifacts only", async (t) => {
  const directory = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "Homun-z.exe"), "windows");
  await writeFile(path.join(directory, "Homun-a.zip"), "mac");
  await writeFile(path.join(directory, "latest.yml"), "metadata");
  await writeFile(path.join(directory, "Homun-z.exe.blockmap"), "blockmap");
  await writeFile(path.join(directory, "SHA256SUMS-old.txt"), "stale");
  const outputPath = path.join(directory, "SHA256SUMS-win.txt");

  const entries = await createArtifactChecksums(directory, outputPath);
  const manifest = await readFile(outputPath, "utf8");

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["Homun-a.zip", "Homun-z.exe"],
  );
  assert.match(manifest, /^[0-9a-f]{64}  Homun-a\.zip\n[0-9a-f]{64}  Homun-z\.exe\n$/);
  assert.doesNotMatch(manifest, /latest|blockmap|SHA256SUMS-old/);
});

test("uses basenames even when the artifact directory is absolute", async (t) => {
  const directory = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "Homun.AppImage"), "linux");
  const outputPath = path.join(directory, "SHA256SUMS-linux.txt");

  await createArtifactChecksums(directory, outputPath);
  const manifest = await readFile(outputPath, "utf8");

  assert.match(manifest, /  Homun\.AppImage\n$/);
  assert.doesNotMatch(manifest, new RegExp(directory.replaceAll("\\", "\\\\")));
});

test("fails closed when no installer artifact exists", async (t) => {
  const directory = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "latest.yml"), "metadata");

  await assert.rejects(
    createArtifactChecksums(directory, path.join(directory, "SHA256SUMS-empty.txt")),
    /no installer artifacts found/,
  );
});
