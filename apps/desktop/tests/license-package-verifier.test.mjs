import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(import.meta.dirname, "..");
const modulePath = path.join(appRoot, "scripts", "verify-license-compliance.mjs");

async function write(target, contents = "present\n") {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function completeResources() {
  const root = await mkdtemp(path.join(os.tmpdir(), "homun-license-verify-"));
  for (const relativePath of [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "third-party-licenses/electron/LICENSE",
    "third-party-licenses/electron/LICENSES.chromium.html",
    "third-party-licenses/cargo/demo@1.0.0/LICENSE",
    "third-party-licenses/npm/demo@1.0.0/LICENSE",
    "third-party-licenses/fonts/THIRD_PARTY_NOTICES.md",
    "third-party-licenses/fonts/licenses/demo/LICENSE",
    "third-party-licenses/default-skills/LICENSE.md",
    "third-party-licenses/python-runtime/inventory.json",
    "third-party-licenses/python-runtime/NOTICE.md",
    "third-party-licenses/spdx/MIT.txt",
  ]) {
    await write(path.join(root, relativePath));
  }
  return root;
}

async function loadVerifier(t) {
  if (!existsSync(modulePath)) {
    t.skip("verify-license-compliance.mjs does not exist yet");
    return null;
  }
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
}

test("license package verifier exists", () => {
  assert.equal(existsSync(modulePath), true);
});

test("afterPack verifies final resources before mutating Electron fuses", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(appRoot, "scripts", "after-pack-fuses.mjs"), "utf8")
  );
  const verifyIndex = source.lastIndexOf("verifyLicenseResources");
  const fuseIndex = source.lastIndexOf("flipFuses");
  assert.ok(verifyIndex >= 0, "afterPack must verify the final resources");
  assert.ok(verifyIndex < fuseIndex, "verification must run before fuse mutation");
});

test("CI verifies prepared license resources before Electron Builder", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(appRoot, "..", "..", ".github", "workflows", "build.yml"), "utf8")
  );
  const prepareIndex = source.indexOf("npm run package:prepare");
  const verifyIndex = source.indexOf("npm run verify:license-compliance");
  const builderIndex = source.indexOf("npx electron-builder");
  assert.ok(prepareIndex >= 0 && prepareIndex < verifyIndex);
  assert.ok(verifyIndex < builderIndex);
});

test("accepts a complete prepared resource tree", async (t) => {
  const verifier = await loadVerifier(t);
  if (!verifier) return;
  const resources = await completeResources();
  t.after(() => rm(resources, { recursive: true, force: true }));
  assert.doesNotThrow(() => verifier.verifyLicenseResources(resources));
});

test("names each required missing license artifact", async (t) => {
  const verifier = await loadVerifier(t);
  if (!verifier) return;
  const required = [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "third-party-licenses/electron/LICENSE",
    "third-party-licenses/electron/LICENSES.chromium.html",
    "third-party-licenses/cargo",
    "third-party-licenses/npm",
    "third-party-licenses/fonts/THIRD_PARTY_NOTICES.md",
    "third-party-licenses/fonts/licenses",
    "third-party-licenses/default-skills/LICENSE.md",
    "third-party-licenses/python-runtime/inventory.json",
    "third-party-licenses/python-runtime/NOTICE.md",
    "third-party-licenses/spdx",
  ];
  for (const relativePath of required) {
    const resources = await completeResources();
    await rm(path.join(resources, relativePath), { recursive: true, force: true });
    assert.throws(
      () => verifier.verifyLicenseResources(resources),
      new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await rm(resources, { recursive: true, force: true });
  }
});

test("rejects empty legal files and empty legal directories", async (t) => {
  const verifier = await loadVerifier(t);
  if (!verifier) return;
  const emptyFileResources = await completeResources();
  const emptyDirectoryResources = await completeResources();
  t.after(() => rm(emptyFileResources, { recursive: true, force: true }));
  t.after(() => rm(emptyDirectoryResources, { recursive: true, force: true }));
  await writeFile(path.join(emptyFileResources, "LICENSE.md"), "");
  await rm(
    path.join(emptyDirectoryResources, "third-party-licenses", "cargo"),
    { recursive: true, force: true },
  );
  await mkdir(
    path.join(emptyDirectoryResources, "third-party-licenses", "cargo"),
    { recursive: true },
  );

  assert.throws(
    () => verifier.verifyLicenseResources(emptyFileResources),
    /LICENSE\.md.*empty/i,
  );
  assert.throws(
    () => verifier.verifyLicenseResources(emptyDirectoryResources),
    /third-party-licenses\/cargo.*empty/i,
  );
});
