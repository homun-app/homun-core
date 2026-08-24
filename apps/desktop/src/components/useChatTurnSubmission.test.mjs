import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(join(here, "useChatTurnSubmission.ts"), "utf8");
const chatViewSource = readFileSync(join(here, "ChatView.tsx"), "utf8");

test("useChatTurnSubmission consumes submission state from the runtime view model", () => {
  assert.match(hookSource, /runtimeViewModel: KernelProjectionPresenterView/);
  assert.match(hookSource, /runtimeViewModel\.turnUiState/);
  assert.match(hookSource, /runtimeViewModel\.activeTurn/);
  assert.doesNotMatch(hookSource, /\n\s+composerMode: string;/);
  assert.doesNotMatch(hookSource, /\n\s+projectedActiveTurn: ActiveTurnProjection \| null;/);
  assert.doesNotMatch(hookSource, /\n\s+projectedTurnStatus: string \| null;/);
  assert.match(chatViewSource, /\n\s+runtimeViewModel,\n\s+setPromptSubmitting,/);
  assert.doesNotMatch(chatViewSource, /\n\s+composerMode: runtimeViewModel\.composerMode,/);
});
