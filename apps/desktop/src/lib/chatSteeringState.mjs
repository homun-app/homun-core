const VISIBLE_STATUSES = new Set(["pending", "held", "claimed"]);
const MUTABLE_STATUSES = new Set(["pending", "held"]);
// The UI intentionally consumes a plain array. Keep revision watermarks in a
// sidecar keyed by that array so terminal records can remain invisible without
// discarding the information needed to reject delayed changes.
const revisionWatermarks = new WeakMap();

function isVisible(row) {
  return VISIBLE_STATUSES.has(row.status);
}

function bySteeringId(left, right) {
  return left.steering_id - right.steering_id;
}

function revisionsFor(rows) {
  const tracked = revisionWatermarks.get(rows);
  if (tracked) return tracked;
  return new Map(rows.map((row) => [row.steering_id, row.revision]));
}

function trackRevisions(rows, revisions) {
  revisionWatermarks.set(rows, revisions);
  return rows;
}

export function reconcileSteering(rows) {
  const latestById = new Map();
  for (const row of rows) {
    const latest = latestById.get(row.steering_id);
    if (!latest || row.revision > latest.revision) latestById.set(row.steering_id, row);
  }
  const revisions = new Map(
    [...latestById.values()].map((row) => [row.steering_id, row.revision]),
  );
  return trackRevisions(
    [...latestById.values()].filter(isVisible).sort(bySteeringId),
    revisions,
  );
}

export function applySteeringChange(current, change) {
  const revisions = revisionsFor(current);
  const currentRevision = revisions.get(change.steering_id);
  if (currentRevision !== undefined && change.revision <= currentRevision) return current;

  const nextRevisions = new Map(revisions).set(change.steering_id, change.revision);
  const remaining = current.filter((row) => row.steering_id !== change.steering_id);
  if (!isVisible(change)) {
    return trackRevisions(remaining.sort(bySteeringId), nextRevisions);
  }
  return trackRevisions([...remaining, change].sort(bySteeringId), nextRevisions);
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
