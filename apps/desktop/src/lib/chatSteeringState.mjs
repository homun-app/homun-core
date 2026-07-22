const VISIBLE_STATUSES = new Set(["pending", "held", "claimed"]);
const MUTABLE_STATUSES = new Set(["pending", "held"]);

function isVisible(row) {
  return VISIBLE_STATUSES.has(row.status);
}

function bySteeringId(left, right) {
  return left.steering_id - right.steering_id;
}

export function reconcileSteering(rows) {
  return rows.filter(isVisible).sort(bySteeringId);
}

export function applySteeringChange(current, change) {
  const existing = current.find((row) => row.steering_id === change.steering_id);
  if (existing && change.revision <= existing.revision) return current;

  const remaining = current.filter((row) => row.steering_id !== change.steering_id);
  if (!isVisible(change)) return remaining.sort(bySteeringId);
  return [...remaining, change].sort(bySteeringId);
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
