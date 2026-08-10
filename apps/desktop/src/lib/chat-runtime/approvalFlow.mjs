/**
 * Approvals scoped to the active computer session.
 * `requestedBy` is a free-form string that may embed the session id as a
 * substring, so we match with `String.prototype.includes`.
 */
export function filterActiveApprovels(approvals, computerSessionId) {
  return approvals.filter((approval) =>
    approval.requestedBy.includes(computerSessionId),
  );
}
