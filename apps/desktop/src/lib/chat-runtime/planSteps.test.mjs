import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePlanStepStatus,
  parsePlanSteps,
  projectPlanSteps,
} from "./planSteps.mjs";

test("parsePlanSteps parses markdown checkboxes into UI plan steps", () => {
  assert.deepEqual(parsePlanSteps("- [x] **Cerca** (`s1`): ok\n- [-] **Leggi**: in corso"), [
    { status: "done", title: "Cerca", detail: "ok", id: "s1" },
    { status: "doing", title: "Leggi", detail: "in corso" },
  ]);
});

test("projectPlanSteps normalizes unknown kernel statuses for the UI", () => {
  assert.deepEqual(
    projectPlanSteps({
      plan: {
        steps: [
          { id: "s1", title: "Known", status: "blocked", detail: null },
          { id: "s2", title: "Future", status: "paused", detail: "later" },
        ],
      },
    }),
    [
      { id: "s1", title: "Known", status: "blocked", detail: "" },
      { id: "s2", title: "Future", status: "todo", detail: "later" },
    ],
  );
});

test("normalizePlanStepStatus maps only supported display states through", () => {
  assert.equal(normalizePlanStepStatus("doing"), "doing");
  assert.equal(normalizePlanStepStatus("done"), "done");
  assert.equal(normalizePlanStepStatus("blocked"), "blocked");
  assert.equal(normalizePlanStepStatus("in_progress"), "todo");
});
