// T1 (fase web-strategia): aspettare un sottoagente non è un ciclo —
// check_subagent diventa un'attesa VERA (long-poll: ritorna appena il figlio
// cambia qualcosa — passo nuovo, stato, risultato — o dopo al massimo 60 s),
// due attese a vuoto dicono al bot di CHIUDERE il turno (il figlio lo
// sveglia da solo con wake_parent), e il loop-guard non conta come «stessa
// azione ripetuta» le attese su un figlio che avanza: conta solo se è fermo.
import { describe, expect, it } from 'vitest'
import {
  waitForSubagentChange, subagentCheckChanged, subagentInProgress,
  CHECK_SUBAGENT_WAIT_MAX_MS, CHECK_SUBAGENT_NOTHING_NEW_LINE, CHECK_SUBAGENT_CLOSE_TURN_LINE,
  noNewsWaitCount
} from '../subagents'
import { trackToolStreak, initialToolStreakState } from '../loop-guard'

const SNAP = (over: Partial<{ status: string; steps: number; summary: string | null }> = {}): { status: string; steps: number; summary: string | null } => ({
  status: 'running', steps: 3, summary: null, ...over
})

describe('T1: cos\'è una novità del figlio (puro)', () => {
  it('un passo in più, un cambio di stato o il summary sono novità', () => {
    expect(subagentCheckChanged(SNAP(), SNAP({ steps: 4 }))).toBe(true)
    expect(subagentCheckChanged(SNAP(), SNAP({ status: 'done' }))).toBe(true)
    expect(subagentCheckChanged(SNAP({ status: 'done' }), SNAP({ status: 'done', summary: 'pronto' }))).toBe(true)
  })

  it('lo stesso stato, gli stessi passi e nessun summary NON sono novità', () => {
    expect(subagentCheckChanged(SNAP(), SNAP())).toBe(false)
    expect(subagentCheckChanged(SNAP({ status: 'queued', steps: 0, summary: null }), SNAP({ status: 'queued', steps: 0, summary: null }))).toBe(false)
  })

  it('in corsa: queued e running; terminali: done/failed/stopped/stopped-loop/expired', () => {
    expect(subagentInProgress('queued')).toBe(true)
    expect(subagentInProgress('running')).toBe(true)
    for (const t of ['done', 'failed', 'stopped', 'stopped-loop', 'expired']) expect(subagentInProgress(t)).toBe(false)
  })
})

describe('T1: l\'attesa vera (orologio finto)', () => {
  const clock = (start = 0) => {
    let t = start
    return { now: () => t, advance: (ms: number) => { t += ms } }
  }

  it('il tetto dell\'attesa è 60 s', () => {
    expect(CHECK_SUBAGENT_WAIT_MAX_MS).toBe(60_000)
  })

  it('ritorna APPENA il figlio fa un passo nuovo (non aspetta il tetto)', async () => {
    const c = clock()
    let polls = 0
    const snapshot = () => {
      polls++
      // alla terza lettura il figlio ha fatto un passo in più
      return polls >= 3 ? SNAP({ steps: 4 }) : SNAP()
    }
    const sleep = async (ms: number) => { c.advance(ms) }
    const r = await waitForSubagentChange({ snapshot, sleep, now: c.now, pollMs: 500, maxMs: 60_000 })
    expect(r.changed).toBe(true)
    expect(r.final.steps).toBe(4)
    expect(polls).toBe(3)
    expect(c.now()).toBe(1_000) // due attese da 500 ms, poi la novità
  })

  it('figlio fermo → dopo il tetto torna senza novità', async () => {
    const c = clock()
    const r = await waitForSubagentChange({ snapshot: () => SNAP(), sleep: async (ms) => { c.advance(ms) }, now: c.now, pollMs: 1_000, maxMs: 5_000 })
    expect(r.changed).toBe(false)
    expect(r.final.steps).toBe(3)
    expect(c.now()).toBeGreaterThanOrEqual(5_000)
  })

  it('il figlio che FINISCE durante l\'attesa è una novità (stato done)', async () => {
    const c = clock()
    let polls = 0
    const r = await waitForSubagentChange({
      snapshot: () => { polls++; return polls >= 2 ? SNAP({ status: 'done', summary: 'orari trovati' }) : SNAP() },
      sleep: async (ms) => { c.advance(ms) },
      now: c.now, pollMs: 500, maxMs: 60_000
    })
    expect(r.changed).toBe(true)
    expect(r.final.status).toBe('done')
  })
})

describe('T1: due attese a vuoto → chiudi il turno', () => {
  it('la riga di «nessuna novità» e quella di chiusura del turno esistono e sono in parole', () => {
    expect(CHECK_SUBAGENT_NOTHING_NEW_LINE).toMatch(/nothing new/i)
    expect(CHECK_SUBAGENT_CLOSE_TURN_LINE).toMatch(/wake you on its own/i)
    expect(CHECK_SUBAGENT_CLOSE_TURN_LINE).toMatch(/close your turn/i)
  })

  it('noNewsWaitCount: prima attesa a vuoto → 1, seconda → 2, una novità azzera', () => {
    let n = noNewsWaitCount(0, { changed: false })
    expect(n).toBe(1)
    n = noNewsWaitCount(n, { changed: false })
    expect(n).toBe(2)
    n = noNewsWaitCount(n, { changed: true })
    expect(n).toBe(0)
  })
})

describe('T1: il loop-guard non conta le attese di un figlio che AVANZA', () => {
  const call = { name: 'check_subagent', args: JSON.stringify({ id: 'sub_1' }) }

  it('25 chiamate identiche CON novità (progress) non fermano il turno', () => {
    let state = initialToolStreakState()
    let stop: string | null = null
    for (let i = 0; i < 25; i++) {
      // il result CAMBIA a ogni chiamata: i passi del figlio aumentano
      const out = trackToolStreak(state, call, { fingerprint: `passi-${i}`, failed: false, progress: true })
      state = out.state
      stop = out.stop
    }
    expect(stop).toBeNull()
  })

  it('col figlio FERMO le attese fermano il turno: identiche → no-progress (a 6); risposte che girano a vuoto → similar (a 25)', () => {
    // identiche con la STESSA risposta (il figlio non si muove): si ferma
    // PRIMA ancora, a 6 (identical-no-progress) — «con il figlio fermo sì»
    let state = initialToolStreakState()
    let stop: string | null = null
    for (let i = 0; i < 25; i++) {
      const out = trackToolStreak(state, call, { fingerprint: 'sempre-uguale', failed: false, progress: false })
      state = out.state
      stop = out.stop
    }
    expect(stop).toBe('identical-no-progress')
    // risposte DIVERSE ma senza novità del figlio (il result cambia per i
    // tempi, il figlio non avanza): resta la serie «simile», che ferma a 25
    state = initialToolStreakState()
    stop = null
    for (let i = 0; i < 25; i++) {
      const out = trackToolStreak(state, call, { fingerprint: `vuoto-${i}`, failed: false, progress: false })
      state = out.state
      stop = out.stop
    }
    expect(stop).toBe('similar')
  })

  it('senza progress il comportamento di oggi resta: le attese vere (browser_wait) non contano il «no progress»', () => {
    let state = initialToolStreakState()
    let stop: string | null = null
    for (let i = 0; i < 30; i++) {
      const out = trackToolStreak(state, { name: 'browser_wait', args: '{"ms":1000}' }, { fingerprint: 'same', failed: false })
      state = out.state
      stop = out.stop
    }
    expect(stop).toBe('similar') // solo la serie «simile» resta per le attese vere
  })
})
