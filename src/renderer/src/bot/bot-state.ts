// Fase 16 (U3): lo stato della mascotte dai dati veri. Funzione pura con la
// tabella di priorità della specifica — la UI le passa i fatti, non decide.
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
 * <tool> / Sta scrivendo… / Aspetta te / Offline.
 */
export function botStatusText(input: BotStateInput & { activityTool?: string | null }): string {
  if (input.status === 'offline') return 'Offline'
  const state = botStateFor(input)
  switch (state) {
    case 'thinking':
      return 'Sta pensando…'
    case 'speaking':
      return 'Sta scrivendo…'
    case 'listening':
      // running: il tool in corso; utente che scrive: la mascotte ascolta
      return input.status === 'running' && input.activityTool ? `Sta facendo: ${input.activityTool}` : 'Sta scrivendo…'
    case 'waiting':
      return 'Aspetta te'
    default:
      return 'Online'
  }
}

/** L'etichetta per l'aria-label della mascotte ("Nanna, sta pensando"). */
export function botAriaLabel(name: string, state: BotState): string {
  const s =
    state === 'thinking' ? ', sta pensando'
    : state === 'listening' ? ', sta ascoltando'
    : state === 'speaking' ? ', sta scrivendo'
    : state === 'waiting' ? ', aspetta te'
    : state === 'happy' ? ' è contento'
    : ''
  return `${name}${s}`
}
