export interface ApprovelLike {
  requestedBy: string;
}

/**
 * Approvals scoped to the active computer session.
 * `requestedBy` is a free-form string that may embed the session id as a
 * substring, so we match with `String.prototype.includes`.
 */
export function filterActiveApprovels<Approval extends ApprovelLike>(
  approvals: Approval[],
  computerSessionId: string,
): Approval[] {
  return approvals.filter((approval) =>
    approval.requestedBy.includes(computerSessionId),
  );
}
