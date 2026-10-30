// Outbox — finestre di consegna (fase 6, §3bis L4): i send_to_user NON
// urgenti prodotti dai turni automatici (routine e trigger) vengono
// trattenuti (entry con meta.held, nascoste in chat) finché non arriva la
// finestra di consegna — 'morning' (default 08:30–09:30) o 'working'
// (lun–ven 09:00–19:00), nel fuso orario dell'utente — o finché l'utente non
// apre la chat dell'agente. I turni avviati dall'utente e i messaggi urgent
// non passano mai dall'outbox (deciso nel loop), il look-around neppure
// (turno user-message con initiator LOOK_AROUND).
import { getSetting } from '../main/store/db'
// fase 17c (C2): la riga «Mentre eri via:» è un id del catalogo UI
import { uiLanguage, formatUi, ui } from '../main/ui-language'
import { UI } from '../shared/ui-messages'
import { allHeldOutbox, heldOutboxForAgent, releaseOutboxEntry, getEntries, updateEntryMeta, appendEntry, type OutboxRow } from '../main/store/db'
import { tzParts, parseHm, localTimeZone } from './tz'
import type { SandbotEvent, TranscriptEntry } from '../shared/types'

/** Finestra di consegna configurabile (Impostazioni → generale). */
export interface DeliveryWindowConfig {
  mode: 'morning' | 'working'
  morning: { start: string; end: string }
  working: { start: string; end: string }
}

export const DEFAULT_DELIVERY_WINDOW: DeliveryWindowConfig = {
  mode: 'morning',
  morning: { start: '08:30', end: '09:30' },
  working: { start: '09:00', end: '19:00' }
}

/** "L'utente è assente" per la riga "Mentre eri via:" (mezz'ora senza segnali). */
export const AWAY_NOTICE_MS = 30 * 60_000

/**
 * `now` sta nella finestra di consegna? (puro). 'morning' vale tutti i
 * giorni, 'working' solo lun–ven; orari nel fuso orario dell'utente.
 */
export function inDeliveryWindow(now: number, tz: string, cfg: DeliveryWindowConfig): boolean {
  const p = tzParts(now, tz)
  const times = cfg.mode === 'working' ? cfg.working : cfg.morning
  const start = parseHm(times.start)
  const end = parseHm(times.end)
  if (!start || !end) return false
  if (cfg.mode === 'working' && (p.dow < 1 || p.dow > 5)) return false
  const minuteOfDay = p.hour * 60 + p.minute
  return minuteOfDay >= start.h * 60 + start.m && minuteOfDay < end.h * 60 + end.m
}

type Emitter = (e: SandbotEvent) => void

/** La riga «Mentre eri via:» (meta.ui per la lingua dell'interfaccia, fase 17c). */
function awayNotice(agentId: string, emit: Emitter): void {
  const text = ui(UI.awayLine)
  const notice = appendEntry({ agentId, kind: 'notice', role: 'system', content: formatUi(text, uiLanguage()), meta: { ui: text } })
  emit({ type: 'entries', agentId, entries: [notice] })
}

/** Rimuove meta.held da una entry e la riemette alla UI. */
function deliverEntry(row: OutboxRow, emit: Emitter): TranscriptEntry | null {
  const entry = getEntries(row.agent_id).find((e) => e.id === row.entry_id)
  releaseOutboxEntry(row.entry_id)
  if (!entry) return null
  const meta = { ...(entry.meta ?? {}) }
  delete meta.held
  updateEntryMeta(entry.id, meta)
  const updated = getEntries(row.agent_id).find((e) => e.id === entry.id)
  if (updated) emit({ type: 'entries', agentId: row.agent_id, entries: [updated] })
  return updated ?? null
}

/**
 * Consegna i messaggi trattenuti di UN agente (finestra o apertura della
 * chat): compaiono insieme, in ordine, con la riga "Mentre eri via:" se
 * l'utente è assente. Torna le entry consegnate.
 */
export function deliverHeldForAgent(agentId: string, emit: Emitter, opts: { now: number; lastSeen: number }): TranscriptEntry[] {
  const rows = heldOutboxForAgent(agentId)
  if (!rows.length) return []
  if (opts.now - opts.lastSeen > AWAY_NOTICE_MS) awayNotice(agentId, emit)
  const out: TranscriptEntry[] = []
  for (const row of rows) {
    const e = deliverEntry(row, emit)
    if (e) out.push(e)
  }
  return out
}

/** Tick del daemon: nella finestra consegna TUTTE le outbox (per agente, in ordine). */
export function deliverDueHeld(emit: Emitter, now: number, getLastSeen: () => number): void {
  const tz = getSetting<string>('userTimeZone', '') || localTimeZone()
  const cfg = { ...DEFAULT_DELIVERY_WINDOW, ...getSetting<Partial<DeliveryWindowConfig>>('deliveryWindow', {}) } as DeliveryWindowConfig
  if (!inDeliveryWindow(now, tz, cfg)) return
  const byAgent = new Map<string, OutboxRow[]>()
  for (const row of allHeldOutbox()) {
    const list = byAgent.get(row.agent_id) ?? []
    list.push(row)
    byAgent.set(row.agent_id, list)
  }
  for (const [agentId, rows] of byAgent) {
    if (now - getLastSeen() > AWAY_NOTICE_MS) awayNotice(agentId, emit)
    for (const row of rows) deliverEntry(row, emit)
  }
}
