export const STALE_STEERING_STATUSES = new Set([
  "claimed",
  "interpreted",
  "applied",
  "completed",
  "cancelled",
  "promoted",
]);

export function visiblePendingSteeringRows(rows, options) {
  if (!options.terminalTurnAtRest) return rows;
  return rows.filter((row) => !STALE_STEERING_STATUSES.has(row.status));
}
