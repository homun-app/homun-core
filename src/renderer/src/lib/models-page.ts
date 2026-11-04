// Fase impostazioni (I2): le funzioni PURE della pagina Modelli — l'ordine
// delle riserve (sposta su/giù, aggiungi, togli) e lo stato della riga del
// revisore. Il tetto è la stessa costante del daemon (K4).
import type { ApprovalsMode, FallbackRoute } from '../../../shared/types'

/** Sposta una riserva di una posizione (fuori dai limiti: la catena non cambia). */
export function moveFallback(chain: FallbackRoute[], index: number, dir: -1 | 1): FallbackRoute[] {
  const j = index + dir
  if (j < 0 || j >= chain.length) return chain
  const next = [...chain]
  const [x] = next.splice(index, 1)
  next.splice(j, 0, x!)
  return next
}

/** Toglie una riserva. */
export function removeFallback(chain: FallbackRoute[], index: number): FallbackRoute[] {
  return chain.filter((_, i) => i !== index)
}

/**
 * Lo stato della riga del revisore (I2.2): con Approvazioni su Automatico e
 * NESSUN modello scelto, la riga lo dice in arancio — senza revisore,
 * Automatico chiede sempre.
 */
export function reviewerMissing(mode: ApprovalsMode, reviewer: { providerId: string | null; model: string | null }): boolean {
  return mode === 'auto' && !(!!reviewer.providerId && !!reviewer.model)
}
