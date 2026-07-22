import assert from "node:assert/strict";
import test from "node:test";

import {
  applySteeringChange,
  canDelete,
  canEdit,
  canSendNow,
  createSteeringQueueState,
  reconcileSteering,
} from "./chatSteeringState.mjs";

test("reconciliation is FIFO and drops terminal rows", () => {
  const state = createSteeringQueueState([
    { steering_id: 5, revision: 1, status: "applied" },
    { steering_id: 2, revision: 1, status: "pending" },
    { steering_id: 1, revision: 2, status: "held" },
    { steering_id: 4, revision: 1, status: "promoted" },
    { steering_id: 3, revision: 1, status: "cancelled" },
  ]);

  assert.deepEqual(
    state.rows.map((row) => row.steering_id),
    [1, 2],
  );
  assert.deepEqual(state.revisions, { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1 });
});

test("older revisions cannot replace a claimed card", () => {
  const current = createSteeringQueueState([
    { steering_id: 1, revision: 3, status: "claimed" },
  ]);

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
  const current = createSteeringQueueState([
    { steering_id: 3, revision: 1, status: "pending", visible_prompt: "third" },
    { steering_id: 1, revision: 1, status: "pending", visible_prompt: "first" },
  ]);
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
    added.rows.map(({ steering_id, revision, status }) => ({ steering_id, revision, status })),
    [
      { steering_id: 1, revision: 2, status: "held" },
      { steering_id: 2, revision: 1, status: "claimed" },
      { steering_id: 3, revision: 1, status: "pending" },
    ],
  );
});

test("terminal changes remove visible cards", () => {
  const current = createSteeringQueueState([
    { steering_id: 1, revision: 1, status: "pending" },
    { steering_id: 2, revision: 1, status: "held" },
    { steering_id: 3, revision: 1, status: "claimed" },
  ]);

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

  assert.deepEqual(withoutApplied.rows, []);
  assert.deepEqual(withoutApplied.revisions, { 1: 2, 2: 2, 3: 2 });
});

test("a delayed older change cannot resurrect a terminal row", () => {
  const pending = createSteeringQueueState([
    { steering_id: 1, revision: 1, status: "pending" },
  ]);
  const cancelled = applySteeringChange(pending, {
    steering_id: 1,
    revision: 2,
    status: "cancelled",
  });

  assert.deepEqual(cancelled.rows, []);
  assert.strictEqual(
    applySteeringChange(cancelled, {
      steering_id: 1,
      revision: 1,
      status: "pending",
    }),
    cancelled,
  );
});

test("immutable copies and serialization retain terminal revision watermarks", () => {
  const cancelled = applySteeringChange(
    createSteeringQueueState([{ steering_id: 7, revision: 1, status: "pending" }]),
    { steering_id: 7, revision: 2, status: "cancelled" },
  );
  const copied = { rows: [...cancelled.rows], revisions: { ...cancelled.revisions } };
  const serialized = JSON.parse(JSON.stringify(cancelled));
  const delayed = { steering_id: 7, revision: 1, status: "pending" };

  assert.strictEqual(applySteeringChange(copied, delayed), copied);
  assert.strictEqual(applySteeringChange(serialized, delayed), serialized);
});

test("reconciliation cannot revive a row older than an explicit tombstone", () => {
  const cancelled = applySteeringChange(
    createSteeringQueueState([{ steering_id: 4, revision: 1, status: "pending" }]),
    { steering_id: 4, revision: 2, status: "cancelled" },
  );
  const copied = JSON.parse(JSON.stringify(cancelled));
  const reconciled = reconcileSteering(copied, [
    { steering_id: 4, revision: 1, status: "pending" },
  ]);

  assert.deepEqual(reconciled.rows, []);
  assert.deepEqual(reconciled.revisions, { 4: 2 });
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
