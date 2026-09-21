/** Shared Italian status vocabulary for engine-backed works — product language only. */
export const ENGINE_STATUS_LABELS: Record<string, string> = {
  draft: "Da concordare",
  ready: "Pronto",
  running: "In corso",
  review: "Da rivedere",
  completed: "Completato",
  failed: "Da verificare",
  paused: "In pausa",
  cancelled: "Annullato",
  waiting_input: "In attesa del tuo contributo",
  waiting_approval: "In attesa di approvazione",
};

export function engineStatusLabel(status: string | undefined): string {
  return (status && ENGINE_STATUS_LABELS[status]) || "Stato da verificare";
}
