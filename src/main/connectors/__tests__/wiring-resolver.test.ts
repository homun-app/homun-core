// Test del RESOLVER d'autenticazione (fase 13, correzione L1): la catena "il
// valore che l'utente salva dalla UI → quello che la connessione usa". Lo
// store è FINTO in memoria e si scrive con gli STESSI kind di SECRET_KIND che
// usa l'RPC connectors:save-server-values; il resolver è buildMcpAuthResolver
// (quello che il daemon registra con setMcpAuthResolver). L'ultimo test è
// l'integrazione L1.3: OAuth COMPLETO di un server del registro con AS e MCP
// finti in-process, fino a toolsOfServer(cfg.id). Nessuna rete esterna.
import { describe, expect, it, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMcpAuthResolver } from '../wiring'
import { authorizeWithLoopback, createOAuthProvider } from '../oauth-provider'
import { createConnectorsSecretStore } from '../sealed-store'
import { serverIdFor, SECRET_KIND } from '../install'
import type { McpServerConfig } from '../../mcp'
import type { ConnectorsSecretStore } from '../sealed-store'

// lo store cifrato FINTO (chiave fissa, settings in memoria come oauth.test.ts)
const KEY = randomBytes(32)
function makeStore(): { store: ConnectorsSecretStore; settings: Map<string, unknown> } {
  const settings = new Map<string, unknown>()
  const store = createConnectorsSecretStore({
    getKey: async () => KEY,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key: string, value: unknown) => settings.set(key, value)
  })
  return { store, settings }
}

function makeResolver(over: {
  store?: ConnectorsSecretStore
  settings?: Map<string, unknown>
  servers?: McpServerConfig[]
} = {}) {
  const { store, settings } = makeStore()
  const servers = over.servers ?? []
  const getSetting = <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback)
  const resolver = buildMcpAuthResolver({
    store: over.store ?? store,
    catalog: [],
    getSetting: over.settings ? <T>(key: string, fallback: T): T => (over.settings!.has(key) ? (over.settings!.get(key) as T) : fallback) : getSetting,
    markNeedsAuth: () => undefined,
    listServers: () => servers,
    saveServers: (s: McpServerConfig[]) => {
      const copy = [...s]
      servers.length = 0
      servers.push(...copy)
    }
  })
  return { resolver, store, settings: over.settings ?? settings, servers }
}

// la UI scrive i valori con l'RPC connectors:save-server-values, che usa
// SECRET_KIND — qui lo stesso contratto (mai chiavi dello store a mano)
const saveAsUi = async (store: ConnectorsSecretStore, serverId: string, kind: keyof typeof SECRET_KIND, values: Record<string, string>): Promise<void> => {
  await store.write(serverId, SECRET_KIND[kind], values)
}

describe('L1: il resolver porta i valori salvati dalla UI fino alla connessione', () => {
  it('header segreto del registro salvato come farebbe la UI (kind "headers") → header presente', async () => {
    const { resolver, store } = makeResolver()
    const id = serverIdFor({ kind: 'registry', name: 'ai.smithery/smithery-notion' })
    // il bottone "salva cifrato" della scheda Installati
    await saveAsUi(store, id, 'headers', { Authorization: 'Bearer chiave-finta' })
    const cfg: McpServerConfig = { id, name: 'ai.smithery/smithery-notion', transport: 'http', url: 'https://s.example/mcp', enabled: true, auth: { kind: 'headers' }, source: { kind: 'registry', name: 'ai.smithery/smithery-notion' } }
    // PRIMA della correzione il resolver leggeva 'staticHeaders' e la UI
    // scriveva 'headers': la chiave non arrivava MAI al server
    await expect(resolver(cfg)).resolves.toEqual({ headers: { Authorization: 'Bearer chiave-finta' } })
  })

  it('OAuth SENZA catalogId (registro/url/plugin): authProvider che legge i token di cfg.id', async () => {
    const { resolver, store } = makeResolver()
    const id = serverIdFor({ kind: 'registry', name: 'com.linear/linear' })
    // i token li ha salvati authorizeWithLoopback dell'installazione, sotto cfg.id
    await store.write(id, 'oauth.tokens', { access_token: 'ACCESS_FINTO', token_type: 'Bearer' })
    const cfg: McpServerConfig = { id, name: 'com.linear/linear', transport: 'http', url: 'https://l.example/mcp', enabled: true, auth: { kind: 'oauth' }, source: { kind: 'registry', name: 'com.linear/linear' } }
    const a = await resolver(cfg)
    expect(a.authProvider).toBeDefined()
    // il provider legge i token dallo store sotto cfg.id (non del catalogo)
    await expect(a.authProvider!.tokens()).resolves.toMatchObject({ access_token: 'ACCESS_FINTO' })
  })

  it('stdio del registro: i valori salvati con kind "env" diventano stdioEnv (prima -e NOME passava vuoto)', async () => {
    const { resolver, store } = makeResolver()
    const id = serverIdFor({ kind: 'registry', name: 'com.foreverworks/notion' })
    await saveAsUi(store, id, 'env', { NOTION_TOKENS_DIR: '/box/home/a7/tokens' })
    const cfg: McpServerConfig = {
      id, name: 'com.foreverworks/notion', transport: 'stdio', enabled: true,
      box: { workdir: '/box/home/a7', home: '/box/home/a7', command: 'npx', args: ['-y', 'x@1'], envKeys: ['NOTION_TOKENS_DIR'] },
      source: { kind: 'registry', name: 'com.foreverworks/notion' }
    }
    await expect(resolver(cfg)).resolves.toEqual({ stdioEnv: { NOTION_TOKENS_DIR: '/box/home/a7/tokens' } })
  })

  it('server di plugin http: headers e url RISOLTI dai template (pluginSpec) coi valori userConfig', async () => {
    const { resolver, store } = makeResolver()
    const id = serverIdFor({ kind: 'plugin', marketplace: 'mp', plugin: 'demo', server: 'api' })
    await saveAsUi(store, id, 'userConfig', { API_KEY: 'chiave-del-plugin' })
    const cfg: McpServerConfig = {
      id, name: 'api', transport: 'http', url: 'https://api.example/${user_config.API_KEY}/mcp', enabled: true,
      auth: { kind: 'headers' }, source: { kind: 'plugin', plugin: 'demo', marketplace: 'mp', sha: 'abc123' },
      pluginSpec: { url: 'https://api.example/${user_config.API_KEY}/mcp', headers: { 'x-api-key': '${user_config.API_KEY}' } }
    }
    await expect(resolver(cfg)).resolves.toEqual({
      url: 'https://api.example/chiave-del-plugin/mcp',
      headers: { 'x-api-key': 'chiave-del-plugin' }
    })
  })

  it('server di plugin stdio: env risolto (placeholder, valore letterale e ${CLAUDE_PLUGIN_ROOT}) → stdioEnv', async () => {
    const { resolver, store } = makeResolver()
    const id = serverIdFor({ kind: 'plugin', marketplace: 'mp', plugin: 'demo', server: 'runner' })
    await saveAsUi(store, id, 'userConfig', { API_KEY: 'chiave-del-plugin' })
    const cfg: McpServerConfig = {
      id, name: 'runner', transport: 'stdio', enabled: true,
      box: { workdir: '/box/plugins/mp/demo/abc123', home: '/box/home/a7', command: 'node', args: ['run.js'] },
      source: { kind: 'plugin', plugin: 'demo', marketplace: 'mp', sha: 'abc123' },
      pluginSpec: { env: { API_KEY: '${user_config.API_KEY}', LIT: 'fisso', ROOT: '${CLAUDE_PLUGIN_ROOT}/data' } }
    }
    await expect(resolver(cfg)).resolves.toEqual({
      stdioEnv: { API_KEY: 'chiave-del-plugin', LIT: 'fisso', ROOT: '/box/plugins/mp/demo/abc123/data' }
    })
  })

  it('placeholder ${user_config.KEY} senza valore salvato → needsAuth e la connessione rifiuta di partire', async () => {
    const { resolver, servers } = makeResolver()
    const id = serverIdFor({ kind: 'plugin', marketplace: 'mp', plugin: 'demo', server: 'api' })
    servers.push({
      id, name: 'api', transport: 'http', url: 'https://api.example/mcp', enabled: true,
      auth: { kind: 'headers' }, source: { kind: 'plugin', plugin: 'demo', marketplace: 'mp', sha: 'abc123' },
      pluginSpec: { headers: { 'x-api-key': '${user_config.API_KEY}' } }
    })
    await expect(resolver(servers[0]!)).rejects.toThrow('richiede i valori API_KEY')
    // il server torna in needsAuth: niente stringhe vuote silenziose
    expect(servers[0]!.needsAuth).toEqual({ kind: 'settings', keys: ['API_KEY'] })
  })

  it('bearer e catalogo: i percorsi della fase 5 restano quelli', async () => {
    const { resolver, store, settings } = makeResolver()
    const gwId = serverIdFor({ kind: 'gateway', name: 'gw', url: 'https://mcp.gw.example/mcp' })
    // per bearer l'RPC scrive la STRINGA token, non un oggetto
    await store.write(gwId, SECRET_KIND.bearer, 'tok-finto')
    const a = await resolver({ id: gwId, name: 'gw', transport: 'http', url: 'https://mcp.gw.example/mcp', enabled: true, auth: { kind: 'bearer' }, source: { kind: 'gateway' } })
    // il valore "bearer" è lo store a riceverlo: token → header Authorization
    expect(a.headers).toEqual({ Authorization: 'Bearer tok-finto' })
    // connettore del catalogo sconosciuto: niente authProvider
    const b = await resolver({ id: 'notion', name: 'Notion', transport: 'http', url: 'https://x', enabled: true, auth: { kind: 'oauth' }, catalogId: 'notion' })
    expect(b).toEqual({})
    expect(settings.size).toBeGreaterThanOrEqual(0)
  })
})

// ---- L1.3: OAuth END-TO-END di un server del REGISTRO (AS e MCP finti in-process) ----

/** Un authorization server finto compatto (discovery, DCR, PKCE S256, loopback). */
async function startFakeAs(): Promise<{ url: string; server: Server; accessTokens: string[] }> {
  const clients = new Map<string, string[]>()
  const codes = new Map<string, string>()
  const accessTokens: string[] = []
  let n = 0
  let url = ''
  const s256 = (v: string): string => createHash('sha256').update(v).digest('base64url')
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (code: number, body: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(200, { resource: url, authorization_servers: [url] })
      }
      if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json(200, {
          issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, registration_endpoint: `${url}/register`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
        })
      }
      if (u.pathname === '/register') {
        const clientId = 'client_' + ++n
        const redirectUris = (JSON.parse(body || '{}') as { redirect_uris?: string[] }).redirect_uris ?? []
        clients.set(clientId, redirectUris)
        return json(201, { client_id: clientId, redirect_uris: redirectUris })
      }
      if (u.pathname === '/authorize') {
        const clientId = u.searchParams.get('client_id') ?? ''
        const redirectUri = u.searchParams.get('redirect_uri') ?? ''
        // RFC 8252: per le app native il redirect loopback è valido su QUALUNQUE
        // porta (il client della connessione silenziosa ha registrato 127.0.0.1:9)
        const loopback = /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)
        const registered = (clients.get(clientId) ?? []).some((r) => r === redirectUri || (loopback && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(r)))
        if (!clients.has(clientId) || !registered) return json(400, { error: 'unauthorized_client' })
        const code = 'code_' + randomBytes(6).toString('hex')
        codes.set(code, u.searchParams.get('code_challenge') ?? '')
        return res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state') ?? '')}` }).end()
      }
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body)
        if (p.get('grant_type') === 'authorization_code') {
          const challenge = codes.get(p.get('code') ?? '')
          if (!challenge || s256(p.get('code_verifier') ?? '') !== challenge) return json(400, { error: 'invalid_grant' })
          const access = 'ACCESS_' + ++n
          accessTokens.push(access)
          return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: 'REFRESH_' + n })
        }
        return json(400, { error: 'unsupported_grant_type' })
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { url, server, accessTokens }
}

/**
 * Un server MCP streamable-http finto che ACCETTA solo i token dell'AS (401
 * senza Authorization: Bearer ACCESS_…), come un vero server del registro.
 */
async function startFakeMcp(asUrl: string): Promise<{ url: string; server: Server; saw: string[] }> {
  const saw: string[] = []
  let url = ''
  const server = createServer((req, res) => {
    // discovery RFC 9728: il server MCP indica il SUO authorization server
    if (req.method === 'GET' && (req.url ?? '').includes('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: url, authorization_servers: [asUrl] }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const msg = (JSON.parse(body || '{}') as { id?: unknown; method?: string }).method ? (JSON.parse(body || '{}') as { id?: number | null; method?: string; params?: Record<string, unknown> }) : null
      const auth = req.headers.authorization ?? ''
      if (!/^Bearer ACCESS_/.test(auth)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32001, message: 'unauthorized' } }))
        return
      }
      saw.push(auth)
      const reply = (result: unknown): void => {
        if (msg?.id === undefined || msg.id === null) { res.writeHead(202).end(); return }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      }
      if (msg?.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake-registry-mcp', version: '1' } })
      if (msg?.method === 'tools/list') return reply({ tools: [{ name: 'linear_list_issues', description: 'Le issue', inputSchema: { type: 'object', properties: {} } }] })
      reply({})
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
  return { url, server, saw }
}

describe('L1.3: OAuth end-to-end di un server del registro (AS + MCP finti in-process)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sandbot-wiring-test-'))
  const serversToClose: Server[] = []
  afterAll(() => {
    for (const s of serversToClose) {
      s.closeAllConnections?.()
      s.close()
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  it('dopo authorizeWithLoopback, toolsOfServer(cfg.id) elenca i tool del server (token letti dal provider di cfg.id)', async () => {
    const as = await startFakeAs()
    const mcpFake = await startFakeMcp(as.url)
    serversToClose.push(as.server, mcpFake.server)
    const { setDataDir, setSetting } = await import('../../store/db')
    setDataDir(tmp)
    const mcp = await import('../../mcp')
    // UNO SOLO store cifrato per resolver e flusso di autorizzazione: è quello
    // che fa il daemon (wireConnectors) — i token salvati dal loopback sono gli
    // stessi che il resolver legge alla connessione
    const oAuthSettings = new Map<string, unknown>()
    const store = createConnectorsSecretStore({
      getKey: async () => KEY,
      getSetting: <T>(key: string, fallback: T): T => (oAuthSettings.has(key) ? (oAuthSettings.get(key) as T) : fallback),
      setSetting: (key: string, value: unknown) => oAuthSettings.set(key, value)
    })
    mcp.setMcpAuthResolver(buildMcpAuthResolver({
      store,
      catalog: [],
      getSetting: <T>(key: string, fallback: T): T => (key === 'connectors.oauth.clientMetadataUrl' ? ('' as T) : fallback),
      markNeedsAuth: () => undefined,
      listServers: mcp.listServers,
      saveServers: mcp.saveServers
    }))
    // un server del REGISTRO (OAuth, senza catalogId)
    const cfg: McpServerConfig = {
      id: serverIdFor({ kind: 'registry', name: 'app.linear/linear' }), name: 'app.linear/linear',
      transport: 'http', url: mcpFake.url, enabled: true, auth: { kind: 'oauth' },
      enabledFor: ['agent_oauth'], source: { kind: 'registry', name: 'app.linear/linear' }
    }
    setSetting('mcp.servers', [cfg])
    // prima: 401 (nessun token)
    await expect(mcp.toolsOfServer(cfg.id)).rejects.toThrow()
    // il flusso di installazione/riconnessione: authorizeWithLoopback coi
    // token salvati sotto cfg.id (il "browser" segue il redirect fino al loopback)
    await authorizeWithLoopback(cfg.url!, (redirectUrl, stateFactory) =>
      createOAuthProvider({
        serverId: cfg.id, redirectUrl, store, stateFactory,
        openExternal: async (u) => {
          const r = await fetch(u, { redirect: 'manual' })
          const location = r.headers.get('location')
          if (location) await fetch(location).catch(() => undefined)
        }
      })
    )
    // L1: il token salvato sotto cfg.id arriva al server — il tool si elenca
    const tools = await mcp.toolsOfServer(cfg.id)
    expect(tools.map((t) => t.name)).toEqual(['mcp__app-linear-linear__linear_list_issues'])
    expect(mcpFake.saw.length).toBeGreaterThan(0)
    expect(mcpFake.saw.every((h) => /^Bearer ACCESS_/.test(h))).toBe(true)
  })
})
