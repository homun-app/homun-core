import test from "node:test";
import assert from "node:assert/strict";
import { packetLabel, selectLatestRun } from "./executionInspector.mjs";

test("selects the latest execution attempt", () => {
  assert.equal(selectLatestRun([{ run_id: "a", started_at: 1, attempt: 1 }, { run_id: "b", started_at: 2, attempt: 1 }]).run_id, "b");
  assert.equal(selectLatestRun([]), null);
});

test("packet labels retain provenance", () => {
  assert.equal(packetLabel({ source: "project", id: "project-agents" }), "project:project-agents");
});
