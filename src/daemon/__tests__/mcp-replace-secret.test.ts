// PP2 (fase plugin-pulita): il token di un server si cambia DOVE VIVE il
// server — l'RPC stretta mcp:replace-secret(id, secret) del daemon. Scrive
// solo il segreto cifrato (lo stesso sealed-store e gli stessi SECRET_KIND di
// mcp:save), non tocca nient'altro della config, aggiorna auth.kind, pulisce
// needsReauth / needsAuth quando ora c'è tutto, poi il test di connessione
// parte da solo (come U5 di mcp:save). La scrittura del segreto è una
// funzione PURA condivisa con mcp:save (planServerSecret + il suo apply):
// niente copia. Store vero su cartella mkdtemp di TEST_TMP_BASE, chiave e
// safeStorage FINTI (mai il Portachiavi vero), server MCP finti su
// 127.0.0.1 e su stdio (nessuna rete fuori, nessun Docker). I valori dei
// token di prova sono stringhe qualunque dei test: non finiscono in nessun
// log (qui si contano le richieste, non si stampano).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { setDataDir, db, setSetting, getSetting } from '../../main/store/db'
import { buildApiMethods } from '../api'
import { setMasterKeyStorage, safeStorageBackendForEnv, MasterKeyUnavailableError, isMasterKeyUnavailableError } from '../master-keys'
import { getConnectorsKey } from '../keychain'
import { createConnectorsSecretStore, type ConnectorsSecretStore } from '../../main/connectors/sealed-store'
import { buildMcpAuthResolver } from '../../main/connectors/wiring'
import * as mcp from '../../main/mcp'
import { SECRET_KIND, type McpServerInfo, type McpServerSecret } from '../../shared/types'
import type { JobWorker } from '../worker'
import { TEST_TMP_BASE } from '../../test-tmp'

type Handler = (params: unknown[]) => Promise<unknown>
const API = readFileSync(fileURLToPath(new URL('../api.ts', import.meta.url)), 'utf8')

let dir: string
let http: Server
let httpPort = 0
/** Le intestazioni Authorization arrivate al server http finto, nell'ordine (per contare, mai per stampare). */
const seen: Array<{ auth: string | undefined; xa: string | undefined; xb: string | undefined }> = []
/** Il token che il server http finto accetta. */
const BUONO = 'token-buono-di-prova'
const VECCHIO = 'token-vecchio-di-prova'

/** Il server MCP http FINTO: 401 a chi non porta il bearer buono (e le due intestazioni). */
const startHttpFake = (): Promise<void> => new Promise((resolve) => {
  http = createServer((req, res) => {
    const auth = req.headers.authorization
    seen.push({ auth, xa: req.headers['x-a'] as string | undefined, xb: req.headers['x-b'] as string | undefined })
    const okBearer = auth === `Bearer ${BUONO}`
    const okHeaders = req.headers['x-a'] === 'uno' && req.headers['x-b'] === 'due-nuovo'
    if (!okBearer && !okHeaders) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let msg: { id?: unknown; method?: string } = {}
      try { msg = JSON.parse(body) } catch { /* non JSON */ }
      if (msg.id === undefined) { res.writeHead(202); res.end(); return }
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'finto', version: '1' } }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'chiama', description: 'x', inputSchema: { type: 'object' } }] }
          : {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })
  void http.listen(0, '127.0.0.1', () => { httpPort = (http.address() as { port: number }).port; resolve() })
})

/** Il server MCP stdio FINTO: esce subito (codice 2) se la variabile TOKEN non è quella attesa. */
const STDIO_MCP = (attesa: string): string => [
  `if (process.env.TOKEN !== ${JSON.stringify(attesa)}) process.exit(2)`,
  "const rl = require('node:readline').createInterface({ input: process.stdin })",
  "rl.on('line', (line) => {",
  '  let m; try { m = JSON.parse(line) } catch { return }',
  '  if (m.id === undefined) return',
  "  const r = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'finto', version: '1' } }",
  "    : m.method === 'tools/list' ? { tools: [{ name: 'uno', description: 'x', inputSchema: { type: 'object' } }] } : {}",
  "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }) + '\\n')",
  '})'
].join('\n')

const events: unknown[] = []
let api: Record<string, Handler>
let sealed: ConnectorsSecretStore

const server = (id: string): McpServerInfo | undefined => (mcp.listServers() as unknown as McpServerInfo[]).find((s) => s.id === id)
const secretsSetting = (): string => JSON.stringify(getSetting('connectors.secrets', {}))
/** La config del server senza i campi che l'RPC può cambiare (auth, needsReauth, needsAuth) e senza la prova P7 della prima connessione http riuscita. */
const stable = (s: McpServerInfo | undefined): string => {
  if (!s) return 'assente'
  const { auth: _a, needsReauth: _r, needsAuth: _n, firstOkAt: _f, ...rest } = s
  void _a; void _r; void _n; void _f
  return JSON.stringify(rest)
}

beforeAll(async () => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mcp-replace-secret-'))
  setDataDir(dir)
  db()
  // i testi del catalogo UI nei test restano italiani (come prima della 17c)
  setSetting('ui.activeLanguage', 'it')
  // Keychain e safeStorage FINTI (mai i veri)
  process.env.SANDBOT_TEST_FAKE_KEYCHAIN = join(dir, 'fake-keychain.json')
  setMasterKeyStorage(safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'fake-safestorage.json') }))
  await startHttpFake()
  api = buildApiMethods((e: unknown) => events.push(e), { poke: () => undefined } as unknown as JobWorker) as Record<string, Handler>
  sealed = createConnectorsSecretStore({ getKey: () => getConnectorsKey(), getSetting, setSetting })
  // il resolver VERO, come lo collega il daemon (wireConnectors): senza, nei test non si manda nessuna credenziale
  mcp.setMcpAuthResolver(buildMcpAuthResolver({
    store: sealed,
    catalog: [],
    getSetting,
    markNeedsAuth: () => undefined,
    listServers: mcp.listServers,
    saveServers: mcp.saveServers
  }))
})
afterAll(() => {
  mcp.setMcpAuthResolver(() => ({}))
  delete process.env.SANDBOT_TEST_FAKE_KEYCHAIN
  rmSync(dir, { recursive: true, force: true })
  return new Promise<void>((r) => http.close(() => r()))
})
beforeEach(() => {
  seen.length = 0
  setSetting('mcp.servers', [])
  setSetting('connectors.state', {})
  setSetting('connectors.secrets', {})
  setSetting('mcp.serverNotifiedState', {})
})

/**
 * Il test di connessione U5 di mcp:save parte in BACKGROUND (fire-and-forget):
 * una richiesta in ritardo di un test finirebbe nel conteggio delle richieste
 * del test dopo. `save` è mcp:save come lo chiama la UI, col test automatico
 * ATTESO: lo stato notificato (mcp.serverNotifiedState) si scrive per ultimo.
 */
const waitAutoTest = async (id: string): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (getSetting<Record<string, string>>('mcp.serverNotifiedState', {})[id] !== undefined) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`il test automatico di ${id} non è finito entro 5 s`)
}
const save = async ([cfg, secret]: [McpServerInfo, McpServerSecret?]): Promise<unknown> => {
  const out = await api['mcp:save']!([cfg, secret])
  if (cfg.enabled) await waitAutoTest(cfg.id)
  return out
}
const replace = (id: string, secret: McpServerSecret): Promise<{ ok: boolean; test: { ok: boolean; tools?: string[]; error?: string } | null }> =>
  api['mcp:replace-secret']!([id, secret]) as Promise<{ ok: boolean; test: { ok: boolean; tools?: string[]; error?: string } | null }>

describe('PP2 — mcp:replace-secret: il bearer', () => {
  it('il sealed-store ha il token nuovo, la config è identica (a parte auth/needsReauth), il test di connessione parte da solo e passa', async () => {
    const cfg: McpServerInfo = { id: 'srv-http', name: 'http', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }
    // registrato col token VECCHIO, da mcp:save (la funzione condivisa, lato save)
    await save([cfg, { bearerToken: VECCHIO }])
    expect(server('srv-http')?.auth).toEqual({ kind: 'bearer' })
    expect(await sealed.read('srv-http', SECRET_KIND.bearer)).toBe(VECCHIO)
    seen.length = 0
    expect(await mcp.testServer('srv-http')).toMatchObject({ ok: false })
    expect(getSetting<Record<string, { status: string }>>('connectors.state', {})['srv-http']?.status).toBe('error')
    const before = stable(server('srv-http'))

    seen.length = 0
    const r = await replace('srv-http', { bearerToken: BUONO })

    // il test è PARTITO da solo: una richiesta col token nuovo, nessuna col vecchio
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every((s) => s.auth === `Bearer ${BUONO}`), seen.map((s) => (s.auth === `Bearer ${BUONO}` ? 'buono' : s.auth ? 'un altro token' : 'senza token')).join(', ')).toBe(true)
    // l'esito torna alla UI («collegato» / il motivo)
    expect(r.ok).toBe(true)
    expect(r.test?.ok, r.test?.error).toBe(true)
    expect(r.test?.tools).toEqual(['mcp__http__chiama'])
    // lo store cifrato ha il token nuovo
    expect(await sealed.read('srv-http', SECRET_KIND.bearer)).toBe(BUONO)
    // la config: identica a parte auth/needsReauth/needsAuth (e la prova P7 della prima connessione riuscita)
    expect(stable(server('srv-http'))).toBe(before)
    expect(server('srv-http')?.auth).toEqual({ kind: 'bearer' })
    expect(typeof server('srv-http')?.firstOkAt).toBe('number')
    // lo stato dell'ultima prova non è più errore
    expect(getSetting<Record<string, { status: string }>>('connectors.state', {})['srv-http']?.status).not.toBe('error')
    expect(events.some((e) => (e as { type?: string }).type === 'connectors')).toBe(true)
  })

  it('un token che non va: il segreto si salva lo stesso e il test dice perché (l\'errore arriva alla UI)', async () => {
    await save([{ id: 'srv-http2', name: 'http2', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }, { bearerToken: VECCHIO }])
    const r = await replace('srv-http2', { bearerToken: 'non-e-il-buono' })
    expect(r.ok).toBe(true)
    expect(r.test?.ok).toBe(false)
    expect(r.test?.error).toMatch(/unauthorized/)
    expect(await sealed.read('srv-http2', SECRET_KIND.bearer)).toBe('non-e-il-buono')
    expect(getSetting<Record<string, { status: string }>>('connectors.state', {})['srv-http2']?.status).toBe('error')
  })

  it('un server SPENTO: il segreto si cambia, il test non parte (come U5) e la config resta spenta', async () => {
    await save([{ id: 'srv-off', name: 'off', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: false, disabledReason: 'user', enabledFor: ['*'] }])
    seen.length = 0
    const r = await replace('srv-off', { bearerToken: BUONO })
    expect(seen).toHaveLength(0)
    expect(r.test).toBeNull()
    expect(await sealed.read('srv-off', SECRET_KIND.bearer)).toBe(BUONO)
    expect(server('srv-off')).toMatchObject({ enabled: false, disabledReason: 'user', auth: { kind: 'bearer' } })
  })
})

describe('PP2 — mcp:replace-secret: le intestazioni', () => {
  it('sostituisce SOLO la chiave scritta: le altre restano; auth diventa headers; il test usa quelle fuse', async () => {
    await save([{ id: 'srv-h', name: 'h', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }, { headers: { 'X-A': 'uno', 'X-B': 'due-vecchio' } }])
    expect(server('srv-h')?.auth).toEqual({ kind: 'headers' })
    const r = await replace('srv-h', { headers: { 'X-B': 'due-nuovo' } })
    expect(await sealed.read('srv-h', SECRET_KIND.headers)).toEqual({ 'X-A': 'uno', 'X-B': 'due-nuovo' })
    expect(r.test?.ok, r.test?.error).toBe(true)
    expect(server('srv-h')?.auth).toEqual({ kind: 'headers' })
  })
})

describe('PP2 — mcp:replace-secret: le variabili segrete (stdio)', () => {
  it('fonde con i valori vecchi, una chiave per volta, e arrivano al processo (il test passa col valore nuovo)', async () => {
    const cfg: McpServerInfo = {
      id: 'srv-env', name: 'env', transport: 'stdio', command: process.execPath, args: ['-e', STDIO_MCP('env-nuovo')],
      enabled: true, enabledFor: ['*'],
      envSpec: [{ name: 'TOKEN', secret: true }, { name: 'PIANO', secret: false }],
      envValues: { PIANO: 'in-chiaro' }
    }
    await sealed.write('srv-env', SECRET_KIND.env, { TOKEN: 'env-vecchio', ALTRO: 'resta' })
    setSetting('mcp.servers', [cfg])
    const before = stable(server('srv-env'))
    expect(await mcp.testServer('srv-env')).toMatchObject({ ok: false }) // col vecchio il processo esce

    const r = await replace('srv-env', { env: { TOKEN: 'env-nuovo' } })

    expect(await sealed.read('srv-env', SECRET_KIND.env)).toEqual({ TOKEN: 'env-nuovo', ALTRO: 'resta' })
    expect(r.test?.ok, r.test?.error).toBe(true)
    // la config non cambia affatto (nemmeno auth: le variabili non sono un'autenticazione)
    expect(stable(server('srv-env'))).toBe(before)
    expect(server('srv-env')?.auth).toBeUndefined()
    expect(server('srv-env')?.envValues).toEqual({ PIANO: 'in-chiaro' })
  })

  it('needsAuth si pulisce quando TUTTE le chiavi attese hanno un valore (e prima no)', async () => {
    const cfg: McpServerInfo = {
      id: 'srv-needs', name: 'needs', transport: 'stdio', command: process.execPath, args: ['-e', STDIO_MCP('env-nuovo')],
      enabled: true, enabledFor: ['*'], envSpec: [{ name: 'TOKEN', secret: true }],
      needsAuth: { kind: 'env', keys: ['TOKEN'] }
    }
    setSetting('mcp.servers', [cfg])
    // una chiave che non è tra quelle attese: needsAuth resta
    const r1 = await replace('srv-needs', { env: { ALTRO: 'x' } })
    expect(server('srv-needs')?.needsAuth).toEqual({ kind: 'env', keys: ['TOKEN'] })
    expect(r1.test).toBeNull() // con needsAuth il test non parte (U7)
    const r2 = await replace('srv-needs', { env: { TOKEN: 'env-nuovo' } })
    expect(server('srv-needs')?.needsAuth).toBeUndefined()
    expect(r2.test?.ok, r2.test?.error).toBe(true)
  })

  it('lo stato «token scaduto» di un server del registro si pulisce: la pagina non lo dice più da ricollegare', async () => {
    // needsReauth e «accesso scaduto» li dice la pagina Plugin dallo stato dell'ultima prova (connectors.state)
    const cfg: McpServerInfo = { id: 'srv-reauth', name: 'reauth', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'], source: { kind: 'registry', name: 'reauth' }, auth: { kind: 'headers' } }
    setSetting('mcp.servers', [cfg])
    setSetting('connectors.state', { 'srv-reauth': { status: 'needs_auth', error: 'token scaduto' } })
    await sealed.write('srv-reauth', SECRET_KIND.headers, { 'X-A': 'uno', 'X-B': 'vecchio' })
    // come lo vede la pagina Plugin (lo stato dell'ultima prova è un campo in più della risposta)
    const before = await api['connectors:installed']!([]) as { servers: Array<McpServerInfo & { stateStatus?: string }> }
    expect(before.servers[0]?.stateStatus).toBe('needs_auth')

    const r = await replace('srv-reauth', { headers: { 'X-B': 'due-nuovo' } })

    const after = await api['connectors:installed']!([]) as { servers: Array<McpServerInfo & { stateStatus?: string }> }
    expect(after.servers[0]?.stateStatus).not.toBe('needs_auth')
    expect(r.test?.ok, r.test?.error).toBe(true)
  })
})

describe('PP2 — mcp:replace-secret: gli errori', () => {
  it('un id inesistente → errore pulito (server {id} non trovato) e NESSUNA scrittura', async () => {
    const secretsBefore = secretsSetting()
    await save([{ id: 'srv-c\'è', name: 'c', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }])
    const serversBefore = JSON.stringify(mcp.listServers())
    const err = await replace('srv-non-esiste', { bearerToken: BUONO }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/non trovato/)
    expect(secretsSetting()).toBe(secretsBefore)
    expect(JSON.stringify(mcp.listServers())).toBe(serversBefore)
    expect(await sealed.read('srv-non-esiste', SECRET_KIND.bearer)).toBeUndefined()
  })

  it('MasterKeyUnavailableError arriva INTERO (non incapsulato) e la config non cambia', async () => {
    await save([{ id: 'srv-mk', name: 'mk', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }])
    const before = JSON.stringify(mcp.listServers())
    // un backend che c'è ma non cifra: l'entry di keys.json non si può leggere
    setMasterKeyStorage({ isEncryptionAvailable: () => false, encryptString: () => { throw new Error('non cifra') }, decryptString: () => { throw new Error('non decifra') } })
    try {
      const err = await replace('srv-mk', { bearerToken: BUONO }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MasterKeyUnavailableError)
      expect(isMasterKeyUnavailableError(err)).toBe(true)
    } finally {
      setMasterKeyStorage(safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'fake-safestorage.json') }))
    }
    expect(JSON.stringify(mcp.listServers())).toBe(before)
  })
})

describe('PP2 — trovato scrivendo questi test: mcp:save non faceva arrivare auth.kind alla config', () => {
  // Prima: `cfg.auth = { kind }` si scriveva sull'oggetto del CHIAMANTE e poi
  // si ri-salvava x.listServers() (riletto dal database, senza auth): il tipo
  // di autenticazione non restava mai in config, il resolver non trovava il
  // ramo giusto e il token del form non partiva mai (dal 26 ottobre, fase 5).
  it('mcp:save con un bearer token: auth.kind resta in config e il token del FORM viaggia nell\'intestazione', async () => {
    await save([{ id: 'srv-form', name: 'form', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }, { bearerToken: BUONO }])
    expect(server('srv-form')?.auth).toEqual({ kind: 'bearer' })
    seen.length = 0
    expect(await mcp.testServer('srv-form')).toMatchObject({ ok: true })
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every((s) => s.auth === `Bearer ${BUONO}`)).toBe(true)
  })

  it('mcp:save con le intestazioni: auth.kind resta in config e viaggiano nell\'intestazione', async () => {
    await save([{ id: 'srv-form-h', name: 'formh', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }, { headers: { 'X-A': 'uno', 'X-B': 'due-nuovo' } }])
    expect(server('srv-form-h')?.auth).toEqual({ kind: 'headers' })
    seen.length = 0
    expect(await mcp.testServer('srv-form-h')).toMatchObject({ ok: true })
    expect(seen.every((s) => s.xa === 'uno' && s.xb === 'due-nuovo')).toBe(true)
  })

  it('se la chiave per cifrare manca, mcp:save non lascia un server a metà: la config resta com\'era', async () => {
    setSetting('mcp.servers', [])
    setMasterKeyStorage({ isEncryptionAvailable: () => false, encryptString: () => { throw new Error('non cifra') }, decryptString: () => { throw new Error('non decifra') } })
    try {
      const err = await save([{ id: 'srv-senza-chiave', name: 'x', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: true, enabledFor: ['*'] }, { bearerToken: BUONO }]).catch((e: unknown) => e)
      expect(isMasterKeyUnavailableError(err)).toBe(true)
    } finally {
      setMasterKeyStorage(safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'fake-safestorage.json') }))
    }
    expect(mcp.listServers()).toEqual([])
  })
})

describe('PP2 — mcp:secret-names: i NOMI dei segreti, mai i valori', () => {
  const names = () => api['mcp:secret-names']!([]) as Promise<Array<{ id: string; bearer: boolean; headers: string[]; env: string[] }>>

  it("per ogni server con un segreto: dove c'è un token, i nomi delle intestazioni e delle variabili; chi non ne ha non compare", async () => {
    await save([{ id: 'srv-n', name: 'n', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: false, enabledFor: ['*'] }, { bearerToken: BUONO }])
    setSetting('mcp.servers', [
      { id: 'srv-n', name: 'n', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: false, enabledFor: ['*'], auth: { kind: 'bearer' as const } },
      { id: 'srv-h2', name: 'h2', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: false, enabledFor: ['*'], auth: { kind: 'headers' as const } },
      { id: 'srv-e2', name: 'e2', transport: 'stdio', command: process.execPath, args: ['x'], enabled: false, enabledFor: ['*'] },
      { id: 'srv-zero', name: 'zero', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: false, enabledFor: ['*'] }
    ])
    await sealed.write('srv-h2', SECRET_KIND.headers, { 'X-A': 'valore-segreto-a', 'X-Vuota': '' })
    await sealed.write('srv-e2', SECRET_KIND.env, { TOKEN: 'valore-segreto-b', API: 'valore-segreto-c' })
    const out = await names()
    expect(out).toEqual([
      { id: 'srv-n', bearer: true, headers: [], env: [] },
      { id: 'srv-h2', bearer: false, headers: ['X-A'], env: [] },
      { id: 'srv-e2', bearer: false, headers: [], env: ['TOKEN', 'API'] }
    ])
    // mai un valore nella risposta
    const text = JSON.stringify(out)
    for (const valore of [BUONO, 'valore-segreto-a', 'valore-segreto-b', 'valore-segreto-c']) expect(text).not.toContain(valore)
  })

  it("senza la chiave l'errore arriva INTERO: un elenco vuoto mentirebbe (la Cassaforte lo dice)", async () => {
    setSetting('mcp.servers', [{ id: 'srv-k', name: 'k', transport: 'http', url: `http://127.0.0.1:${httpPort}/mcp`, enabled: false, enabledFor: ['*'] }])
    await sealed.write('srv-k', SECRET_KIND.bearer, BUONO)
    setMasterKeyStorage({ isEncryptionAvailable: () => false, encryptString: () => { throw new Error('non cifra') }, decryptString: () => { throw new Error('non decifra') } })
    try {
      const err = await names().catch((e: unknown) => e)
      expect(isMasterKeyUnavailableError(err)).toBe(true)
    } finally {
      setMasterKeyStorage(safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'fake-safestorage.json') }))
    }
  })
})

describe('PP2 — la funzione condivisa da mcp:save e mcp:replace-secret', () => {
  it('i due gestori passano da planServerSecret e applyServerSecretPlan: nel codice di api.ts nessuna scritture a mano nello store', () => {
    const save = API.slice(API.indexOf("'mcp:save'"), API.indexOf("'mcp:delete'"))
    const replaceBlock = API.slice(API.indexOf("'mcp:replace-secret'"), API.indexOf("'mcp:tools'"))
    expect(replaceBlock).not.toBe('')
    for (const block of [save, replaceBlock]) {
      expect(block).toMatch(/planServerSecret\(/)
      expect(block).toMatch(/applyServerSecretPlan\(/)
      expect(block).not.toMatch(/sealed\.write\(/)
    }
    // il test di connessione parte da solo in tutti e due, con la nota di sistema di oggi
    for (const block of [save, replaceBlock]) {
      expect(block).toMatch(/testServer\(/)
      expect(block).toMatch(/notifyMcpServerState\(/)
    }
  })

  it('planServerSecret è PURA: in «save» ricalcola tutto dal form, in «replace» fonde con il vecchio', async () => {
    const { planServerSecret } = await import('../server-secret')
    // bearer: nessun merge, auth bearer
    expect(planServerSecret({ bearerToken: 't' }, {}, { mode: 'save', transport: 'http' })).toMatchObject({ writes: [{ kind: 'bearer', value: 't' }], removes: [], auth: { kind: 'bearer' } })
    // headers in «save» come oggi: il record del form così com'è (vince il bearer se ci sono tutti e due)
    expect(planServerSecret({ headers: { A: '1' } }, { headers: { B: '2' } }, { mode: 'save', transport: 'http' })).toMatchObject({ writes: [{ kind: 'headers', value: { A: '1' } }], auth: { kind: 'headers' } })
    expect(planServerSecret({ bearerToken: 't', headers: { A: '1' } }, {}, { mode: 'save', transport: 'http' })).toMatchObject({ writes: [{ kind: 'bearer', value: 't' }] })
    // headers in «replace»: solo la chiave scritta cambia
    expect(planServerSecret({ headers: { B: 'nuovo' } }, { headers: { A: '1', B: '2' } }, { mode: 'replace', transport: 'http' })).toMatchObject({ writes: [{ kind: 'headers', value: { A: '1', B: 'nuovo' } }], auth: { kind: 'headers' } })
    // env in «replace»: si fonde con i vecchi, una chiave per volta; su http non si scrive
    const env = planServerSecret({ env: { Y: 'nuovo' } }, { env: { X: '1', Y: '2' } }, { mode: 'replace', transport: 'stdio' })
    expect(env.writes).toEqual([{ kind: 'env', value: { X: '1', Y: 'nuovo' } }])
    expect(env.auth).toBeUndefined()
    expect(planServerSecret({ env: { Y: 'nuovo' } }, {}, { mode: 'replace', transport: 'http' })).toMatchObject({ writes: [], removes: [] })
    // env in «save» (il form): restano solo i nomi dichiarati SEGRETI, i valori non segreti tornano in config
    const save = planServerSecret({ env: { TOKEN: 't', EXTRA: 'x' } }, { env: { VECCHIO: 'v' } }, { mode: 'save', transport: 'stdio', form: { envSpec: [{ name: 'TOKEN', secret: true }, { name: 'PIANO', secret: false }], envValues: { PIANO: 'a' } } })
    expect(save.writes).toEqual([{ kind: 'env', value: { TOKEN: 't' } }])
    expect(save.envValues).toEqual({ PIANO: 'a' })
    expect(save.sealedEnv).toEqual({ TOKEN: 't' })
    // in «save», senza più segreti dichiarati, il campo esce dallo store
    const via = planServerSecret({}, { env: { VECCHIO: 'v' } }, { mode: 'save', transport: 'stdio', form: { envSpec: [{ name: 'PIANO', secret: false }], envValues: {} } })
    expect(via.writes).toEqual([])
    expect(via.removes).toEqual(['env'])
    // nessun segreto: niente
    expect(planServerSecret(undefined, {}, { mode: 'replace', transport: 'http' })).toEqual({ writes: [], removes: [] })
  })

  it('applyServerSecretPlan: un errore qualsiasi diventa UI.rpcSecretSaveFailed; MasterKeyUnavailableError passa intero', async () => {
    const { applyServerSecretPlan } = await import('../server-secret')
    const mk = new MasterKeyUnavailableError('servizio', 'storage-unavailable')
    const storeCheFallisce = { write: async () => { throw new Error('disco pieno') }, remove: async () => undefined, read: async () => undefined, removeAll: async () => undefined }
    const err = await applyServerSecretPlan(storeCheFallisce, 'srv', { writes: [{ kind: 'bearer', value: 't' }], removes: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    // come oggi: il testo del catalogo, con il motivo in coda
    expect((err as Error).message).toContain('impossibile salvare il segreto del server')
    expect((err as Error).message).toContain('disco pieno')
    expect(err).not.toBeInstanceOf(MasterKeyUnavailableError)
    const storeSenzaChiave = { ...storeCheFallisce, write: async () => { throw mk } }
    const whole = await applyServerSecretPlan(storeSenzaChiave, 'srv', { writes: [{ kind: 'bearer', value: 't' }], removes: [] }).catch((e: unknown) => e)
    expect(whole).toBe(mk)
  })
})
