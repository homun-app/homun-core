// Test del RESOLVER d'autenticazione (fase 13, correzione L1): la catena "il
// valore che l'utente salva dalla UI → quello che la connessione usa". Lo
// store è FINTO in memoria e si scrive con gli STESSI kind di SECRET_KIND che
// usa l'RPC connectors:save-server-values; il resolver è buildMcpAuthResolver
// (quello che il daemon registra con setMcpAuthResolver). L'ultimo test è
// l'integrazione L1.3: OAuth COMPLETO di un server del registro con AS e MCP
// finti in-process, fino a toolsOfServer(cfg.id). Nessuna rete esterna.
// Fase 13 correzioni 2: M2 (authProvider anche per i server di PLUGIN con
// OAuth, bottone Connetti via reconnectServer) e M3 (${VAR} negli header del
// plugin arriva al server finto; l'ambiente del daemon NON si usa mai).
import { describe, expect, it, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { buildMcpAuthResolver } from '../wiring'
import { authorizeWithLoopback, createOAuthProvider } from '../oauth-provider'
import { createConnectorsSecretStore } from '../sealed-store'
import { serverIdFor, reconnectServer, SECRET_KIND } from '../install'
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

  it('M2: plugin OAuth + pluginSpec (linear) → authProvider che legge i token di cfg.id', async () => {
    const { resolver, store } = makeResolver()
    const id = serverIdFor({ kind: 'plugin', marketplace: 'claude-plugins-official', plugin: 'linear', server: 'linear' })
    await store.write(id, 'oauth.tokens', { access_token: 'ACCESS_PLUGIN', token_type: 'Bearer' })
    const cfg: McpServerConfig = {
      id, name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', enabled: true,
      auth: { kind: 'oauth' }, source: { kind: 'plugin', plugin: 'linear', marketplace: 'claude-plugins-official', sha: 'abc123' },
      pluginSpec: { url: 'https://mcp.linear.app/mcp' }
    }
    const a = await resolver(cfg)
    expect(a.url).toBe('https://mcp.linear.app/mcp')
    expect(a.authProvider).toBeDefined()
    // il provider lavora sotto cfg.id (serverId === cfg.id): sono i token che
    // salverà connectors:reconnect-server dalla scheda Installati
    await expect(a.authProvider!.tokens()).resolves.toMatchObject({ access_token: 'ACCESS_PLUGIN' })
  })

  it('M2: plugin con HEADER + pluginSpec (github) → NESSUN authProvider (autenticazione statica)', async () => {
    const { resolver, store } = makeResolver()
    const id = serverIdFor({ kind: 'plugin', marketplace: 'mp', plugin: 'github', server: 'github' })
    await saveAsUi(store, id, 'userConfig', { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-1' })
    const cfg: McpServerConfig = {
      id, name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', enabled: true,
      auth: { kind: 'headers' }, source: { kind: 'plugin', plugin: 'github', marketplace: 'mp', sha: 'abc123' },
      pluginSpec: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } }
    }
    const a = await resolver(cfg)
    expect(a.authProvider).toBeUndefined()
    expect(a.headers).toEqual({ Authorization: 'Bearer ghp-1' })
  })

  it('M3: ${VAR} e ${VAR:-default} negli header/url del plugin; l\'ambiente del daemon NON si usa MAI', async () => {
    const { resolver } = makeResolver()
    const id = serverIdFor({ kind: 'plugin', marketplace: 'mp', plugin: 'demo', server: 'api' })
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'VALORE-DELL-AMBIENTE-DEL-DAEMON'
    try {
      const cfg = (over: Partial<McpServerConfig>): McpServerConfig => ({
        id, name: 'api', transport: 'http', url: 'https://api.example/mcp', enabled: true,
        auth: { kind: 'headers' }, source: { kind: 'plugin', plugin: 'demo', marketplace: 'mp', sha: 'abc123' },
        ...over
      })
      // senza valore e SENZA default: rifiuto (niente valore dall'ambiente)
      let no: unknown = null
      try {
        await resolver(cfg({ pluginSpec: { url: 'https://api.example/mcp', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } } }))
      } catch (e) {
        no = e
      }
      expect(no).toBeInstanceOf(Error)
      expect((no as Error).message).toContain('GITHUB_PERSONAL_ACCESS_TOKEN')
      // senza valore e CON default: il default, non l'ambiente del daemon
      const a = await resolver(cfg({ pluginSpec: { url: 'https://api.example/${PORTA:-8080}/mcp' } }))
      expect(a.url).toBe('https://api.example/8080/mcp')
    } finally {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    }
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

// ---- M2/M3 (fase 13 correzioni 2): plugin OAuth dalla scheda Installati e ${VAR} negli header ----

/**
 * M3: un server MCP streamable-http finto che accetta SOLO l'header statico
 * `Authorization: Bearer <token>` (come github col PAT): 401 senza.
 */
async function startHeaderMcp(token: string): Promise<{ url: string; server: Server; saw: string[] }> {
  const saw: string[] = []
  let url = ''
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const auth = req.headers.authorization ?? ''
      const msg = body ? (JSON.parse(body) as { id?: number | null; method?: string }) : null
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32001, message: 'unauthorized' } }))
        return
      }
      saw.push(auth)
      if (msg?.id === undefined || msg.id === null) { res.writeHead(202).end(); return }
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      }
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'header-mcp', version: '1' } })
      if (msg.method === 'tools/list') return reply({ tools: [{ name: 'list_repos', description: 'I repository', inputSchema: { type: 'object', properties: {} } }] })
      reply({})
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
  return { url, server, saw }
}

describe('M2/M3: server di PLUGIN — Connetti dalla scheda Installati e ${VAR} negli header', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sandbot-wiring-m23-'))
  const serversToClose: Server[] = []
  afterAll(() => {
    for (const s of serversToClose) {
      s.closeAllConnections?.()
      s.close()
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Il wiring minimo del test: db reale su tmp, store cifrato, resolver del daemon. */
  async function wire() {
    const { setDataDir, setSetting, getSetting } = await import('../../store/db')
    setDataDir(tmp)
    const mcp = await import('../../mcp')
    const settings = new Map<string, unknown>()
    const store = createConnectorsSecretStore({
      getKey: async () => KEY,
      getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
      setSetting: (key: string, value: unknown) => settings.set(key, value)
    })
    mcp.setMcpAuthResolver(buildMcpAuthResolver({
      store,
      catalog: [],
      getSetting: <T>(key: string, fallback: T): T => (key === 'connectors.oauth.clientMetadataUrl' ? ('' as T) : fallback),
      markNeedsAuth: (id, message) => {
        const states = getSetting<Record<string, Record<string, unknown>>>('connectors.state', {})
        setSetting('connectors.state', { ...states, [id]: { ...(states[id] ?? {}), status: 'needs_auth', error: message } })
      },
      listServers: mcp.listServers,
      saveServers: mcp.saveServers
    }))
    return { mcp, store, setSetting, getSetting }
  }

  it('M2: server http di plugin in needs_auth → reconnectServer fa l\'OAuth e il TOKEN arriva al server finto', async () => {
    const as = await startFakeAs()
    const mcpFake = await startFakeMcp(as.url)
    serversToClose.push(as.server, mcpFake.server)
    const { mcp, store, setSetting, getSetting } = await wire()
    // un server di PLUGIN http OAuth (linear): installato senza token, stato needs_auth
    const cfg: McpServerConfig = {
      id: serverIdFor({ kind: 'plugin', marketplace: 'claude-plugins-official', plugin: 'linear', server: 'linear' }),
      name: 'linear', transport: 'http', url: mcpFake.url, enabled: true, auth: { kind: 'oauth' },
      enabledFor: ['agent_a'], source: { kind: 'plugin', plugin: 'linear', marketplace: 'claude-plugins-official', sha: 'abc123' },
      pluginSpec: { url: mcpFake.url }
    }
    setSetting('mcp.servers', [cfg])
    setSetting('connectors.state', { [cfg.id]: { status: 'needs_auth', error: 'da autorizzare (Impostazioni → Installati → Connetti)' } })
    // il click su "Connetti": reconnectServer col flusso OAuth VERO (loopback)
    // e il "browser" che segue i redirect
    const r = await reconnectServer(cfg.id, {
      store,
      marketplaces: { findPlugin: async () => null, cloneOf: () => null, list: () => [] },
      findRegistryEntry: async () => null,
      listServers: mcp.listServers,
      saveServers: mcp.saveServers,
      toolsOfServer: mcp.toolsOfServer,
      openExternal: async (u) => {
        const resp = await fetch(u, { redirect: 'manual' })
        const location = resp.headers.get('location')
        if (location) await fetch(location).catch(() => undefined)
      },
      hasUi: () => true,
      dockerMode: () => false,
      dataDir: () => tmp,
      onChange: () => undefined
    }, getSetting, setSetting)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.message).toContain('Server linear added')
    // lo stato connettore è tornato connected e il token è arrivato al server
    expect((getSetting<Record<string, { status?: string }>>('connectors.state', {})[cfg.id])?.status).toBe('connected')
    expect(mcpFake.saw.length).toBeGreaterThan(0)
    expect(mcpFake.saw.every((h) => /^Bearer ACCESS_/.test(h))).toBe(true)
  })

  it('M3: github-like — il PAT salvato con la RPC e il kind della UI arriva come header al server finto', async () => {
    const mcpFake = await startHeaderMcp('ghp-finta')
    serversToClose.push(mcpFake.server)
    const { mcp, store, setSetting } = await wire()
    const cfg: McpServerConfig = {
      id: serverIdFor({ kind: 'plugin', marketplace: 'claude-plugins-official', plugin: 'github', server: 'github' }),
      name: 'github', transport: 'http', url: mcpFake.url, enabled: true, auth: { kind: 'headers' },
      enabledFor: ['agent_a'], source: { kind: 'plugin', plugin: 'github', marketplace: 'claude-plugins-official', sha: 'abc123' },
      pluginSpec: { url: mcpFake.url, headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } }
    }
    setSetting('mcp.servers', [cfg])
    // senza il PAT la connessione rifiuta di partire (placeholder mancante)
    await expect(mcp.toolsOfServer(cfg.id)).rejects.toThrow('GITHUB_PERSONAL_ACCESS_TOKEN')
    // la UI salva col kind userConfig (SECRET_KIND_FOR_NEEDS.settings)
    await saveAsUi(store, cfg.id, 'userConfig', { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-finta' })
    const tools = await mcp.toolsOfServer(cfg.id)
    expect(tools.map((t) => t.name)).toEqual(['mcp__github__list_repos'])
    expect(mcpFake.saw.every((h) => h === 'Bearer ghp-finta')).toBe(true)
  })

  it('M2: UnauthorizedError scoperto in ensure() (activeTools) porta il server in needs_auth', async () => {
    const { mcp, setSetting, getSetting } = await wire()
    // il resolver lancia UnauthorizedError alla connessione: prima ensure()
    // lo inghiottiva come errore generico e il bottone non compariva MAI
    mcp.setMcpAuthResolver(async () => { throw new UnauthorizedError('401') })
    const cfg: McpServerConfig = {
      id: serverIdFor({ kind: 'plugin', marketplace: 'mp', plugin: 'demo', server: 'api' }),
      name: 'demo-api', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: true, auth: { kind: 'oauth' },
      enabledFor: ['*'], source: { kind: 'plugin', plugin: 'demo', marketplace: 'mp', sha: 'abc123' },
      pluginSpec: { url: 'http://127.0.0.1:9/mcp' }
    }
    setSetting('mcp.servers', [cfg])
    setSetting('connectors.state', {})
    // activeTools usa ensure(): un errore NON rompe il turno, ma il 401 deve
    // lasciare il segno nello stato del connettore
    await expect(mcp.activeTools()).resolves.toEqual([])
    expect((getSetting<Record<string, { status?: string }>>('connectors.state', {})[cfg.id])?.status).toBe('needs_auth')
    mcp.setMcpAuthResolver(() => ({}))
  })
})
