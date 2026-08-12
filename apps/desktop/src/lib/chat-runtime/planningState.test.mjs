import test from "node:test";
import assert from "node:assert/strict";
import { derivePlanningDisplayState } from "./planningState.mjs";

test("active turn with no plan and no activity shows planning indicator", () => {
  const result = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 0,
  });

  assert.equal(result.showPlanningIndicator, true);
  assert.equal(result.showBrowsingIndicator, false);
  assert.equal(result.showPlan, false);
  assert.equal(result.planDisplayState, "planning");
});

test("active turn with no plan but with activity shows browsing indicator", () => {
  const result = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 0,
    activityStepCount: 3,
  });

  assert.equal(result.showPlanningIndicator, false);
  assert.equal(result.showBrowsingIndicator, true);
  assert.equal(result.showPlan, false);
  assert.equal(result.planDisplayState, "browsing");
});

test("active turn with plan shows plan checklist, not indicator", () => {
  const result = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 3,
  });

  assert.equal(result.showPlanningIndicator, false);
  assert.equal(result.showBrowsingIndicator, false);
  assert.equal(result.showPlan, true);
  assert.equal(result.planDisplayState, "active");
});

test("inactive turn with no plan shows nothing", () => {
  const result = derivePlanningDisplayState({
    workInProgress: false,
    planStepCount: 0,
  });

  assert.equal(result.showPlanningIndicator, false);
  assert.equal(result.showBrowsingIndicator, false);
  assert.equal(result.showPlan, false);
  assert.equal(result.planDisplayState, "idle");
});

test("inactive turn with plan shows completed plan", () => {
  const result = derivePlanningDisplayState({
    workInProgress: false,
    planStepCount: 5,
  });

  assert.equal(result.showPlanningIndicator, false);
  assert.equal(result.showBrowsingIndicator, false);
  assert.equal(result.showPlan, true);
  assert.equal(result.planDisplayState, "completed");
});

test("auto-transition: planning indicator disappears as soon as plan arrives", () => {
  const before = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 0,
  });
  assert.equal(before.planDisplayState, "planning");
  assert.equal(before.showPlanningIndicator, true);

  const after = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 1,
  });
  assert.equal(after.planDisplayState, "active");
  assert.equal(after.showPlanningIndicator, false);
  assert.equal(after.showPlan, true);
});

test("auto-transition: planning → browsing as soon as activity arrives", () => {
  const before = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 0,
  });
  assert.equal(before.planDisplayState, "planning");
  assert.equal(before.showPlanningIndicator, true);
  assert.equal(before.showBrowsingIndicator, false);

  const after = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 0,
    activityStepCount: 1,
  });
  assert.equal(after.planDisplayState, "browsing");
  assert.equal(after.showPlanningIndicator, false);
  assert.equal(after.showBrowsingIndicator, true);
});

test("browsing yields to plan when plan arrives", () => {
  const browsing = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 0,
    activityStepCount: 5,
  });
  assert.equal(browsing.planDisplayState, "browsing");
  assert.equal(browsing.showBrowsingIndicator, true);

  const withPlan = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 2,
    activityStepCount: 5,
  });
  assert.equal(withPlan.planDisplayState, "active");
  assert.equal(withPlan.showBrowsingIndicator, false);
  assert.equal(withPlan.showPlan, true);
});

test("activityStepCount defaults to 0 when omitted (backward compatible)", () => {
  const result = derivePlanningDisplayState({
    workInProgress: true,
    planStepCount: 0,
    // activityStepCount omitted
  });

  assert.equal(result.showPlanningIndicator, true);
  assert.equal(result.showBrowsingIndicator, false);
  assert.equal(result.planDisplayState, "planning");
});
