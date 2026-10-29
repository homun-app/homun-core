// Wiring di produzione del sottosistema connettori nel daemon (fase 5): lo
// store cifrato con chiave dal Keychain, il manager del catalogo e il resolver
// d'autenticazione del client MCP (OAuth per i connettori del catalogo,
// bearer/header statici cifrati per i server manuali).
// Fase 13 correzioni (L1): il resolver copre TUTTE le fonti — anche l'OAuth dei
// server NON del catalogo (registro/url/plugin, che salvano i token sotto
// cfg.id), gli header segreti con lo STESSO kind della UI, l'env dei server
// stdio nel box e i placeholder ${user_config.KEY} dei server di plugin.
import { createConnectorsManager, loadCatalog, type CatalogEntry } from './index'
import { createConnectorsSecretStore, type ConnectorsSecretStore } from './sealed-store'
import { createOAuthProvider } from './oauth-provider'
import { getConnectorsKey } from '../../daemon/keychain'
import { getSetting, setSetting } from '../store/db'
import { listServers, saveServers, setMcpAuthResolver, type McpServerConfig, type McpAuth, type McpAuthResolver } from '../mcp'
import { SECRET_KIND } from '../../shared/types'
import { resolvePluginServerPlaceholders, unresolvedUserConfigKeys } from './install'

export interface ConnectorsHost {
  callUi(method: string, params?: unknown[]): Promise<unknown>
  hasUi(): boolean
}

/**
 * Le dipendenze del resolver d'autenticazione (L1): iniettabili per i test,
 * così la catena "valore salvato dalla UI → header/env/provider alla
 * connessione" si prova con uno store finto, senza daemon.
 */
export interface AuthResolverDeps {
  store: ConnectorsSecretStore
  catalog: CatalogEntry[]
  getSetting: <T>(key: string, fallback: T) => T
  /** refresh fallito di un connettore del CATALOGO (card "Riconnetti") */
  markNeedsAuth(id: string, message: string): void
  listServers(): McpServerConfig[]
  saveServers(s: McpServerConfig[]): void
}

/**
 * buildMcpAuthResolver (L1): come il client MCP risolve l'autenticazione di
 * OGNI server — OAuth del catalogo, OAuth dei server non del catalogo (token
 * sotto cfg.id), bearer/header statici CIFRATI (kind di SECRET_KIND, gli
 * stessi con cui la UI scrive), env dei server stdio nel box e placeholder
 * ${user_config.KEY} dei server di plugin risolti alla connessione.
 */
export function buildMcpAuthResolver(deps: AuthResolverDeps): McpAuthResolver {
  // Nel trasporto l'auth serve per il refresh: se serve di nuovo l'utente non
  // si apre nessun browser qui — il connettore passa a needs_auth e la
  // riconnessione parte dalla vista "Connetti app" (catalogo) o dal bottone
  // "Riconnetti" della scheda Installati (registro/plugin/url).
  const silentOpen = async (): Promise<void> => {
    throw new Error('browser non disponibile senza la finestra di SandBot')
  }

  /**
   * L1: un placeholder ${user_config.KEY} senza valore salvato lascia
   * needsAuth sul server e la connessione rifiuta di partire — niente
   * stringhe vuote silenziose verso il server.
   */
  const pluginNeedsAuth = (cfg: McpServerConfig, missing: string[]): never => {
    const servers = deps.listServers()
    const cur = servers.find((s) => s.id === cfg.id)
    if (cur) {
      cur.needsAuth = { kind: 'settings', keys: missing }
      deps.saveServers(servers)
    }
    throw new Error(`il server "${cfg.name}" richiede i valori ${missing.join(', ')}: l'utente li inserisce nelle Impostazioni`)
  }

  return async (cfg): Promise<McpAuth> => {
    if (cfg.auth?.kind === 'oauth' && cfg.catalogId) {
      const entry = deps.catalog.find((e) => e.id === cfg.catalogId)
      if (!entry) return {}
      return {
        authProvider: createOAuthProvider(
          {
            serverId: entry.id,
            // redirect di riserva: nel trasporto non serve navigare davvero
            redirectUrl: 'http://127.0.0.1:9/callback',
            scope: entry.scopes?.join(' '),
            openExternal: silentOpen,
            store: deps.store,
            ...(entry.clientRegistration === 'static'
              ? {
                  staticClient: async () => (await deps.store.read<{ client_id: string; client_secret?: string }>(entry.id, 'staticClient')) ?? null,
                  extraAuthParams: { access_type: 'offline', prompt: 'consent' }
                }
              : {})
          },
          // refresh fallito durante l'uso del server: card "Riconnetti"
          (scope) => {
            if (scope === 'tokens' || scope === 'all') {
              deps.markNeedsAuth(entry.id, 'Sessione scaduta: riconnetti')
            }
          }
        )
      }
    }
    // L1: server di PLUGIN — url, headers ed env si calcolano ALLA CONNESSIONE
    // dalla dichiarazione (pluginSpec, template pubblici) coi valori
    // ${user_config.KEY} dello store (kind userConfig, come li salva la UI)
    if (cfg.pluginSpec) {
      const values = (await deps.store.read<Record<string, string>>(cfg.id, SECRET_KIND.userConfig)) ?? {}
      const resolved = resolvePluginServerPlaceholders(
        {
          name: cfg.name, from: 'config',
          ...(cfg.pluginSpec.url ? { url: cfg.pluginSpec.url } : {}),
          ...(cfg.pluginSpec.headers ? { headers: cfg.pluginSpec.headers } : {}),
          ...(cfg.pluginSpec.env ? { env: cfg.pluginSpec.env } : {})
        },
        values,
        cfg.box?.workdir ?? ''
      )
      const missing = unresolvedUserConfigKeys(resolved)
      if (missing.length) pluginNeedsAuth(cfg, missing)
      if (cfg.transport === 'stdio') return { stdioEnv: resolved.env }
      return {
        ...(resolved.url ? { url: resolved.url } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {})
      }
    }
    // L1: OAuth dei server NON del catalogo (registro, url:, plugin): i token
    // stanno sotto cfg.id (li ha salvati authorizeWithLoopback dell'installazione
    // o della card "Riconnetti") e il provider è lo stesso del catalogo, con il
    // redirect di riserva del trasporto. Se il refresh fallisce, l'SDK throwa
    // UnauthorizedError e markNeedsAuth della fase 13 mette il server in
    // needs_auth per cfg.source (card "Riconnetti" nella scheda Installati)
    if (cfg.auth?.kind === 'oauth') {
      const cimd = deps.getSetting<string>('connectors.oauth.clientMetadataUrl', '')
      return {
        authProvider: createOAuthProvider(
          {
            serverId: cfg.id,
            redirectUrl: 'http://127.0.0.1:9/callback',
            openExternal: silentOpen,
            store: deps.store,
            ...(cimd ? { clientMetadataUrl: cimd } : {})
          }
        )
      }
    }
    if (cfg.auth?.kind === 'bearer') {
      const token = await deps.store.read<string>(cfg.id, SECRET_KIND.bearer)
      return token ? { headers: { Authorization: `Bearer ${token}` } } : {}
    }
    if (cfg.auth?.kind === 'headers') {
      const headers = await deps.store.read<Record<string, string>>(cfg.id, SECRET_KIND.headers)
      return headers ? { headers } : {}
    }
    // L1: server stdio del registro NEL BOX — i valori salvati con kind 'env'
    // (come li scrive la UI) arrivano al processo docker exec: prima -e NOME
    // passava vuoto e il server partiva senza credenziali
    if (cfg.box) {
      const env = await deps.store.read<Record<string, string>>(cfg.id, SECRET_KIND.env)
      return { stdioEnv: env ?? {} }
    }
    return {}
  }
}

export function wireConnectors(host: ConnectorsHost, onChange: () => void) {
  const store = createConnectorsSecretStore({
    getKey: () => getConnectorsKey(),
    getSetting,
    setSetting
  })
  const catalog = loadCatalog()

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

  // L1: il resolver copre tutte le fonti (vedi buildMcpAuthResolver)
  setMcpAuthResolver(buildMcpAuthResolver({
    store,
    catalog,
    getSetting,
    markNeedsAuth: (id, message) => connectors.markNeedsAuth(id, message),
    listServers,
    saveServers
  }))

  return connectors
}
