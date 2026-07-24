import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "..", "electron", "main.cjs"), "utf8");

test("the renderer is never background-throttled", () => {
  // The whole streaming render is gated on requestAnimationFrame; the default
  // throttling drops it to ~1Hz when the window is occluded, so the answer
  // freezes and then bursts on refocus.
  assert.match(main, /backgroundThrottling:\s*false/);
});

test("the window is revealed only once it can paint", () => {
  assert.match(main, /show:\s*false/, "the window must not be shown before first paint");
  assert.match(main, /once\(["']ready-to-show["']/, "reveal on ready-to-show");
});
