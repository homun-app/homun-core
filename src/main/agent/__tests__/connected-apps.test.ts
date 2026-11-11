// B4 (fase beta.4): il bot sa quali app ha collegate. Una riga nel prompt di
// ogni turno, nella PARTE CHE CAMBIA (mai nel prefisso in cache): le app
// collegate tramite Composio (stato locale di composio-gateway) e i server
// MCP attivi del bot, con l'ordine dei nomi, il tetto di 20 e poi «and N
// more». E search_connectors su un'app già collegata risponde subito
// «già collegata tramite Composio», senza proporne un'altra.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { connectedAppsLine, connectedAppMatch, CONNECTED_APPS_MAX_NAMES } = await import('../connected-apps')
const { systemPrompt } = await import('../prompts')

let root: string
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-connapps-test-'))
  const { setDataDir, dataDir } = await import('../../store/db')
  setDataDir(root)
  dataDir()
  const { openMemoryEngine } = await import('../../memory/engine')
  const st = await openMemoryEngine({ dataDir: root })
  if (!st.available) throw new Error('motore Engramma non disponibile nei test: ' + st.error)
})
afterAll(async () => {
  const { closeMemoryEngine } = await import('../../memory/engine')
  await closeMemoryEngine()
  rmSync(root, { recursive: true, force: true })
})

describe('B4: connectedAppsLine — la riga del prompt (pura)', () => {
  it('con le app collegate c\'è, con la guida Composio e i server MCP', () => {
    const line = connectedAppsLine({ composioApps: ['Trello', 'Gmail'], mcpServers: ['Notion'] })
    expect(line).toContain('Connected apps: Trello, Gmail (via Composio: COMPOSIO_SEARCH_TOOLS to find the action, then COMPOSIO_MULTI_EXECUTE_TOOL)')
    expect(line).toContain('MCP servers: Notion')
    expect(line).toMatch(/use these tools|use THESE tools/i)
    expect(line).toMatch(/not history, memory, the browser or a new connector/)
  })

  it('SENZA app e SENZA server la riga NON c\'è (stringa vuota)', () => {
    expect(connectedAppsLine({ composioApps: [], mcpServers: [] })).toBe('')
  })

  it('l\'ordine dei nomi resta quello dato; massimo 20, poi «and N more»', () => {
    expect(CONNECTED_APPS_MAX_NAMES).toBe(20)
    const many = Array.from({ length: 25 }, (_, i) => `App${i}`)
    const line = connectedAppsLine({ composioApps: many, mcpServers: [] })
    expect(line).toContain('App0, App1')
    expect(line).toMatch(/App19, and 5 more/)
    expect(line).not.toContain('App20')
    // i server MCP contano nello stesso tetto
    const line2 = connectedAppsLine({ composioApps: many.slice(0, 10), mcpServers: many.slice(10) })
    expect(line2).toMatch(/and 5 more/)
  })

  it('la riga NON sta nel prefisso in cache: systemPrompt non la contiene', () => {
    const agent = { id: 'a', name: 'Bot', description: '', providerId: 'p', model: 'm', status: 'idle' as const, unread: 0, createdAt: 1 }
    const p = systemPrompt(agent, { subagents: true })
    expect(p).not.toContain('Connected apps')
    // e nessuna sezione del prompt base la introduce
    expect(p).not.toMatch(/# Connected apps/)
  })
})

describe('B4: connectedAppMatch — query che nomina un\'app già collegata (pura)', () => {
  const CONNECTED = [
    { slug: 'trello', name: 'Trello' },
    { slug: 'gmail', name: 'Gmail' }
  ]

  it('il nome o lo slug, maiuscole irrilevanti', () => {
    expect(connectedAppMatch('trello', CONNECTED)?.slug).toBe('trello')
    expect(connectedAppMatch('Trello', CONNECTED)?.slug).toBe('trello')
    expect(connectedAppMatch('GMAIL', CONNECTED)?.slug).toBe('gmail')
    expect(connectedAppMatch('slack', CONNECTED)).toBeNull()
  })

  it('il nome dentro la query («le board di trello»)', () => {
    expect(connectedAppMatch('le mie board di trello', CONNECTED)?.slug).toBe('trello')
  })
})

// ---- B4: l'integrazione (gateway FINTO, niente rete) ----

const { setActiveComposioGateway } = await import('../../connectors/composio-gateway')
const { executeTool } = await import('../tools')

const fakeGateway = (apps: Array<{ slug: string; name: string }>) =>
  ({
    status: () => ({
      active: true,
      connected: apps.map((a) => ({ ...a, status: 'ACTIVE', accountId: 'acct' })),
      pending: null
    })
  }) as unknown as import('../../connectors/composio-gateway').ComposioGatewayManager

describe('B4: search_connectors su un\'app già collegata', () => {
  it('risponde subito «già collegata tramite Composio», senza proporne un\'altra', async () => {
    setActiveComposioGateway(fakeGateway([{ slug: 'trello', name: 'Trello' }]))
    try {
      const { output, meta } = await executeTool('agent_x', 'search_connectors', { query: 'trello' })
      expect(output).toContain('already connected via Composio')
      expect(output).toContain('COMPOSIO_SEARCH_TOOLS')
      expect(meta).toEqual({ connectedApp: 'trello' })
    } finally {
      setActiveComposioGateway(null)
    }
  })

  it('senza il gateway collegato la ricerca procede come oggi (nessun esito finto)', async () => {
    setActiveComposioGateway(null)
    // nessun gateway → nessuna risposta «già collegata»: il result è quello
    // del runner vero (qui: la query corta si rifiuta, come sempre)
    const { output } = await executeTool('agent_x', 'search_connectors', { query: 'x' })
    expect(output).not.toContain('already connected')
  })
})
