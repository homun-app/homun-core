// Test di unità della fase mcp-setup: il gateway Composio avvisa quando
// un'app diventa ACTIVE (M5.3, SOLO la transizione) e il resolver dei server
// del registro col template risolve l'URL e rifiuta di partire con le graffe.
import { describe, expect, it } from 'vitest'
import { createComposioGatewayManager } from '../composio-gateway'
import { buildMcpAuthResolver } from '../wiring'
import type { McpServerConfig } from '../../mcp'
import type { ConnectorsSecretStore } from '../sealed-store'

// ---- M5.3: il gateway avvisa SOLO sulla transizione a ACTIVE ----

describe('gateway: onAppActive (M5.3)', () => {
  const makeGateway = () => {
    const settings = new Map<string, unknown>()
    const active: Array<{ slug: string; name: string }> = []
    const manager = createComposioGatewayManager({
      callMcp: async (tool, args) => {
        const slug = String((args.toolkits as Array<{ name?: string }>)[0]?.name ?? '')
        if (tool.endsWith('COMPOSIO_WAIT_FOR_CONNECTIONS')) return JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ id: 'a', status: 'ACTIVE' }] }] })
        // il list VERO: l'app è collegata appena il link è stato aperto
        return JSON.stringify({
          successful: true,
          data: { results: { [slug]: { toolkit: slug, status: 'active', accounts: [{ id: `acc_${slug}`, status: 'active', is_default: true }] } } }
        })
      },
      gatewayActive: () => true,
      getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
      setSetting: (key, value) => settings.set(key, value),
      openExternal: async () => undefined,
      hasUi: () => true,
      emit: () => undefined,
      retryDelayMs: () => 0,
      onAppActive: (slug, name) => active.push({ slug, name })
    })
    return { manager, active }
  }

  it('un collegamento riuscito chiama onAppActive UNA volta (non al refresh di una già attiva)', async () => {
    const { manager, active } = makeGateway()
    await manager.connectApp('gmail', 'Gmail')
    // il collegamento gira: il link si apre, WAIT finisce, `list` dice ACTIVE
    await new Promise((r) => setTimeout(r, 30))
    expect(active).toEqual([{ slug: 'gmail', name: 'Gmail' }])
    // il refresh di un'app GIÀ attiva NON ri-avvisa
    await manager.refreshAccounts()
    await new Promise((r) => setTimeout(r, 30))
    expect(active).toHaveLength(1)
  })
})

// ---- M1.3: il resolver del server col template ----

const fakeStore = (saved: Map<string, Map<string, unknown>>): ConnectorsSecretStore => ({
  read: async <T>(id: string, key: string) => (saved.get(id)?.get(key) as T | undefined) ?? undefined,
  write: async (id: string, key: string, value: unknown) => {
    if (!saved.has(id)) saved.set(id, new Map())
    saved.get(id)!.set(key, value)
  },
  remove: async (id: string, keys: string[]) => { for (const k of keys) saved.get(id)?.delete(k) },
  removeAll: async (id: string) => { saved.delete(id) }
})

describe('resolver: il server del registro col template (M1.3)', () => {
  const make = () => {
    const saved = new Map<string, Map<string, unknown>>()
    const servers: McpServerConfig[] = []
    const resolver = buildMcpAuthResolver({
      store: fakeStore(saved),
      catalog: [],
      getSetting: ((_k: string, fb: unknown) => fb) as never,
      markNeedsAuth: () => undefined,
      listServers: () => servers,
      saveServers: (s: McpServerConfig[]) => { servers.length = 0; servers.push(...s) }
    })
    return { resolver, servers, saved }
  }
  const mmServer = (): McpServerConfig => ({
    id: 'registry-mm', name: 'Mattermost', transport: 'http', enabled: true,
    urlTemplate: 'https://{mattermost_host}/plugins/mattermost-ai/mcp-server/mcp',
    headerTemplates: [{ name: 'Authorization', valueTemplate: 'Bearer {personal_access_token}', isSecret: true, variables: [{ name: 'personal_access_token', isSecret: true }] }],
    auth: { kind: 'oauth' },
    source: { kind: 'registry', name: 'io.github.mattermost/mattermost-plugin-agents' }
  })

  it('senza il valore, la connessione rifiuta e resta needsAuth setup (mai URL con le graffe)', async () => {
    const { resolver, servers } = make()
    servers.push(mmServer())
    await expect(resolver(servers[0]!)).rejects.toThrow(/not configured yet/)
    expect(servers[0]!.needsAuth).toEqual({ kind: 'setup', keys: ['mattermost_host'] })
  })
  it('col valore l\'URL arriva RISOLTO; l\'header del token (già risolto) vince su OAuth', async () => {
    const { resolver, servers, saved } = make()
    const cfg = { ...mmServer(), vars: { mattermost_host: 'chat.example.com' }, url: 'https://chat.example.com/plugins/mattermost-ai/mcp-server/mcp' }
    servers.push(cfg)
    let auth = await resolver(cfg)
    expect(auth.url).toBe('https://chat.example.com/plugins/mattermost-ai/mcp-server/mcp')
    expect(auth.headers).toBeUndefined()
    expect(auth.authProvider).toBeDefined() // OAuth quando non c'è il token
    // il token salvato (header RISOLTO dal modulo) prende il posto di OAuth
    saved.set('registry-mm', new Map([['staticHeaders', { Authorization: 'Bearer xyz' }]]))
    auth = await resolver(cfg)
    expect(auth.headers).toEqual({ Authorization: 'Bearer xyz' })
    expect(auth.authProvider).toBeUndefined()
  })
})
