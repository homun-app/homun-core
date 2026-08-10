import test from "node:test";
import assert from "node:assert/strict";
import { filterActiveApprovels } from "./approvalFlow.mjs";

test("filterActiveApprovels keeps approvals matching the computer session id", () => {
  const approvals = [
    { id: "1", requestedBy: "session-a" },
    { id: "2", requestedBy: "session-b" },
    { id: "3", requestedBy: "session-a" },
  ];
  const result = filterActiveApprovels(approvals, "session-a");
  assert.deepEqual(
    result.map((a) => a.id),
    ["1", "3"],
  );
});

test("filterActiveApprovels matches by substring in requestedBy", () => {
  const approvals = [
    { id: "1", requestedBy: "prefix:session-a:suffix" },
    { id: "2", requestedBy: "session-b" },
  ];
  const result = filterActiveApprovels(approvals, "session-a");
  assert.deepEqual(
    result.map((a) => a.id),
    ["1"],
  );
});

test("filterActiveApprovels returns empty when no approvals match", () => {
  const approvals = [{ id: "1", requestedBy: "session-a" }];
  const result = filterActiveApprovels(approvals, "session-z");
  assert.deepEqual(result, []);
});

test("filterActiveApprovels returns empty for empty input", () => {
  const result = filterActiveApprovels([], "session-a");
  assert.deepEqual(result, []);
});
