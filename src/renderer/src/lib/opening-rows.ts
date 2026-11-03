// Fase 0.3.1001 (M2): l'apertura di un turno può essere un messaggio DELL'UTENTE
// o un avvio AUTOMATICO (routine, giro al rientro, risvegli di sistema). La
// regola si rovescia rispetto a prima: una entry `role: 'user'` CON un
// qualsiasi initiator NON è un fumetto dell'utente — è una riga di sistema
// breve, nella lingua della UI; il testo per il modello resta nel transcript
// e si mostra solo dentro un «dettagli» chiuso.
// Funzione PURA (il componente Chat la rende, i test la tabellano).
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { TranscriptEntry } from '../../../shared/types'

/** La riga con cui l'apertura di un turno si mostra in chat. */
export type OpeningRow =
  | { kind: 'user' }
  /** riga «Da <nome>» di un messaggio di un altro bot (rendering di prima) */
  | { kind: 'agent' }
  /** righe espandibili dei template e dei report dei task (rendering di prima) */
  | { kind: 'details'; template: boolean }
  /** riga di sistema breve: ROUTINE, LOOK_AROUND, tutto il resto */
  | { kind: 'system'; label: MessageDescriptor; icon: string }

/** Il titolo della routine, se l'apertura lo porta (M2: meta.routineTitle). */
export function routineTitleOf(meta: Record<string, unknown> | null | undefined): string | undefined {
  const t = (meta as { routineTitle?: unknown } | null)?.routineTitle
  return typeof t === 'string' && t.trim() ? t : undefined
}

/**
 * La riga di un'apertura di turno (entry message role 'user'): fumetto
 * dell'utente SOLO senza initiator. Con initiator qualsiasi → riga di
 * sistema; il testo per il modello NON si mostra (al massimo nei dettagli).
 */
export function openingRowFor(entry: Pick<TranscriptEntry, 'role' | 'meta'>): OpeningRow {
  if (entry.role !== 'user') return { kind: 'user' }
  const initiator = (entry.meta as { initiator?: unknown } | null)?.initiator
  if (initiator === undefined || initiator === '') return { kind: 'user' }
  switch (initiator) {
    case 'AGENT':
      return { kind: 'agent' }
    case 'TEMPLATE_IMPORT':
      return { kind: 'details', template: true }
    case 'TASK_DONE':
      return { kind: 'details', template: false }
    case 'ROUTINE': {
      const title = routineTitleOf(entry.meta)
      return { kind: 'system', icon: '⏱', label: title ? msg`Routine «${title}»` : msg`Routine` }
    }
    case 'LOOK_AROUND':
      return { kind: 'system', icon: '👋', label: msg`Al tuo rientro` }
    default:
      return { kind: 'system', icon: '⚙', label: msg`Avvio automatico` }
  }
}
