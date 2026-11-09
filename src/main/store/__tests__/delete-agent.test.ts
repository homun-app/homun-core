// Test della pulizia alla cancellazione di un agente (fase 7, residuo 0c):
// oltre a righe agents/entries e directory su disco (fase 5), vanno via anche
// le righe outbox trattenute e i setting trigger.seen.<id> delle sue routine
// (con le routine stesse: un poll di un agente morto continuerebbe a girare).
// Store reale su directory temporanea.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setDataDir, db, createAgent, deleteAgent, listAgents, listRoutines,
  createRoutine, getSetting, setSetting, holdOutboxEntry, heldOutboxForAgent,
  appendEntry
} from '../db'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-delagent-'))
  setDataDir(dir)
  db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('deleteAgent: pulizia outbox e trigger.seen (residuo 0c)', () => {
  it('rimuove righe outbox, setting trigger.seen e routine dell\'agente', () => {
    const a = createAgent('Pulito', '')
    const other = createAgent('Altro', '')
    // routine con set dei visti (trigger connector_poll) per entrambi
    const r1 = createRoutine(a.id, 'Poll', 'p', '', { trigger: { type: 'connector_poll', connectorId: 'x', tool: 't', intervalMin: 5, idField: 'items[].id' } })
    const r2 = createRoutine(other.id, 'Poll altro', 'p', '', { trigger: { type: 'connector_poll', connectorId: 'x', tool: 't', intervalMin: 5, idField: 'items[].id' } })
    setSetting(`trigger.seen.${r1.id}`, { ids: ['a'], primed: true })
    setSetting(`trigger.seen.${r2.id}`, { ids: ['b'], primed: true })
    // un messaggio trattenuto in outbox per ciascuno
    const e1 = appendEntry({ agentId: a.id, kind: 'send-message', role: 'assistant', content: 'x' })
    const e2 = appendEntry({ agentId: other.id, kind: 'send-message', role: 'assistant', content: 'y' })
    holdOutboxEntry(e1.id, a.id, e1.createdAt)
    holdOutboxEntry(e2.id, other.id, e2.createdAt)

    deleteAgent(a.id)

    expect(listAgents().map((x) => x.id)).toEqual([other.id])
    // le routine dell'agente muoiono con lui, quelle dell'altro restano
    expect(listRoutines().map((r) => r.id)).toEqual([r2.id])
    // setting trigger.seen: via quello della routine cancellata, resta l'altro
    expect(getSetting(`trigger.seen.${r1.id}`, null)).toBeNull()
    expect(getSetting(`trigger.seen.${r2.id}`, null)).toEqual({ ids: ['b'], primed: true })
    // righe outbox dell'agente rimosse, l'altra resta
    expect(heldOutboxForAgent(a.id)).toEqual([])
    expect(heldOutboxForAgent(other.id).map((o) => o.entry_id)).toEqual([e2.id])
    // directory dati dell'agente rimossa
    expect(existsSync(join(dir, 'agents', a.id))).toBe(false)
  })

  it('cancellare un agente inesistente non tocca nulla', () => {
    expect(() => deleteAgent('agent_manca')).not.toThrow()
    expect(listAgents()).toHaveLength(1)
  })
})

// ---- fase 12 (punto 1): i FIGLI muoiono col padre ----

describe('deleteAgent(padre): ferma ed elimina i sottoagenti', () => {
  it('righe agents/entries/jobs/subagents dei figli eliminate, interrupt chiamato; mai file del box', async () => {
    const { setAgentStopperForDaemon } = await import('../db') as typeof import('../db')
    const { insertSubagent } = await import('../subagents') as typeof import('../subagents')
    const { enqueueJob } = await import('../jobs') as typeof import('../jobs')
    const parent = createAgent('Padre', '')
    const other = createAgent('Altro', '')
    // due figli col registro e la coda
    const child = createAgent('Padre · Ricerca', 'Ricerca', { parentId: parent.id, id: 'sub_del1' })
    createAgent('Padre · Altro', 'Altro', { parentId: parent.id, id: 'sub_del2' })
    insertSubagent(db(), {
      id: 'sub_del1', parentId: parent.id, parentTaskId: null, batchId: 'b1',
      title: 'Ricerca', brief: 'b', deadlineAt: 999, createdAt: 1
    })
    insertSubagent(db(), {
      id: 'sub_del2', parentId: parent.id, parentTaskId: null, batchId: 'b1',
      title: 'Altro', brief: 'b', deadlineAt: 999, createdAt: 1
    })
    appendEntry({ agentId: child.id, kind: 'message', role: 'user', content: 'brief' })
    enqueueJob(db(), { agentId: 'sub_del1', kind: 'subagent-run', payload: { subagentId: 'sub_del1', first: true }, runAt: 1, now: 1 })
    const otherJob = enqueueJob(db(), { agentId: other.id, kind: 'user-message', payload: { text: 'ciao' }, runAt: 1, now: 1 })

    const stopped: string[] = []
    setAgentStopperForDaemon((id) => stopped.push(id))
    deleteAgent(parent.id)
    setAgentStopperForDaemon(null)

    // l'interrupt ha fermato ENTRAMBI i figli (una volta ciascuno)
    expect(stopped.sort()).toEqual(['sub_del1', 'sub_del2'])
    // righe agents dei figli e del padre: via (restano l'ALTRO bot di questo
    // test e quelli dei test precedenti, che condividono lo store)
    const agentsLeft = (db().prepare('SELECT id FROM agents').all() as Array<{ id: string }>).map((r) => r.id)
    expect(agentsLeft).toContain(other.id)
    expect(agentsLeft).not.toContain(parent.id)
    expect(agentsLeft).not.toContain('sub_del1')
    expect(agentsLeft).not.toContain('sub_del2')
    expect((db().prepare('SELECT COUNT(*) AS n FROM subagents').get() as { n: number }).n).toBe(0)
    expect((db().prepare("SELECT COUNT(*) AS n FROM entries WHERE agent_id LIKE 'sub_%'").get() as { n: number }).n).toBe(0)
    // i job dell'ALTRO bot restano
    const jobsLeft = (db().prepare('SELECT id FROM jobs').all() as Array<{ id: number }>).map((r) => r.id)
    expect(jobsLeft).toEqual([otherJob.id])
  })
})

// ---- fase memoria-engramma · correzioni 2 (R2): un bot eliminato non
// lascia il testo dei messaggi nella tabella jobs ----

describe('correzioni 2 R2: deleteAgent cancella TUTTI i job del bot; l\'oblio gira lo stesso', () => {
  it('nessuna riga in jobs col testo; il job memory-forget-agent (accodato DOPO, come la RPC) fa sparire le celle', async () => {
    const e = await import('../../memory/engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: join(dir, 'mem-r2') })).available).toBe(true)
    const { writeMemoryNote } = await import('../../memory/memory-store')
    const { indexStoryNote } = await import('../../memory/history-store')
    const { enqueueJob } = await import('../jobs')

    const bot = createAgent('Sporco di job', '')
    const other = createAgent('Altro R2', '')
    // job FATTI e FALLITI col testo del messaggio (come le versioni prima
    // della R3), più uno in coda: cancelAgentJobs porta via solo i queued
    const done = enqueueJob(db(), { agentId: bot.id, kind: 'user-message', payload: { text: 'TESTO-SEGRETO-R2 done' }, runAt: 1, now: 1 })
    db().prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(done.id)
    const failed = enqueueJob(db(), { agentId: bot.id, kind: 'user-message', payload: { text: 'TESTO-SEGRETO-R2 failed' }, runAt: 1, now: 1 })
    db().prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(failed.id)
    enqueueJob(db(), { agentId: bot.id, kind: 'user-message', payload: { text: 'TESTO-SEGRETO-R2 queued' }, runAt: 1, now: 1 })
    const otherJob = enqueueJob(db(), { agentId: other.id, kind: 'user-message', payload: { text: 'messaggio dell altro bot' }, runAt: 1, now: 1 })

    // memorie e storia del bot: le celle che l'oblio deve far sparire
    await writeMemoryNote(bot.id, { content: 'memoria privata del bot R2', tier: 'core', source: 'test', userTurn: true })
    await indexStoryNote(bot.id, 7, 'user', 'conversazione da dimenticare R2', 1_730_000_000_000)

    deleteAgent(bot.id)

    // in jobs NON resta NESSUNA riga del bot — né col testo, né senza
    expect((db().prepare('SELECT payload_json FROM jobs WHERE agent_id = ?').all(bot.id))).toEqual([])
    const rawAll = JSON.stringify(db().prepare('SELECT payload_json FROM jobs').all())
    expect(rawAll).not.toContain('TESTO-SEGRETO-R2')
    // i job dell'ALTRO bot restano
    expect((db().prepare('SELECT COUNT(*) AS n FROM jobs WHERE id = ?').get(otherJob.id) as { n: number }).n).toBe(1)

    // l'oblio: come agents:delete della RPC — enqueueForgetAgent DOPO la
    // cancellazione (l'ordine che fa sopravvivere il job al DELETE)
    const { enqueueForgetAgent } = e
    const forget = enqueueForgetAgent(db(), bot.id)
    expect(forget.kind).toBe('memory-forget-agent')
    const { makeJobRunner } = await import('../../../daemon/run-job')
    await makeJobRunner(db())(forget, () => undefined)
    const engine = await e.memoryEngine()
    expect(await engine.cells()).toEqual(expect.not.arrayContaining([`bot-${bot.id}`, `storia-${bot.id}`]))
    await e.closeMemoryEngine()
  })
})
