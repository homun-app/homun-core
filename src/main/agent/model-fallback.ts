// Fase 9 (punto 1): la decisione della RISERVA — se la chiamata al modello
// fallisce per errore del server (5xx), timeout o scadenza dello stream, il
// turno riprova UNA volta con il modello di riserva dello stesso provider.
// Mai riserva sugli errori 4xx (richiesta sbagliata: la riserva farebbe lo
// stesso errore). Modulo PURO, testato senza rete.
//
// Nota: gli errori di rete del provider (connessione rifiutata/reset) valgono
// come "il modello principale non risponde": la riprova è una sola e costa
// poco, ed è esattamente il caso in cui la riserva serve.
export interface FallbackState {
  /** Il modello di riserva configurato per il provider (null: nessuno). */
  fallbackModel: string | null
  /** Il modello che è appena fallito. */
  model: string
  /** La riserva è già stata usata in questo turno (una volta sola). */
  fallbackUsed: boolean
  /** Il turno è stato interrotto (dall'utente): mai riserva. */
  aborted: boolean
}

/** L'errore ammette la riserva? (5xx / timeout / scadenza dello stream / rete) */
export function fallbackEligible(err: unknown): boolean {
  // fase 8: scadenza dello stream (nessun token / inattività) — name, non
  // instanceof, così i test e i bundle non dipendono dal modulo
  if (err instanceof Error && err.name === 'StreamDeadlineError') return true
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number') return status >= 500 // 4xx = richiesta sbagliata: mai
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /timeout|timed out|etimedout|econnreset|econnrefused|socket hang up|fetch failed|network error|terminated/.test(msg)
}

/** La decisione completa: si riprova col modello di riserva? */
export function shouldUseFallback(err: unknown, s: FallbackState): boolean {
  if (s.aborted) return false
  if (s.fallbackUsed) return false
  if (!s.fallbackModel || s.fallbackModel === s.model) return false
  return fallbackEligible(err)
}
