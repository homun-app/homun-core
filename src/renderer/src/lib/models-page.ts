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

/**
 * Fase locale correzioni (LC2): i pulsanti della scheda Integrato per ogni
 * stato — Annulla SOLO col download attivo (con paused/error non c'è niente
 * da annullare e il bottone today non fa nulla); Riprendi (riparte col
 * Range) e Ricomincia (cancella il .part) con paused e con error.
 */
export function localModelCardActions(
  state: 'not-installed' | 'downloading' | 'paused' | 'error' | 'ready' | 'running'
): { cancel: boolean; resume: boolean; restart: boolean } {
  if (state === 'downloading') return { cancel: true, resume: false, restart: false }
  if (state === 'paused' || state === 'error') return { cancel: false, resume: true, restart: true }
  return { cancel: false, resume: false, restart: false }
}
