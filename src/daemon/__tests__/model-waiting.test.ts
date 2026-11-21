// OA5 (fase onboarding-a): il primo messaggio senza modello NON si perde.
// Il job del messaggio si TRATTIENE (run_at lontanissimo, payload.waitingModel)
// e riparte DA SOLO una volta sola quando un modello valido viene salvato:
// alla ripresa il turno NON riscrive il messaggio utente (resume quiet).
// Qui la meccanica della coda: jobs puri + worker + runner con runTurn finto
// che trattiene la prima volta e gira la seconda (il comportamento VERO di
// runTurn senza modello è provato in loop.test.ts).
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { JOBS_DDL, enqueueJob, listJobs, holdJobForModel, releaseJobsHeldForModel, HELD_FOR_MODEL_MS } from '../../main/store/jobs'
import { JobWorker } from '../worker'
import { makeJobRunner } from '../run-job'
import { TurnHeldForModel } from '../../main/agent/turn-held'
import type { RunTurnOptions } from '../../main/agent/loop'
import type { SandbotEvent } from '../../shared/types'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(JOBS_DDL)
})

describe('OA5 jobs puri: trattenere e rilasciare il job che aspetta il modello', () => {
  it('holdJobForModel: il job torna in coda, lontanissimo, col waitingModel', () => {
    const job = enqueueJob(db, { agentId: 'a_1', kind: 'user-message', payload: { text: 'ciao' }, runAt: 1_000, now: 1_000 })!
    db.exec("UPDATE jobs SET status = 'leased' WHERE id = " + job.id)
    holdJobForModel(db, job.id, 1_000)
    const [held] = listJobs(db)
    expect(held.status).toBe('queued')
    expect(held.run_at).toBe(1_000 + HELD_FOR_MODEL_MS)
    expect(held.payload.waitingModel).toBe(true)
  })

  it('releaseJobsHeldForModel: solo i job trattenuti tornano dovuti ADESSO; conta i rilanciati', () => {
    const held = enqueueJob(db, { agentId: 'a_1', kind: 'user-message', payload: { text: 'ciao', waitingModel: true }, runAt: 9_000_000_000_000, now: 1_000 })!
    const normal = enqueueJob(db, { agentId: 'a_1', kind: 'user-message', payload: { text: 'poi' }, runAt: 5_000, now: 1_000 })!
    const released = releaseJobsHeldForModel(db, 2_000)
    expect(released).toBe(1)
    const jobs = listJobs(db)
    expect(jobs.find((j) => j.id === held.id)!.run_at).toBe(2_000)
    expect(jobs.find((j) => j.id === normal.id)!.run_at).toBe(5_000)
  })

  it('HELD_FOR_MODEL_MS è lontano (un anno: nessun worker lo prende per caso)', () => {
    expect(HELD_FOR_MODEL_MS).toBeGreaterThanOrEqual(365 * 24 * 3600 * 1000)
  })
})

describe('OA5 worker+runner: il messaggio trattenuto parte una volta sola quando il modello arriva', () => {
  it('senza modello: il turno si trattiene (job in coda, lontano, con entryId); col modello: riparte in resume QUIET e gira UNA volta', async () => {
    const calls: Array<{ text: string; opts: RunTurnOptions }> = []
    const runTurnFake = async (_agentId: string, text: string, _emit: unknown, _images: unknown, opts: RunTurnOptions): Promise<void> => {
      calls.push({ text, opts })
      if (!opts.resume) {
        // come runTurn vero senza modello: il messaggio entra nel transcript
        // (entry 42), l'id finisce nel payload del job, il turno si trattiene
        opts.onTurnEntry?.(42)
        throw new TurnHeldForModel()
      }
    }
    let t = 1_000
    const worker = new JobWorker(db, { now: () => t, runJob: makeJobRunner(db, runTurnFake as never) }, () => undefined)
    const job = enqueueJob(db, { agentId: 'a_1', kind: 'user-message', payload: { text: 'ciao' }, runAt: 1_000, now: 1_000 })!
    worker.poke()
    await worker.drain()
    // il job è tornato in coda, trattenuto, e NON è fallito
    let [held] = listJobs(db)
    expect(held.status).toBe('queued')
    expect(held.attempts).toBe(1) // il primo tentativo è quello trattenuto, non un fallimento
    expect(held.run_at).toBe(1_000 + HELD_FOR_MODEL_MS)
    expect(held.payload.waitingModel).toBe(true)
    expect(held.payload.entryId).toBe(42)
    // il modello arriva: si rilascia e il job riparte
    t = 2_000 // il modello è arrivato: per il worker è ADESSO
    expect(releaseJobsHeldForModel(db, 2_000)).toBe(1)
    worker.poke()
    await worker.drain()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.opts.resume).toMatchObject({ entryId: 42, quiet: true })
    const [done] = listJobs(db)
    expect(done.status).toBe('done')
    expect(job.id).toBe(done.id)
    // UNA volta sola: niente altre corse
    worker.poke()
    await worker.drain()
    expect(calls).toHaveLength(2)
  })
})

// ---- OAC2 (fase guida, G1): il job della SECONDA attesa riparte una volta sola ----
describe('OAC2 worker: due attese trattenute, entrambe ripartono UNA volta quando il modello torna', () => {
  it('due messaggi in due attese diverse: due job trattenuti; al rilascio due resume, e poi mai più', async () => {
    const calls: string[] = []
    let nextEntryId = 41
    const runTurnFake = async (_agentId: string, text: string, _emit: unknown, _images: unknown, opts: RunTurnOptions): Promise<void> => {
      calls.push(`${opts.resume ? 'resume' : 'nuovo'}:${text}`)
      if (!opts.resume) {
        // come runTurn vero senza modello: il messaggio entra nel transcript
        // (entry con id SUO) e il turno si trattiene
        opts.onTurnEntry?.(nextEntryId++)
        throw new TurnHeldForModel()
      }
    }
    let t = 1_000
    const worker = new JobWorker(db, { now: () => t, runJob: makeJobRunner(db, runTurnFake as never) }, () => undefined)
    // prima attesa: si trattiene (il messaggio resta, la riga needModel esce)
    enqueueJob(db, { agentId: 'a_1', kind: 'user-message', payload: { text: 'prima attesa' }, runAt: 1_000, now: 1_000 })
    worker.poke(); await worker.drain()
    // il bot HA risposto ( modello arrivato e poi tolto): una seconda attesa
    // nasce un nuovo job, che si trattiene a sua volta
    enqueueJob(db, { agentId: 'a_1', kind: 'user-message', payload: { text: 'seconda attesa' }, runAt: 2_000, now: 2_000 })
    t = 2_000
    worker.poke(); await worker.drain()
    expect(calls).toEqual(['nuovo:prima attesa', 'nuovo:seconda attesa'])
    const held = listJobs(db).filter((j) => j.status === 'queued')
    expect(held).toHaveLength(2)
    expect(held.every((j) => j.payload.waitingModel === true)).toBe(true)
    // il modello torna: ENTRAMBE ripartono, una volta sola ciascuna (il
    // worker prende un job per agente per tick: servono due poke)
    t = 3_000
    expect(releaseJobsHeldForModel(db, 3_000)).toBe(2)
    worker.poke(); await worker.drain()
    expect(calls).toEqual(['nuovo:prima attesa', 'nuovo:seconda attesa', 'resume:prima attesa'])
    worker.poke(); await worker.drain()
    expect(calls).toEqual(['nuovo:prima attesa', 'nuovo:seconda attesa', 'resume:prima attesa', 'resume:seconda attesa'])
    worker.poke(); await worker.drain()
    expect(calls).toHaveLength(4)
    expect(listJobs(db).every((j) => j.status === 'done')).toBe(true)
  })
})
