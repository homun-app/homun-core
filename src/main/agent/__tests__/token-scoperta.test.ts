// Fase token · scoperta (R7): la scoperta dei gruppi — una riga «quando» per
// gruppo nel prompt di base, document nel nucleo, le regole che solo la
// descrizione può dare, i budget nuovi. Test PURI scritti PRIMA
// dell'implementazione e visti fallire sulla base fase-token-ritocchi.
import { describe, expect, it, vi, beforeEach } from 'vitest'

// il prompt base dipende dalla modalità sandbox solo per la sezione computer
const mode = vi.hoisted(() => ({ v: 'host' as 'host' | 'docker' }))
const browserOk = vi.hoisted(() => ({ v: false }))
vi.mock('../../sandbox', () => ({ sandboxMode: () => mode.v, browserSandboxOk: () => browserOk.v }))

import {
  systemPrompt, subagentSystemPrompt, withLanguage, PROMPT_TOKEN_BUDGET,
  GROUP_WHEN, groupWhenLine
} from '../prompts'
import { toolDefs } from '../tools'
import { TOOL_GROUPS } from '../core-tools'
import { assembleTurnTools, TURN_TOKEN_BUDGET } from '../turn-tools'
import { toolsForTurnSource } from '../connectors-policy'
import { buildFacadeDef, expandFacadeCall } from '../facades'
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
const assembleUser = (over: Partial<Parameters<typeof assembleTurnTools>[0]> = {}) =>
  assembleTurnTools({
    builtins: userBuiltin(), browserAvailable: false, browserDefs: [],
    mcpToolDefs: [], maxInlineTools: 30, activatedGroups: [], ...over
  })
const tok = (s: string): number => Math.ceil(s.length / 4)
const toolTok = (t: ToolDef): number => tok(JSON.stringify(t))

describe('fase token·scoperta (R7.1): una riga «quando» per gruppo nel prompt di base', () => {
  it('GROUP_WHEN ha un testo per OGNI gruppo builtin e ogni riga `- id: quando` è ≤ 110 caratteri', () => {
    for (const g of TOOL_GROUPS) {
      expect(GROUP_WHEN[g.id], `manca il «quando» del gruppo ${g.id}`).toBeTruthy()
      const line = groupWhenLine(g.id)
      expect(line.startsWith(`- ${g.id}: `), line).toBe(true)
      expect(line.length, `${g.id}: ${line}`).toBeLessThanOrEqual(110)
    }
  })

  it('i testi della spec per i nove gruppi indicati (parola per parola; connectors senza il «the» iniziale; subagents cambia in R8.2)', () => {
    // fase token · nucleo (R8.2.3): spawn_subagent è nel nucleo, il gruppo
    // restano check/message/stop — la riga dice quelli
    expect(GROUP_WHEN.subagents).toBe('check, message or stop the subagents you started')
    // la riga della spec con «the» misura 114 caratteri, oltre il tetto di 110
    // della spec stessa (visto da questo file): tolto SOLO l'articolo
    expect(GROUP_WHEN.connectors).toBe('user wants a service, app or documentation "inside" you → search connectors, never a key in chat')
    expect(GROUP_WHEN.apps).toBe('guide the user on a website or app they use with an account → open it with use-app')
    expect(GROUP_WHEN.browser).toBe('act on a web page (click, fill, log in); reading only → web_fetch')
    expect(GROUP_WHEN.credentials).toBe('a login is needed → saved logins, secure input, or hand over to the user')
    expect(GROUP_WHEN.tasks).toBe('routines, reminders, long background work')
    expect(GROUP_WHEN.bots).toBe('other bots, teams and groups')
    expect(GROUP_WHEN.outside).toBe('send email or messages to other people (always as a draft)')
    expect(GROUP_WHEN.admin).toBe('save a procedure as a skill, permission rules, files with the Mac')
  })

  it('systemPrompt mette le righe dei gruppi PRESENTI nel turno, non quelle degli assenti', () => {
    const p = systemPrompt(agent, { groups: ['subagents', 'tasks', 'bots'] })
    // fase token · nucleo (R8.2.3): la riga nuova di subagents
    expect(p).toContain('- subagents: check, message or stop the subagents you started')
    expect(p).toContain('- tasks: routines, reminders, long background work')
    expect(p).toContain('- bots: other bots, teams and groups')
    expect(p).not.toContain('- browser:')
    expect(p).not.toContain('- connectors:')
    expect(p).not.toContain('- admin:')
  })

  it('la riga dice anche che chiamare per nome un tool di un gruppo lo attiva', () => {
    const p = systemPrompt(agent, { groups: ['tasks'] })
    expect(p).toMatch(/by name[^.]*activat/)
  })

  it('senza gruppi non c\'è nessuna riga (nemmeno find_tools esisterebbe)', () => {
    const p = systemPrompt(agent, { groups: [] })
    expect(p).not.toContain('find_tools({group:')
  })

  it('il figlio riceve le righe dei SUOI gruppi (tasks sì, browser e subagents no)', () => {
    const p = subagentSystemPrompt(agent, { id: 'sub_x', title: 'prova' }, ['tasks'])
    expect(p).toContain('- tasks: routines, reminders, long background work')
    expect(p).not.toContain('- browser:')
    expect(p).not.toContain('- subagents:')
  })

  it('i gruppi mcp:<server> hanno una riga generica ≤ 110 caratteri', () => {
    const line = groupWhenLine('mcp:gw')
    expect(line).toContain('gw')
    expect(line).toContain('- mcp:gw: ')
    expect(line.length).toBeLessThanOrEqual(110)
  })
})

describe('fase token·scoperta (R7.2): document passa nel nucleo', () => {
  it('il nucleo del bot normale contiene la facciata document, tra memory e skill', () => {
    const names = assembleUser().tools.map((t) => t.name)
    expect(names).toContain('document')
    expect(names.indexOf('document')).toBeGreaterThan(names.indexOf('memory'))
    expect(names.indexOf('document')).toBeLessThan(names.indexOf('skill'))
  })

  it('document srotola in write_document (expandFacadeCall, puro)', () => {
    const schemaOf = (n: string): Pick<ToolDef, 'name' | 'parameters'> | null =>
      toolDefs.find((t) => t.name === n) ?? null
    const r = expandFacadeCall(
      { name: 'document', arguments: JSON.stringify({ action: 'write', title: 'T', content: 'C' }) },
      schemaOf
    )
    expect(r).toMatchObject({ ok: true, name: 'write_document' })
  })

  it('il gruppo documents resta per charts e libreria, SENZA la facciata document', () => {
    const g = assembleUser().deferredIndex.find((x) => x.id === 'documents')!
    expect(g.tools.map((t) => t.name).sort())
      .toEqual(['export_from_library', 'list_library', 'save_to_library', 'visualize'])
  })

  it('la descrizione della facciata document porta la regola della spec (testo non in chat, messaggio breve)', () => {
    const byName = new Map(toolDefs.map((t) => [t.name, t] as const))
    const def = buildFacadeDef('document', [
      byName.get('write_document')!, byName.get('read_document')!, byName.get('edit_document')!
    ])!
    expect(def.description).toContain('not in chat')
    expect(def.description).toContain('short message')
    // le righe delle azioni restano
    expect(def.description).toContain('write:')
    expect(def.description).toContain('edit:')
  })

  it('write_document (interno) dice che il testo non va in chat', () => {
    expect(toolDefs.find((t) => t.name === 'write_document')!.description).toContain('NOT in chat')
  })
})

describe('fase token·scoperta (R7.3): le regole che solo la descrizione può dare', () => {
  it('update_skill: la DESCRIZIONE contiene la regola del «QUANDO usarla» (caso 44)', () => {
    const d = toolDefs.find((t) => t.name === 'update_skill')!.description
    expect(d).toMatch(/WHEN to use/i)
  })

  it('il parametro description di update_skill dice «what it does AND when» (regola storica mai tolta: resta)', () => {
    const p = toolDefs.find((t) => t.name === 'update_skill')!.parameters as {
      properties: Record<string, { description?: string }>
    }
    expect(p.properties.description!.description).toContain('what it does AND when')
  })
})

describe('fase token·scoperta (R7.5): i budget nuovi (valori aggiornati da R8.4 e da R9.4)', () => {
  it('TURN_TOKEN_BUDGET e PROMPT_TOKEN_BUDGET (R9.4: misurato + 60, dentro i tetti 5000/2400)', () => {
    // R9.4: 4558 misurati (la prima richiesta del caso 3 dell'eval, T7) + 60
    expect(TURN_TOKEN_BUDGET).toBe(4618)
    expect(PROMPT_TOKEN_BUDGET).toBe(2046)
    expect(TURN_TOKEN_BUDGET).toBeLessThanOrEqual(5000)
    expect(PROMPT_TOKEN_BUDGET).toBeLessThanOrEqual(2400)
  })

  it('il turno base (prompt con le righe dei gruppi + nucleo con document e spawn_subagent + find_tools) ≤ TURN_TOKEN_BUDGET', () => {
    const r = assembleUser()
    // R8.2: il prompt del bot NORMALE porta i punti 1-3 (subagents: true)
    const prompt = withLanguage(systemPrompt(agent, { subagents: true, groups: r.deferredIndex.map((g) => g.id) }), 'it')
    const total = tok(prompt) + r.tools.reduce((n, t) => n + toolTok(t), 0)
    expect(total, `totale ${total}`).toBeLessThanOrEqual(TURN_TOKEN_BUDGET)
  })

  it('il prompt di base con TUTTI i gruppi (senza browser) ≤ PROMPT_TOKEN_BUDGET', () => {
    const ids = TOOL_GROUPS.map((g) => g.id).filter((id) => id !== 'browser')
    const p = systemPrompt(agent, { subagents: true, groups: ids })
    expect(p.length / 4, `${p.length / 4} token`).toBeLessThanOrEqual(PROMPT_TOKEN_BUDGET)
  })
})
