import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "useChatActivityProjection.ts"), "utf8");

test("useChatActivityProjection consumes kernel projection instead of legacy activity", () => {
  assert.match(source, /fetchKernelThreadProjection/);
  assert.doesNotMatch(source, /fetchThreadActivity/);
  assert.match(source, /projectKernelThreadView/);
  assert.doesNotMatch(source, /deriveConversationPlan/);
});

test("useChatActivityProjection keeps marker parsing behind legacyMarkerProjection", () => {
  const latestPlanUses = [...source.matchAll(/latestPlanMarkdown\(/g)].length;
  assert.equal(latestPlanUses, 1);
  assert.match(source, /legacyMarkerProjection/);
  assert.doesNotMatch(source, /status === "doing" \? \{ \.\.\.step, status: "done"/);
});

test("useChatActivityProjection reads browser failure from typed kernel projection", () => {
  assert.match(source, /projectedView\.browserStatus\.failureReason/);
  assert.doesNotMatch(source, /browser_budget_exceeded/);
});
