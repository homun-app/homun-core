// Fase chat-limiti (CL6): collegare un'app e poi TROVARNE gli strumenti.
// Il messaggio dopo un collegamento Composio dice find_tools: la strada deve
// FUNZIONARE — find_tools({query: <nome o slug dell'app collegata>}) trova e
// attiva gli strumenti dell'app (composio__<slug>__* nel flusso SDK, i proxy
// mcp__composio__* nel flusso gateway). Come: le app collegate entrano nel
// TESTO CERCABILE del gruppo del connettore, dentro il catalogo di find_tools.
import { describe, expect, it } from 'vitest'
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
