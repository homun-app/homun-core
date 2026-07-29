import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const electronMain = readFileSync(
  new URL("../electron/main.cjs", import.meta.url),
  "utf8",
);

test("development gateway startup allows a cold Cargo build", () => {
  assert.match(
    electronMain,
    /const GATEWAY_STARTUP_TIMEOUT_MS = app\.isPackaged \? 60_000 : 180_000;/,
  );
  assert.match(
    electronMain,
    /async function waitForGateway\(timeoutMs = GATEWAY_STARTUP_TIMEOUT_MS\)/,
  );
});

test("Electron handles terminal gateway startup failures", () => {
  assert.match(electronMain, /\.catch\(handleStartupFailure\);/);
  assert.match(electronMain, /function handleStartupFailure\(error\)/);
  assert.match(electronMain, /desktop startup failed:/);
});
