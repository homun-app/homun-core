// Notifiche (fase 6, §3bis L9): eventi agent-done (turno finito con almeno un
// messaggio visibile) e agent-needs-input (ask_user, approval, bozza in
// attesa). La decisione se consegnare è una funzione PURA con le regole di
// soppressione NELL'ORDINE: notifiche disattivate per l'agente → l'utente sta
// già guardando quell'agente (finestra a fuoco sulla sua chat) → già letto →
// throttle di 5 s per agente → consegna. La consegna vera passa dall'HostBridge
// (notifica nativa con la UI, osascript senza).
import type { SandbotEvent } from '../shared/types'

export const NOTIFY_THROTTLE_MS = 5_000

export interface NotificationInput {
  /** preferenza "notifiche per agente" disattivata */
  enabled: boolean
  /** l'utente sta guardando la chat di questo agente (finestra a fuoco) */
  viewing: boolean
  /** l'utente ha già letto il contenuto che genererebbe la notifica */
  read: boolean
  /** ultima notifica consegnata per l'agente (ms), null se mai */
  lastNotifiedAt: number | null
  now: number
  throttleMs?: number
}

export type NotificationDecision =
  | { deliver: true }
  | { deliver: false; suppress: 'disabled' | 'viewing' | 'read' | 'throttled' }

/**
 * Regole di soppressione nell'ordine della specifica (puro, testato): la
 * prima che scatta vince.
 */
export function decideNotification(i: NotificationInput): NotificationDecision {
  if (!i.enabled) return { deliver: false, suppress: 'disabled' }
  if (i.viewing) return { deliver: false, suppress: 'viewing' }
  if (i.read) return { deliver: false, suppress: 'read' }
  if (i.lastNotifiedAt !== null && i.now - i.lastNotifiedAt < (i.throttleMs ?? NOTIFY_THROTTLE_MS)) {
    return { deliver: false, suppress: 'throttled' }
  }
  return { deliver: true }
}

export type AgentNotifyEvent = Extract<SandbotEvent, { type: 'agent-notify' }>

/** Titolo/corpo della notifica per kind (agent-done / agent-needs-input). */
export function notifyTexts(agentName: string, e: AgentNotifyEvent): { title: string; body: string } {
  if (e.kind === 'needs-input') {
    return { title: `${agentName} ha bisogno di te`, body: e.preview.slice(0, 120) }
  }
  return { title: `${agentName} ha risposto`, body: e.preview.slice(0, 120) }
}
