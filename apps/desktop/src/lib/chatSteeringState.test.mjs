import assert from "node:assert/strict";
import test from "node:test";

import {
  applySteeringChange,
  canDelete,
  canEdit,
  canSendNow,
  reconcileSteering,
} from "./chatSteeringState.mjs";

test("reconciliation is FIFO and drops terminal rows", () => {
  const rows = reconcileSteering([
    { steering_id: 5, revision: 1, status: "applied" },
    { steering_id: 2, revision: 1, status: "pending" },
    { steering_id: 1, revision: 2, status: "held" },
    { steering_id: 4, revision: 1, status: "promoted" },
    { steering_id: 3, revision: 1, status: "cancelled" },
  ]);

  assert.deepEqual(
    rows.map((row) => row.steering_id),
    [1, 2],
  );
});

test("older revisions cannot replace a claimed card", () => {
  const current = [{ steering_id: 1, revision: 3, status: "claimed" }];

  assert.strictEqual(
    applySteeringChange(current, {
      steering_id: 1,
      revision: 2,
      status: "pending",
    }),
    current,
  );
});

test("new rows and newer revisions are reconciled in FIFO order", () => {
  const current = [
    { steering_id: 3, revision: 1, status: "pending", visible_prompt: "third" },
    { steering_id: 1, revision: 1, status: "pending", visible_prompt: "first" },
  ];
  const changed = applySteeringChange(current, {
    steering_id: 1,
    revision: 2,
    status: "held",
    visible_prompt: "edited first",
  });
  const added = applySteeringChange(changed, {
    steering_id: 2,
    revision: 1,
    status: "claimed",
    visible_prompt: "second",
  });

  assert.deepEqual(
    added.map(({ steering_id, revision, status }) => ({ steering_id, revision, status })),
    [
      { steering_id: 1, revision: 2, status: "held" },
      { steering_id: 2, revision: 1, status: "claimed" },
      { steering_id: 3, revision: 1, status: "pending" },
    ],
  );
});

test("terminal changes remove visible cards", () => {
  const current = [
    { steering_id: 1, revision: 1, status: "pending" },
    { steering_id: 2, revision: 1, status: "held" },
    { steering_id: 3, revision: 1, status: "claimed" },
  ];

  const withoutCancelled = applySteeringChange(current, {
    steering_id: 1,
    revision: 2,
    status: "cancelled",
  });
  const withoutPromoted = applySteeringChange(withoutCancelled, {
    steering_id: 2,
    revision: 2,
    status: "promoted",
  });
  const withoutApplied = applySteeringChange(withoutPromoted, {
    steering_id: 3,
    revision: 2,
    status: "applied",
  });

  assert.deepEqual(withoutApplied, []);
});

test("a delayed older change cannot resurrect a terminal row", () => {
  const pending = [{ steering_id: 1, revision: 1, status: "pending" }];
  const cancelled = applySteeringChange(pending, {
    steering_id: 1,
    revision: 2,
    status: "cancelled",
  });

  assert.deepEqual(cancelled, []);
  assert.strictEqual(
    applySteeringChange(cancelled, {
      steering_id: 1,
      revision: 1,
      status: "pending",
    }),
    cancelled,
  );
});

test("selectors permit mutations only before claim", () => {
  assert.equal(canEdit({ status: "pending" }), true);
  assert.equal(canEdit({ status: "held" }), true);
  assert.equal(canEdit({ status: "claimed" }), false);

  assert.equal(canDelete({ status: "pending" }), true);
  assert.equal(canDelete({ status: "held" }), true);
  assert.equal(canDelete({ status: "claimed" }), false);

  assert.equal(canSendNow({ status: "pending" }), false);
  assert.equal(canSendNow({ status: "held" }), true);
  assert.equal(canSendNow({ status: "claimed" }), false);
});
