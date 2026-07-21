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
import { assertExactArchitecture } from "../scripts/verify-host-computer-package.mjs";

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
  const helperArchitecture = commands.find(
    ([command, args]) => command === "lipo" && args.at(-1).endsWith("HomunComputerService"),
  );
  const gatewayArchitecture = commands.find(
    ([command, args]) => command === "lipo" && args.at(-1).endsWith("local-first-desktop-gateway"),
  );
  assert.deepEqual(helperArchitecture?.[1].slice(0, 1), ["-archs"]);
  assert.deepEqual(gatewayArchitecture?.[1].slice(0, 1), ["-archs"]);
  const helperSignature = commands.find(
    ([command, args]) => command === "codesign" && args.at(-1).endsWith("HomunComputerService.app"),
  );
  assert.ok(helperSignature);
  assert.deepEqual(commands.at(-2).slice(0, 1), ["spctl"]);
  assert.deepEqual(commands.at(-1), ["xcrun", ["stapler", "validate", "/tmp/Homun.app"]]);
});

test("release workflow verifies the first beta as arm64-only", async () => {
  const workflow = await readFile(
    path.resolve(import.meta.dirname, "../../../.github/workflows/build.yml"),
    "utf8",
  );
  assert.match(workflow, /verify:host-computer-package -- --app "\$APP_PATH" --expected-arch arm64/);
});

test("architecture verification rejects universal and Intel binaries", () => {
  assert.deepEqual(assertExactArchitecture("arm64\n", "arm64", "helper"), ["arm64"]);
  assert.throws(
    () => assertExactArchitecture("arm64 x86_64\n", "arm64", "helper"),
    /expected exactly arm64/,
  );
  assert.throws(
    () => assertExactArchitecture("x86_64\n", "arm64", "gateway"),
    /expected exactly arm64/,
  );
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
