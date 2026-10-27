// Test del runner dei job: la mappa job → runTurn con la ripresa R1 — al
// primo tentativo l'id dell'entry che apre il turno finisce nel payload
// (payload.entryId); ai tentativi successivi torna indietro come `resume`,
// così il turno riprende dal transcript invece di riscrivere il messaggio.
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { JOBS_DDL, enqueueJob, getJobById } from '../../main/store/jobs'
import { makeJobRunner } from '../run-job'
import type { RunTurnOptions } from '../../main/agent/loop'
import type { SandbotEvent } from '../../shared/types'

const emit = (_e: SandbotEvent): void => undefined

interface Seen { agentId: string; text: string; images?: string[]; opts: RunTurnOptions }

/** runTurn finto: registra la chiamata e, al primo tentativo (niente resume), registra l'entry. */
function fakeTurn(log: Seen[]) {
  return async (agentId: string, text: string, _emit: typeof emit, images?: string[], opts: RunTurnOptions = {}): Promise<void> => {
    log.push({ agentId, text, images, opts })
    if (!opts.resume) opts.onTurnEntry?.(42)
  }
}

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(JOBS_DDL)
  // fase 8: il runner legge il titolo del task dalla propria connessione
  db.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, agent_id TEXT, title TEXT, status TEXT DEFAULT 'working', created_at INTEGER, updated_at INTEGER, summary TEXT)")
})

describe('makeJobRunner: user-message', () => {
  it('primo tentativo: onTurnEntry salva payload.entryId nel job', async () => {
    const job = enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'ciao' }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.agentId).toBe('a1')
    expect(log[0]!.text).toBe('ciao')
    expect(log[0]!.opts.source).toBe('user')
    expect(log[0]!.opts.resume).toBeUndefined()
    expect(getJobById(db, job.id)!.payload).toEqual({ text: 'ciao', entryId: 42 })
  })

  it('retry (payload.entryId presente): passa resume al turno', async () => {
    const job = enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'ciao', entryId: 7 }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.resume).toEqual({ entryId: 7 })
    expect(getJobById(db, job.id)!.payload).toEqual({ text: 'ciao', entryId: 7 })
  })

  it('le immagini viaggiano fino a runTurn', async () => {
    const job = enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'guarda', images: ['AAAA'] }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.images).toEqual(['AAAA'])
  })

  // fase 7: i payload speciali del sistema mappano sulle opzioni del turno
  it('kickstart TEMPLATE_IMPORT: initiator ed extraMeta (templateName) arrivano a runTurn', async () => {
    const job = enqueueJob(db, {
      agentId: 'a1', kind: 'user-message',
      payload: { text: 'configurati', initiator: 'TEMPLATE_IMPORT', extraMeta: { templateName: 'Gestore della posta in arrivo' } },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.initiator).toBe('TEMPLATE_IMPORT')
    expect(log[0]!.opts.extraMeta).toEqual({ templateName: 'Gestore della posta in arrivo' })
    expect(log[0]!.opts.agentMessage).toBeUndefined()
  })

  it('messaggio di un altro bot (initiator AGENT): fromAgentId/fromAgentName/hop diventano opts.agentMessage', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'user-message',
      payload: { text: '<messaggio_da_agente nome="X">ciao</messaggio_da_agente>', initiator: 'AGENT', fromAgentId: 'a1', fromAgentName: 'Bot', toAgentId: 'a2', hop: 2 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.initiator).toBe('AGENT')
    expect(log[0]!.opts.agentMessage).toEqual({ fromAgentId: 'a1', fromAgentName: 'Bot', hop: 2 })
  })

  // correzione A3: l'automaticità della catena viaggia nel payload e sopravvive alla ripresa
  it('payload automatic (catena partita da un turno automatico) → opts.automatic, anche in ripresa', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'user-message',
      payload: {
        text: '<messaggio_da_agente nome="Bot">ciao</messaggio_da_agente>', initiator: 'AGENT',
        fromAgentId: 'a1', fromAgentName: 'Bot', toAgentId: 'a2', hop: 1, automatic: true, entryId: 9
      },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.automatic).toBe(true)
    expect(log[0]!.opts.resume).toEqual({ entryId: 9 })
    expect(log[0]!.opts.agentMessage).toEqual({ fromAgentId: 'a1', fromAgentName: 'Bot', hop: 1 })
  })

  it('senza payload automatic la catena resta immediata (nessuna opts.automatic)', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'user-message',
      payload: { text: 'ciao', initiator: 'AGENT', fromAgentId: 'a1', fromAgentName: 'Bot', toAgentId: 'a2', hop: 1 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.automatic).toBeUndefined()
  })
})

describe('makeJobRunner: task-run (fase 8, §3bis L7)', () => {
  it('il brief apre il turno con l\'identità del task (id per update_task), taskId e respondedTo passati', async () => {
    db.prepare("INSERT INTO tasks(id, agent_id, title) VALUES(7, 'a3', 'Verifica controlli')").run()
    const job = enqueueJob(db, {
      agentId: 'a3', kind: 'task-run',
      payload: { taskId: 7, brief: 'fai la verifica', respondedTo: 55 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    // il modello del task sa chi è e come chiudersi (contesto separato)
    expect(log[0]!.text).toBe('[task n. 7 "Verifica controlli" — per chiuderlo: update_task con id 7]\nfai la verifica')
    expect(log[0]!.opts).toMatchObject({ source: 'user', taskId: 7, respondedTo: 55 })
  })

  it('task senza riga (eliminato): il prefisso resta senza titolo', async () => {
    const job = enqueueJob(db, {
      agentId: 'a3', kind: 'task-run',
      payload: { taskId: 99, brief: 'b' },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.text).toBe('[task n. 99 — per chiuderlo: update_task con id 99]\nb')
  })
})

describe('makeJobRunner: routine-run', () => {
  it('prompt della routine con source/title, ripresa inclusa', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'routine-run',
      payload: { routineId: 3, title: 'Backup', prompt: 'fai il backup', entryId: 9 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.text).toBe('[routine ricorrente: Backup] fai il backup')
    expect(log[0]!.opts.source).toBe('routine')
    expect(log[0]!.opts.title).toBe('Backup')
    expect(log[0]!.opts.resume).toEqual({ entryId: 9 })
  })
})
