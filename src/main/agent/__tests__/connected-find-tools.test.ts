// Fase chat-limiti (CL6): collegare un'app e poi TROVARNE gli strumenti.
// Il messaggio dopo un collegamento Composio dice find_tools: la strada deve
// FUNZIONARE — find_tools({query: <nome o slug dell'app collegata>}) trova e
// attiva gli strumenti dell'app (composio__<slug>__* nel flusso SDK, i proxy
// mcp__composio__* nel flusso gateway). Come: le app collegate entrano nel
// TESTO CERCABILE del gruppo del connettore, dentro il catalogo di find_tools.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assembleTurnTools, activateGroupsResult } from '../turn-tools'
import { mcpGroupAppsForAgent } from '../../mcp'
import type { ToolDef } from '../llm'

const tool = (name: string, description = 'Composio tool of the gateway server'): ToolDef => ({
  name,
  description,
  parameters: { type: 'object', properties: {}, required: [] }
})

/** i proxy del server «Composio For You» (flusso gateway: era il caso della beta.5) */
const GATEWAY_DEFS: ToolDef[] = [
  tool('mcp__composio__COMPOSIO_SEARCH_TOOLS', 'Search and run Composio app actions'),
  tool('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', 'Execute several Composio actions')
]

/** i tool del flusso SDK diretto (fase app) */
const SDK_DEFS: ToolDef[] = [
  tool('composio__gmail__GMAIL_FETCH_THREADS', 'Fetch Gmail threads'),
  tool('composio__gmail__GMAIL_SEND_EMAIL', 'Send an email with Gmail')
]

const assemble = (mcpToolDefs: ToolDef[], over: Record<string, unknown> = {}) =>
  assembleTurnTools({
    builtins: [], browserAvailable: false, browserDefs: [],
    mcpToolDefs, maxInlineTools: 1, activatedGroups: [],
    ...over
  } as Parameters<typeof assembleTurnTools>[0])

describe('CL6: find_tools col NOME dell\'app collegata trova i suoi strumenti', () => {
  it('collegamento (finto) di gmail via GATEWAY: find_tools({query:"gmail"}) attiva il gruppo e restituisce i suoi strumenti (oggi «No tool groups match»)', () => {
    const r = assemble(GATEWAY_DEFS, { mcpGroupApps: { 'mcp:composio': ['gmail', 'Gmail'] } })
    const act = activateGroupsResult(r.deferredIndex, [], { query: 'gmail' })
    expect(act.activated).toContain('mcp:composio')
    expect(act.text).toContain('Group mcp:composio is now active: mcp__composio__COMPOSIO_SEARCH_TOOLS')
    expect(act.text).not.toContain('No tool groups match')
    // anche col NOME umano dell'app (non solo lo slug)
    const byName = activateGroupsResult(r.deferredIndex, [], { query: 'Gmail' })
    expect(byName.activated).toContain('mcp:composio')
  })

  it('SENZA app collegate la query gmail non trova il gruppo gateway (il gruppo parla solo di Composio: il comportamento di prima, documentato)', () => {
    const r = assemble(GATEWAY_DEFS)
    const act = activateGroupsResult(r.deferredIndex, [], { query: 'gmail' })
    expect(act.text).toContain('No tool groups match')
  })

  it('GUARDIA flusso SDK: i tool composio__gmail__* si trovano con la query gmail (già vero: il gruppo è mcp:gmail)', () => {
    const r = assemble(SDK_DEFS)
    const act = activateGroupsResult(r.deferredIndex, [], { query: 'gmail' })
    expect(act.activated).toContain('mcp:gmail')
    expect(act.text).toContain('composio__gmail__GMAIL_SEND_EMAIL')
  })
})

describe('CL6: mcpGroupAppsForAgent — le app collegate per gruppo mcp', () => {
  const fakeGateway = (apps: Array<{ slug: string; name: string }>) =>
    ({
      status: () => ({
        active: true,
        connected: apps.map((a) => ({ ...a, status: 'ACTIVE', accountId: 'acct' })),
        pending: null
      })
    }) as unknown as import('../../connectors/composio-gateway').ComposioGatewayManager

  it('gateway attivo connesso a gmail (e solo quello tra i tool c\'è il server composio) → mcp:composio → [gmail, Gmail]', async () => {
    const { setActiveComposioGateway } = await import('../../connectors/composio-gateway')
    setActiveComposioGateway(fakeGateway([{ slug: 'gmail', name: 'Gmail' }]))
    try {
      const m = await mcpGroupAppsForAgent(GATEWAY_DEFS)
      expect(m['mcp:composio']).toEqual(['gmail', 'Gmail'])
    } finally {
      setActiveComposioGateway(null)
    }
  })

  it('più app collegate: tutte nel gruppo; un\'app non ACTIVE non conta', async () => {
    const { setActiveComposioGateway } = await import('../../connectors/composio-gateway')
    const gw2 = {
      status: () => ({
        active: true,
        connected: [
          { slug: 'gmail', name: 'Gmail', status: 'ACTIVE', accountId: 'a' },
          { slug: 'slack', name: 'Slack', status: 'ACTIVE', accountId: 'b' },
          { slug: 'broken', name: 'Broken', status: 'RECONNECT', accountId: 'c' }
        ],
        pending: null
      })
    } as unknown as import('../../connectors/composio-gateway').ComposioGatewayManager
    setActiveComposioGateway(gw2)
    try {
      const m = await mcpGroupAppsForAgent(GATEWAY_DEFS)
      expect(m['mcp:composio']).toEqual(['gmail', 'Gmail', 'slack', 'Slack'])
    } finally {
      setActiveComposioGateway(null)
    }
  })

  it('flusso SDK: i tool composio__gmail__* portano lo slug nel gruppo mcp:gmail', async () => {
    const m = await mcpGroupAppsForAgent(SDK_DEFS)
    expect(m['mcp:gmail']).toContain('gmail')
  })

  it('nessun tool composio/gateway → mappa vuota (niente rumore nell\'indice)', async () => {
    expect(await mcpGroupAppsForAgent([tool('mcp__notion__NOTION_SEARCH', 'Notion search')])).toEqual({})
  })
})

// ---- U5 (fase mcp-ui): find_tools trova gli strumenti PER NOME DEL SERVER
// (e del servizio), non solo per gruppo: il NOME del server entra nel testo
// cercabile del gruppo (mcpGroupServers), così «mattermost» trova i suoi
// strumenti anche quando lo slug è un altro e i tool non lo nominano.
describe('U5: find_tools col NOME del server trova i suoi strumenti', () => {
  const MM_DEFS: ToolDef[] = [
    tool('mcp__mm42__send_message', 'Send a message to a channel'),
    tool('mcp__mm42__read_channel', 'Read the posts of a channel')
  ]

  it('find_tools({query:"mattermost"}) attiva il gruppo del server quando il NOME è noto (mcpGroupServers)', () => {
    const r = assemble(MM_DEFS, { mcpGroupServers: { 'mcp:mm42': 'mattermost' } })
    const act = activateGroupsResult(r.deferredIndex, [], { query: 'mattermost' })
    expect(act.activated).toContain('mcp:mm42')
    expect(act.text).toContain('Group mcp:mm42 is now active')
    expect(act.text).not.toContain('No tool groups match')
  })

  it('la descrizione del gruppo porta il NOME del server (non solo lo slug)', () => {
    const r = assemble(MM_DEFS, { mcpGroupServers: { 'mcp:mm42': 'mattermost' } })
    const g = r.deferredIndex.find((x) => x.id === 'mcp:mm42')!
    expect(g.description).toContain('"mattermost"')
  })

  it('senza il nome noto la query «mattermost» NON trova il gruppo (i tool non lo nominano: il comportamento di prima)', () => {
    const r = assemble(MM_DEFS)
    const act = activateGroupsResult(r.deferredIndex, [], { query: 'mattermost' })
    expect(act.activated).not.toContain('mcp:mm42')
  })

  it('il loop passa i nomi dei server (mcpGroupServers costruito da activeServersForAgent)', () => {
    const LOOP = readFileSync(fileURLToPath(new URL('../loop.ts', import.meta.url)), 'utf8')
    expect(LOOP).toMatch(/mcpGroupServers/)
  })
})
