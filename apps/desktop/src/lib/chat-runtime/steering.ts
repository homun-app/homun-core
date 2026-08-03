export interface SteeringRowLike {
  status: string;
}

export const STALE_STEERING_STATUSES = new Set([
  "claimed",
  "interpreted",
  "applied",
  "completed",
  "cancelled",
]);

export function visiblePendingSteeringRows<Row extends SteeringRowLike>(
  rows: Row[],
  options: { terminalTurnAtRest: boolean },
): Row[] {
  if (!options.terminalTurnAtRest) return rows;
  return rows.filter((row) => !STALE_STEERING_STATUSES.has(row.status));
}
