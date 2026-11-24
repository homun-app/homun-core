// AH2 (fase aiutanti): la card del figlio arriva nella CHAT DEL PADRE — è la
// STESSA approvazione (nessuna copia nel DB): subagents:list porta le
// approvazioni PENDING di ogni figlio aperto, lette dal transcript del figlio;
// la decisione emette 'subagents' col parentId, così la card sparisce dalla
// chat del padre e resta nella storia del figlio. Store reale su temporanea.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../test-tmp'
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

const { setDataDir, dataDir, db, createAgent, updateAgent, appendEntry, setSetting } = await import('../../main/store/db')
const { insertSubagent, closeSubagent } = await import('../../main/store/subagents')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent } from '../../shared/types'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

beforeAll(() => {
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-ah2-test-'))
  setDataDir(dir)
  setSetting('ui.activeLanguage', 'it')
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

/** Un figlio aperto col padre, con UNA approval pending nel suo transcript. */
function familyWithPendingApproval(): { parent: string; child: string } {
  const parent = createAgent('Padre', '')
  const child = createAgent('Padre · Ricerca', 'Ricerca', { parentId: parent.id, id: `sub_${Math.random().toString(36).slice(2, 8)}` })
  insertSubagent(db(), {
    id: child.id, parentId: parent.id, parentTaskId: null, batchId: 'b-ah2',
    title: 'Ricerca', brief: 'b'.repeat(220), deadlineAt: 9e15, createdAt: 1000
  })
  updateAgent(child.id, { status: 'paused-for-approval' })
  appendEntry({
    agentId: child.id, kind: 'approval', role: 'system',
    content: 'run-command: run-command requires approval',
    meta: { approvalId: 'ap-ah2', tool: 'run-command', status: 'pending', input: { command: 'echo x' } }
  })
  return { parent: parent.id, child: child.id }
}

describe('AH3: subagents:list porta anche i PASSI del figlio aperto', () => {
  it('le chiamate di strumento nel transcript del figlio si contano (steps cresce)', async () => {
    const { parent, child } = familyWithPendingApproval()
    const before = (await api['subagents:list']!([parent])) as Array<{ steps: number }>
    expect(before[0]!.steps).toBe(0)
    appendEntry({ agentId: child, kind: 'tool-call', role: 'assistant', content: 'run-command', meta: { name: 'run-command', arguments: '{}' } })
    appendEntry({ agentId: child, kind: 'tool-call', role: 'assistant', content: 'web_fetch', meta: { name: 'web_fetch', arguments: '{}' } })
    const after = (await api['subagents:list']!([parent])) as Array<{ steps: number }>
    expect(after[0]!.steps).toBe(2)
  })
})

describe('AH2: subagents:list porta le approvazioni PENDING del figlio aperto', () => {
  it('figlio in paused-for-approval → pendingApprovals contiene la SUA entry (agentId del figlio, stessa approvalId)', async () => {
    const { parent, child } = familyWithPendingApproval()
    const rows = (await api['subagents:list']!([parent])) as Array<{
      id: string
      agentStatus: string | null
      pendingApprovals?: Array<{ agentId: string; kind: string; meta: { approvalId?: string; status?: string } }>
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agentStatus).toBe('paused-for-approval')
    expect(rows[0]!.pendingApprovals).toHaveLength(1)
    const ap = rows[0]!.pendingApprovals![0]!
    expect(ap.agentId).toBe(child)
    expect(ap.kind).toBe('approval')
    expect(ap.meta.approvalId).toBe('ap-ah2')
    expect(ap.meta.status).toBe('pending')
  })

  it('figlio TERMINALE (done) → pendingApprovals vuota: la storia resta nel figlio, la chat del padre non la mostra più', async () => {
    const { parent, child } = familyWithPendingApproval()
    closeSubagent(db(), child, { status: 'done', summary: 'fatto', finishedAt: 2000 })
    const rows = (await api['subagents:list']!([parent])) as Array<{ pendingApprovals?: unknown[] }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pendingApprovals).toEqual([])
  })

  it('approvals:resolve sul FIGLIO emette subagents col parentId (la card del padre si aggiorna senza copie nel DB)', async () => {
    events = []
    const { parent, child } = familyWithPendingApproval()
    api['approvals:resolve']!([child, 'ap-ah2', 'allow', 'once'])
    const subEv = events.find((e) => e.type === 'subagents') as Extract<SandbotEvent, { type: 'subagents' }> | undefined
    expect(subEv).toBeDefined()
    expect(subEv!.parentId).toBe(parent)
    // NESSUNA copia: nel transcript del PADRE non esiste entry con quell'approvalId
    const { getEntries } = await import('../../main/store/db')
    expect(getEntries(parent).some((e) => e.meta?.approvalId === 'ap-ah2')).toBe(false)
  })
})
