export const STALE_STEERING_STATUSES = new Set([
  "claimed",
  "interpreted",
  "applied",
  "completed",
  "cancelled",
  "promoted",
]);

export function visiblePendingSteeringRows(rows, options) {
  return rows.filter((row) => {
    if (
      options.activeTurnId
      && row.active_turn_id
      && row.active_turn_id !== options.activeTurnId
      && STALE_STEERING_STATUSES.has(row.status)
    ) {
      return false;
    }
    return !options.terminalTurnAtRest || !STALE_STEERING_STATUSES.has(row.status);
  });
}
