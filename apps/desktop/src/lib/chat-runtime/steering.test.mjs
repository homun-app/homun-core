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
    { steering_id: 7, status: "promoted" },
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
    { steering_id: 3, status: "promoted" },
  ];

  assert.deepEqual(
    visiblePendingSteeringRows(rows, { terminalTurnAtRest: false }).map((row) => row.steering_id),
    [1, 2, 3],
  );
});

test("active turn hides stale applied rows from previous turns", () => {
  const rows = [
    { steering_id: 1, active_turn_id: "turn-old", status: "applied" },
    { steering_id: 2, active_turn_id: "turn-current", status: "applied" },
    { steering_id: 3, active_turn_id: "turn-old", status: "pending" },
  ];

  assert.deepEqual(
    visiblePendingSteeringRows(rows, {
      terminalTurnAtRest: false,
      activeTurnId: "turn-current",
    }).map((row) => row.steering_id),
    [2, 3],
  );
});

test("stale steering status set is explicit", () => {
  assert.deepEqual([...STALE_STEERING_STATUSES].sort(), [
    "applied",
    "cancelled",
    "claimed",
    "completed",
    "interpreted",
    "promoted",
  ]);
});
