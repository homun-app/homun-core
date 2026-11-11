// B3 (fase beta.4): la riga che resta dopo la risposta a una domanda
// (ask_user). Una risposta LIBERA diventa «Hai scritto: Alle 8» — niente
// lettera né «·» vuoti com'era («Hai scelto: · · Alle 8»); con un'opzione
// resta «Hai scelto: B · Preparare le fatture». E la risposta NON si ripete
// come bolla utente separata: resta questa riga, riapribile. Funzioni PURE.
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { TranscriptEntry } from '../../../shared/types'

/** Le lettere dei quadratini delle opzioni (come WidgetCard). */
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

/**
 * La riga della risposta data (PURa): «Hai scelto: B · etichetta» quando c'è
 * un'opzione scelta (anche mista al testo libero), «Hai scritto: …» quando
 * la risposta è solo testo libero.
 */
export function widgetDecidedLabel(values: string | string[], options: Array<{ label: string; value: string }>): MessageDescriptor {
  const list = Array.isArray(values) ? values : [values]
  const chosen = list.some((v) => options.some((o) => o.value === v))
  if (!chosen) return msg`Hai scritto: ${list.join(', ')}`
  const parts = list.map((v) => {
    const at = options.findIndex((o) => o.value === v)
    return at < 0 ? v : `${LETTERS[at]} · ${options[at]!.label}`
  })
  return msg`Hai scelto: ${parts.join(' · ')}`
}

/**
 * True se il messaggio utente è la risposta a una domanda (meta.respondedTo):
 * NON si rende come bolla — il testo vive già nella riga della card, che si
 * può riaprire. PURO.
 */
export function hidesUserBubble(entry: Pick<TranscriptEntry, 'role' | 'meta'>): boolean {
  if (entry.role !== 'user') return false
  return (entry.meta as { respondedTo?: unknown } | null)?.respondedTo !== undefined
}
