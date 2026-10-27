// Test delle RPC di fase 8: la decisione sulla regola di auto-review proposta
// dal bot (si salva SOLO al click) e i task thread (list/cancel). Store reale
// su directory temporanea, permessi e tool finti come in draft-actions.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  tools: { calls: [] as Array<{ tool: string; args: Record<string, unknown> }> }
}))

vi.mock('../../main/agent/permissions', () => ({
  check: async () => ({ kind: 'allow', via: 'rule' }),
  grantStanding: async () => undefined,
  targetKey: (tool: string) => tool
}))

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async (_agentId: string, tool: string, args: Record<string, unknown>) => {
    h.tools.calls.push({ tool, args })
    return { output: 'ok', meta: {} }
  }
}))

const {
  setDataDir, dataDir, db, getEntries, appendEntry, getSetting,
  createTask, getTask, listTasks, updateTask, openTasksOf, MAX_OPEN_TASKS
} = await import('../../main/store/db')
const { enqueueJob, listJobs } = await import('../../main/store/jobs')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent, TranscriptEntry, AutoReviewSettings } from '../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../shared/types'

const AGENT = 'agent_f8'
let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-fase8-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

/** Una proposta di regola nel transcript, come la crea propose_rule_change. */
function mkRuleProposal(kind: 'allow' | 'block', text: string): TranscriptEntry {
  return appendEntry({
    agentId: AGENT, kind: 'send-message', role: 'assistant', content: text,
    meta: { message: { type: 'rule', kind, text, why: 'perché' } }
  })
}

beforeEach(() => {
  events = []
  db().exec('DELETE FROM entries')
  db().exec('DELETE FROM tasks')
  db().exec('DELETE FROM jobs')
  db().exec("DELETE FROM settings WHERE key = 'autoReview'")
})

describe('autoreview:rule-decision — la regola si salva SOLO al click', () => {
  it('"Aggiungi regola" scrive la regola nei settings e chiude la card', () => {
    const p = mkRuleProposal('allow', 'comandi git dentro la cartella del progetto')
    api['autoreview:rule-decision']!([AGENT, p.id, 'add'])
    const cfg = getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW)
    expect(cfg.allowRules).toContain('comandi git dentro la cartella del progetto')
    expect(getEntries(AGENT).find((e) => e.id === p.id)?.meta?.ruleStatus).toBe('added')
    // la proposta era apparsa in chat: l'entry aggiornata è stata emessa
    expect(events.some((e) => e.type === 'entries')).toBe(true)
  })

  it('kind block finisce nella lista "fermati e chiedimi sempre"', () => {
    const p = mkRuleProposal('block', 'scrivere fuori dalla home del bot')
    api['autoreview:rule-decision']!([AGENT, p.id, 'add'])
    expect(getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).blockRules).toContain('scrivere fuori dalla home del bot')
  })

  it('"Ignora" non tocca i settings; la proposta già gestita non si clicca due volte', () => {
    const p1 = mkRuleProposal('allow', 'leggere le email di lavoro')
    api['autoreview:rule-decision']!([AGENT, p1.id, 'dismiss'])
    expect(getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).allowRules).toEqual([])
    expect(getEntries(AGENT).find((e) => e.id === p1.id)?.meta?.ruleStatus).toBe('dismissed')
    // secondo click sulla stessa proposta: rifiutato
    expect(() => api['autoreview:rule-decision']!([AGENT, p1.id, 'add'])).toThrow()
    expect(getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).allowRules).toEqual([])
  })

  it('lo stesso testo non si duplica nella lista', () => {
    const a = mkRuleProposal('allow', 'comandi ls dentro il box')
    const b = mkRuleProposal('allow', 'comandi ls dentro il box')
    api['autoreview:rule-decision']!([AGENT, a.id, 'add'])
    api['autoreview:rule-decision']!([AGENT, b.id, 'add'])
    expect(getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).allowRules).toEqual(['comandi ls dentro il box'])
  })
})

describe('tasks:list / tasks:cancel (§3bis L7)', () => {
  it('list ritorna i task (tutti o per agente), cancel chiude e toglie i job in coda', () => {
    const t1 = createTask(AGENT, 'Ricerca documenti')
    createTask('agent_altro', 'Altro lavoro')
    expect((api['tasks:list']!([undefined]) as Array<{ id: number }>).map((t) => t.id).sort((a, b) => a - b))
      .toEqual([t1.id, t1.id + 1].sort((a, b) => a - b))
    expect((api['tasks:list']!([AGENT]) as Array<{ id: number; status: string }>)).toEqual([
      { id: t1.id, agentId: AGENT, title: 'Ricerca documenti', status: 'working', createdAt: t1.created_at, updatedAt: expect.any(Number), summary: null }
    ])

    // un task-run in coda per t1: l'interruzione dell'utente lo toglie
    const now = Date.now()
    enqueueJob(db(), { agentId: AGENT, kind: 'task-run', payload: { taskId: t1.id, brief: 'b' }, runAt: now, now })
    api['tasks:cancel']!([t1.id])
    expect(getTask(t1.id)?.status).toBe('cancelled')
    const jobs = listJobs(db())
    expect(jobs.filter((j) => j.kind === 'task-run')).toEqual([])
    expect(events.some((e) => e.type === 'tasks')).toBe(true)

    // cancel su un task già chiuso: no-op senza errori
    expect(api['tasks:cancel']!([t1.id])).toEqual({ ok: true })
  })

  it('i task chiusi (done/failed/cancelled) non riaprono', () => {
    const t = createTask(AGENT, 'Analisi')
    updateTask(t.id, { status: 'done', summary: 'fatto' })
    updateTask(t.id, { status: 'working' })
    expect(getTask(t.id)?.status).toBe('done')
    expect(listTasks(AGENT)).toHaveLength(1)
  })
})

describe('correzioni B1/B2: origine del task e task aperti (store reale)', () => {
  it('createTask salva l\'origine del turno sulla riga (untrusted/automatic)', () => {
    const t = createTask(AGENT, 'Analisi posta', { untrusted: true, automatic: true })
    expect(getTask(t.id)).toMatchObject({ title: 'Analisi posta', untrusted: 1, automatic: 1 })
    // default: turno utente ordinario
    const t2 = createTask(AGENT, 'Verifica')
    expect(getTask(t2.id)).toMatchObject({ untrusted: 0, automatic: 0 })
  })

  it('openTasksOf conta solo working/needs_input; MAX_OPEN_TASKS è 5', () => {
    expect(MAX_OPEN_TASKS).toBe(5)
    const ts = [createTask(AGENT, 'T1'), createTask(AGENT, 'T2'), createTask(AGENT, 'T3'), createTask(AGENT, 'In attesa')]
    expect(openTasksOf(AGENT)).toBe(4)
    updateTask(ts[1]!.id, { status: 'needs_input' })
    expect(openTasksOf(AGENT)).toBe(4) // needs_input resta aperto
    updateTask(ts[2]!.id, { status: 'done', summary: 'x' })
    expect(openTasksOf(AGENT)).toBe(3)
    // i task di altri agenti non contano
    createTask('agent_altro', 'Altro')
    expect(openTasksOf(AGENT)).toBe(3)
  })
})
