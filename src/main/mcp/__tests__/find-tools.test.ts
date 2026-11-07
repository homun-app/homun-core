// Test PURI dei tool MCP deferiti (fase 13, punto 5): rankTools (BM25
// semplice), gli attivati ricostruiti dal TRANSCRIPT, la sezione "Connettori
// attivi" e serversForAgent (enabledFor, il figlio eredita dal padre).
// Fase token (T2): find_tools cerca e attiva GRUPPI — la descrizione porta
// l'indice dei gruppi (findToolsGroupedDef); il result dell'attivazione e la
// divisione nucleo/gruppi stanno in turn-tools.test.ts. Nessun Electron,
// nessuna rete.
import { describe, expect, it } from 'vitest'
import {
  rankTools, activeToolsFromTranscript, connectorsActiveSection,
  toolsDeferred, findToolsGroupedDef, DEFAULT_MAX_INLINE_TOOLS, FIND_TOOLS_LIMIT
} from '../find-tools'
import { useToolDef } from '../../agent/core-tools'
import { serversForAgent, migrateEnabledFor, type McpServerConfig } from '../index'

const tools = [
  { name: 'mcp__gw__linear_create_issue', description: 'Crea una issue su Linear con titolo e team', requiredParams: ['title'] },
  { name: 'mcp__gw__linear_list_issues', description: 'Elenca le issue di un progetto', requiredParams: [] },
  { name: 'mcp__gw__slack_send_message', description: 'Manda un messaggio su Slack', requiredParams: ['channel'] },
  { name: 'mcp__gw__github_create_pr', description: 'Apre una pull request', requiredParams: ['title'] },
  { name: 'mcp__gw__docs_search', description: 'Cerca nella documentazione', requiredParams: ['query'] },
  ...Array.from({ length: 56 }, (_, i) => ({ name: `mcp__gw__tool_${String(i).padStart(2, '0')}`, description: `strumento generico ${i}` }))
]

describe('rankTools (pura, BM25 semplice)', () => {
  it('la query "issue linear crea" mette linear_create_issue PRIMA (solo i tool che matchano)', () => {
    const ranked = rankTools(tools, 'issue linear crea', 8)
    expect(ranked[0]?.name).toBe('mcp__gw__linear_create_issue')
    // i tool senza corrispondenza NON si attivano (punteggio zero escluso)
    expect(ranked.length).toBe(2)
    expect(ranked.map((t) => t.name)).toEqual(['mcp__gw__linear_create_issue', 'mcp__gw__linear_list_issues'])
  })
  it('i token sono minuscoli e il punteggio pesa nome e parametri oltre alla descrizione', () => {
    const ranked = rankTools(tools, 'SLACK MESSAGE', 8)
    expect(ranked[0]?.name).toBe('mcp__gw__slack_send_message')
  })
  it('a parità di punteggio vince l\'ordine alfabetico; query vuota → alfabetico', () => {
    const flat = rankTools([{ name: 'mcp__x__b' }, { name: 'mcp__x__a' }], '')
    expect(flat.map((t) => t.name)).toEqual(['mcp__x__a', 'mcp__x__b'])
    const pari = rankTools([
      { name: 'mcp__x__b', description: ' Genera un report' },
      { name: 'mcp__x__a', description: ' Genera un report' }
    ], 'report')
    expect(pari.map((t) => t.name)).toEqual(['mcp__x__a', 'mcp__x__b'])
  })
  it('il tetto è FIND_TOOLS_LIMIT (8)', () => {
    expect(FIND_TOOLS_LIMIT).toBe(8)
    expect(rankTools(tools, 'tool').length).toBeLessThanOrEqual(8)
  })
})

describe('soglia e definizione (pura)', () => {
  it('toolsDeferred: sotto la soglia tutto inline, sopra si deferisce', () => {
    expect(DEFAULT_MAX_INLINE_TOOLS).toBe(30)
    expect(toolsDeferred(30, 30)).toBe(false)
    expect(toolsDeferred(31, 30)).toBe(true)
  })
  it('findToolsGroupedDef: l\'indice dei gruppi nella descrizione, parametri query/group facoltativi', () => {
    const def = findToolsGroupedDef(['browser: Open and drive web pages.', 'bots: The other bots and groups.'])
    expect(def.name).toBe('find_tools')
    expect(def.description).toContain('browser: Open and drive web pages.')
    expect(def.description).toContain('bots: The other bots and groups.')
    expect(def.description).toContain('ACTIVATES')
    const params = def.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(params.properties).sort()).toEqual(['group', 'query'])
    expect(params.required).toBeUndefined()
  })
  it('use_tool: nome e argomenti obbligatori, e non può chiamare sé stesso (storie vecchie)', () => {
    expect(useToolDef.name).toBe('use_tool')
    expect(useToolDef.parameters).toHaveProperty('required', ['name', 'arguments'])
    expect(useToolDef.description).toContain('cannot call itself')
  })
})

describe('activeToolsFromTranscript (pura sul transcript, meta.activated legacy)', () => {
  const entries = (activated: string[][]): Array<{ kind: 'tool-call' | 'tool-result'; meta: Record<string, unknown> | null }> =>
    activated.flatMap((names, i) => [
      { kind: 'tool-call', meta: { id: `c${i}`, name: 'find_tools' } },
      { kind: 'tool-result', meta: { callId: `c${i}`, activated: names } }
    ])

  it('gli attivati coi find_tools della conversazione, in ordine, senza duplicati', () => {
    expect(activeToolsFromTranscript(entries([['a', 'b'], ['b', 'c']]))).toEqual(['a', 'b', 'c'])
  })
  it('si tengono gli ULTIMI 20 (ActiveToolsMemory)', () => {
    const many = Array.from({ length: 30 }, (_, i) => [`t${i}`])
    expect(activeToolsFromTranscript(entries(many))).toHaveLength(20)
    expect(activeToolsFromTranscript(entries(many))[0]).toBe('t10')
  })
  it('i tool-result senza activated non contano', () => {
    expect(activeToolsFromTranscript([{ kind: 'tool-result', meta: { callId: 'x' } }])).toEqual([])
  })
})

describe('connectorsActiveSection (pura)', () => {
  it('una riga per server: nome, numero di tool, descrizione di 80 caratteri', () => {
    const s = connectorsActiveSection([
      { name: 'gw', toolCount: 60, description: 'Gateway con tante app: ' + 'x'.repeat(200) },
      { name: 'notion', toolCount: 12, description: 'Legge e aggiorna il workspace Notion' }
    ])
    expect(s).toContain('# Active connectors')
    expect(s).toContain('- gw: 60 tools')
    expect(s).toContain('- notion: 12 tools — Legge e aggiorna il workspace Notion')
    expect(s).toContain('find_tools')
    // la descrizione è troncata a 80
    const gwLine = s.split('\n').find((l) => l.startsWith('- gw'))!
    expect(gwLine.length).toBeLessThanOrEqual('- gw: 60 tools — '.length + 81)
  })
  it('vuota senza server', () => {
    expect(connectorsActiveSection([])).toBe('')
  })
})

// ---- serversForAgent / migrazione enabledFor ----

const server = (id: string, enabledFor?: string[]): McpServerConfig =>
  ({ id, name: id, transport: 'http', url: 'https://x.example/mcp', enabled: true, ...(enabledFor ? { enabledFor } : {}) })

describe('serversForAgent (pura, punto 5)', () => {
  const servers = [server('s-tutti', ['*']), server('s-alice', ['agent_alice']), server('s-padre', ['agent_bob'])]
  it("'*' vale per tutti; il server nuovo solo per il bot che l'ha proposto", () => {
    const ids = serversForAgent(servers, 'agent_alice').map((s) => s.id)
    expect(ids).toEqual(['s-tutti', 's-alice'])
    expect(serversForAgent(servers, 'agent_carl').map((s) => s.id)).toEqual(['s-tutti'])
  })
  it('il FIGLIO eredita dal padre (parentId)', () => {
    expect(serversForAgent(servers, 'sub_x', 'agent_bob').map((s) => s.id)).toEqual(['s-tutti', 's-padre'])
  })
  it('senza enabledFor (server pre-migrazione) vale per tutti', () => {
    expect(serversForAgent([server('vecchio')], 'chiunque').map((s) => s.id)).toEqual(['vecchio'])
  })
})

describe('migrateEnabledFor (pura)', () => {
  it('i server esistenti restano abilitati per tutti; i nuovi non si toccano', () => {
    const { servers, changed } = migrateEnabledFor([server('vecchio1'), server('vecchio2'), server('nuovo', ['agent_a'])])
    expect(changed).toBe(true)
    expect(servers.find((s) => s.id === 'vecchio1')?.enabledFor).toEqual(['*'])
    expect(servers.find((s) => s.id === 'nuovo')?.enabledFor).toEqual(['agent_a'])
  })
  it('idempotente: già migrati → changed false', () => {
    expect(migrateEnabledFor([server('a', ['*'])]).changed).toBe(false)
  })
})
