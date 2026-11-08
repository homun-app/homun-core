// Fase token · pari (R9.2): le frasi che il diff delle richieste VERE
// (R9.1: prima richiesta dell'eval su 7ceae173 e su fase-token-nucleo) ha
// trovato FUORI dal turno tornano dove servono, e solo lì. Test PURI scritti
// PRIMA dell'implementazione e visti fallire sulla base fase-token-nucleo.
import { describe, expect, it, vi, beforeEach } from 'vitest'

// il prompt base dipende dalla modalità sandbox solo per la sezione computer
const mode = vi.hoisted(() => ({ v: 'host' as 'host' | 'docker' }))
const browserOk = vi.hoisted(() => ({ v: false }))
vi.mock('../../sandbox', () => ({ sandboxMode: () => mode.v, browserSandboxOk: () => browserOk.v }))

import { systemPrompt, subagentSystemPrompt, groupGuides } from '../prompts'
import { toolDefs, computerToolDefs } from '../tools'
import { browserToolDefs } from '../browser'
import { assembleTurnTools, activateGroupsResult, GROUP_ACTIVATION_ACT_NOW } from '../turn-tools'
import { toolsForTurnSource } from '../connectors-policy'
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
const allBrowser = (): ToolDef[] => [...browserToolDefs, ...computerToolDefs]
const assemble = (over: Partial<Parameters<typeof assembleTurnTools>[0]> = {}) => assembleTurnTools({
  builtins: userBuiltin(), browserAvailable: false, browserDefs: [],
  mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], ...over
})

describe('fase token · pari (R9.2, casi 10/11): le guide dei gruppi arrivano col result dell\'attivazione', () => {
  it('find_tools({group:"bots"}) porta la guida: la procedura del team PRIMA, con create_agent e create_group nella prima regola', () => {
    const act = activateGroupsResult(assemble().deferredIndex, [], { group: 'bots' })
    expect(act.text).toContain('# Teams and groups')
    expect(act.text).toContain('# The other bots')
    // dopo le righe dei tool la guida si apre col titolo del team…
    const lines = act.text.split('\n')
    const guideStart = lines.findIndex((l) => !l.startsWith('Group bots is now active:'))
    expect(lines[guideStart]).toBe('# Teams and groups')
    // …e la sua prima regola nomina i due tool per costruire il team
    const firstRule = lines.slice(guideStart).find((l) => l.startsWith('- '))!
    expect(firstRule).toContain('create_agent')
    expect(firstRule).toContain('create_group')
    // la guida sta PRIMA delle righe finali, che restano in coda (R8.3.3)
    expect(act.text.indexOf('# Teams and groups')).toBeLessThan(act.text.indexOf('Call these tools directly by name from the next step.'))
    expect(act.text.trimEnd().endsWith(GROUP_ACTIVATION_ACT_NOW)).toBe(true)
  })

  it('ogni gruppo con una guida la porta nel result (fino a R8 nessuna arrivava: TOOL_GROUPS aveva guide vuote)', () => {
    const r = assemble({ browserAvailable: true, browserDefs: allBrowser() })
    const guides = groupGuides({ takeover: true })
    const withGuide = r.deferredIndex.filter((g) => (guides[g.id] ?? '').trim())
    expect(withGuide.map((g) => g.id).sort()).toEqual(['apps', 'bots', 'connectors', 'credentials', 'documents', 'subagents'])
    for (const g of withGuide) {
      expect(activateGroupsResult(r.deferredIndex, [], { group: g.id }).text, g.id).toContain(guides[g.id]!.trim())
    }
  })

  it('la guida di credentials segue il browser del TURNO (input di assembleTurnTools), non lo stato globale', () => {
    browserOk.v = false
    const withBrowser = assemble({ browserAvailable: true, browserDefs: allBrowser() })
    expect(activateGroupsResult(withBrowser.deferredIndex, [], { group: 'credentials' }).text).toContain('request_takeover')
    browserOk.v = true
    const noBrowser = activateGroupsResult(assemble().deferredIndex, [], { group: 'credentials' }).text
    expect(noBrowser).toContain('request_secure_input')
    expect(noBrowser).not.toContain('request_takeover')
  })

  it('le sezioni delle guide NON tornano nel prompt di base del turno utente (arrivano solo con l\'attivazione)', () => {
    const p = systemPrompt(agent, { subagents: true, groups: assemble().deferredIndex.map((g) => g.id) })
    for (const title of ['# Teams and groups', '# The other bots', '# Connectors and plugins', '# Credentials', '# Documents']) {
      expect(p, title).not.toContain(title)
    }
  })
})

describe('fase token · pari (R9.2, caso 17): la regola del background nel turno privato, e solo lì', () => {
  const RULE = 'tell the user you will report the outcome when it finishes'

  it('il prompt del bot normale la porta accanto a run-command, nella riga dei Base tools', () => {
    const p = systemPrompt(agent, { subagents: true, groups: ['tasks'] })
    expect(p).toContain(RULE)
    const at = p.indexOf(RULE)
    expect(at).toBeGreaterThan(p.indexOf('Base tools: run-command'))
    expect(at).toBeLessThan(p.indexOf('read-file'))
  })

  it('NON nel turno di gruppo (lì si scrive al gruppo), NON nel figlio (consegna al padre), NON nelle descrizioni dei tool (le vedono gruppo e figlio)', () => {
    expect(systemPrompt(agent, { subagents: false, teams: true, groups: ['tasks'] })).not.toContain(RULE)
    expect(subagentSystemPrompt(agent, { id: 'sub_x', title: 'prova' }, ['tasks'])).not.toContain(RULE)
    for (const name of ['run-command', 'await_shell']) {
      expect(toolDefs.find((t) => t.name === name)!.description, name).not.toContain(RULE)
    }
  })
})
