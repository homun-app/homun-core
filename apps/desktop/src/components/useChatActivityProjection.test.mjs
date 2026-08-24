import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "useChatActivityProjection.ts"), "utf8");
const browserLifecycleSource = readFileSync(join(here, "useChatBrowserActivityLifecycle.ts"), "utf8");
const chatViewSource = readFileSync(join(here, "ChatView.tsx"), "utf8");
const submissionSource = readFileSync(join(here, "useChatTurnSubmission.ts"), "utf8");

test("useChatActivityProjection consumes kernel projection instead of legacy activity", () => {
  assert.match(source, /fetchKernelThreadProjection/);
  assert.doesNotMatch(source, /fetchThreadActivity/);
  assert.match(source, /projectKernelThreadView/);
  assert.doesNotMatch(source, /deriveConversationPlan/);
});

test("useChatActivityProjection does not project plan or activity from legacy markers", () => {
  assert.doesNotMatch(source, /latestPlanMarkdown\(/);
  assert.doesNotMatch(source, /latestActivitySteps\(/);
  assert.doesNotMatch(source, /legacyMarkerProjection/);
  assert.doesNotMatch(source, /parsePlanSteps/);
  assert.doesNotMatch(source, /parsePlanGoal/);
  assert.doesNotMatch(source, /normalizeKernelPlanStatus/);
  assert.doesNotMatch(source, /kernelPlanStepsToUiSteps/);
  assert.doesNotMatch(source, /status === "doing" \? \{ \.\.\.step, status: "done"/);
});

test("useChatActivityProjection reads browser failure from typed kernel projection", () => {
  assert.match(source, /projectedView\.browserStatus\.failureReason/);
  assert.doesNotMatch(source, /browser_budget_exceeded/);
});

test("turn active/status contracts stay inside the runtime view model", () => {
  assert.doesNotMatch(
    source,
    /return\s*\{[\s\S]*\bprojectedActiveTurn\b[\s\S]*\}/,
  );
  assert.doesNotMatch(
    source,
    /return\s*\{[\s\S]*\bprojectedTurnStatus\b[\s\S]*\}/,
  );
  assert.doesNotMatch(browserLifecycleSource, /\bprojectedActiveTurn\b/);
  assert.doesNotMatch(browserLifecycleSource, /\bprojectedTurnStatus\b/);
  assert.doesNotMatch(chatViewSource, /\bprojectedActiveTurn\b/);
  assert.doesNotMatch(chatViewSource, /\bprojectedTurnStatus\b/);
  assert.doesNotMatch(submissionSource, /\bprojectedActiveTurn\b/);
  assert.doesNotMatch(submissionSource, /\bprojectedTurnStatus\b/);
  assert.match(chatViewSource, /runtimeViewModel\.activeTurn/);
  assert.match(chatViewSource, /runtimeViewModel\.turnUiState\.status/);
});
