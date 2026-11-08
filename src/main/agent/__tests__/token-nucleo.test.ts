// Fase token · nucleo (R8): i comportamenti che non possono stare dietro una
// scoperta — la regola dei documenti nel prompt di base (accanto ai tool del
// nucleo), spawn_subagent nel nucleo del bot normale con i punti 1-3 della
// guida, il result dei tool che porta l'istruzione al momento giusto. Test
// PURI scritti PRIMA dell'implementazione e visti fallire sulla base
// fase-token-scoperta.
import { describe, expect, it, vi, beforeEach } from 'vitest'

// il prompt base dipende dalla modalità sandbox solo per la sezione computer
const mode = vi.hoisted(() => ({ v: 'host' as 'host' | 'docker' }))
const browserOk = vi.hoisted(() => ({ v: false }))
vi.mock('../../sandbox', () => ({ sandboxMode: () => mode.v, browserSandboxOk: () => browserOk.v }))

import {
  systemPrompt, subagentSystemPrompt, GROUP_WHEN, documentsPart, documentRule,
  subagentsCoreSection, subagentsSection, groupGuides
} from '../prompts'
import { toolDefs } from '../tools'
import { TOOL_GROUPS } from '../core-tools'
import { assembleTurnTools, activateGroupsResult, GROUP_ACTIVATION_ACT_NOW } from '../turn-tools'
import { toolsForTurnSource } from '../connectors-policy'
import { subagentToolDenyReason } from '../subagents'
import type { ToolDef } from '../llm'
import type { Agent } from '../../../shared/types'

const agent: Agent = {
  id: 'agent_x', name: 'SandBot', description: 'Ti tieni la posta in ordine.',
  providerId: 'p', model: 'm', status: 'idle', unread: 0, createdAt: 1
}

beforeEach(() => {
  mode.v = 'host'
  browserOk.v = false
})

const userBuiltin = () => toolsForTurnSource(toolDefs, { source: 'user' })
const groupBuiltin = () => toolsForTurnSource(toolDefs, { source: 'group', groupTurn: {} })
const childBuiltin = () => toolsForTurnSource(
  toolDefs.filter((t) => subagentToolDenyReason(t.name) === null),
  { source: 'user', subagent: true }
)
const assemble = (
  builtins: ToolDef[],
  over: Partial<Parameters<typeof assembleTurnTools>[0]> = {}
) => assembleTurnTools({
  builtins, browserAvailable: false, browserDefs: [],
  mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], ...over
})

/** i punti 1-3 di subagentsSection, PAROLA PER PAROLA (R8.2.2) */
const SUBAGENT_POINTS_1_3 = [
  '- For INDEPENDENT pieces of work in parallel (several searches, comparisons, multiple sources): spawn_subagent, ALL in the same turn (usually 2-4). Research on several named items (frameworks, products, cities…) = ONE subagent per item, no extra cross-cutting branch: each brief covers its item fully. Not for what you solve in 1-3 calls: do that yourself.',
  '- Each brief is self-contained: goal, boundaries ("do not search for X: another subagent does that"), result format, where to save; the subagent does not see this conversation.',
  '- Once you delegate, you do not research yourself (no web_search, web_fetch or run-command/curl on the same topic): the subagents do it.'
] as const

describe('fase token·nucleo (R8.1): la regola dei documenti va dove sta il tool', () => {
  it('il prompt del bot normale contiene la regola del documento (primo punto + riga degli indici), dentro la sezione del computer', () => {
    const p = systemPrompt(agent, { subagents: true, groups: ['documents', 'tasks'] })
    expect(p).toContain('A report, a plan or a long text goes in write_document (the document tool), NOT in the message')
    expect(p).toContain('one or two sentences about what you did (the card already shows the document), without a bullet-point summary')
    expect(p).toContain('The user reads the document as a page with an index built from the ##/### headings: organize long documents with them.')
    // accanto a computerSection: dopo il titolo della sezione, prima della successiva
    expect(p.indexOf('A report, a plan or a long text')).toBeGreaterThan(p.indexOf('# Your computer'))
    expect(p.indexOf('A report, a plan or a long text')).toBeLessThan(p.indexOf('# How you talk'))
  })

  it('il prompt del turno di GRUPPO contiene la regola (document è nel nucleo anche lì)', () => {
    const p = systemPrompt(agent, { subagents: false, teams: true, groups: ['documents'] })
    expect(p).toContain('A report, a plan or a long text goes in write_document')
    expect(p).toContain('##/### headings')
  })

  it('la guida del gruppo documents NON la ripete: restano solo charts, save_to_library e save_contact', () => {
    const guide = groupGuides().documents
    expect(guide).not.toContain('A report, a plan or a long text')
    expect(guide).not.toContain('##/###')
    expect(documentsPart()).toContain('visualize')
    expect(documentsPart()).toContain('save_to_library')
    expect(documentsPart()).toContain('save_contact')
    expect(documentsPart()).not.toContain('write_document')
  })

  it('la regola esce una volta sola: documentRule la incarna per il prompt e per il figlio', () => {
    const rule = documentRule()
    expect(rule).toContain('A report, a plan or a long text goes in write_document')
    expect(rule).toContain('##/### headings')
    // il figlio la ha (come il bot normale): il costruttore la include
    const child = subagentSystemPrompt(agent, { id: 'sub_x', title: 'prova' })
    expect(child).toContain('A report, a plan or a long text goes in write_document')
    expect(child).toContain('##/### headings')
  })
})

describe('fase token·nucleo (R8.2): spawn_subagent nel nucleo del bot normale', () => {
  it('il nucleo del bot normale contiene spawn_subagent, dopo skill e prima di find_tools', () => {
    const names = assemble(userBuiltin()).tools.map((t) => t.name)
    expect(names).toContain('spawn_subagent')
    expect(names.indexOf('spawn_subagent')).toBeGreaterThan(names.indexOf('skill'))
    expect(names.indexOf('spawn_subagent')).toBeLessThan(names.indexOf('find_tools'))
  })

  it('il nucleo del turno di GRUPPO NON contiene spawn_subagent (lì si coordina col gruppo)', () => {
    const names = assemble(groupBuiltin(), { groupTurn: {} }).tools.map((t) => t.name)
    expect(names).not.toContain('spawn_subagent')
  })

  it('il nucleo del FIGLIO NON contiene spawn_subagent (la whitelist non cambia)', () => {
    const names = assemble(childBuiltin(), { subagent: true }).tools.map((t) => t.name)
    expect(names).not.toContain('spawn_subagent')
    expect(subagentToolDenyReason('spawn_subagent')).toBeTruthy()
  })

  it('il gruppo subagents contiene ormai solo check, message e stop', () => {
    for (const builtins of [userBuiltin(), groupBuiltin()]) {
      const g = assemble(builtins, builtins === groupBuiltin() ? { groupTurn: {} } : {}).deferredIndex.find((x) => x.id === 'subagents')!
      expect(g.tools.map((t) => t.name)).toEqual(['check_subagent', 'message_subagent', 'stop_subagent'])
    }
    expect(TOOL_GROUPS.find((g) => g.id === 'subagents')!.tools).toEqual(['check_subagent', 'message_subagent', 'stop_subagent'])
  })

  it('i punti 1-3 dei subagent sono nel prompt del bot normale, PAROLA PER PAROLA', () => {
    const p = systemPrompt(agent, { subagents: true, groups: ['tasks'] })
    for (const line of SUBAGENT_POINTS_1_3) expect(p).toContain(line)
    expect(p).toContain('# Subagents')
    expect(p.indexOf('# Subagents')).toBeGreaterThan(p.indexOf('# Long work'))
  })

  it('i punti 1-3 NON sono nel prompt di gruppo né in quello del figlio', () => {
    const group = systemPrompt(agent, { subagents: false, teams: true, groups: ['tasks'] })
    expect(group).not.toContain('# Subagents')
    for (const line of SUBAGENT_POINTS_1_3) expect(group).not.toContain(line)
    const child = subagentSystemPrompt(agent, { id: 'sub_x', title: 'prova' }, ['tasks'])
    expect(child).not.toContain('For INDEPENDENT pieces of work')
    expect(child).not.toContain('spawn_subagent')
  })

  it('i punti 4-5 restano nella guida del gruppo, senza duplicare i punti 1-3', () => {
    const guide = subagentsSection()
    expect(guide).toContain('Afterwards: at most ONE line to the user (message_user or the final text, not both); results arrive together: ONE SINGLE report, no waiting in a loop.')
    expect(guide).toContain('A task is LONG serial work outside the chat; subagents are PARALLEL pieces (and a task can spawn them).')
    expect(guide).not.toContain('For INDEPENDENT pieces of work')
    expect(groupGuides().subagents).toBe(guide)
    // e la sezione del nucleo è SOLO punti 1-3
    const core = subagentsCoreSection()
    for (const line of SUBAGENT_POINTS_1_3) expect(core).toContain(line)
    expect(core).not.toContain('Afterwards:')
  })

  it('la riga «quando» di subagents diventa quella dei tre tool rimasti', () => {
    expect(GROUP_WHEN.subagents).toBe('check, message or stop the subagents you started')
  })
})

describe('fase token·nucleo (R8.3.3): il result dell\'attivazione di un gruppo', () => {
  it('find_tools({group}) termina con «Now call the tool you need; do not announce it.» (e la riga di meccanica resta)', () => {
    const catalog = assemble(userBuiltin()).deferredIndex
    const act = activateGroupsResult(catalog, [], { group: 'tasks' })
    expect(act.activated).toEqual(['tasks'])
    expect(act.text).toContain('Call these tools directly by name from the next step.')
    expect(act.text.trimEnd().endsWith(GROUP_ACTIVATION_ACT_NOW)).toBe(true)
  })

  it('la riga è quella della spec, parola per parola', () => {
    expect(GROUP_ACTIVATION_ACT_NOW).toBe('Now call the tool you need; do not announce it.')
  })
})
