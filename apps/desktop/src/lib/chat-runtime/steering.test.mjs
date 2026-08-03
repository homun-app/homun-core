import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_STEERING_STATUSES,
  visiblePendingSteeringRows,
} from "./steering.mjs";

test("terminal turn hides stale steering rows", () => {
  const rows = [
    { steering_id: 1, status: "pending" },
    { steering_id: 2, status: "claimed" },
    { steering_id: 3, status: "interpreted" },
    { steering_id: 4, status: "applied" },
    { steering_id: 5, status: "completed" },
    { steering_id: 6, status: "cancelled" },
  ];

  assert.deepEqual(
    visiblePendingSteeringRows(rows, { terminalTurnAtRest: true }).map((row) => row.steering_id),
    [1],
  );
});

test("active turn keeps all rows visible for truthful progress", () => {
  const rows = [
    { steering_id: 1, status: "pending" },
    { steering_id: 2, status: "applied" },
  ];

  assert.deepEqual(
    visiblePendingSteeringRows(rows, { terminalTurnAtRest: false }).map((row) => row.steering_id),
    [1, 2],
  );
});

test("stale steering status set is explicit", () => {
  assert.deepEqual([...STALE_STEERING_STATUSES].sort(), [
    "applied",
    "cancelled",
    "claimed",
    "completed",
    "interpreted",
  ]);
});
