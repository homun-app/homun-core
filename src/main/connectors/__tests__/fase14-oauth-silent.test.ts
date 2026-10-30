// Fase 14 (punto 0a): la registrazione OAuth avviene SOLO nel flusso
// interattivo. Il provider SILENZIOSO del trasporto (redirect
// http://127.0.0.1:9/callback) NON registra client: senza client salvato la
// connessione rifiuta PRIMA della DCR (l'endpoint /register non viene mai
// chiamato) con UnauthorizedError → il server va in needs_auth col bottone
// Connetti/Riconnetti. authorizeWithLoopback RI-REGISTRA il client quando
// quello salvato non contiene il redirect di questo flusso fra i suoi
// redirect_uris. Con CIMD il provider non throwa (URL-based client id, nessuna
// registrazione necessaria). Stesso authorization server finto della fase 13.
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { buildMcpAuthResolver } from '../wiring'
import { authorizeWithLoopback, createOAuthProvider } from '../oauth-provider'
import { createConnectorsSecretStore, type ConnectorsSecretStore } from '../sealed-store'
import type { McpServerConfig } from '../../mcp'

// ---- authorization server finto (come oauth.test.ts della fase 13) ----

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

interface FakeAs {
  url: string
  server: Server
  clients: Map<string, { redirect_uris: string[] }>
  codes: Map<string, { challenge: string; redirectUri: string; clientId: string }>
  refreshTokens: Set<string>
  authorizeRequests: Array<URL>
  registrations: number
}

async function startFakeAs(): Promise<FakeAs> {
  const as: FakeAs = {
    url: '', server: null as unknown as Server, clients: new Map(), codes: new Map(),
    refreshTokens: new Set(), authorizeRequests: [], registrations: 0
  }
  let n = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: as.url, authorization_servers: [as.url] })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
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
      // questo AS NON accetta porte di loopback non registrate (RFC 8252 §7.3):
      // è il caso reale che la 0a deve sistemare
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
          as.codes.delete(code)
          if (s256(verifier) !== issued.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' })
          const refresh = 'REFRESH_' + randomBytes(4).toString('hex')
          as.refreshTokens.add(refresh)
          return json(200, { access_token: 'ACCESS_' + ++n, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh })
        }
        if (params.get('grant_type') === 'refresh_token') {
          const refresh = params.get('refresh_token') ?? ''
          if (!as.refreshTokens.has(refresh)) return json(400, { error: 'invalid_grant' })
          return json(200, { access_token: 'ACCESS_' + ++n, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh })
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

/** Il "browser": segue il redirect fino al callback server del flusso. */
async function fakeBrowser(url: string): Promise<void> {
  const r = await fetch(url, { redirect: 'manual' })
  const location = r.headers.get('location')
  if (!location) throw new Error(`il browser finto si aspettava un redirect, ha ${r.status}`)
  const done = await fetch(location)
  if (!done.ok) throw new Error(`callback risponde ${done.status}`)
}

// ---- ambiente (store cifrato reale su chiave di prova, settings in memoria) ----

const KEY = randomBytes(32)

function makeEnv(settingsInit: Record<string, unknown> = {}): {
  store: ConnectorsSecretStore
  settings: Map<string, unknown>
  resolver: ReturnType<typeof buildMcpAuthResolver>
} {
  const settings = new Map<string, unknown>(Object.entries(settingsInit))
  const store = createConnectorsSecretStore({
    getKey: async () => KEY,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key: string, value: unknown) => settings.set(key, value)
  })
  const servers: McpServerConfig[] = []
  const resolver = buildMcpAuthResolver({
    store,
    catalog: [],
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    markNeedsAuth: () => undefined,
    listServers: () => servers,
    saveServers: (s) => {
      servers.length = 0
      servers.push(...s)
    }
  })
  return { store, settings, resolver }
}

const REGISTRY_CFG = (id: string): McpServerConfig => ({
  id, name: 'server registro', transport: 'http', url: '', enabled: true,
  auth: { kind: 'oauth' }, source: { kind: 'registry', name: 'com.example/demo' }
})

let as: FakeAs

beforeAll(async () => {
  as = await startFakeAs()
})
afterAll(() => {
  as.server.closeAllConnections?.()
  as.server.close()
})
afterEach(() => {
  as.registrations = 0
  as.authorizeRequests = []
  as.codes.clear()
  as.refreshTokens.clear()
  as.clients.clear()
})

describe('fase 14 0a: il provider SILENZIOSO non registra client (nessuna DCR fuori dal flusso interattivo)', () => {
  it('connessione silenziosa senza client salvato: NESSUNA chiamata a /register, UnauthorizedError (→ needs_auth)', async () => {
    const { resolver } = makeEnv()
    const cfg = REGISTRY_CFG('srv_silent1')
    const a = await resolver(cfg)
    expect(a.authProvider).toBeDefined()
    // è quello che il trasporto chiama sul 401: deve rifiutare PRIMA della DCR
    await expect(auth(a.authProvider!, { serverUrl: as.url })).rejects.toBeInstanceOf(UnauthorizedError)
    // l'endpoint di registrazione NON è mai stato chiamato
    expect(as.registrations).toBe(0)
    // il provider non espone saveClientInformation: nessun percorso può salvare un client
    expect(a.authProvider!.saveClientInformation).toBeUndefined()
  })

  it('con un client salvato (dal flusso interattivo) e i token, il silenzioso continua a funzionare', async () => {
    const { store, resolver } = makeEnv()
    const cfg = REGISTRY_CFG('srv_silent2')
    await store.write(cfg.id, 'oauth.client', { client_id: 'client_dyn_1', redirect_uris: ['http://127.0.0.1:34567/callback'] })
    await store.write(cfg.id, 'oauth.tokens', { access_token: 'ACCESS_FINTO', token_type: 'Bearer', refresh_token: 'REFRESH_VALID' })
    as.clients.set('client_dyn_1', { redirect_uris: ['http://127.0.0.1:34567/callback'] })
    as.refreshTokens.add('REFRESH_VALID')
    const a = await resolver(cfg)
    // il refresh riesce col client salvato: NESSUNA nuova registrazione
    await expect(auth(a.authProvider!, { serverUrl: as.url })).resolves.toBe('AUTHORIZED')
    expect(as.registrations).toBe(0)
  })

  it('CIMD: con clientMetadataUrl il provider silenzioso NON throwa su clientInformation (comportamento invariato)', async () => {
    const { store } = makeEnv({ 'connectors.oauth.clientMetadataUrl': 'https://pages.github.example/sandbot/client.json' })
    const provider = createOAuthProvider({
      serverId: 'srv_cimd', redirectUrl: 'http://127.0.0.1:9/callback',
      openExternal: async () => { throw new Error('browser non disponibile senza la finestra di Homun') },
      store, registration: 'existing-only',
      clientMetadataUrl: 'https://pages.github.example/sandbot/client.json'
    })
    await expect(provider.clientInformation()).resolves.toBeUndefined()
  })
})

describe('fase 14 0a: authorizeWithLoopback RI-REGISTRA il client col redirect di questo flusso', () => {
  it('client salvato col redirect della porta 9 → il flusso interattivo registra di nuovo e completa', async () => {
    const { store } = makeEnv()
    // il client "avvelenato" che il vecchio trasporto silenzioso lasciava in giro
    await store.write('srv_re', 'oauth.client', { client_id: 'client_vecchio', redirect_uris: ['http://127.0.0.1:9/callback'] })
    await authorizeWithLoopback(as.url, (redirectUrl, stateFactory) =>
      createOAuthProvider({
        serverId: 'srv_re', redirectUrl, openExternal: fakeBrowser, store, stateFactory
      })
    )
    // il client vecchio è STATO RI-REGISTRATO: una nuova DCR con il redirect
    // del callback di questo flusso (l'AS finto la conta)
    expect(as.registrations).toBe(1)
    expect(as.authorizeRequests.length).toBe(1)
    // e il client salvato ora ha il redirect del loopback (non più la porta 9)
    const saved = await store.read<{ redirect_uris?: string[] }>('srv_re', 'oauth.client')
    expect(saved?.redirect_uris?.some((u) => /127\.0\.0\.1:\d+\/callback/.test(u) && !u.includes(':9/'))).toBe(true)
    // l'autorizzazione è andata in porto col NUOVO client
    expect(as.authorizeRequests[0]!.searchParams.get('client_id')).toBe('client_dyn_1')
  })

  it('client salvato col redirect GIUSTO → nessuna ri-registrazione inutile', async () => {
    const { store } = makeEnv()
    // prima il flusso vero, che salva il client col redirect del suo callback
    await authorizeWithLoopback(as.url, (redirectUrl, stateFactory) =>
      createOAuthProvider({ serverId: 'srv_ok', redirectUrl, openExternal: fakeBrowser, store, stateFactory })
    )
    expect(as.registrations).toBe(1)
    const firstClient = as.authorizeRequests[0]!.searchParams.get('client_id')
    // secondo flusso: il client salvato contiene già il redirect (porta diversa
    // ma la verifica è sul redirect esatto di QUESTO flusso... qui il redirect
    // CAMBIA a ogni flusso perché la porta cambia) — per provare il "niente
    // ri-registrazione" si salva un client che dichiara ENTRAMBI i redirect
    await store.write('srv_ok', 'oauth.client', {
      client_id: firstClient!,
      redirect_uris: ['http://127.0.0.1:9/callback', 'http://127.0.0.1:1/callback', 'http://127.0.0.1:65535/callback']
    })
    as.registrations = 0
    // il provider finto di questo test dichiara il redirect GIUSTO già letto
    // dal client salvato? authorizeWithLoopback confronta col SUO callback: si
    // costruisce un providerFor che usa un client con TUTTI i redirect (come
    // farebbe un AS che li accetta) — nessuna DCR in più
    await authorizeWithLoopback(as.url, (redirectUrl, stateFactory) => {
      const provider = createOAuthProvider({ serverId: 'srv_ok', redirectUrl, openExternal: fakeBrowser, store, stateFactory })
      return {
        ...provider,
        clientInformation: async () => {
          const saved = await store.read<{ client_id: string; redirect_uris?: string[] }>('srv_ok', 'oauth.client')
          // il client "dichiara" anche il redirect di questo flusso (AS permissivo)
          return saved ? { ...saved, redirect_uris: [...new Set([...(saved.redirect_uris ?? []), redirectUrl])] } : undefined
        }
      }
    })
    expect(as.registrations).toBe(0)
  })
})
