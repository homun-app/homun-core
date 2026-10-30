// Fase 16 (U3): lo stato della mascotte dai dati veri. Funzione pura con la
// tabella di priorità della specifica — la UI le passa i fatti, non decide.
// Fase 17a (L3): i testi sono message descriptor (msg): li traduce chi li
// mostra, con la lingua attiva. I valori ({tool}, {name}) viaggiano nel
// descriptor, così i18n._ li interpola da sé.
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { AgentStatus, TurnEnd } from '../../../shared/types'

export type BotState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'waiting'

/** Quanto dura il "happy" dopo l'ultimo send-message di un turno FINISHED. */
export const HAPPY_MS = 1500

/** Quanto resta "recente" un delta prima di smettere di contare come streaming. */
export const STREAMING_MS = 1500

/** true se l'ultimo delta di questo bot è recente (testo in arrivo → speaking). */
export function isStreaming(lastDeltaAt: number | undefined, now: number): boolean {
  return lastDeltaAt !== undefined && now - lastDeltaAt <= STREAMING_MS
}

export interface BotStateInput {
  /** lo status dell'agente dal daemon */
  status: AgentStatus
  /** sta arrivando testo in streaming (delta) per QUESTO bot */
  streaming?: boolean
  /** l'utente sta scrivendo nel composer di QUESTO bot */
  userTyping?: boolean
  /**
   * L'ultimo fine turno (meta.turnEnd) con il momento dell'ultimo
   * send-message visibile (null se il turno non ne ha prodotti).
   */
  turnEnd?: { value: TurnEnd; sendAt: number | null } | null
  /** orologio, per i test */
  now?: number
}

/**
 * La tabella di priorità della specifica, in ordine:
 * offline batte tutto; il delta batte running; la scrittura dell'utente batte
 * waiting (se il bot aspetta una risposta e l'utente la sta scrivendo, la
 * mascotte ascolta); happy scade dopo 1,5 s e torna idle.
 */
export function botStateFor(input: BotStateInput): BotState {
  const now = input.now ?? Date.now()
  if (input.status === 'offline') return 'idle'
  if (input.streaming) return 'speaking'
  if (input.status === 'thinking') return 'thinking'
  if (input.status === 'running') return 'listening'
  if (input.userTyping) return 'listening'
  if (input.status === 'paused-for-approval' || input.turnEnd?.value === 'AWAITING_USER') return 'waiting'
  const te = input.turnEnd
  if (te?.value === 'FINISHED' && te.sendAt != null && now - te.sendAt <= HAPPY_MS) return 'happy'
  return 'idle'
}

/**
 * Il testo di stato dell'intestazione: Online / Sta pensando… / Sta facendo:
 * <tool> / Sta scrivendo… / Aspetta te / Offline. Descriptor: chi lo mostra
 * lo traduce con i18n._().
 */
export function botStatusText(input: BotStateInput & { activityTool?: string | null }): MessageDescriptor {
  if (input.status === 'offline') return msg`Offline`
  const state = botStateFor(input)
  switch (state) {
    case 'thinking':
      return msg`Sta pensando…`
    case 'speaking':
      return msg`Sta scrivendo…`
    case 'listening':
      // running: il tool in corso; utente che scrive: la mascotte ascolta
      return input.status === 'running' && input.activityTool ? msg`Sta facendo: ${input.activityTool}` : msg`Sta scrivendo…`
    case 'waiting':
      return msg`Aspetta te`
    default:
      return msg`Online`
  }
}

/** Il descriptor per l'aria-label della mascotte ("Nanna, sta pensando"). */
export function botAriaLabel(name: string, state: BotState): MessageDescriptor {
  switch (state) {
    case 'thinking':
      return msg`${name}, sta pensando`
    case 'listening':
      return msg`${name}, sta ascoltando`
    case 'speaking':
      return msg`${name}, sta scrivendo`
    case 'waiting':
      return msg`${name}, aspetta te`
    case 'happy':
      return msg`${name} è contento`
    default:
      return msg`${name}`
  }
}
