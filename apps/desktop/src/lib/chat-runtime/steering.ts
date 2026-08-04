export interface SteeringRowLike {
  status: string;
  active_turn_id?: string | null;
}

export const STALE_STEERING_STATUSES = new Set([
  "claimed",
  "interpreted",
  "applied",
  "completed",
  "cancelled",
  "promoted",
]);

export function visiblePendingSteeringRows<Row extends SteeringRowLike>(
  rows: Row[],
  options: { terminalTurnAtRest: boolean; activeTurnId?: string | null },
): Row[] {
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
