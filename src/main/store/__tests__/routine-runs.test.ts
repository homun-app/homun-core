// Fase 16c (C5): la tabella routine_runs — scrittura, esito, potatura dei 90
// giorni. Funzioni SQL pure su un DB :memory: (come jobs.test.ts).
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { JOBS_DDL } from '../jobs'
import { ROUTINE_RUNS_DDL, startRoutineRun, endRoutineRun, listRoutineRuns, pruneRoutineRuns, routineFailReason } from '../routine-runs'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(JOBS_DDL)
  db.exec(ROUTINE_RUNS_DDL)
})

describe('routine_runs (C5): scrittura ed esito', () => {
  it('si apre quando il job parte e si chiude con l\'esito; endRoutineRun è idempotente', () => {
    const id = startRoutineRun(db, { routineId: 7, agentId: 'a1', title: 'Rassegna del mattino', now: 1000 })
    let rows = listRoutineRuns(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ routine_id: 7, agent_id: 'a1', title: 'Rassegna del mattino', started_at: 1000, ended_at: null })
    endRoutineRun(db, id, 'ok', null, 2000)
    endRoutineRun(db, id, 'failed', 'other', 3000) // già chiusa: non si tocca
    rows = listRoutineRuns(db)
    expect(rows[0]).toMatchObject({ ended_at: 2000, outcome: 'ok', reason: null })
  })

  it('il fallimento porta un CODICE di motivo, mai testo del provider', () => {
    const id = startRoutineRun(db, { routineId: 1, agentId: 'a1', title: 't', now: 1 })
    endRoutineRun(db, id, 'failed', routineFailReason(Object.assign(new Error('HTTP 402 payment required'), { status: 402 })), 2)
    expect(listRoutineRuns(db)[0]!.reason).toBe('credit')
    expect(JSON.stringify(listRoutineRuns(db))).not.toContain('payment required')
  })

  it('routineFailReason: credit, not-responding, rate-limit, cancelled, other', () => {
    expect(routineFailReason(Object.assign(new Error('401 Unauthorized'), { status: 401 }))).toBe('credit')
    expect(routineFailReason(Object.assign(new Error('boom'), { status: 503 }))).toBe('not-responding')
    expect(routineFailReason(new Error('fetch failed'))).toBe('not-responding')
    expect(routineFailReason(Object.assign(new Error('rate limit exceeded'), { status: 429 }))).toBe('rate-limit')
    expect(routineFailReason(new Error('AbortError: interrupted'))).toBe('cancelled')
    expect(routineFailReason(new Error('qualcos\'altro'))).toBe('other')
  })

  it('le righe oltre i 90 giorni si potano all\'avvio', () => {
    const now = 100 * 86_400_000
    const old = startRoutineRun(db, { routineId: 1, agentId: 'a1', title: 'vecchia', now: now - 91 * 86_400_000 })
    endRoutineRun(db, old, 'ok', null, now - 91 * 86_400_000 + 1000)
    const fresh = startRoutineRun(db, { routineId: 2, agentId: 'a1', title: 'nuova', now: now - 10 * 86_400_000 })
    endRoutineRun(db, fresh, 'ok', null, now - 10 * 86_400_000 + 1000)
    const pruned = pruneRoutineRuns(db, now)
    expect(pruned).toBe(1)
    expect(listRoutineRuns(db).map((r) => r.title)).toEqual(['nuova'])
  })

  it('listRoutineRuns: le più recenti prima, con finestra since', () => {
    for (let i = 0; i < 3; i++) {
      const id = startRoutineRun(db, { routineId: i, agentId: 'a1', title: `r${i}`, now: 100 + i })
      endRoutineRun(db, id, 'ok', null, 200 + i)
    }
    expect(listRoutineRuns(db).map((r) => r.title)).toEqual(['r2', 'r1', 'r0'])
    expect(listRoutineRuns(db, 101).map((r) => r.title)).toEqual(['r2', 'r1'])
  })
})
