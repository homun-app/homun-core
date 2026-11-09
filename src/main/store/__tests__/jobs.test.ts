// Test della coda durevole (tabella jobs) su SQLite :memory: — nessun
// Electron, nessun timer: tutte le funzioni ricevono `now` da fuori.
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  JOBS_DDL, enqueueJob, claimDueJobs, recoverExpiredLeases, requeueAllLeased, renewLease,
  completeJob, failJob, retryDelayMs, activeJobForAgent, pendingUserMessages,
  cancelAgentJobs, MAX_ATTEMPTS, getJobById
} from '../jobs'

const NOW = 1_000_000
const LEASE = 2 * 60_000

function memdb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(JOBS_DDL)
  return db
}

let db: DatabaseSync
beforeEach(() => {
  db = memdb()
})

const userMsg = (agentId: string, runAt = NOW, text = 'ciao') =>
  enqueueJob(db, { agentId, kind: 'user-message', payload: { text }, runAt, now: NOW })

describe('enqueue e claim', () => {
  it('un job dovuto viene preso in lease con RETURNING (attempts parte da 1)', () => {
    userMsg('a1')
    const [job] = claimDueJobs(db, NOW, LEASE)
    expect(job?.agent_id).toBe('a1')
    expect(job?.status).toBe('leased')
    expect(job?.attempts).toBe(1)
    expect(job?.lease_until).toBe(NOW + LEASE)
    expect(activeJobForAgent(db, 'a1')?.id).toBe(job?.id)
  })

  it('un job futuro NON viene reclamato; dopo il run_at sì', () => {
    userMsg('a1', NOW + 60_000)
    expect(claimDueJobs(db, NOW, LEASE)).toHaveLength(0)
    expect(claimDueJobs(db, NOW + 60_000, LEASE)).toHaveLength(1)
  })

  it('un job già leased non viene riconsegnato a un secondo claim', () => {
    userMsg('a1')
    expect(claimDueJobs(db, NOW, LEASE)).toHaveLength(1)
    expect(claimDueJobs(db, NOW, LEASE)).toHaveLength(0)
  })

  it('UN job attivo per agente: due job dello stesso agente, uno solo in lease; altro agente ok', () => {
    userMsg('a1', NOW, 'primo')
    userMsg('a1', NOW + 1, 'secondo')
    userMsg('a2')
    const claimed = claimDueJobs(db, NOW, LEASE)
    expect(claimed.map((j) => j.agent_id).sort()).toEqual(['a1', 'a2'])
    // del primo agente è partito solo il primo job (ordine run_at)
    expect(claimed.find((j) => j.agent_id === 'a1')?.payload.text).toBe('primo')
    expect(pendingUserMessages(db, 'a1')).toBe(1)
  })

  it('ordine FIFO per run_at e id', () => {
    userMsg('a1', NOW + 10, 'tardi')
    userMsg('a2', NOW, 'presto')
    const claimed = claimDueJobs(db, NOW + 10, LEASE)
    expect(claimed.map((j) => j.payload.text)).toEqual(['presto', 'tardi'])
  })
})

describe('lease: rinnovo, scadenza e ripresa dopo crash', () => {
  it('renewLease estende lease_until solo per job in lease', () => {
    userMsg('a1')
    const [job] = claimDueJobs(db, NOW, LEASE)
    expect(renewLease(db, job!.id, NOW + 30_000, LEASE)).toBe(true)
    expect(getJobById(db, job!.id)?.lease_until).toBe(NOW + 30_000 + LEASE)
    completeJob(db, job!.id)
    expect(renewLease(db, job!.id, NOW + 60_000, LEASE)).toBe(false)
  })

  it('i lease scaduti tornano queued al riavvio e il job viene ripreso (attempts cresce)', () => {
    userMsg('a1')
    const [first] = claimDueJobs(db, NOW, LEASE)
    expect(first?.attempts).toBe(1)
    // crash simulato: nessun completeJob, il lease scade
    expect(recoverExpiredLeases(db, NOW + LEASE - 1)).toBe(0)
    expect(recoverExpiredLeases(db, NOW + LEASE)).toBe(1)
    const [second] = claimDueJobs(db, NOW + LEASE, LEASE)
    expect(second?.id).toBe(first?.id)
    expect(second?.attempts).toBe(2)
  })

  it('un lease NON scaduto non viene rubato', () => {
    userMsg('a1')
    claimDueJobs(db, NOW, LEASE)
    recoverExpiredLeases(db, NOW + LEASE - 1)
    expect(claimDueJobs(db, NOW + LEASE - 1, LEASE)).toHaveLength(0)
  })

  it('residuo 2b: requeueAllLeased rimette in coda OGNI leased all\'avvio, anche non scaduto', () => {
    userMsg('a1')
    userMsg('a2')
    const claimed = claimDueJobs(db, NOW, LEASE)
    expect(claimed).toHaveLength(2)
    // il daemon muore: al riavvio il lease è ancora vivo (scade tra 2 minuti)…
    expect(recoverExpiredLeases(db, NOW + 1)).toBe(0)
    // …ma requeueAllLeased non aspetta: tutti e due tornano subito queued
    expect(requeueAllLeased(db)).toBe(2)
    for (const j of claimed) {
      const again = getJobById(db, j.id)!
      expect(again.status).toBe('queued')
      expect(again.lease_until).toBeNull()
    }
    // e il worker li reclama subito, senza aspettare la scadenza
    const reclaimed = claimDueJobs(db, NOW + 1, LEASE)
    expect(reclaimed.map((j) => j.id).sort()).toEqual(claimed.map((j) => j.id).sort())
    // idempotente: senza leased attivi restituisce 0
    for (const j of reclaimed) completeJob(db, j.id)
    expect(requeueAllLeased(db)).toBe(0)
  })
})

describe('retry con backoff esponenziale, massimo 5 tentativi', () => {
  it('backoff puro: 30s, 60s, 120s, 240s', () => {
    expect(retryDelayMs(1)).toBe(30_000)
    expect(retryDelayMs(2)).toBe(60_000)
    expect(retryDelayMs(3)).toBe(120_000)
    expect(retryDelayMs(4)).toBe(240_000)
  })

  it('i fallimenti rimettono in coda con run_at = now + backoff', () => {
    userMsg('a1')
    const [j1] = claimDueJobs(db, NOW, LEASE)
    expect(failJob(db, j1!, NOW, 'boom')).toBe('retry')
    const again = getJobById(db, j1!.id)!
    expect(again.status).toBe('queued')
    expect(again.run_at).toBe(NOW + 30_000)
    expect(again.last_error).toBe('boom')
    // non riparte prima del backoff
    expect(claimDueJobs(db, NOW + 29_999, LEASE)).toHaveLength(0)
    expect(claimDueJobs(db, NOW + 30_000, LEASE)).toHaveLength(1)
  })

  it('al 5° tentativo fallito il job è failed per sempre', () => {
    userMsg('a1')
    let job = claimDueJobs(db, NOW, LEASE)[0]! // attempts 1
    for (let n = 1; n < MAX_ATTEMPTS; n++) {
      expect(failJob(db, job, NOW + n * 60_000, `err${n}`)).toBe('retry')
      job = claimDueJobs(db, NOW + n * 60_000 + 300_000, LEASE)[0]!
    }
    expect(job.attempts).toBe(MAX_ATTEMPTS)
    expect(failJob(db, job, NOW + 9_999_999, 'ultimo')).toBe('failed')
    const fin = getJobById(db, job.id)!
    expect(fin.status).toBe('failed')
    expect(fin.last_error).toBe('ultimo')
    expect(claimDueJobs(db, NOW * 100, LEASE)).toHaveLength(0)
  })
})

describe('cancellazione per agente eliminato', () => {
  it('cancelAgentJobs rimuove queued e leased, lascia lo storico done/failed', () => {
    const j1 = userMsg('a1') // reclamato per primo → done
    const j2 = userMsg('a1', NOW + 1, 'due') // resta queued
    const [leased] = claimDueJobs(db, NOW, LEASE)
    expect(leased?.id).toBe(j1.id)
    completeJob(db, leased!.id)
    cancelAgentJobs(db, 'a1')
    expect(getJobById(db, j2.id)).toBeNull()
    expect(getJobById(db, j1.id)?.status).toBe('done')
  })
})

// ---- fase 12 (punto 4): il tetto globale dei subagent-run in lease ----

describe('claimDueJobs col tetto maxSubagentLeases', () => {
  const subRun = (agentId: string, runAt = NOW) =>
    enqueueJob(db, { agentId, kind: 'subagent-run', payload: { subagentId: agentId }, runAt, now: NOW })

  it('5 job dovuti col tetto 3 → ne partono 3; finito uno → parte il quarto', () => {
    for (let i = 1; i <= 5; i++) subRun(`sub_${i}`)
    const first = claimDueJobs(db, NOW, LEASE, 5, 3)
    expect(first).toHaveLength(3)
    // il quarto e il quinto restano in coda anche con tick successivi
    expect(claimDueJobs(db, NOW + 1, LEASE, 5, 3)).toHaveLength(0)
    // uno finisce: libera un posto
    completeJob(db, first[0]!.id)
    const second = claimDueJobs(db, NOW + 2, LEASE, 5, 3)
    expect(second).toHaveLength(1)
    expect(second[0]!.agent_id).toBe('sub_4')
  })

  it('i job NORMALI non sono toccati dal tetto', () => {
    for (let i = 1; i <= 3; i++) subRun(`sub_${i}`)
    userMsg('a1')
    userMsg('a2')
    const claimed = claimDueJobs(db, NOW, LEASE, 10, 3)
    // i 3 subagent-run occupano il tetto, i 2 user-message partono LO STESSO
    expect(claimed.filter((j) => j.kind === 'subagent-run')).toHaveLength(3)
    expect(claimed.filter((j) => j.kind === 'user-message')).toHaveLength(2)
    // con tetto 0 nessun subagent-run parte, i normali sì
    const db2 = memdb()
    enqueueJob(db2, { agentId: 'sub_x', kind: 'subagent-run', payload: {}, runAt: NOW, now: NOW })
    enqueueJob(db2, { agentId: 'a1', kind: 'user-message', payload: { text: 'x' }, runAt: NOW, now: NOW })
    const claimed2 = claimDueJobs(db2, NOW, LEASE, 10, 0)
    expect(claimed2.map((j) => j.kind)).toEqual(['user-message'])
  })

  it('senza tetto esplicito (default Infinity) tutto parte come prima', () => {
    for (let i = 1; i <= 4; i++) subRun(`sub_${i}`)
    expect(claimDueJobs(db, NOW, LEASE, 5)).toHaveLength(4)
  })
})

// ---- fase memoria-engramma · correzioni 2 (R3): il job user-message
// finito non tiene il TESTO del messaggio per sempre — chi legge il payload
// di un job done/failed? Nessuno (il runner legge i job che esegue, la
// ripresa usa payload.entryId finché il job può ancora girare, la UI non
// guarda la tabella jobs): il testo vive già nelle entry ----

describe('correzioni 2 R3: il payload del user-message si svuota a fine corsa', () => {
  it('completeJob svuota il payload dei user-message; gli altri kind lo tengono', () => {
    const um = userMsg('a1')
    const rr = enqueueJob(db, { agentId: 'a2', kind: 'routine-run', payload: { routineId: 7, title: 'Backup', prompt: 'fai il backup' }, runAt: NOW, now: NOW })
    completeJob(db, um.id)
    expect(getJobById(db, um.id)!.status).toBe('done')
    expect(getJobById(db, um.id)!.payload).toEqual({})
    completeJob(db, rr.id)
    expect(getJobById(db, rr.id)!.status).toBe('done')
    expect(getJobById(db, rr.id)!.payload).toEqual({ routineId: 7, title: 'Backup', prompt: 'fai il backup' })
  })

  it('failJob TERMINALE svuota; il retry NON tocca il payload (la ripresa usa entryId)', () => {
    userMsg('a1')
    let job = claimDueJobs(db, NOW, LEASE)[0]! // attempts 1
    for (let n = 1; n < MAX_ATTEMPTS; n++) {
      expect(failJob(db, job, NOW + n * 60_000, `err${n}`)).toBe('retry')
      // il retry torna queued col payload INTATTO: payload.entryId serve alla ripresa
      const again = getJobById(db, job.id)!
      expect(again.payload.text).toBe('ciao')
      job = claimDueJobs(db, NOW + n * 60_000 + 300_000, LEASE)[0]!
    }
    expect(failJob(db, job, NOW + 9_999_999, 'ultimo')).toBe('failed')
    const fin = getJobById(db, job.id)!
    expect(fin.status).toBe('failed')
    expect(fin.payload).toEqual({})
    expect(fin.last_error).toBe('ultimo')
  })

  it('clearUserMessageJobPayloads: la migrazione svuota i VECCHI done/failed (una volta), non i queued', async () => {
    const { clearUserMessageJobPayloads } = await import('../jobs') as typeof import('../jobs')
    const oldDone = userMsg('a1', NOW, 'vecchio done')
    db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(oldDone.id)
    const oldFailed = userMsg('a1', NOW + 1, 'vecchio failed')
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(oldFailed.id)
    const queued = userMsg('a1', NOW + 2, 'ancora in coda')
    const oldRoutine = enqueueJob(db, { agentId: 'a1', kind: 'routine-run', payload: { routineId: 1, title: 't', prompt: 'p' }, runAt: NOW, now: NOW })
    db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(oldRoutine.id)
    expect(clearUserMessageJobPayloads(db)).toBe(2)
    expect(getJobById(db, oldDone.id)!.payload).toEqual({})
    expect(getJobById(db, oldFailed.id)!.payload).toEqual({})
    expect(getJobById(db, queued.id)!.payload).toEqual({ text: 'ancora in coda' })
    expect(getJobById(db, oldRoutine.id)!.payload).toEqual({ routineId: 1, title: 't', prompt: 'p' })
    // idempotente: la seconda corsa non trova niente
    expect(clearUserMessageJobPayloads(db)).toBe(0)
  })
})
