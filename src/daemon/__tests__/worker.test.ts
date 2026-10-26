// Test del worker della coda: lease, rinnovo (heartbeat sugli eventi), retry
// con backoff, ripresa dopo crash simulato, un solo job attivo per agente.
// SQLite :memory: + orologio finto + runner finto: nessun timer reale.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { JOBS_DDL, enqueueJob, getJobById } from '../../main/store/jobs'
import { JobWorker } from '../worker'
import type { Job } from '../../main/store/jobs'
import type { SandbotEvent } from '../../shared/types'

const LEASE = 2 * 60_000
const ev = (agentId: string): SandbotEvent => ({ type: 'status', agentId, status: 'thinking' })

/** Orologio controllabile: il worker vede solo questo. */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, set: (v: number) => { t = v }, advance: (ms: number) => { t += ms } }
}

interface RunnerCall { job: Job; emit: (e: SandbotEvent) => void }

function makeRunner() {
  const state = {
    calls: [] as RunnerCall[],
    /** risposte in coda: Error → il run fallisce, fn → comportamento custom */
    behaviors: [] as Array<'ok' | Error | ((c: RunnerCall) => Promise<void>)>,
    seen: [] as number[] // id dei job eseguiti
  }
  const runJob = vi.fn(async (job: Job, emit: (e: SandbotEvent) => void) => {
    state.calls.push({ job, emit })
    state.seen.push(job.id)
    const b = state.behaviors.shift() ?? 'ok'
    if (b instanceof Error) throw b
    if (typeof b === 'function') return b({ job, emit })
  })
  return { state, runJob }
}

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(JOBS_DDL)
})

describe('worker: esecuzione e lease', () => {
  it('un job dovuto viene eseguito e marcato done', async () => {
    const clock = fakeClock()
    const { runJob } = makeRunner()
    const w = new JobWorker(db, { now: clock.now, runJob }, () => undefined, LEASE, 0)
    enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'ciao' }, runAt: clock.now(), now: clock.now() })

    w.tick()
    await w.drain()
    expect(runJob).toHaveBeenCalledTimes(1)
    expect(runJob.mock.calls[0]![0].payload).toEqual({ text: 'ciao' })
    const j = getJobById(db, 1)!
    expect(j.status).toBe('done')
    expect(j.attempts).toBe(1)
  })

  it('heartbeat: gli eventi del turno rinnovano il lease', async () => {
    const clock = fakeClock()
    const runner = makeRunner()
    const w = new JobWorker(db, { now: clock.now, runJob: runner.runJob }, () => undefined, LEASE, 0)
    enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'x' }, runAt: clock.now(), now: clock.now() })

    // il runner emette un "passo" del loop al minuto: senza rinnovo il lease
    // da 2 minuti scadrebbe durante il turno
    runner.state.behaviors.push(async (c) => {
      clock.advance(60_000)
      c.emit(ev('a1'))
      clock.advance(60_000)
      c.emit(ev('a1'))
      clock.advance(60_000)
      c.emit(ev('a1'))
    })
    w.tick()
    await w.drain()

    const j = getJobById(db, 1)!
    expect(j.status).toBe('done')
    expect(j.attempts).toBe(1) // mai ripreso per lease scaduto
  })

  it('UN job per agente: il secondo aspetta che il primo finisca', async () => {
    const clock = fakeClock()
    const runner = makeRunner()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    runner.state.behaviors = [
      () => gate, // il primo job resta in volo finché non si apre il cancello
      'ok'
    ]
    const w = new JobWorker(db, { now: clock.now, runJob: runner.runJob }, () => undefined, LEASE, 0)
    enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'primo' }, runAt: clock.now(), now: clock.now() })
    enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'secondo' }, runAt: clock.now(), now: clock.now() })

    w.tick()
    await vi.waitFor(() => expect(runner.state.seen).toEqual([1]))
    clock.advance(5000)
    w.tick() // il secondo NON parte: l'agente ha un lease attivo
    expect(runner.state.seen).toEqual([1])

    release()
    await w.drain()
    clock.advance(1)
    w.tick()
    await w.drain()
    expect(runner.state.seen).toEqual([1, 2])
    expect(getJobById(db, 1)?.status).toBe('done')
    expect(getJobById(db, 2)?.status).toBe('done')
  })
})

describe('worker: retry e crash', () => {
  it('un run che fallisce rimette in coda con backoff; al 5° tentativo failed', async () => {
    const clock = fakeClock()
    const runner = makeRunner()
    const errors: Array<{ job: Job; outcome: string }> = []
    const w = new JobWorker(db, { now: clock.now, runJob: runner.runJob, onError: (_j, _e, o) => errors.push({ job: _j, outcome: o }) }, () => undefined, LEASE, 0)
    enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'x' }, runAt: clock.now(), now: clock.now() })

    // 5 tentativi, tutti in errore
    for (let n = 1; n <= 5; n++) {
      runner.state.behaviors.push(new Error(`boom${n}`))
      w.tick()
      await w.drain()
      const j = getJobById(db, 1)!
      if (n < 5) {
        expect(j.status, `tentativo ${n}`).toBe('queued')
        expect(j.run_at).toBe(clock.now() + 30_000 * 2 ** (n - 1))
        clock.set(j.run_at) // il backoff passa
      } else {
        expect(j.status).toBe('failed')
        expect(j.last_error).toBe('boom5')
      }
    }
    expect(runner.state.seen).toHaveLength(5)
    expect(errors.map((e) => e.outcome)).toEqual(['retry', 'retry', 'retry', 'retry', 'failed'])
  })

  it('crash simulato: lease scaduto → il job riprende dal punto di coda (attempts=2)', async () => {
    const clock = fakeClock()
    const runner = makeRunner()
    const w = new JobWorker(db, { now: clock.now, runJob: runner.runJob }, () => undefined, LEASE, 0)
    enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'x' }, runAt: clock.now(), now: clock.now() })

    // primo worker: il job parte ma il "processo muore" (il run non finisce mai)
    let zombie!: () => void
    runner.state.behaviors.push(() => new Promise<void>(() => { zombie = () => undefined }))
    w.tick()
    await vi.waitFor(() => expect(runner.state.seen).toEqual([1]))

    // nuovo worker sulla stessa coda dopo la scadenza del lease
    const clock2 = { now: () => clock.now() + LEASE + 1 }
    const runner2 = makeRunner()
    const w2 = new JobWorker(db, { now: clock2.now, runJob: runner2.runJob }, () => undefined, LEASE, 0)
    w2.tick()
    await w2.drain()
    expect(runner2.state.seen).toEqual([1]) // stesso job
    const j = getJobById(db, 1)!
    expect(j.attempts).toBe(2)
    expect(j.status).toBe('done')
    void zombie
  })

  it('routine-run: payload passato tale e quale al runner', async () => {
    const clock = fakeClock()
    const runner = makeRunner()
    const w = new JobWorker(db, { now: clock.now, runJob: runner.runJob }, () => undefined, LEASE, 0)
    enqueueJob(db, {
      agentId: 'a2', kind: 'routine-run',
      payload: { routineId: 7, title: 'Backup', prompt: 'fai il backup' },
      runAt: clock.now(), now: clock.now()
    })
    w.tick()
    await w.drain()
    expect(runner.runJob.mock.calls[0]![0].payload).toEqual({ routineId: 7, title: 'Backup', prompt: 'fai il backup' })
  })
})
