// Test delle RPC di fase 12 (punto 7): subagents:list (payload per la UI, con
// lo stato live dell'agente figlio), subagents:stop (come stop_subagent) e i
// rifiuti degli id di figlio nelle routine. Store reale su temporanea,
// permessi/tool finti come fase8-rpc: niente loop, niente modello.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/loop', () => ({
  interrupt: (id: string) => { interrupted.push(id) },
  interruptTask: () => false,
  resolveApproval: () => undefined
}))
const interrupted = vi.hoisted(() => [] as string[])

const { setDataDir, dataDir, db, createAgent, updateAgent } = await import('../../main/store/db')
const { insertSubagent, getSubagent } = await import('../../main/store/subagents')
const { listJobs } = await import('../../main/store/jobs')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent } from '../../shared/types'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-f12rpc-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

describe('fase 12 (punto 7): RPC subagents:list e subagents:stop', () => {
  it('list torna le righe del padre col payload per la UI e lo stato live del figlio', async () => {
    events = []
    const parent = createAgent('Padre', '')
    const child = createAgent('Padre · Ricerca', 'Ricerca', { parentId: parent.id, id: 'sub_rpc1' })
    insertSubagent(db(), {
      id: child.id, parentId: parent.id, parentTaskId: null, batchId: 'b-rpc',
      title: 'Ricerca', brief: 'b', deadlineAt: 9e15, createdAt: 1000
    })
    // stato live dell'agente figlio: fermo su una card
    updateAgent(child.id, { status: 'paused-for-approval' })
    const rows = (await api['subagents:list']!([parent.id])) as Array<{
      id: string; parentId: string; title: string; status: string; agentStatus: string | null; reportPath: string | null
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'sub_rpc1', parentId: parent.id, title: 'Ricerca', status: 'queued', agentStatus: 'paused-for-approval', reportPath: null
    })
  })

  it('stop interrompe il figlio, cancella i suoi job, chiude stopped e sveglia il lotto', async () => {
    events = []
    interrupted.length = 0
    const parent = createAgent('Padre2', '')
    createAgent('Padre2 · Solo', 'Solo', { parentId: parent.id, id: 'sub_rpc2' })
    insertSubagent(db(), {
      id: 'sub_rpc2', parentId: parent.id, parentTaskId: null, batchId: 'b-rpc2',
      title: 'Solo', brief: 'b', deadlineAt: 9e15, createdAt: 1000
    })
    const { enqueueJob } = await import('../../main/store/jobs')
    enqueueJob(db(), { agentId: 'sub_rpc2', kind: 'subagent-run', payload: {}, runAt: 1, now: 1 })
    const out = (await api['subagents:stop']!(['sub_rpc2'])) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(interrupted).toEqual(['sub_rpc2'])
    expect(getSubagent(db(), 'sub_rpc2')!.status).toBe('stopped')
    // il job in coda del figlio è via e il lotto (un membro) si è svegliato
    expect(listJobs(db()).filter((j) => j.agent_id === 'sub_rpc2')).toEqual([])
    const wake = listJobs(db()).find((j) => (j.payload as { initiator?: string }).initiator === 'SUBAGENTS_DONE')
    expect(wake).toBeTruthy()
    expect(wake!.agent_id).toBe(parent.id)
    // evento di cambio stato per la UI
    expect(events.some((e) => e.type === 'subagents' && e.parentId === parent.id)).toBe(true)
  })

  it('stop di un sottoagente inesistente → errore chiaro', async () => {
    await expect(api['subagents:stop']!(['sub_manca'])).rejects.toThrow('Sottoagente non trovato')
  })
})

describe('fase 12 (punto 1): le routine rifiutano un id di figlio', () => {
  it('routines:create e routines:create-trigger dicono "non è un bot: è un sottoagente di…"', async () => {
    const parent = createAgent('Padre3', '')
    createAgent('Padre3 · NoRoutine', 'x', { parentId: parent.id, id: 'sub_rpc3' })
    // create è SINCRONA (throw diretto), create-trigger è async (rejects)
    expect(() => api['routines:create']!(['sub_rpc3', 'R', 'p', '0 9 * * *']))
      .toThrow('sub_rpc3 non è un bot: è un sottoagente di Padre3')
    await expect(api['routines:create-trigger']!(['sub_rpc3', 'R', 'p', { type: 'schedule', kind: 'cron', cron: '0 9 * * *' }]))
      .rejects.toThrow('non è un bot: è un sottoagente di Padre3')
  })
})
