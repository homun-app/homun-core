// OA3 (fase onboarding-a): le parti PURE dei passi della guida. Il passo
// autorizzazioni offre «Chiedi prima» e «Automatico» (approvals.mode):
// «Automatico» ha bisogno del modello — il revisore che decide se un'azione
// può passare da sola È un modello — senza modello la scelta resta spenta,
// con la riga che dice perché («Serve un modello»).
export interface ApprovalChoice {
  id: 'ask' | 'auto'
  enabled: boolean
  /** perché la scelta è spenta (solo quando lo è) */
  hint?: string
}

/** Le due scelte del passo autorizzazioni, in ordine fisso. */
export function approvalsChoices(modelReady: boolean): ApprovalChoice[] {
  return [
    { id: 'ask', enabled: true },
    { id: 'auto', enabled: modelReady, ...(modelReady ? {} : { hint: 'Serve un modello' }) }
  ]
}
