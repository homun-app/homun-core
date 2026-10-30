// Test dell'outbox e delle finestre di consegna (fase 6, §3bis L4): i
// send_to_user non urgenti dei turni AUTOMATICI restano trattenuti (entry
// con meta.held) finché non arriva la finestra ('morning'/'working', nel
// fuso dell'utente) o l'utente apre la chat; urgent bypassa; la consegna
// raggruppa in ordine con la riga "Mentre eri via:" se l'utente è assente.
// Store reale su directory temporanea, orologio controllato.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setDataDir, dataDir, db, appendEntry, setSetting, getSetting, updateEntryMeta } = await import('../../main/store/db')
const { holdOutboxEntry, heldOutboxForAgent, allHeldOutbox, releaseOutboxEntry } = await import('../../main/store/db')
const { inDeliveryWindow, deliverHeldForAgent, deliverDueHeld, DEFAULT_DELIVERY_WINDOW, AWAY_NOTICE_MS } = await import('../outbox')
import type { SandbotEvent, TranscriptEntry } from '../../shared/types'

const AGENT = 'agent_o'

/** Crea una send-message trattenuta (come fa il loop per i turni routine). */
function mkHeld(text: string): TranscriptEntry {
  const e = appendEntry({
    agentId: AGENT, kind: 'send-message', role: 'assistant', content: text,
    meta: { message: { type: 'text', text }, held: true }
  })
  holdOutboxEntry(e.id, AGENT, e.createdAt)
  return e
}

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-outbox-test-'))
  setDataDir(dir)
  // fase 17c: la lingua dei testi del daemon è l'italiano (come prima)
  setSetting('ui.activeLanguage', 'it')
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

beforeEach(() => {
  events = []
  const d = db()
  d.exec('DELETE FROM entries')
  d.exec('DELETE FROM outbox')
  d.exec('DELETE FROM settings')
  // fase 17c: la lingua dei testi del daemon è l'italiano (come prima)
  setSetting('ui.activeLanguage', 'it')
})

describe('inDeliveryWindow (puro)', () => {
  // 2026-10-26 è un lunedì: le 09:00 di Roma sono le 07:00 UTC (CET dopo il 25/10)
  const ROME = 'Europe/Rome'
  const at = (h: number, m: number): number => Date.UTC(2026, 9, 26, h - 1, m) // ora di Roma

  it('morning: dentro 08:30–09:30 di ogni giorno', () => {
    const cfg = { ...DEFAULT_DELIVERY_WINDOW, mode: 'morning' as const }
    expect(inDeliveryWindow(at(8, 45), ROME, cfg)).toBe(true)
    expect(inDeliveryWindow(at(9, 29), ROME, cfg)).toBe(true)
    expect(inDeliveryWindow(at(9, 30), ROME, cfg)).toBe(false) // fine esclusa
    expect(inDeliveryWindow(at(8, 29), ROME, cfg)).toBe(false)
    expect(inDeliveryWindow(at(15, 0), ROME, cfg)).toBe(false)
  })

  it('working: lun–ven 09:00–19:00 (la domenica mai)', () => {
    const cfg = { ...DEFAULT_DELIVERY_WINDOW, mode: 'working' as const }
    expect(inDeliveryWindow(at(12, 0), ROME, cfg)).toBe(true) // lunedì
    const sunday = Date.UTC(2026, 9, 25, 11, 0) // domenica 25/10, 12:00 Roma
    expect(inDeliveryWindow(sunday, ROME, cfg)).toBe(false)
    expect(inDeliveryWindow(at(20, 0), ROME, cfg)).toBe(false)
  })

  it('orari configurabili', () => {
    const cfg = { ...DEFAULT_DELIVERY_WINDOW, mode: 'morning' as const, morning: { start: '18:00', end: '19:00' } }
    expect(inDeliveryWindow(at(18, 30), ROME, cfg)).toBe(true)
    expect(inDeliveryWindow(at(9, 0), ROME, cfg)).toBe(false)
  })
})

describe('consegna per agente (apertura della chat)', () => {
  it('consegna tutte le entry trattenute in ordine, senza la riga se l\'utente è presente', () => {
    mkHeld('prima')
    mkHeld('seconda')
    const delivered = deliverHeldForAgent(AGENT, emit, { now: Date.now(), lastSeen: Date.now() })
    expect(delivered.map((e) => e.content)).toEqual(['prima', 'seconda'])
    expect(heldOutboxForAgent(AGENT)).toHaveLength(0)
    // meta.held rimosso e entry riemessa alla UI
    const withHeld = delivered.filter((e) => e.meta?.held)
    expect(withHeld).toHaveLength(0)
    expect(events.some((e) => e.type === 'entries')).toBe(true)
    // utente presente: niente "Mentre eri via:"
    expect(delivered.length).toBe(2)
  })

  it('utente assente: riga "Mentre eri via:" prima della consegna', () => {
    mkHeld('ciao')
    const delivered = deliverHeldForAgent(AGENT, emit, { now: Date.now(), lastSeen: Date.now() - AWAY_NOTICE_MS - 1 })
    expect(delivered).toHaveLength(1)
    const notice = events.flatMap((e) => (e.type === 'entries' ? e.entries : [])).find((e) => e.kind === 'notice')
    expect(notice?.content).toBe('Mentre eri via:')
  })

  it('outbox vuota: nessun effetto', () => {
    expect(deliverHeldForAgent(AGENT, emit, { now: Date.now(), lastSeen: 0 })).toHaveLength(0)
  })
})

describe('consegna a finestra (tick del daemon)', () => {
  it('fuori finestra non consegna; dentro consegna per agente', () => {
    mkHeld('trattenuta')
    setSetting('userTimeZone', 'Europe/Rome')
    // 03:00 di Roma di un lunedì: fuori da ogni finestra
    let now = Date.UTC(2026, 9, 26, 2, 0)
    deliverDueHeld(emit, now, () => now)
    expect(heldOutboxForAgent(AGENT)).toHaveLength(1)
    // 08:45 di Roma: dentro la morning window (default)
    now = Date.UTC(2026, 9, 26, 7, 45)
    deliverDueHeld(emit, now, () => now)
    expect(heldOutboxForAgent(AGENT)).toHaveLength(0)
  })

  it('la finestra si configura col setting deliveryWindow', () => {
    mkHeld('x')
    setSetting('userTimeZone', 'Europe/Rome')
    setSetting('deliveryWindow', { mode: 'working', morning: { start: '08:30', end: '09:30' }, working: { start: '21:00', end: '22:00' } })
    const now = Date.UTC(2026, 9, 26, 20, 30) // 21:30 Roma, lunedì
    deliverDueHeld(emit, now, () => now)
    expect(heldOutboxForAgent(AGENT)).toHaveLength(0)
  })

  it('una entry già rilasciata a mano non si ri-consegna', () => {
    const e = mkHeld('x')
    releaseOutboxEntry(e.id)
    updateEntryMeta(e.id, { message: { type: 'text', text: 'x' } })
    setSetting('userTimeZone', 'Europe/Rome')
    const now = Date.UTC(2026, 9, 26, 7, 45)
    deliverDueHeld(emit, now, () => now)
    expect(allHeldOutbox()).toHaveLength(0)
    expect(getSetting('presence.lastSeen', 0)).toBe(0) // nessun side effect strano
  })
})
