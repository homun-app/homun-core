const VISIBLE_STATUSES = new Set(["pending", "held", "claimed"]);
const MUTABLE_STATUSES = new Set(["pending", "held"]);

function isVisible(row) {
  return VISIBLE_STATUSES.has(row.status);
}

function bySteeringId(left, right) {
  return left.steering_id - right.steering_id;
}

export function createSteeringQueueState(rows = []) {
  return reconcileSteering({ rows: [], revisions: {} }, rows);
}

export function reconcileSteering(state, rows) {
  const revisions = { ...state.revisions };
  const previouslyVisible = new Map(state.rows.map((row) => [row.steering_id, row]));
  const latestById = new Map();
  for (const row of rows) {
    const latest = latestById.get(row.steering_id);
    if (!latest || row.revision > latest.revision) latestById.set(row.steering_id, row);
  }

  const visible = [];
  for (const row of latestById.values()) {
    const watermark = revisions[row.steering_id];
    const previous = previouslyVisible.get(row.steering_id);
    if (watermark !== undefined && row.revision < watermark) {
      if (previous) visible.push(previous);
      continue;
    }
    // No visible row at the current watermark means the state holds a terminal
    // tombstone. Only a strictly newer server revision may replace it.
    if (watermark !== undefined && row.revision === watermark && !previous) continue;
    revisions[row.steering_id] = row.revision;
    if (isVisible(row)) visible.push(row);
  }

  return { rows: visible.sort(bySteeringId), revisions };
}

export function applySteeringChange(state, change) {
  const currentRevision = state.revisions[change.steering_id];
  if (currentRevision !== undefined && change.revision <= currentRevision) return state;

  const revisions = { ...state.revisions, [change.steering_id]: change.revision };
  const remaining = state.rows.filter((row) => row.steering_id !== change.steering_id);
  const rows = isVisible(change) ? [...remaining, change].sort(bySteeringId) : remaining;
  return { rows, revisions };
}

export function canEdit(row) {
  return MUTABLE_STATUSES.has(row.status);
}

export function canDelete(row) {
  return MUTABLE_STATUSES.has(row.status);
}

export function canSendNow(row) {
  return row.status === "held";
}
