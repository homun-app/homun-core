// B2 (fase b20-bug): il «Riprova» dell'avviso di risposta vuota — l'RPC
// turn:retry riaccoda lo STESSO turno finito vuoto (lo stesso testo e la
// stessa origine, letti dal meta.retry che il loop scrive nell'avviso). DB
// vero in memoria (solo la tabella dei job): nessun Electron, nessuna rete.
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { JOBS_DDL, enqueueJob, getJobById, listJobs } from '../../main/store/jobs'
import { retryTurn } from '../turn-retry'
import type { TranscriptEntry } from '../../shared/types'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(JOBS_DDL)
})

const notice = (id: number, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id, agentId: 'bot-1', kind: 'notice', role: 'system', content: 'Risposta vuota.', createdAt: id, meta: null, ...over
})

const wake = notice(77, {
  meta: {
    ui: { id: 'notice.modelEmpty', values: { why: 'reasoning' } },
    retry: { kind: 'user-message', payload: { text: '<comando_finito id="sh">\n$ curl\nok\n</comando_finito>', initiator: 'SHELL_DONE', untrusted: true, extraMeta: { shellId: 'sh' } } }
  }
})

describe('B2: retryTurn — «Riprova» riaccoda lo stesso turno', () => {
  it('riaccoda testo, origine e bandiere tale e quali; l’apertura del nuovo turno porta retryOf', () => {
    const r = retryTurn(db, 'bot-1', wake, 1_000)
    expect(r).toEqual({ ok: true, jobId: 1 })
    const job = getJobById(db, 1)!
    expect(job.agent_id).toBe('bot-1')
    expect(job.kind).toBe('user-message')
    expect(job.status).toBe('queued')
    expect(job.payload).toEqual({
      text: '<comando_finito id="sh">\n$ curl\nok\n</comando_finito>',
      initiator: 'SHELL_DONE',
      untrusted: true,
      extraMeta: { shellId: 'sh', retryOf: 77 }
    })
  })

  it('il turno di un task torna come task-run con lo stesso brief e le sue bandiere', () => {
    const r = retryTurn(db, 'bot-1', notice(9, { meta: { retry: { kind: 'task-run', payload: { taskId: 4, brief: 'cerca le novità', untrusted: true } } } }), 1_000)
    expect(r.ok).toBe(true)
    expect(getJobById(db, 1)!.kind).toBe('task-run')
    expect(getJobById(db, 1)!.payload).toEqual({ taskId: 4, brief: 'cerca le novità', untrusted: true, retryOf: 9 })
  })

  it('il meta.retry dell’avviso NON si modifica (resta quello del turno di partenza, anche dopo un «Riprova»)', () => {
    retryTurn(db, 'bot-1', wake, 1_000)
    expect(wake.meta).toEqual({
      ui: { id: 'notice.modelEmpty', values: { why: 'reasoning' } },
      retry: { kind: 'user-message', payload: { text: '<comando_finito id="sh">\n$ curl\nok\n</comando_finito>', initiator: 'SHELL_DONE', untrusted: true, extraMeta: { shellId: 'sh' } } }
    })
  })

  it('non è un avviso di risposta vuota: niente job (notRetryable) — entry senza retry, entry di un altro tipo, di un altro bot, o con un payload rotto', () => {
    expect(retryTurn(db, 'bot-1', notice(1, { meta: { ui: { id: 'notice.modelError' } } }))).toEqual({ ok: false, error: 'notRetryable' })
    expect(retryTurn(db, 'bot-1', notice(2, { kind: 'message', role: 'user', meta: { retry: { kind: 'user-message', payload: { text: 'x' } } } }))).toEqual({ ok: false, error: 'notRetryable' })
    expect(retryTurn(db, 'bot-1', notice(3, { agentId: 'bot-2', meta: wake.meta }))).toEqual({ ok: false, error: 'notRetryable' })
    expect(retryTurn(db, 'bot-1', notice(4, { meta: { retry: { kind: 'group-turn', payload: {} } } }))).toEqual({ ok: false, error: 'notRetryable' })
    expect(retryTurn(db, 'bot-1', notice(5, { meta: { retry: { kind: 'user-message', payload: 'rotto' } } }))).toEqual({ ok: false, error: 'notRetryable' })
    expect(retryTurn(db, 'bot-1', undefined)).toEqual({ ok: false, error: 'notRetryable' })
    expect(listJobs(db)).toEqual([])
  })

  it('doppio clic (o clic mentre il nuovo turno gira): UN job solo — alreadyQueued', () => {
    expect(retryTurn(db, 'bot-1', wake, 1_000)).toEqual({ ok: true, jobId: 1 })
    expect(retryTurn(db, 'bot-1', wake, 1_100)).toEqual({ ok: false, error: 'alreadyQueued' })
    // il job è passato al worker (leased) e il clic arriva di nuovo: ancora uno solo
    db.prepare("UPDATE jobs SET status = 'leased', lease_until = 9999 WHERE id = 1").run()
    expect(retryTurn(db, 'bot-1', wake, 1_200)).toEqual({ ok: false, error: 'alreadyQueued' })
    expect(listJobs(db)).toHaveLength(1)
    // il turno rifatto è finito (job done): «Riprova» di nuovo si può
    db.prepare("UPDATE jobs SET status = 'done', lease_until = NULL WHERE id = 1").run()
    expect(retryTurn(db, 'bot-1', wake, 1_300)).toEqual({ ok: true, jobId: 2 })
  })
})
