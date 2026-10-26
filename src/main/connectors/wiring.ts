// Wiring di produzione del sottosistema connettori nel daemon (fase 5): lo
// store cifrato con chiave dal Keychain, il manager del catalogo e il resolver
// d'autenticazione del client MCP (OAuth per i connettori del catalogo,
// bearer/header statici cifrati per i server manuali).
import { createConnectorsManager, loadCatalog } from './index'
import { createConnectorsSecretStore } from './sealed-store'
import { createOAuthProvider } from './oauth-provider'
import { getConnectorsKey } from '../../daemon/keychain'
import { getSetting, setSetting } from '../store/db'
import { listServers, saveServers, setMcpAuthResolver, type McpServerConfig } from '../mcp'

export interface ConnectorsHost {
  callUi(method: string, params?: unknown[]): Promise<unknown>
  hasUi(): boolean
}

export function wireConnectors(host: ConnectorsHost, onChange: () => void) {
  const store = createConnectorsSecretStore({
    getKey: () => getConnectorsKey(),
    getSetting,
    setSetting
  })
  const catalog = loadCatalog()

  // Nel trasporto l'auth serve per il refresh: se serve di nuovo l'utente non
  // si apre nessun browser qui — il connettore passa a needs_auth e la
  // riconnessione parte dalla vista "Connetti app".
  const silentOpen = async (): Promise<void> => {
    throw new Error('browser non disponibile senza la finestra di SandBot')
  }

  const connectors = createConnectorsManager({
    store,
    getSetting,
    setSetting,
    openExternal: (url) => host.callUi('host.openExternal', [url]).then(() => undefined),
    hasUi: () => host.hasUi(),
    toolsOf: async (id) => {
      const mcp = await import('../mcp')
      return mcp.toolsOfServer(id)
    },
    registerServer: (cfg) => {
      // il connettore del catalogo diventa un server MCP http con auth OAuth
      const mcpCfg: McpServerConfig = {
        id: cfg.id, name: cfg.name, transport: 'http', url: cfg.url,
        enabled: true, auth: { kind: 'oauth' }, catalogId: cfg.id
      }
      saveServers([...listServers().filter((s) => s.id !== cfg.id), mcpCfg])
    },
    removeServer: (id) => saveServers(listServers().filter((s) => s.id !== id)),
    serverExists: (id) => listServers().some((s) => s.id === id),
    onChange
  })

  setMcpAuthResolver(async (cfg) => {
    if (cfg.auth?.kind === 'oauth' && cfg.catalogId) {
      const entry = catalog.find((e) => e.id === cfg.catalogId)
      if (!entry) return {}
      return {
        authProvider: createOAuthProvider(
          {
            serverId: entry.id,
            // redirect di riserva: nel trasporto non serve navigare davvero
            redirectUrl: 'http://127.0.0.1:9/callback',
            scope: entry.scopes?.join(' '),
            openExternal: silentOpen,
            store,
            ...(entry.clientRegistration === 'static'
              ? {
                  staticClient: async () => (await store.read<{ client_id: string; client_secret?: string }>(entry.id, 'staticClient')) ?? null,
                  extraAuthParams: { access_type: 'offline', prompt: 'consent' }
                }
              : {})
          },
          // refresh fallito durante l'uso del server: card "Riconnetti"
          (scope) => {
            if (scope === 'tokens' || scope === 'all') {
              connectors.markNeedsAuth(entry.id, 'Sessione scaduta: riconnetti')
            }
          }
        )
      }
    }
    if (cfg.auth?.kind === 'bearer') {
      const token = await store.read<string>(cfg.id, 'bearer')
      return token ? { headers: { Authorization: `Bearer ${token}` } } : {}
    }
    if (cfg.auth?.kind === 'headers') {
      const headers = await store.read<Record<string, string>>(cfg.id, 'staticHeaders')
      return headers ? { headers } : {}
    }
    return {}
  })

  return connectors
}
