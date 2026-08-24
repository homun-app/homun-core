import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(join(here, "useChatTurnStatus.ts"), "utf8");
const chatViewSource = readFileSync(join(here, "ChatView.tsx"), "utf8");

test("useChatTurnStatus consumes active turn from the kernel runtime view model", () => {
  assert.match(hookSource, /runtimeViewModel\.activeTurn/);
  assert.doesNotMatch(hookSource, /projectedActiveTurn/);
  assert.doesNotMatch(chatViewSource, /projectedActiveTurn,\n\s+conversationActivityCount/);
});
