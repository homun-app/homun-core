// Test della presenza e del check-in al rientro (fase 6, §3ter T2):
// orologio FINTO — soglia minAwayHours, throttle dei segnali 'active'
// (max uno ogni 30 s), rate limit del look-around (12 h), messaggio FISSA
// prima del turno, pausa delle routine per assenza lunga (flag
// pausedForAway, provenance invariata) e riattivazione SOLO di quelle.
// Dipendenze registrate (nessun db vero): si verifica cosa fa il rientro.
import { describe, expect, it, beforeEach } from 'vitest'
import { createPresence, isLongReturn, lookaroundAllowed, isAwayForDays, mainAgentOf, DEFAULT_MIN_AWAY_HOURS } from '../presence'
// fase 17c (C4): il testo fisso del check-in vive nel catalogo UI
import { formatUi, ui } from '../../shared/ui-text'
import { UI } from '../../shared/ui-messages'
const LOOKAROUND_OPENING = formatUi(ui(UI.lookaroundOpening), 'it')
import type { Routine } from '../../main/store/db'
import type { Agent, SendMessagePayload, WidgetOption } from '../../shared/types'
// fase 17c: la lingua dell'interfaccia dei test è l'italiano (i testi erano italiani prima)
import { setSetting } from '../../main/store/db'
setSetting('ui.activeLanguage', 'it')

/** Registro di tutto ciò che la presenza fa (per le asserzioni). */
interface Log {
  settings: Record<string, unknown>
  sends: Array<{ agentId: string; message: SendMessagePayload; meta?: Record<string, unknown> }>
  lookarounds: string[]
  routineRuns: Array<{ routine: Routine; event: { source: string } }>
  routineUpdates: Array<{ id: number; patch: Record<string, unknown> }>
}

function mkPresence(log: Log, agents: Agent[], routines: Routine[], now: () => number) {
  return createPresence({
    now,
    getSetting: <T,>(key: string, fallback: T) => (key in log.settings ? (log.settings[key] as T) : fallback),
    setSetting: (key, value) => { log.settings[key] = value },
    emit: () => undefined,
    listAgents: () => agents,
    listRoutines: () => routines,
    updateRoutine: (id, patch) => {
      log.routineUpdates.push({ id, patch: patch as Record<string, unknown> })
      // applica davvero il patch (per provare l'idempotenza della pausa)
      const r = routines.find((x) => x.id === id)
      if (r) Object.assign(r, patch)
    },
    appendSystemSend: (agentId, message, meta) => { log.sends.push({ agentId, message, meta }) },
    enqueueLookaround: (agentId) => { log.lookarounds.push(agentId) },
    enqueueRoutineRun: (routine, event) => { log.routineRuns.push({ routine, event }) },
    pokeWorker: () => undefined
  })
}

const AGENT_MAIN: Agent = { id: 'a_main', name: 'Bot', description: '', providerId: 'p', model: 'm', status: 'idle', unread: 0, createdAt: 1 }
const AGENT_ALT: Agent = { ...AGENT_MAIN, id: 'a_alt', name: 'Alt', createdAt: 2 }

function routine(id: number, agentId: string, over: Partial<Routine> = {}): Routine {
  return {
    id, agent_id: agentId, title: `R${id}`, prompt: 'p', schedule: '0 9 * * *', enabled: 1,
    last_run: null, created_at: 1, description: '', timezone: '', provenance: 'user',
    trigger: null, paused_for_away: 0, last_poll: null, ...over
  }
}

let clock = 0
let log: Log
let presence: ReturnType<typeof mkPresence>

beforeEach(() => {
  clock = 1_000_000_000_000
  log = { settings: {}, sends: [], lookarounds: [], routineRuns: [], routineUpdates: [] }
  presence = mkPresence(log, [AGENT_MAIN], [], () => clock)
})

describe('funzioni pure di soglia', () => {
  it('isLongReturn: primo segnale mai, oltre la soglia sì', () => {
    expect(isLongReturn(0, 10_000, 12)).toBe(false)
    expect(isLongReturn(clock - 11 * 3_600_000, clock, 12)).toBe(false)
    expect(isLongReturn(clock - 12 * 3_600_000, clock, 12)).toBe(true)
  })

  it('lookaroundAllowed: uno ogni 12 ore', () => {
    expect(lookaroundAllowed(0, clock)).toBe(true)
    expect(lookaroundAllowed(clock - 11 * 3_600_000, clock)).toBe(false)
    expect(lookaroundAllowed(clock - 12 * 3_600_000, clock)).toBe(true)
  })

  it('isAwayForDays: assenza oltre i giorni configurati', () => {
    expect(isAwayForDays(0, clock, 7)).toBe(false)
    expect(isAwayForDays(clock - 6 * 86_400_000, clock, 7)).toBe(false)
    expect(isAwayForDays(clock - 7 * 86_400_000, clock, 7)).toBe(true)
  })

  it('mainAgentOf: setting mainAgentId, altrimenti il primo (il più vecchio)', () => {
    expect(mainAgentOf([AGENT_MAIN, AGENT_ALT], null)?.id).toBe('a_main') // più vecchio (createdAt 1)
    expect(mainAgentOf([AGENT_MAIN, AGENT_ALT], 'a_alt')?.id).toBe('a_alt')
    expect(mainAgentOf([AGENT_MAIN, AGENT_ALT], 'sparito')?.id).toBe('a_main')
    expect(mainAgentOf([], null)).toBeNull()
  })
})

describe('segnali di presenza', () => {
  it('persiste l\'ultimo istante di presenza', () => {
    presence.onSignal('active')
    expect(log.settings['presence.lastSeen']).toBe(clock)
    clock += 1_000
    presence.onSignal('typing')
    expect(log.settings['presence.lastSeen']).toBe(clock)
  })

  it("'active' è accettato al massimo ogni 30 s (gli altri sono solo rumore)", () => {
    presence.onSignal('active') // accettato
    expect(log.settings['presence.lastSeen']).toBe(clock)
    clock += 10_000
    presence.onSignal('active') // scartato: troppo presto
    expect(log.settings['presence.lastSeen']).toBe(clock - 10_000)
    clock += 21_000
    presence.onSignal('active') // accettato di nuovo (31 s dopo)
    expect(log.settings['presence.lastSeen']).toBe(clock)
  })

  it('assenza sotto la soglia: nessun look-around', () => {
    presence.onSignal('active')
    clock += (DEFAULT_MIN_AWAY_HOURS - 1) * 3_600_000
    presence.onSignal('active')
    expect(log.lookarounds).toHaveLength(0)
    expect(log.sends).toHaveLength(0)
  })
})

describe('rientro dopo l\'assenza lunga (look-around)', () => {
  it('messaggio FISSO prima del turno, poi il job del look-around', () => {
    presence.onSignal('active')
    clock += 13 * 3_600_000
    presence.onSignal('active')
    expect(log.sends).toHaveLength(1)
    expect(log.sends[0]!.agentId).toBe('a_main')
    expect(log.sends[0]!.message).toEqual({ type: 'text', text: LOOKAROUND_OPENING })
    expect(log.lookarounds).toEqual(['a_main'])
    // rate limit registrato
    expect(log.settings['lookaround.lastAt']).toBe(clock)
  })

  it('rate limit: un secondo rientro entro 12 ore NON rifà il look-around', () => {
    // soglia di assenza corta (1 h): così il rientro è frequente ma il rate
    // limit del look-around (12 h) deve tenerlo a bada
    log.settings['minAwayHours'] = 1
    presence = mkPresence(log, [AGENT_MAIN], [], () => clock)
    presence.onSignal('active')
    clock += 2 * 3_600_000
    presence.onSignal('active') // rientro 1 → look-around
    expect(log.lookarounds).toHaveLength(1)
    clock += 2 * 3_600_000
    presence.onSignal('active') // rientro 2 dopo 2 h: bloccato dal rate limit
    expect(log.lookarounds).toHaveLength(1)
    expect(log.sends).toHaveLength(1) // nemmeno il messaggio fisso si ripete
    clock += 13 * 3_600_000
    presence.onSignal('active') // ora sono passate 12+ ore dal primo
    expect(log.lookarounds).toHaveLength(2)
  })

  it('con routine in pausa per assenza: widget ask_user fisso con le due opzioni', () => {
    const paused = routine(7, 'a_main', { enabled: 0, paused_for_away: 1, trigger: { type: 'webhook', token: 't' } })
    presence = mkPresence(log, [AGENT_MAIN], [paused], () => clock)
    presence.onSignal('active')
    clock += 8 * 86_400_000
    presence.onSignal('active')
    // send fissa + widget
    expect(log.sends).toHaveLength(2)
    const widget = log.sends[1]!
    expect(widget.message.type).toBe('widget')
    if (widget.message.type === 'widget') {
      expect(widget.message.prompt).toContain('Ho messo in pausa le tue routine')
      const labels = widget.message.options.map((o: WidgetOption) => o.label)
      expect(labels).toEqual([formatUi(ui(UI.presenceResumeAll), 'it'), formatUi(ui(UI.presenceKeepPaused), 'it')])
    }
    expect(widget.meta).toMatchObject({ awayResume: true })
  })

  it('le routine con trigger presence_return girano a ogni rientro qualificato', () => {
    const pr = routine(3, 'a_main', { trigger: { type: 'presence_return' } })
    const sched = routine(4, 'a_main', {})
    presence = mkPresence(log, [AGENT_MAIN], [pr, sched], () => clock)
    presence.onSignal('active')
    clock += 13 * 3_600_000
    presence.onSignal('active')
    expect(log.routineRuns).toHaveLength(1)
    expect(log.routineRuns[0]!.routine.id).toBe(3)
    // fase 17c correzioni (D1): titolo inglese per il modello + kind per la bolla UI
    expect(log.routineRuns[0]!.event).toMatchObject({
      source: 'presence_return',
      kind: 'presenceReturn',
      title: 'The user just came back to the computer'
    })
  })
})

describe('pausa per assenza lunga', () => {
  it('maybePauseForAway: le routine attive vanno in pausa con flag, provenance invariata', () => {
    const active = [routine(1, 'a_main'), routine(2, 'a_alt', { provenance: 'agent' })]
    const stopped = routine(5, 'a_main', { enabled: 0 })
    presence = mkPresence(log, [AGENT_MAIN, AGENT_ALT], [...active, stopped], () => clock)
    presence.onSignal('active')
    clock += 8 * 86_400_000
    expect(presence.maybePauseForAway()).toBe(2)
    expect(log.routineUpdates).toEqual([
      { id: 1, patch: { enabled: 0, paused_for_away: 1 } },
      { id: 2, patch: { enabled: 0, paused_for_away: 1 } }
    ])
    // idempotente: già tutte in pausa → 0
    log.routineUpdates.length = 0
    expect(presence.maybePauseForAway()).toBe(0)
  })

  it('resumeAwayPaused riprende SOLO quelle con pausedForAway', () => {
    const away = routine(1, 'a_main', { enabled: 0, paused_for_away: 1 })
    const manual = routine(2, 'a_main', { enabled: 0, paused_for_away: 0 })
    const active = routine(3, 'a_main', { enabled: 1 })
    presence = mkPresence(log, [AGENT_MAIN], [away, manual, active], () => clock)
    expect(presence.resumeAwayPaused()).toBe(1)
    expect(log.routineUpdates).toEqual([{ id: 1, patch: { enabled: 1, paused_for_away: 0 } }])
  })
})
