import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { nextRestartDelay, WINDOW_MS, DELAYS_MS } = require("../electron/lib/watchdog.cjs");

const NOW = 1_000_000_000;

test("first crash restarts quickly", () => {
  assert.equal(nextRestartDelay([], NOW), DELAYS_MS[0]);
});

test("delays escalate with each recent restart", () => {
  assert.equal(nextRestartDelay([NOW - 1000], NOW), DELAYS_MS[1]);
  assert.equal(nextRestartDelay([NOW - 2000, NOW - 1000], NOW), DELAYS_MS[2]);
});

test("gives up (null) after budget exhausted within the window", () => {
  const stamps = [NOW - 3000, NOW - 2000, NOW - 1000];
  assert.equal(nextRestartDelay(stamps, NOW), null);
});

test("old restarts outside the window don't count", () => {
  const stamps = [NOW - WINDOW_MS - 1, NOW - WINDOW_MS - 2, NOW - WINDOW_MS - 3];
  assert.equal(nextRestartDelay(stamps, NOW), DELAYS_MS[0]);
});
