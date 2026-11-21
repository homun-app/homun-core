// X1 (fase sicurezza-beta16): la GUARDIA CENTRALE — un bot archiviato o
// eliminato non lavora più, da NESSUNA strada:
//  · enqueueUserMessage e la coda (enqueueJob) RIFIUTANO i job per lui (e per
//    i FIGLI di un padre rimosso), con una riga di log;
//  · il worker ANNULLA i job rimasti in coda (il caso del job accodato prima
//    dell'archiviazione, arrivato da una versione precedente o da una insert
//    diretta): runJob non parte mai;
//  · l'eccezione è memory-forget-agent: l'oblio del bot eliminato DEVE girare;
//  · listAgents() lo esclude, listAgentsIncludingRemoved() lo vede (sezione
//    «Archiviati», pulizia dei 30 giorni, ripristino) e agents:list lo torna
//    alla UI;
//  · il ripristino riporta tutto come prima (le routine restano in pausa);
//  · la nota MCP di notifyMcpServerState NON va ai rimossi;
//  · removedAgentRefusal dà il messaggio «questo bot non è disponibile» per
//    gli id rimossi (null per i vivi e per gli id sconosciuti).
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const {
  setDataDir, dataDir, db, createAgent, listAgents, listAgentsIncludingRemoved,
  getAgent, setAgentArchived, setAgentDeleted, removedAgentRefusal
} = await import('../../main/store/db')
const { enqueueJob, listJobs, JOBS_DDL } = await import('../../main/store/jobs')
const { enqueueUserMessage } = await import('../enqueue')
const { JobWorker } = await import('../worker')
const { buildApiMethods, notifyMcpServerState } = await import('../api')
import { TEST_TMP_BASE } from '../../test-tmp'
import type { SandbotEvent } from '../../shared/types'

let dir: string
const emit: (e: SandbotEvent) => void = () => undefined

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-removed-guard-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const userMessageJobsOf = (id: string) =>
  listJobs(db()).filter((j) => j.kind === 'user-message' && j.agent_id === id)

describe('X1: enqueueUserMessage rifiuta i rimossi', () => {
  it('bot eliminato → null, nessun job, nessuna entry scritta', () => {
    const a = createAgent('Eliminato', '')
    setAgentDeleted(a.id, Date.now())
    const before = getAgent(a.id)
    expect(before?.deletedAt).not.toBeNull()
    const job = enqueueUserMessage(db(), a.id, 'ehi', undefined, emit)
    expect(job).toBeNull()
    expect(userMessageJobsOf(a.id)).toHaveLength(0)
  })

  it('bot archiviato → null, nessun job', () => {
    const a = createAgent('Archiviato', '')
    setAgentArchived(a.id, Date.now())
    expect(enqueueUserMessage(db(), a.id, 'ehi', undefined, emit)).toBeNull()
    expect(userMessageJobsOf(a.id)).toHaveLength(0)
  })

  it('il ripristino riporta tutto come prima: il messaggio riparte', () => {
    const a = createAgent('Ripristinato', '')
    setAgentArchived(a.id, Date.now())
    expect(enqueueUserMessage(db(), a.id, 'ehi', undefined, emit)).toBeNull()
    setAgentArchived(a.id, null)
    const job = enqueueUserMessage(db(), a.id, 'ci sono di nuovo', undefined, emit)
    expect(job).not.toBeNull()
    expect(userMessageJobsOf(a.id)).toHaveLength(1)
    // e il ripristino dell'eliminazione pure
    setAgentDeleted(a.id, Date.now())
    expect(enqueueUserMessage(db(), a.id, 'no', undefined, emit)).toBeNull()
    setAgentDeleted(a.id, null)
    expect(enqueueUserMessage(db(), a.id, 'sì', undefined, emit)).not.toBeNull()
  })
})

describe('X1: guardia centrale della coda (enqueueJob)', () => {
  it('routine-run per un bot archiviato → rifiutata (null) con una riga di log', () => {
    const a = createAgent('Routine morte', '')
    setAgentArchived(a.id, Date.now())
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
    try {
      const job = enqueueJob(db(), {
        agentId: a.id, kind: 'routine-run',
        payload: { routineId: 1, title: 't', prompt: 'p' }, runAt: Date.now(), now: Date.now()
      })
      expect(job).toBeNull()
      expect(listJobs(db()).some((j) => j.agent_id === a.id)).toBe(false)
      expect(logs.some((l) => l.includes(a.id))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('il FIGLIO di un padre rimosso segue il padre: il suo job è rifiutato', () => {
    const padre = createAgent('Padre archiviato', '')
    const child = createAgent('Figlio', '', { parentId: padre.id, id: 'sub_x1test' })
    setAgentArchived(padre.id, Date.now())
    expect(enqueueJob(db(), {
      agentId: child.id, kind: 'subagent-run',
      payload: { subagentId: child.id, first: true }, runAt: Date.now(), now: Date.now()
    })).toBeNull()
  })

  it('memory-forget-agent PASSA anche per un bot eliminato (l\'oblio deve girare)', () => {
    const a = createAgent('Da dimenticare', '')
    setAgentDeleted(a.id, Date.now())
    const job = enqueueJob(db(), { agentId: a.id, kind: 'memory-forget-agent', payload: {}, runAt: 1, now: 1 })
    expect(job).not.toBeNull()
  })

  it('senza tabella agents (coda pura dei test) la guardia non decide: il job nasce', () => {
    // il contratto dei test puri della coda (JOBS_DDL da solo) resta com'era
    const mem = new DatabaseSync(':memory:')
    mem.exec(JOBS_DDL)
    const job = enqueueJob(mem, { agentId: 'a_1', kind: 'user-message', payload: { text: 'x' }, runAt: 1, now: 1 })
    expect(job).not.toBeNull()
    mem.close()
  })
})

describe('X1: il worker annulla i job dei rimossi', () => {
  it('un job già in coda per un bot poi archiviato → saltato e annullato, runJob mai chiamato', async () => {
    db().prepare('DELETE FROM jobs').run()
    const a = createAgent('In coda poi archiviato', '')
    // il job resta in coda COME SE fosse stato accodato prima dell'archiviazione
    // (insert diretta: agents:archive cancella i job, qui si simola il residuo)
    db().prepare(
      "INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?, 'queued', 0, ?)"
    ).run(a.id, 'user-message', JSON.stringify({ text: 'restato' }), 1_000, 1_000)
    setAgentArchived(a.id, Date.now())
    const run: string[] = []
    let t = 2_000
    const worker = new JobWorker(db(), {
      now: () => t,
      runJob: async (job) => { run.push(job.agent_id) }
    }, emit)
    worker.poke()
    await worker.drain()
    expect(run).toEqual([])
    expect(listJobs(db()).some((j) => j.agent_id === a.id)).toBe(false)
    // e per un ELIMINATO vale lo stesso
    const b = createAgent('In coda poi eliminato', '')
    db().prepare(
      "INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?, 'queued', 0, ?)"
    ).run(b.id, 'user-message', JSON.stringify({ text: 'restato' }), 1_000, 1_000)
    setAgentDeleted(b.id, Date.now())
    t = 3_000
    worker.poke()
    await worker.drain()
    expect(run).toEqual([])
    expect(listJobs(db()).some((j) => j.agent_id === b.id)).toBe(false)
    // il job di un bot VIVO gira
    const c = createAgent('Vivo', '')
    db().prepare(
      "INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?, 'queued', 0, ?)"
    ).run(c.id, 'user-message', JSON.stringify({ text: 'vado' }), 1_000, 1_000)
    t = 4_000
    worker.poke()
    await worker.drain()
    expect(run).toEqual([c.id])
  })
})

describe('X1: il roster — listAgents esclude, listAgentsIncludingRemoved vede', () => {
  it('listAgents() senza i rimossi; listAgentsIncludingRemoved() li ha', () => {
    const vivo = createAgent('Vivo del roster', '')
    const archiviato = createAgent('Archiviato del roster', '')
    const eliminato = createAgent('Eliminato del roster', '')
    setAgentArchived(archiviato.id, Date.now())
    setAgentDeleted(eliminato.id, Date.now())
    const ids = listAgents().map((a) => a.id)
    expect(ids).toContain(vivo.id)
    expect(ids).not.toContain(archiviato.id)
    expect(ids).not.toContain(eliminato.id)
    const tutti = listAgentsIncludingRemoved().map((a) => a.id)
    expect(tutti).toContain(vivo.id)
    expect(tutti).toContain(archiviato.id)
    expect(tutti).toContain(eliminato.id)
  })

  it('agents:list torna ANCHE i rimossi (la UI della sezione «Archiviati» li cerca lì)', () => {
    const api = buildApiMethods(emit, { poke: () => undefined } as never)
    const archiviato = createAgent('Per la UI', '')
    setAgentArchived(archiviato.id, Date.now())
    const out = api['agents:list']!([]) as Array<{ id: string }>
    expect(out.some((a) => a.id === archiviato.id)).toBe(true)
  })
})

describe('X1: la nota MCP non va ai rimossi', () => {
  it('notifyMcpServerState con enabledFor ["*"]: l\'archiviato NON riceve la nota', async () => {
    const vivo = createAgent('Vivo nota', '')
    const archiviato = createAgent('Archiviato nota', '')
    setAgentArchived(archiviato.id, Date.now())
    db().prepare('DELETE FROM jobs').run()
    await notifyMcpServerState(
      { name: 'orion-moon', enabledFor: ['*'] },
      { ok: true, tools: ['mcp__orion_moon__a'] },
      emit,
      { poke: () => undefined } as never
    )
    expect(userMessageJobsOf(vivo.id)).toHaveLength(1)
    expect(userMessageJobsOf(archiviato.id)).toHaveLength(0)
  })
})

describe('X1: removedAgentRefusal — «questo bot non è disponibile»', () => {
  it('id archiviato o eliminato → il rifiuto col nome; id vivo o sconosciuto → null', () => {
    const vivo = createAgent('Vivo rifiuto', '')
    const archiviato = createAgent('Archiviato rifiuto', '')
    const eliminato = createAgent('Eliminato rifiuto', '')
    setAgentArchived(archiviato.id, Date.now())
    setAgentDeleted(eliminato.id, Date.now())
    expect(removedAgentRefusal(vivo.id)).toBeNull()
    expect(removedAgentRefusal('agent_inesistente')).toBeNull()
    const ra = removedAgentRefusal(archiviato.id)
    expect(ra).toContain('not available')
    expect(ra).toContain(archiviato.id)
    expect(removedAgentRefusal(eliminato.id)).toContain('not available')
  })
})
