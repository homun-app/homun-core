/** Shared Italian status vocabulary for engine-backed works — product language only. */
export const ENGINE_STATUS_LABELS: Record<string, string> = {
  draft: "Da concordare",
  ready: "Pronto",
  running: "In corso",
  review: "Da rivedere",
  completed: "Completato",
  failed: "Da verificare",
  paused: "In pausa",
  cancelled: "Chiuso",
  waiting_input: "In attesa del tuo contributo",
  waiting_approval: "In attesa di approvazione",
};

export function engineStatusLabel(status: string | undefined): string {
  return (status && ENGINE_STATUS_LABELS[status]) || "Stato da verificare";
}

/**
 * A draft is "to be agreed" only until its brief is confirmed; afterwards it is
 * agreed work in preparation (materials or action pending), not a stale proposal.
 */
export function engineDraftStatusLabel(confirmedAgreement: boolean): string {
  return confirmedAgreement ? "Concordato · in preparazione" : ENGINE_STATUS_LABELS["draft"]!;
}
