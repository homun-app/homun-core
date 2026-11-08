// Fase token (T5): i budget presidiati — caratteri/4, con lo stesso
// assembleTurnTools del loop (e dell'eval, T7). Le costanti stanno in
// turn-tools.ts (TURN_TOKEN_BUDGET, GROUP_TOKEN_BUDGET): MAI alzarle per far
// passare un test; se un budget non si rispetta, va nel REPORT coi numeri.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mode = vi.hoisted(() => ({ v: 'host' as 'host' | 'docker' }))
const browserOk = vi.hoisted(() => ({ v: false }))
vi.mock('../../sandbox', () => ({ sandboxMode: () => mode.v, browserSandboxOk: () => browserOk.v }))

import { toolDefs, computerToolDefs } from '../tools'
import { browserToolDefs } from '../browser'
import { toolsForTurnSource } from '../connectors-policy'
import { subagentToolDenyReason } from '../subagents'
import { systemPrompt, subagentSystemPrompt, withLanguage } from '../prompts'
import { assembleTurnTools, TURN_TOKEN_BUDGET, GROUP_TOKEN_BUDGET, GROUP_TOKEN_BUDGET_DEFAULT } from '../turn-tools'
import type { ToolDef } from '../llm'

const tok = (s: string): number => Math.ceil(s.length / 4)
const toolTok = (t: ToolDef): number => tok(JSON.stringify(t))

const agent = {
  id: 'agent_x', name: 'SandBot', description: 'Ti tieni la posta in ordine.',
  providerId: 'p', model: 'm', status: 'idle' as const, unread: 0, createdAt: 1
}

beforeEach(() => {
  mode.v = 'host'
  browserOk.v = false
})

const userBuiltin = () => toolsForTurnSource(toolDefs, { source: 'user' })
const assemble = (over: Partial<Parameters<typeof assembleTurnTools>[0]> = {}) =>
  assembleTurnTools({
    builtins: userBuiltin(), browserAvailable: false, browserDefs: [],
    mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], ...over
  })

describe('fase token (T5): i budget presidiati', () => {
  // fase token · scoperta (R7): il prompt porta le righe «quando» dei gruppi
  // PRESENTI nel turno (gli id di deferredIndex), come nel loop.
  // fase token · nucleo (R8.2): il bot NORMALE porta anche i punti 1-3 dei
  // subagent (subagents: true, come il loop)
  it('turno base, bot normale senza connettori (prompt con le righe dei gruppi + nucleo + find_tools) ≤ TURN_TOKEN_BUDGET', () => {
    const r = assemble()
    const prompt = withLanguage(systemPrompt(agent, { subagents: true, groups: r.deferredIndex.map((g) => g.id) }), 'it')
    const total = tok(prompt) + r.tools.reduce((n, t) => n + toolTok(t), 0)
    expect(total).toBeLessThanOrEqual(TURN_TOKEN_BUDGET)
  })

  it('turno base con browser disponibile: STESSO numero di tool (il browser è un gruppo) ≤ TURN_TOKEN_BUDGET', () => {
    browserOk.v = true
    const r = assemble({ browserAvailable: true, browserDefs: [...browserToolDefs, ...computerToolDefs] })
    const noBrowser = assemble()
    expect(r.tools).toHaveLength(noBrowser.tools.length)
    // le righe browser del prompt e la riga «quando» del gruppo browser contano
    const prompt = withLanguage(systemPrompt(agent, { subagents: true, groups: r.deferredIndex.map((g) => g.id) }), 'it')
    const total = tok(prompt) + r.tools.reduce((n, t) => n + toolTok(t), 0)
    expect(total).toBeLessThanOrEqual(TURN_TOKEN_BUDGET)
  })

  it('gruppo browser attivato ≤ 900', () => {
    browserOk.v = true
    const r = assemble({ browserAvailable: true, browserDefs: [...browserToolDefs, ...computerToolDefs], activatedGroups: ['browser'] })
    expect(r.tools.some((t) => t.name === 'browser')).toBe(true)
    expect(groupTokensOf(r, 'browser')).toBeLessThanOrEqual(GROUP_TOKEN_BUDGET.browser!)
  })

  it('gruppi documents, tasks, bots ≤ 700 ciascuno', () => {
    for (const id of ['documents', 'tasks', 'bots'] as const) {
      const r = assemble({ activatedGroups: [id] })
      expect(groupTokensOf(r, id)).toBeLessThanOrEqual(GROUP_TOKEN_BUDGET[id]!)
    }
  })

  it('fase token·nucleo (R8.4): il gruppo subagents (check/message/stop, spawn è nel nucleo) ≤ 340', () => {
    const r = assemble({ activatedGroups: ['subagents'] })
    const g = r.deferredIndex.find((x) => x.id === 'subagents')!
    expect(g.tools.map((t) => t.name)).toEqual(['check_subagent', 'message_subagent', 'stop_subagent'])
    expect(groupTokensOf(r, 'subagents')).toBeLessThanOrEqual(GROUP_TOKEN_BUDGET.subagents!)
  })

  it('ogni ALTRO gruppo ≤ 500', () => {
    const ids = r_groups()
    for (const id of ids) {
      if (id in GROUP_TOKEN_BUDGET) continue
      const r = assemble({ ...(id === 'browser' ? { browserAvailable: true, browserDefs: [...browserToolDefs, ...computerToolDefs] } : {}), activatedGroups: [id] })
      expect(groupTokensOf(r, id), id).toBeLessThanOrEqual(GROUP_TOKEN_BUDGET_DEFAULT)
    }
  })
})

/** i token dei tool che il gruppo id ha aggiunto in coda all'elenco */
function groupTokensOf(r: ReturnType<typeof assemble>, id: string): number {
  const g = r.deferredIndex.find((x) => x.id === id)!
  return g.tools.reduce((n, t) => n + toolTok(t), 0)
}

/** l'elenco degli id di gruppo presenti per un bot normale senza browser */
function r_groups(): string[] {
  const r = assemble()
  return r.deferredIndex.map((g) => g.id)
}
