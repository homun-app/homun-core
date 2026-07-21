import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  forbiddenHelperEntitlements,
  parseDeveloperIdIdentity,
  signingPlan,
  verificationCommandPlan,
} from "../scripts/host-computer-signing.mjs";

test("release signing orders nested code before the outer app", () => {
  assert.deepEqual(signingPlan("darwin"), [
    "host-helper-executable",
    "host-helper-bundle",
    "outer-electron-app",
  ]);
  assert.deepEqual(signingPlan("linux"), []);
  assert.deepEqual(signingPlan("win32"), []);
});

test("Developer ID identity discovery returns only the certificate hash", () => {
  assert.equal(
    parseDeveloperIdIdentity('  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Homun (TEAM123)"'),
    "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
  );
  assert.equal(parseDeveloperIdIdentity('  1) ABC "Apple Development: Example"'), null);
});

test("verification covers strict signatures, Gatekeeper, and stapling", () => {
  const commands = verificationCommandPlan("/tmp/Homun.app");
  assert.equal(commands[0][0], "codesign");
  assert.match(commands[0][1].at(-1), /HomunComputerService\.app$/);
  assert.deepEqual(commands.at(-2).slice(0, 1), ["spctl"]);
  assert.deepEqual(commands.at(-1), ["xcrun", ["stapler", "validate", "/tmp/Homun.app"]]);
});

test("helper entitlement file stays least privilege", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../resources/host-computer/entitlements.mac.plist"), "utf8");
  for (const entitlement of forbiddenHelperEntitlements) {
    assert.equal(source.includes(entitlement), false, entitlement);
  }
});

test("packaging preserves the separately signed nested helper", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
  assert.match(packageJson.build.mac.signIgnore.join("\n"), /HomunComputerService/);
  const hook = await readFile(path.resolve(import.meta.dirname, "../scripts/after-pack-fuses.mjs"), "utf8");
  assert.match(hook, /signHostComputerHelper/);
  assert.match(hook, /entitlements\.mac\.plist/);
});
