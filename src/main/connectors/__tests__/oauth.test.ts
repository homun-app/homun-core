// Test del flusso OAuth dei connettori (fase 5) contro un authorization server
// FITTIZIO in memoria su 127.0.0.1: discovery (RFC 9728/8414), Dynamic Client
// Registration (RFC 7591), PKCE S256, scambio del codice sul callback di
// loopback (con verifica dello state), refresh riuscito e refresh fallito →
// invalidazione dei token (needs_auth). Il "browser" è un fetch che segue il
// redirect dell'AS fino al callback server reale: nessuna rete esterna.
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { startCallbackServer } from '../callback-server'
import { createOAuthProvider } from '../oauth-provider'
import { createConnectorsSecretStore } from '../sealed-store'
import { createConnectorsManager, type CatalogEntry } from '../index'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'

// ---- authorization server finto ----

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

interface FakeAs {
  url: string
  server: Server
  /** client registrati via DCR */
  clients: Map<string, { redirect_uris: string[] }>
  /** codici emessi: code → { challenge, redirectUri, clientId } */
  codes: Map<string, { challenge: string; redirectUri: string; clientId: string }>
  /** refresh token validi */
  refreshTokens: Set<string>
  /** access token correnti (per assertion) */
  accessTokens: string[]
  authorizeRequests: Array<URL>
  registrations: number
  rejectRefresh: boolean
}

async function startFakeAs(): Promise<FakeAs> {
  const as: FakeAs = {
    url: '',
    server: null as unknown as Server,
    clients: new Map(),
    codes: new Map(),
    refreshTokens: new Set(),
    accessTokens: [],
    authorizeRequests: [],
    registrations: 0,
    rejectRefresh: false
  }
  let n = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, {
        resource: as.url,
        authorization_servers: [as.url]
      })
    }
    if (req.method === 'GET' && (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration'))) {
      return json(200, {
        issuer: as.url,
        authorization_endpoint: `${as.url}/authorize`,
        token_endpoint: `${as.url}/token`,
        registration_endpoint: `${as.url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      })
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        as.registrations++
        const meta = JSON.parse(body) as { redirect_uris?: string[] }
        const clientId = 'client_dyn_' + as.registrations
        as.clients.set(clientId, { redirect_uris: meta.redirect_uris ?? [] })
        json(201, { client_id: clientId, redirect_uris: meta.redirect_uris ?? [] })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
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
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const params = new URLSearchParams(body)
        if (params.get('grant_type') === 'authorization_code') {
          const code = params.get('code') ?? ''
          const verifier = params.get('code_verifier') ?? ''
          const issued = as.codes.get(code)
          if (!issued) return json(400, { error: 'invalid_grant' })
          as.codes.delete(code) // il codice è monouso
          if (s256(verifier) !== issued.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' })
          const access = 'ACCESS_' + ++n
          const refresh = 'REFRESH_' + randomBytes(4).toString('hex')
          as.refreshTokens.add(refresh)
          as.accessTokens.push(access)
          return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh })
        }
        if (params.get('grant_type') === 'refresh_token') {
          const refresh = params.get('refresh_token') ?? ''
          if (as.rejectRefresh || !as.refreshTokens.has(refresh)) {
            return json(400, { error: 'invalid_grant' })
          }
          const access = 'ACCESS_' + ++n
          as.accessTokens.push(access)
          return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh })
        }
        json(400, { error: 'unsupported_grant_type' })
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  as.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  as.server = server
  return as
}

/** Il "browser": apre l'URL di autorizzazione e segue il redirect fino al callback. */
async function fakeBrowser(url: string): Promise<void> {
  const r = await fetch(url, { redirect: 'manual' })
  const location = r.headers.get('location')
  if (!location) throw new Error(`il browser finto si aspettava un redirect, ha ${r.status}`)
  const done = await fetch(location)
  if (!done.ok) throw new Error(`callback risponde ${done.status}`)
}

// ---- ambiente del manager (store cifrato reale, settings in memoria) ----

const KEY = randomBytes(32)

function makeEnv(as: FakeAs, hasUi = true) {
  const settings = new Map<string, unknown>()
  const store = createConnectorsSecretStore({
    getKey: async () => KEY,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key: string, value: unknown) => {
      settings.set(key, value)
    }
  })
  const registered: Array<{ id: string; name: string; url: string }> = []
  let uiOpen = hasUi
  const manager = createConnectorsManager({
    store,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key: string, value: unknown) => {
      settings.set(key, value)
    },
    openExternal: fakeBrowser,
    hasUi: () => uiOpen,
    toolsOf: async () => [
      { name: 'mcp__fake__search', description: 'cerca', annotations: { readOnlyHint: true } }
    ],
    registerServer: (cfg) => registered.push(cfg),
    removeServer: (id) => {
      const i = registered.findIndex((r) => r.id === id)
      if (i >= 0) registered.splice(i, 1)
    },
    serverExists: (id) => registered.some((r) => r.id === id),
    onChange: () => undefined
  })
  return { settings, store, registered, manager, setUi: (v: boolean) => (uiOpen = v) }
}

const ENTRY: CatalogEntry = {
  id: 'fake',
  name: 'FakeApp',
  logo: '🔧',
  mcpUrl: '', // as.url, impostato nel beforeAll
  clientRegistration: 'dynamic',
  docsUrl: 'https://example.com/docs',
  notes: 'server di test'
}

let as: FakeAs

beforeAll(async () => {
  as = await startFakeAs()
  ENTRY.mcpUrl = as.url + '/'
})
afterAll(() => {
  as.server.closeAllConnections?.()
  as.server.close()
})
afterEach(() => {
  as.rejectRefresh = false
  // lo stato dell'AS è condiviso tra i test del file: si azzera qui
  as.registrations = 0
  as.authorizeRequests = []
  as.accessTokens = []
  as.codes.clear()
  as.refreshTokens.clear()
  as.clients.clear()
})

describe('flusso OAuth completo (discovery + DCR + PKCE + loopback + refresh)', () => {
  it('connect: discovery, registrazione dinamica, PKCE S256, scambio del codice, token CIFRATI', async () => {
    const { settings, registered, manager } = makeEnv(as)
    const r = await manager.runConnect(ENTRY)
    expect(r.status).toBe('connected')
    // il connettore è diventato un server MCP e lo stato è connesso
    expect(registered).toEqual([{ id: 'fake', name: 'FakeApp', url: ENTRY.mcpUrl }])
    expect(manager.stateOf('fake').status).toBe('connected')
    // DCR: il client è stato registrato dall'AS
    expect(as.registrations).toBe(1)
    // PKCE S256 verificato dall'AS (authorize con challenge + method)
    expect(as.authorizeRequests.length).toBe(1)
    expect(as.authorizeRequests[0]!.searchParams.get('code_challenge_method')).toBe('S256')
    // il codice è stato speso una volta sola
    expect(as.codes.size).toBe(0)
    // NESSUN token in chiaro nei settings: solo envelope sandVault
    const raw = JSON.stringify([...settings.values()])
    expect(raw).not.toContain('ACCESS_1')
    expect(raw).toContain('sandVault')
    // il refresh token è nell'AS finto (prova che lo scambio è riuscito)
    expect(as.refreshTokens.size).toBe(1)
  })

  it('refresh riuscito: auth() di nuovo → AUTHORIZED senza browser, nuovo token cifrato', async () => {
    const { store, manager } = makeEnv(as)
    await manager.runConnect(ENTRY)
    const before = JSON.stringify(await settingsSnapshot(store, 'fake'))
    // provider "silenzioso" come quello del trasporto: niente browser
    const provider = createOAuthProvider({
      serverId: 'fake',
      redirectUrl: 'http://127.0.0.1:9/callback',
      openExternal: async () => {
        throw new Error('il browser non doveva aprirsi per un refresh')
      },
      store
    })
    const result = await auth(provider, { serverUrl: ENTRY.mcpUrl })
    expect(result).toBe('AUTHORIZED')
    const after = JSON.stringify(await settingsSnapshot(store, 'fake'))
    expect(after).not.toBe(before) // i token sono cambiati (nuovo access token)
    expect(as.accessTokens.length).toBeGreaterThanOrEqual(2)
  })

  it('refresh fallito → invalidazione dei token (needs_auth) e nessun browser', async () => {
    const { store, manager } = makeEnv(as)
    await manager.runConnect(ENTRY)
    as.rejectRefresh = true
    const invalidated: string[] = []
    const provider = createOAuthProvider(
      {
        serverId: 'fake',
        redirectUrl: 'http://127.0.0.1:9/callback',
        openExternal: async () => {
          throw new Error('browser non disponibile')
        },
        store
      },
      (scope) => invalidated.push(scope)
    )
    // il refresh è rifiutato: auth() invalida i token e riprova una nuova
    // autorizzazione, che senza browser fallisce
    await expect(auth(provider, { serverUrl: ENTRY.mcpUrl })).rejects.toThrow(/browser/)
    expect(invalidated).toContain('tokens')
    expect(await store.read('fake', 'oauth.tokens')).toBeUndefined()
    // il manager espone lo stato che ne deriva (card "Riconnetti") — su un
    // connettore del catalogo reale (markNeedsAuth ignora gli id sconosciuti)
    manager.markNeedsAuth('cloudflare', 'Sessione scaduta: riconnetti')
    expect(manager.stateOf('cloudflare').status).toBe('needs_auth')
  })

  it('senza UI il connettore resta needs_auth; alla riapertura la connessione riparte', async () => {
    const { manager, setUi } = makeEnv(as, false)
    const r = await manager.runConnect(ENTRY)
    expect(r.status).toBe('needs_auth')
    expect(manager.stateOf('fake').status).toBe('needs_auth')
    expect(as.registrations).toBe(0) // nessun flusso partito senza browser
    expect(as.authorizeRequests.length).toBe(0)
    // l'utente apre la finestra: le autorizzazioni rinviate ripartono
    setUi(true)
    manager.retryPendingAuth()
    const deadline = Date.now() + 10_000
    while (manager.stateOf('fake').status !== 'connected' && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 50))
    }
    expect(manager.stateOf('fake').status).toBe('connected')
    expect(as.registrations).toBe(1)
  })

  it('disconnect: revoca LOCALE (token cancellati, server rimosso, stato non connesso)', async () => {
    const { store, registered, manager } = makeEnv(as)
    await manager.runConnect(ENTRY)
    await manager.disconnect('fake')
    expect(await store.read('fake', 'oauth.tokens')).toBeUndefined()
    expect(await store.read('fake', 'oauth.client')).toBeUndefined()
    expect(registered).toEqual([])
    expect(manager.stateOf('fake').status).toBe('not_connected')
  })
})

/** Snapshot dei campi sealed di un server (per confronto prima/dopo). */
async function settingsSnapshot(store: ReturnType<typeof createConnectorsSecretStore>, id: string): Promise<unknown> {
  return {
    tokens: await store.read(id, 'oauth.tokens'),
    client: await store.read(id, 'oauth.client')
  }
}
