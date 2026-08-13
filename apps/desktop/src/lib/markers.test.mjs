import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const markersSource = readFileSync(join(here, "markers.ts"), "utf8");
const chatEventPartsSource = readFileSync(join(here, "chatEventParts.mjs"), "utf8");
const lifecycleSource = readFileSync(join(here, "chat-runtime", "lifecycle.mjs"), "utf8");

test("markers remain compatibility regexes, not lifecycle owners", () => {
  assert.match(markersSource, /CONNECT_SUGGEST_RE/);
  assert.match(markersSource, /AWAIT_USER_RE/);
  assert.doesNotMatch(lifecycleSource, /markers/);
  assert.doesNotMatch(lifecycleSource, /CHOICES|CLARIFY|AWAIT_USER/);
});

test("chatEventParts does not own HITL liveness fallbacks", () => {
  assert.doesNotMatch(chatEventPartsSource, /LEGACY_HITL_MARKER_RE/);
  assert.doesNotMatch(chatEventPartsSource, /threadTailAwaitsUser/);
  assert.doesNotMatch(chatEventPartsSource, /current-turn liveness/);
  assert.equal(chatEventPartsSource.includes('from "./markers'), false);
});
