import assert from "node:assert/strict";
import { test } from "node:test";
import { planConflictRecovery } from "../apps/web/src/lib/engine-conflict-recovery.ts";
import { HomunClientError } from "../apps/web/src/lib/homun-errors.ts";

test("a stale expected_version is recovered with a guided refresh, not a dry error", () => {
  const conflict = new HomunClientError("version_conflict", "Work changed; refresh before proposing", {
    httpStatus: 409,
  });
  const plan = planConflictRecovery(conflict);
  assert.equal(plan.kind, "refreshed");
  if (plan.kind === "refreshed") {
    assert.match(plan.message, /ricaricato/i);
    assert.match(plan.message, /riprova/i);
  }
});

test("a rejected approve says to prepare the action again, not just retry", () => {
  const conflict = new HomunClientError("version_conflict", "Work changed; create a new proposal", {
    httpStatus: 409,
  });
  const plan = planConflictRecovery(conflict, "approve");
  assert.equal(plan.kind, "refreshed");
  if (plan.kind === "refreshed") {
    assert.match(plan.message, /prepara di nuovo/i);
  }
  const prepare = planConflictRecovery(conflict, "prepare");
  if (prepare.kind === "refreshed") {
    assert.doesNotMatch(prepare.message, /prepara di nuovo/i);
  }
});

test("every other failure stays a normal typed error", () => {
  assert.deepEqual(planConflictRecovery(new HomunClientError("provider_unavailable", "no")), {
    kind: "none",
  });
  assert.deepEqual(planConflictRecovery(new HomunClientError("validation_error", "no")), {
    kind: "none",
  });
  assert.deepEqual(planConflictRecovery(new Error("no")), { kind: "none" });
  assert.deepEqual(planConflictRecovery(undefined), { kind: "none" });
});
