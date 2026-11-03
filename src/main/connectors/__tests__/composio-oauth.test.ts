// Test OAuth (C1): il login di Composio contro un authorization server FINTO
// che rifà i metadati VERI del server «For You» (verificati dal revisore il
// 2026-11-03): 401 con resource_metadata → authorization_servers → metadati
// con authorization_endpoint, token_endpoint, registration_endpoint (DCR),
// S256, token_endpoint_auth_methods [none] (client pubblico) e i quattro
// scope. Si verifica che la richiesta di autorizzazione porti
// resource=<url del server MCP> e i 4 scope (con prompt=consent per
// offline_access), che il token sia salvato CIFRATO nello store e che il
// refresh parta quando serve. Inoltre la voce di catalogo: l'override
// SANDBOT_TEST_COMPOSIO_MCP_URL (solo insieme a SANDBOT_TEST_USER_DATA) e il
// flag gateway validato.
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createOAuthProvider } from '../oauth-provider'
import { createConnectorsSecretStore } from '../sealed-store'
import { createConnectorsManager, loadCatalog, validateCatalog, type CatalogEntry } from '../index'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import catalogJson from '../catalog.json'

// ---- il server MCP finto «For You»: 401 con resource_metadata (RFC 9728) ----

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** L'authorization server finto con i metadati VERI di Composio (forma, non host). */
function startFakeAs(): Promise<{
  url: string
  server: Server
  clients: Map<string, { redirect_uris: string[]; meta: Record<string, unknown> }>
  codes: Map<string, { challenge: string; redirectUri: string; clientId: string }>
  refreshTokens: Set<string>
  accessTokens: string[]
  authorizeRequests: Array<URL>
  tokenRequests: Array<URLSearchParams>
}> {
  const as = {
    url: '',
    server: null as unknown as Server,
    clients: new Map<string, { redirect_uris: string[]; meta: Record<string, unknown> }>(),
    codes: new Map<string, { challenge: string; redirectUri: string; clientId: string }>(),
    refreshTokens: new Set<string>(),
    accessTokens: [] as string[],
    authorizeRequests: [] as Array<URL>,
    tokenRequests: [] as Array<URLSearchParams>
  }
  let n = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    // i metadati dell'authorization server: la FORMA di login.composio.dev
    if (req.method === 'GET' && (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration'))) {
      return json(200, {
        issuer: as.url,
        authorization_endpoint: `${as.url}/oauth/authorize`,
        token_endpoint: `${as.url}/oauth2/token`,
        registration_endpoint: `${as.url}/oauth2/register`,
        jwks_uri: `${as.url}/oauth2/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access']
      })
    }
    if (req.method === 'POST' && url.pathname === '/oauth2/register') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const meta = JSON.parse(body) as { redirect_uris?: string[] }
        const clientId = 'client_dyn_' + ++n
        as.clients.set(clientId, { redirect_uris: meta.redirect_uris ?? [], meta })
        json(201, { client_id: clientId, redirect_uris: meta.redirect_uris ?? [] })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      as.authorizeRequests.push(url)
      const clientId = url.searchParams.get('client_id') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const challenge = url.searchParams.get('code_challenge') ?? ''
      const method = url.searchParams.get('code_challenge_method') ?? ''
      const state = url.searchParams.get('state') ?? ''
      if (!as.clients.has(clientId)) return json(400, { error: 'unauthorized_client' })
      if (!as.clients.get(clientId)!.redirect_uris.includes(redirectUri)) return json(400, { error: 'invalid_request', error_description: 'redirect_uri' })
      if (!challenge || method !== 'S256') return json(400, { error: 'invalid_request', error_description: 'pkce' })
      const code = 'code_' + randomBytes(6).toString('hex')
      as.codes.set(code, { challenge, redirectUri, clientId })
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` }).end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const params = new URLSearchParams(body)
        as.tokenRequests.push(params)
        if (params.get('grant_type') === 'authorization_code') {
          const issued = as.codes.get(params.get('code') ?? '')
          if (!issued) return json(400, { error: 'invalid_grant' })
          as.codes.delete(params.get('code')!)
          if (s256(params.get('code_verifier') ?? '') !== issued.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' })
          const access = 'ACCESS_' + ++n
          const refresh = 'REFRESH_' + randomBytes(4).toString('hex')
          as.refreshTokens.add(refresh)
          as.accessTokens.push(access)
          // come Composio: bearer, expires_in 3600, refresh token presente
          return json(200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh })
        }
        if (params.get('grant_type') === 'refresh_token') {
          const refresh = params.get('refresh_token') ?? ''
          if (!as.refreshTokens.has(refresh)) return json(400, { error: 'invalid_grant' })
          const access = 'ACCESS_' + ++n
          as.accessTokens.push(access)
          return json(200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh })
        }
        json(400, { error: 'unsupported_grant_type' })
      })
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      as.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
      as.server = server
      resolve(as)
    })
  })
}

/** Il "browser": apre l'URL di autorizzazione e segue il redirect fino al callback. */
async function fakeBrowser(url: string): Promise<void> {
  const r = await fetch(url, { redirect: 'manual' })
  const location = r.headers.get('location')
  if (!location) throw new Error(`il browser finto si aspettava un redirect, ha ${r.status}`)
  const done = await fetch(location)
  if (!done.ok) throw new Error(`callback risponde ${done.status}`)
}

let as: Awaited<ReturnType<typeof startFakeAs>>
let resourceServer: Server
let mcpUrl = ''

beforeAll(async () => {
  as = await startFakeAs()
  // il server MCP «For You»: risponde 401 col resource_metadata che punta al AS
  resourceServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        resource: mcpUrl,
        authorization_servers: [as.url]
      }))
      return
    }
    res.writeHead(401, {
      'www-authenticate': `Bearer resource_metadata="${mcpUrl.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource"`
    }).end()
  })
  await new Promise<void>((resolve) => resourceServer.listen(0, '127.0.0.1', resolve))
  const address = resourceServer.address()
  mcpUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`
  // l'override della sonda: valido SOLO insieme a SANDBOT_TEST_USER_DATA
  process.env.SANDBOT_TEST_COMPOSIO_MCP_URL = mcpUrl
  process.env.SANDBOT_TEST_USER_DATA = '/tmp/sandbot-test-oauth'
})
afterAll(() => {
  delete process.env.SANDBOT_TEST_COMPOSIO_MCP_URL
  delete process.env.SANDBOT_TEST_USER_DATA
  resourceServer.closeAllConnections?.()
  resourceServer.close()
  as.server.closeAllConnections?.()
  as.server.close()
})
afterEach(() => {
  as.authorizeRequests = []
  as.tokenRequests = []
  as.accessTokens = []
  as.codes.clear()
  as.refreshTokens.clear()
  as.clients.clear()
})

const KEY = randomBytes(32)

function makeEnv() {
  const settings = new Map<string, unknown>()
  const store = createConnectorsSecretStore({
    getKey: async () => KEY,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key: string, value: unknown) => settings.set(key, value)
  })
  const registered: Array<{ id: string; name: string; url: string }> = []
  const manager = createConnectorsManager({
    store,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key: string, value: unknown) => settings.set(key, value),
    openExternal: fakeBrowser,
    hasUi: () => true,
    toolsOf: async () => [],
    registerServer: (cfg) => registered.push(cfg),
    removeServer: (id) => {
      const i = registered.findIndex((r) => r.id === id)
      if (i >= 0) registered.splice(i, 1)
    },
    serverExists: (id) => registered.some((r) => r.id === id),
    onChange: () => undefined
  })
  return { settings, store, registered, manager }
}

describe('C1 — la voce di catalogo', () => {
  it('valida: mcpUrl https, DCR dinamica, i 4 scope (senza offline_access niente refresh), gateway true', () => {
    expect(validateCatalog(catalogJson)).toEqual([])
    // i valori di PRODUZIONE si leggono senza gli env della sonda
    const savedUrl = process.env.SANDBOT_TEST_COMPOSIO_MCP_URL
    const savedData = process.env.SANDBOT_TEST_USER_DATA
    delete process.env.SANDBOT_TEST_COMPOSIO_MCP_URL
    delete process.env.SANDBOT_TEST_USER_DATA
    const entry = loadCatalog().find((e) => e.id === 'composio') as CatalogEntry & { gateway?: boolean }
    expect(entry).toBeDefined()
    expect(entry.mcpUrl).toBe('https://connect.composio.dev/mcp')
    expect(entry.clientRegistration).toBe('dynamic')
    expect(entry.scopes).toEqual(['openid', 'profile', 'email', 'offline_access'])
    expect(entry.gateway).toBe(true)
    process.env.SANDBOT_TEST_COMPOSIO_MCP_URL = savedUrl
    process.env.SANDBOT_TEST_USER_DATA = savedData
  })

  it('gateway non booleano → errore di validazione', () => {
    const broken = (catalogJson as unknown as Array<Record<string, unknown>>).map((c) =>
      c.id === 'composio' ? { ...c, gateway: 'sì' } : c
    )
    expect(validateCatalog(broken).some((e) => e.includes('gateway'))).toBe(true)
  })

  it('SANDBOT_TEST_COMPOSIO_MCP_URL punta la voce al server finto, SOLO con SANDBOT_TEST_USER_DATA', () => {
    expect(loadCatalog().find((e) => e.id === 'composio')!.mcpUrl).toBe(mcpUrl)
    // le altre voci non cambiano
    expect(loadCatalog().find((e) => e.id === 'cloudflare')!.mcpUrl).toBe('https://mcp.cloudflare.com/mcp')
    // senza SANDBOT_TEST_USER_DATA l'override NON vale (mai un http locale in produzione)
    const saved = process.env.SANDBOT_TEST_USER_DATA
    delete process.env.SANDBOT_TEST_USER_DATA
    expect(loadCatalog().find((e) => e.id === 'composio')!.mcpUrl).toBe('https://connect.composio.dev/mcp')
    process.env.SANDBOT_TEST_USER_DATA = saved
  })
})

describe('C1 — il login OAuth contro l’AS finto con i metadati veri', () => {
  it('la richiesta di autorizzazione porta resource=<server MCP> e i 4 scope (PKCE S256, client pubblico)', async () => {
    const { manager } = makeEnv()
    const entry = loadCatalog().find((e) => e.id === 'composio')!
    const r = await manager.runConnect(entry)
    expect(r.status).toBe('connected')
    expect(as.authorizeRequests).toHaveLength(1)
    const q = as.authorizeRequests[0]!
    expect(q.searchParams.get('resource')).toBe(mcpUrl)
    expect(q.searchParams.get('scope')).toBe('openid profile email offline_access')
    expect(q.searchParams.get('code_challenge_method')).toBe('S256')
    // offline_access → l'SDK aggiunge prompt=consent (come lo scopre il revisore)
    expect(q.searchParams.get('prompt')).toBe('consent')
    // client PUBBLICO: token_endpoint_auth_methods [none], niente client_secret
    expect([...as.clients.values()].every((c) => c.meta.token_endpoint_auth_method === 'none')).toBe(true)
  })

  it('dopo il riscatto il token è salvato CIFRATO (envelope sandVault, mai in chiaro nei settings)', async () => {
    const { settings, manager } = makeEnv()
    const entry = loadCatalog().find((e) => e.id === 'composio')!
    const r = await manager.runConnect(entry)
    expect(r.status).toBe('connected')
    const raw = JSON.stringify([...settings.values()])
    expect(raw).not.toMatch(/ACCESS_\d+/)
    expect(raw).toContain('sandVault')
    // e c'è un refresh token (lo scope offline_access) dentro l'envelope
    expect(as.refreshTokens.size).toBe(1)
  })

  it('il refresh parte allo scadere: auth() di nuovo → AUTHORIZED senza browser, grant refresh_token', async () => {
    const env = makeEnv()
    const entry = loadCatalog().find((e) => e.id === 'composio')!
    const connected = await env.manager.runConnect(entry)
    expect(connected.status).toBe('connected')
    const before = as.accessTokens.length
    // il provider "silenzioso" del trasporto: niente browser, solo refresh
    const provider = createOAuthProvider({
      serverId: 'composio',
      redirectUrl: 'http://127.0.0.1:9/callback',
      scope: entry.scopes?.join(' '),
      openExternal: async () => {
        throw new Error('il browser non doveva aprirsi per un refresh')
      },
      store: env.store
    })
    const result = await auth(provider, { serverUrl: entry.mcpUrl })
    expect(result).toBe('AUTHORIZED')
    expect(as.tokenRequests.some((p) => p.get('grant_type') === 'refresh_token')).toBe(true)
    expect(as.accessTokens.length).toBeGreaterThan(before)
  })
})
