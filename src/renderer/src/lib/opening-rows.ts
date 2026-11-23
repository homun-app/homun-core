// Fase 0.3.1001 (M2): l'apertura di un turno può essere un messaggio DELL'UTENTE
// o un avvio AUTOMATICO (routine, giro al rientro, risvegli di sistema). La
// regola si rovescia rispetto a prima: una entry `role: 'user'` CON un
// qualsiasi initiator NON è un fumetto dell'utente — è una riga di sistema
// breve, nella lingua della UI; il testo per il modello resta nel transcript
// e si mostra solo dentro un «dettagli» chiuso.
// Funzione PURA (il componente Chat la rende, i test la tabellano).
// B2 (fase b20-bug): le icone delle righe di sistema sono componenti lucide
// (prima erano quattro emoji) — regola: mai emoji nell'interfaccia.
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Cog, Hand, RotateCcw, Timer, Zap, type LucideIcon } from 'lucide-react'
import type { TranscriptEntry } from '../../../shared/types'

/** La riga con cui l'apertura di un turno si mostra in chat. */
export type OpeningRow =
  | { kind: 'user' }
  /** riga «Da <nome>» di un messaggio di un altro bot (rendering di prima) */
  | { kind: 'agent' }
  /** righe espandibili dei template e dei report dei task (rendering di prima) */
  | { kind: 'details'; template: boolean }
  /** riga di sistema breve: ROUTINE, LOOK_AROUND, tutto il resto (icona lucide) */
  | { kind: 'system'; label: MessageDescriptor; icon: LucideIcon }
  /**
   * B2 (fase beta.4): il prompt NASCOSTO della presentazione del bot nuovo
   * (initiator BOT_INTRO) — non compare in chat affatto
   */
  | { kind: 'hidden' }

/** Il titolo della routine, se l'apertura lo porta (M2: meta.routineTitle). */
export function routineTitleOf(meta: Record<string, unknown> | null | undefined): string | undefined {
  const t = (meta as { routineTitle?: unknown } | null)?.routineTitle
  return typeof t === 'string' && t.trim() ? t : undefined
}

/**
 * B3 (fase beta.4): True se il messaggio utente è la risposta a una domanda
 * (meta.respondedTo): NON si rende come bolla — il testo vive già nella riga
 * della card, che si può riaprire. PURO.
 */
export function hidesUserBubble(entry: Pick<TranscriptEntry, 'role' | 'meta'>): boolean {
  if (entry.role !== 'user') return false
  return (entry.meta as { respondedTo?: unknown } | null)?.respondedTo !== undefined
}

/**
 * B2 (fase b20-bug): True se l'apertura è una riga di sistema — un avvio
 * AUTOMATICO (routine, risvegli, note [sistema]) o un turno rifatto da
 * «Riprova». Lo usa la vista per raccogliere l'avviso che torna a ogni turno.
 */
export function isAutomaticOpening(entry: Pick<TranscriptEntry, 'kind' | 'role' | 'meta'>): boolean {
  if (entry.kind !== 'message' || entry.role !== 'user') return false
  return openingRowFor(entry).kind === 'system'
}

/**
 * La riga di un'apertura di turno (entry message role 'user'): fumetto
 * dell'utente SOLO senza initiator. Con initiator qualsiasi → riga di
 * sistema; il testo per il modello NON si mostra (al massimo nei dettagli).
 * B2: anche il turno rifatto da «Riprova» (meta.retryOf, l'id dell'avviso)
 * è una riga di sistema — la bolla dell'utente non si ripete.
 */
export function openingRowFor(entry: Pick<TranscriptEntry, 'role' | 'meta'>): OpeningRow {
  if (entry.role !== 'user') return { kind: 'user' }
  const meta = entry.meta as { initiator?: unknown; retryOf?: unknown } | null
  const initiator = meta?.initiator
  if (initiator === undefined || initiator === '') {
    if (meta?.retryOf !== undefined) return { kind: 'system', icon: RotateCcw, label: msg`Riprovo` }
    return { kind: 'user' }
  }
  switch (initiator) {
    case 'AGENT':
      return { kind: 'agent' }
    case 'TEMPLATE_IMPORT':
      return { kind: 'details', template: true }
    case 'TASK_DONE':
      return { kind: 'details', template: false }
    case 'ROUTINE': {
      const title = routineTitleOf(entry.meta)
      return { kind: 'system', icon: Timer, label: title ? msg`Routine «${title}»` : msg`Routine` }
    }
    case 'LOOK_AROUND':
      return { kind: 'system', icon: Hand, label: msg`Al tuo rientro` }
    // V6 (fase stato-vivo): la ripresa dopo il click su «Attiva» di una
    // scheda offer_enable_plugin — il bot ripete l'operazione chiesta
    case 'PLUGIN_ENABLED_RESUME':
      return { kind: 'system', icon: Zap, label: msg`Plugin attivato — riprendo` }
    // B2 (fase beta.4): il prompt della presentazione NON compare in chat
    // (né bolla, né riga, né dettagli): la domanda che segue è la card ask_user
    case 'BOT_INTRO':
      return { kind: 'hidden' }
    default:
      return { kind: 'system', icon: Cog, label: msg`Avvio automatico` }
  }
}
