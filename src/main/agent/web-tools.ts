// Tool web (fase 11, punto 2): la RICERCA usa un servizio esterno dietro
// l'interfaccia sostituibile WebSearchProvider (implementazione reale: la web
// search API di Ollama, chiave SOLO nel vault sigillato); la LETTURA
// (web_fetch) gira in LOCALE nel daemon: nessuna chiave, nessun credito, con
// difese SSRF (web-guard, puro) e validazione degli IP AL MOMENTO DELLA
// CONNESSIONE (la lookup di node:http, F4: niente seconda risoluzione non
// controllata). L'output di entrambi è DATO NON FIDATO: il
// loop lo incarta nel blocco evidenza e contamina il turno (niente
// auto-review sulle azioni con effetti).
//
// Dipendenze iniettabili (fetch, DNS, orologio): i test non toccano la rete
// reale; il loopback è ammesso SOLO col flag di test
// SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1 (che non esiste in produzione).
import * as http from 'node:http'
import * as https from 'node:https'
import { createConnectorsSecretStore } from '../connectors/sealed-store'
import { getSetting, setSetting } from '../store/db'
import {
  checkUrl, resolveRedirect, resolvedIpsAllowed, sliceWithOffset, isForbiddenIp, literalHostIp,
  loopbackAllowedForTests, looksJsBuiltPage
} from './web-guard'
import {
  WEB_FETCH_TIMEOUT_MS, WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_REDIRECTS, WEB_FETCH_CACHE_MS,
  WEB_SEARCH_DEFAULT_RESULTS, WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_TIMEOUT_MS, SANDBOT_USER_AGENT
} from '../../shared/web-limits'
import {
  youKeylessProvider, exaMcpKeylessProvider, tavilyKeylessProvider, parseRetryAfterMs,
  WebSearchProviderError,
  type ExaMcpClientFactory, type WebSearchErrorKind, type WebSearchProviderName
} from './web-search-providers'

export { SANDBOT_USER_AGENT }
export type { WebSearchProviderName }

// ---- la chiave della ricerca web: SOLO nel vault sigillato ----

const SEALED_SERVER = 'websearch'
const SEALED_FIELD = 'apiKey'

export interface SealedKeyDeps {
  /** chiave AES del vault sigillato: nel daemon arriva dal Keychain (test: iniettata). */
  getKey(): Promise<Buffer>
}

function sealed(deps: SealedKeyDeps) {
  return createConnectorsSecretStore({ getKey: deps.getKey, getSetting, setSetting })
}

export async function getWebSearchKey(deps: SealedKeyDeps): Promise<string | null> {
  const k = await sealed(deps).read<string>(SEALED_SERVER, SEALED_FIELD)
  return typeof k === 'string' && k ? k : null
}

export async function setWebSearchKey(key: string, deps: SealedKeyDeps): Promise<void> {
  await sealed(deps).write(SEALED_SERVER, SEALED_FIELD, key)
}

export async function clearWebSearchKey(deps: SealedKeyDeps): Promise<void> {
  await sealed(deps).remove(SEALED_SERVER, [SEALED_FIELD])
}

export async function isWebSearchKeySet(deps: SealedKeyDeps): Promise<boolean> {
  return (await getWebSearchKey(deps)) !== null
}

// ---- il provider di ricerca (interfaccia sostituibile) ----

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchProvider {
  /** fase 15 (S1.2): nome stabile del provider (catena, raffreddamento, meta del tool) */
  name: WebSearchProviderName
  /** etichetta per l'utente (riga "Fonte della ricerca", Impostazioni) */
  label: string
  search(query: string, maxResults: number): Promise<WebSearchResult[]>
}

/** Il messaggio quando la ricerca non è attiva (il bot lo dice all'utente, niente strade alternative). */
export const WEB_SEARCH_INACTIVE =
  'Web search is disabled in the settings. Tell the user in one line: they can re-enable it in Settings → Web search. Do not search on search engines with the browser.'

/** Fase 15 (S6): tutti i provider hanno fallito o sono in raffreddamento. */
export const WEB_SEARCH_UNAVAILABLE =
  'Web search is not available right now (the search services refused or are not responding). Tell the user in one line and suggest trying again later; if you already know the right site you can read it with web_fetch. Do not search on search engines with the browser.'

/**
 * L'implementazione a chiave: POST https://ollama.com/api/web_search con la
 * chiave API di Ollama. La chiave viaggia SOLO nell'header Authorization:
 * mai nel contesto del modello, nei log o in argv. Il parsing della risposta
 * è tollerante (title/name, url/link, snippet/description/content). Fase 15:
 * errori tipizzati (la catena sa cosa fare) e timeout di 15 s come tutti.
 */
export function ollamaWebSearchProvider(
  key: string,
  deps: { fetchImpl?: typeof fetch; baseUrl?: string } = {}
): WebSearchProvider {
  const doFetch = deps.fetchImpl ?? fetch
  const base = (deps.baseUrl ?? 'https://ollama.com').replace(/\/$/, '')
  return {
    name: 'ollama',
    label: 'Ollama',
    async search(query, maxResults) {
      let r: Response
      try {
        r = await doFetch(`${base}/api/web_search`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
            'user-agent': SANDBOT_USER_AGENT
          },
          credentials: 'omit',
          body: JSON.stringify({ query, max_results: maxResults }),
          signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)
        })
      } catch (e) {
        const name = e instanceof Error ? e.name : ''
        throw new WebSearchProviderError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
      }
      if (r.status === 429) throw new WebSearchProviderError('rate-limit', 429, parseRetryAfterMs(r.headers.get('retry-after')))
      if (!r.ok) throw new WebSearchProviderError('http', r.status)
      let j: unknown
      try {
        j = await r.json()
      } catch {
        throw new WebSearchProviderError('parse', r.status)
      }
      const list = Array.isArray(j)
        ? j
        : Array.isArray((j as { results?: unknown[] }).results)
          ? (j as { results: unknown[] }).results
          : []
      return list.slice(0, maxResults).map((raw) => {
        const e = raw as Record<string, unknown>
        return {
          title: String(e.title ?? e.name ?? ''),
          url: String(e.url ?? e.link ?? ''),
          snippet: String(e.snippet ?? e.description ?? e.content ?? '')
        }
      })
    }
  }
}

/** Provider iniettabile per i test e per l'eval (deterministico, niente rete). */
let providerOverride: WebSearchProvider | null = null
export function setWebSearchProviderForTests(p: WebSearchProvider | null): void {
  providerOverride = p
}

/**
 * MODALITÀ TEST (verifica d'integrazione): con SANDBOT_TEST_FAKE_WEB_SEARCH=1
 * la ricerca risponde con un risultato deterministico che punta a
 * SANDBOT_TEST_FAKE_WEB_URL (il server http locale del test) — niente chiave,
 * niente rete vera. Flag esplicito che non esiste in produzione, come
 * SANDBOT_WEB_FETCH_ALLOW_LOOPBACK.
 */
export function fakeWebSearchProviderForTests(): WebSearchProvider | null {
  if (process.env.SANDBOT_TEST_FAKE_WEB_SEARCH !== '1') return null
  const target = process.env.SANDBOT_TEST_FAKE_WEB_URL ?? 'http://127.0.0.1:9/test'
  return {
    name: 'you',
    label: 'You.com',
    async search() {
      return [
        { title: 'Weekend a Roma: luoghi da vedere e dove mangiare', url: target, snippet: 'I luoghi consigliati per un weekend di due persone a Roma.' }
      ]
    }
  }
}

/**
 * MODALITÀ TEST (verifica d'integrazione della fase 15): con
 * SANDBOT_TEST_FAKE_WEB_SEARCH_CHAIN=1 la catena keyless diventa
 * [You.com → 429, Exa → un risultato che punta a SANDBOT_TEST_FAKE_WEB_URL]:
 * si vede il passaggio al provider successivo NELLA STESSA chiamata e il
 * raffreddamento di You.com, senza toccare i servizi veri. Flag SANDBOT_TEST_*
 * che non esiste in produzione.
 */
export function fakeWebSearchChainForTests(): WebSearchProvider[] | null {
  if (process.env.SANDBOT_TEST_FAKE_WEB_SEARCH_CHAIN !== '1') return null
  const target = process.env.SANDBOT_TEST_FAKE_WEB_URL ?? 'http://127.0.0.1:9/test'
  return [
    {
      name: 'you',
      label: 'You.com',
      async search() {
        throw new WebSearchProviderError('rate-limit', 429, 60_000)
      }
    },
    {
      name: 'exa',
      label: 'Exa',
      async search() {
        return [
          { title: 'Risultato della prova (Exa)', url: target, snippet: 'Il risultato deterministico della verifica d\'integrazione.' }
        ]
      }
    }
  ]
}

let realKeyGetter: (() => Promise<Buffer>) | null = null
/** Registra il getter della chiave del vault (wiring del daemon: Keychain); null lo rimuove. */
export function setWebSearchKeyGetter(getKey: (() => Promise<Buffer>) | null): void {
  realKeyGetter = getKey
}

/**
 * Il provider con chiave attivo (oggi solo Ollama), o null. La catena di
 * searchWeb lo mette PRIMA dei keyless (S2); questa funzione resta per chi
 * chiede "c'è un provider a chiave?".
 */
export async function getWebSearchProvider(): Promise<WebSearchProvider | null> {
  if (providerOverride) return providerOverride
  const fake = fakeWebSearchProviderForTests()
  if (fake) return fake
  if (!realKeyGetter) return null
  const key = await getWebSearchKey({ getKey: realKeyGetter })
  return key ? ollamaWebSearchProvider(key) : null
}

// ---- fase 15 (S3): raffreddamento dei provider dopo i rifiuti ----

/** Teti del raffreddamento: Retry-After al massimo 6 h; raddoppio 1 min → 1 h. */
export const RATE_LIMIT_RETRY_AFTER_CAP_MS = 6 * 60 * 60_000
export const RATE_LIMIT_BACKOFF_BASE_MS = 60_000
export const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60_000
export const TRANSIENT_COOLDOWN_MS = 60_000

interface ProviderCooldown {
  cooldownUntil: number
  consecutiveRateLimits: number
  lastError?: { kind: WebSearchErrorKind; status?: number; at: number }
}

/**
 * Stato in memoria del daemon, per provider (S3.3): NON persistito — al
 * riavvio si riparte puliti. Le funzioni prendono l'orologio iniettabile.
 */
const cooldowns = new Map<WebSearchProviderName, ProviderCooldown>()

export function providerCoolingDown(name: WebSearchProviderName, now: number): number {
  const until = cooldowns.get(name)?.cooldownUntil ?? 0
  return until > now ? until : 0
}

/** Successo: tutto lo stato del provider si azzera (S3.2). */
export function noteSearchSuccess(name: WebSearchProviderName, now: number): void {
  cooldowns.delete(name)
}

/** Rifiuto 429: Retry-After (tetto 6 h) oppure attesa che raddoppia (1 min → 1 h). */
export function noteSearchRateLimit(
  name: WebSearchProviderName,
  retryAfterMs: number | undefined,
  now: number
): void {
  const prev = cooldowns.get(name)
  const consecutive = Math.min((prev?.consecutiveRateLimits ?? 0) + 1, 7)
  const wait =
    retryAfterMs !== undefined
      ? Math.min(retryAfterMs, RATE_LIMIT_RETRY_AFTER_CAP_MS)
      : Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (consecutive - 1), RATE_LIMIT_BACKOFF_MAX_MS)
  cooldowns.set(name, {
    cooldownUntil: now + wait,
    consecutiveRateLimits: consecutive,
    lastError: { kind: 'rate-limit', status: 429, at: now }
  })
}

/** http 5xx, timeout o network: raffreddamento breve (1 min), il conteggio dei 429 non si tocca. */
export function noteSearchTransientFailure(name: WebSearchProviderName, kind: WebSearchErrorKind, now: number): void {
  const prev = cooldowns.get(name)
  cooldowns.set(name, {
    cooldownUntil: now + TRANSIENT_COOLDOWN_MS,
    consecutiveRateLimits: prev?.consecutiveRateLimits ?? 0,
    lastError: { kind, at: now }
  })
}

/** Errori stabili (http 4xx, parse, tool-error): si registrano per la UI, niente raffreddamento. */
export function noteSearchError(
  name: WebSearchProviderName,
  kind: WebSearchErrorKind,
  status: number | undefined,
  now: number
): void {
  const prev = cooldowns.get(name)
  cooldowns.set(name, {
    cooldownUntil: prev?.cooldownUntil ?? 0,
    consecutiveRateLimits: prev?.consecutiveRateLimits ?? 0,
    lastError: { kind, ...(status !== undefined ? { status } : {}), at: now }
  })
}

// ---- fase 15 (S4): cache delle ricerche (15 minuti, in memoria) ----

export const WEB_SEARCH_CACHE_MAX_ENTRIES = 200

/** Chiave della cache: query normalizzata (minuscole, spazi compressi, trim) + maxResults. */
export function normalizeSearchQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

interface SearchCacheEntry {
  at: number
  results: WebSearchResult[]
  providerName: WebSearchProviderName
  providerLabel: string
}

const searchCache = new Map<string, SearchCacheEntry>()

function cacheSetSearch(key: string, entry: SearchCacheEntry): void {
  // la stessa chiave si reinserisce in coda (l'ordine della Map è quello d'inserimento)
  searchCache.delete(key)
  searchCache.set(key, entry)
  while (searchCache.size > WEB_SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
}

// ---- fase 15 (S2): la catena ----

export interface SearchWebDeps {
  now?: () => number
  fetchImpl?: typeof fetch
  /** fabbrica del client MCP di Exa (test: finta; produzione: l'SDK) */
  makeExaClient?: ExaMcpClientFactory
  /** override del setting webSearch.keyless (i test); default: il setting, vero se assente */
  keyless?: boolean
}

export interface WebSearchFailure {
  name: string
  kind: WebSearchErrorKind | 'cooldown'
  status?: number
}

export type WebSearchOutcome =
  | { ok: true; results: WebSearchResult[]; provider: { name: WebSearchProviderName; label: string } }
  | { ok: false; error: 'inactive' | 'all-failed'; failures: WebSearchFailure[] }

/**
 * La catena (S2): prima i provider CON CHIAVE configurati (oggi solo Ollama),
 * poi — se la ricerca senza chiave è attiva (S5, predefinita vera) —
 * You.com → Exa → Tavily. Su errore di qualunque tipo si passa al successivo
 * NELLA STESSA chiamata (mai due tentativi allo stesso provider); zero
 * risultati è una risposta valida e NON fa passare avanti. La cache (S4)
 * risponde prima di chiamare chiunque.
 */
export async function searchWeb(query: string, maxResults: number, deps: SearchWebDeps = {}): Promise<WebSearchOutcome> {
  const now = deps.now ?? Date.now
  const cacheKey = `${normalizeSearchQuery(query)}|${maxResults}`
  const hit = searchCache.get(cacheKey)
  if (hit && cacheFresh(hit.at, now())) {
    return { ok: true, results: hit.results, provider: { name: hit.providerName, label: hit.providerLabel } }
  }

  const chain = await buildSearchChain(deps)
  if (!chain.length) return { ok: false, error: 'inactive', failures: [] }

  const failures: WebSearchFailure[] = []
  for (const p of chain) {
    if (providerCoolingDown(p.name, now())) {
      failures.push({ name: p.name, kind: 'cooldown' })
      continue // in raffreddamento: si salta SENZA chiamarlo (S3.4)
    }
    try {
      const results = await p.search(query, maxResults)
      noteSearchSuccess(p.name, now())
      cacheSetSearch(cacheKey, { at: now(), results, providerName: p.name, providerLabel: p.label })
      return { ok: true, results, provider: { name: p.name, label: p.label } }
    } catch (e) {
      const err = e instanceof WebSearchProviderError ? e : new WebSearchProviderError('network')
      if (err.kind === 'rate-limit') noteSearchRateLimit(p.name, err.retryAfterMs, now())
      else if (err.kind === 'timeout' || err.kind === 'network' || (err.kind === 'http' && (err.status ?? 0) >= 500)) {
        noteSearchTransientFailure(p.name, err.kind, now())
      } else {
        noteSearchError(p.name, err.kind, err.status, now())
      }
      failures.push({ name: p.name, kind: err.kind, ...(err.status !== undefined ? { status: err.status } : {}) })
    }
  }
  return { ok: false, error: 'all-failed', failures }
}

/** La catena nell'ordine di S2 (override e finti di test compresi). */
async function buildSearchChain(deps: SearchWebDeps): Promise<WebSearchProvider[]> {
  if (providerOverride) return [providerOverride]
  const fakeChain = fakeWebSearchChainForTests()
  if (fakeChain) return fakeChain
  const fake = fakeWebSearchProviderForTests()
  if (fake) return [fake]
  const out: WebSearchProvider[] = []
  // 1. i provider con chiave configurati (oggi solo Ollama)
  if (realKeyGetter) {
    const key = await getWebSearchKey({ getKey: realKeyGetter })
    if (key) out.push(ollamaWebSearchProvider(key, { fetchImpl: deps.fetchImpl }))
  }
  // 2. la ricerca senza chiave (S5): predefinita VERA
  const keyless = deps.keyless ?? getSetting<boolean>('webSearch.keyless', true)
  if (keyless) {
    out.push(
      youKeylessProvider({ fetchImpl: deps.fetchImpl }),
      exaMcpKeylessProvider({ makeClient: deps.makeExaClient }),
      tavilyKeylessProvider({ fetchImpl: deps.fetchImpl })
    )
  }
  return out
}

/** Ripristina lo stato della ricerca (raffreddamento e cache): solo per i test. */
export function resetWebSearchStateForTests(): void {
  cooldowns.clear()
  searchCache.clear()
}

// ---- fase 15 (S5): lo stato per provider che la UI legge via RPC ----

export interface WebSearchProviderStatus {
  name: WebSearchProviderName
  label: string
  /** in raffreddamento fino a (epoch ms), se lo è */
  cooldownUntil?: number
  lastError?: { kind: WebSearchErrorKind; status?: number; at: number }
}

export interface WebSearchStatus {
  /** il setting webSearch.keyless (la UI lo mostra sull'interruttore) */
  keyless: boolean
  /** true se c'è un provider con chiave configurato (Ollama) */
  keyedConfigured: boolean
  providers: WebSearchProviderStatus[]
}

/** Stato di sola lettura dei provider senza chiave (+ Ollama se configurato). */
export async function webSearchStatus(deps: { now?: () => number } = {}): Promise<WebSearchStatus> {
  const now = deps.now ?? Date.now
  const names: WebSearchProviderName[] = ['you', 'exa', 'tavily']
  let keyedConfigured = false
  if (realKeyGetter && (await getWebSearchKey({ getKey: realKeyGetter }))) {
    keyedConfigured = true
    names.push('ollama')
  }
  const labels: Record<WebSearchProviderName, string> = { you: 'You.com', exa: 'Exa', tavily: 'Tavily', ollama: 'Ollama' }
  return {
    keyless: getSetting<boolean>('webSearch.keyless', true),
    keyedConfigured,
    providers: names.map((name) => {
      const st = cooldowns.get(name)
      const cooling = providerCoolingDown(name, now())
      return {
        name,
        label: labels[name],
        ...(cooling ? { cooldownUntil: cooling } : {}),
        ...(st?.lastError ? { lastError: st.lastError } : {})
      }
    })
  }
}

// web_fetch iniettabile per i test del loop (nessuna rete reale)
let fetchOverride: ((rawUrl: string) => Promise<WebFetchOutcome>) | null = null
export function setWebFetchForTests(fn: ((rawUrl: string) => Promise<WebFetchOutcome>) | null): void {
  fetchOverride = fn
}
/** La funzione di lettura usata dal tool: di default la cached, nei test quella iniettata. */
export function getWebFetchFn(): (rawUrl: string) => Promise<WebFetchOutcome> {
  return fetchOverride ?? ((rawUrl) => webFetchCached(rawUrl))
}

// ---- web_fetch: lettura LOCALE con difese SSRF, limiti e conversione ----

export interface WebFetchDeps {
  /** risoluzione DNS iniettabile: torna TUTTI gli indirizzi dell'host */
  lookup?: (host: string) => Promise<string[]>
  now?: () => number
  /** trasporto http iniettabile (test): di default node:http/https con la lookup VALIDANTE */
  transport?: HttpTransport
}

export type WebFetchOutcome =
  | { ok: true; text: string; contentType: string; finalUrl: string; downloadedBytes: number; truncated?: boolean; jsBuilt?: boolean }
  | { ok: false; reason: string; blocked?: boolean; unsupported?: boolean }

/** Cache per URL di 15 minuti (punto 2): dentro al modulo, iniettabile l'orologio. */
const fetchCache = new Map<string, { at: number; outcome: WebFetchOutcome }>()

export function clearWebFetchCache(): void {
  fetchCache.clear()
}

/** webFetch con la cache per URL (15 minuti): stessa URL, stessa lettura. */
export async function webFetchCached(rawUrl: string, deps: WebFetchDeps = {}): Promise<WebFetchOutcome> {
  const now = deps.now ?? Date.now
  const hit = fetchCache.get(rawUrl)
  if (hit && cacheFresh(hit.at, now())) return hit.outcome
  const outcome = await webFetch(rawUrl, deps)
  fetchCache.set(rawUrl, { at: now(), outcome })
  return outcome
}

/** User-agent onesto (SandBot/<versione>): definito in shared/web-limits, riesportato. */

async function resolveHost(host: string, deps: WebFetchDeps): Promise<string[]> {
  if (deps.lookup) return deps.lookup(host)
  const { lookup } = await import('node:dns').then((m) => m.promises)
  const all = await lookup(host, { all: true })
  return all.map((a) => a.address)
}

/**
 * L'errore che la lookup VALIDANTE restituisce quando l'host risolve SOLO su
 * indirizzi interni: webFetch lo riconosce e risponde col motivo giusto.
 */
export class ForbiddenAddressError extends Error {
  constructor(hostname: string, ips: string[]) {
    super(`internal address: ${hostname} resolves to ${ips.join(', ') || 'no address'}`)
    this.name = 'ForbiddenAddressError'
  }
}

/** La firma della lookup di node (net.connect la chiama alla CONNESSIONE). */
export type NodeLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: Error | null, address?: unknown, family?: number) => void
) => void

/**
 * La lookup che node chiama AL MOMENTO DELLA CONNESSIONE (anti-TOCTOU, F4):
 * risolve l'host ORA, scarta gli indirizzi non ammessi e passa al socket
 * SOLO quelli validati. Non esiste una seconda risoluzione non controllata:
 * il vecchio percorso (checkDns e poi fetch che risolveva di nuovo per conto
 * suo) permetteva il DNS rebinding — primo colpo IP pubblico, secondo colpo
 * 127.0.0.1 o 169.254.169.254.
 */
export function validatingLookup(resolve: (host: string) => Promise<string[]>, allowAll: boolean): NodeLookup {
  return (hostname, options, callback) => {
    void resolve(hostname).then(
      (ips) => {
        const allowed = allowAll ? ips : ips.filter((ip) => !isForbiddenIp(ip))
        if (!allowed.length) {
          callback(new ForbiddenAddressError(hostname, ips))
          return
        }
        if (options?.all) {
          callback(null, allowed.map((address) => ({ address, family: literalHostIp(address) !== null && address.includes(':') ? 6 : 4 })))
        } else {
          const first = allowed[0]!
          callback(null, first, first.includes(':') ? 6 : 4)
        }
      },
      (e) => callback(e instanceof Error ? e : new Error(String(e)))
    )
  }
}

/** Un hop http: status, header (chiavi minuscole) e corpo GIA' limitato a maxBytes. */
export interface HttpHop {
  status: number
  headers: Record<string, string>
  body: Buffer
  /** il corpo superava maxBytes: si sono tenuti i primi maxBytes e si è interrotto il download */
  truncated: boolean
}

export interface HttpTransportOptions {
  /** la lookup VALIDANTE (node la usa alla connessione) */
  lookup: NodeLookup
  /** scadenza TOTALE in ms epoch: copre redirect e lettura del corpo */
  deadlineAt: number
  maxBytes: number
}

export type HttpTransport = (url: URL, opts: HttpTransportOptions) => Promise<HttpHop>

function flattenHeaders(res: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue
    flat[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return flat
}

/**
 * Il trasporto reale (node:http/https, F4): la validazione degli IP avviene
 * AL MOMENTO DELLA CONNESSIONE tramite l'opzione `lookup` — node non risolve
 * per conto suo, il socket riceve SOLO indirizzi già validati. Il corpo si
 * legge in STREAMING con un contatore di byte: oltre il tetto si interrompe
 * il download (memoria limitata) e si tengono i primi maxBytes. Una SCADENZA
 * TOTALE copre connessione, header e corpo.
 */
const realTransport: HttpTransport = (url, opts) =>
  new Promise<HttpHop>((resolve, reject) => {
    let req: http.ClientRequest | undefined
    let settled = false
    const chunks: Buffer[] = []
    let received = 0
    let truncated = false
    const settle = (err: Error | null, hop?: HttpHop) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        req?.destroy()
        reject(err)
      } else {
        resolve(hop!)
      }
    }
    const timer = setTimeout(
      () => settle(new Error(`time expired (${Math.round(WEB_FETCH_TIMEOUT_MS / 1000)} s in total for request, redirects and reading the body)`)),
      Math.max(0, opts.deadlineAt - Date.now())
    )
    timer.unref?.()
    const mod = url.protocol === 'https:' ? https : http
    req = mod.request(url.toString(), {
      headers: { 'user-agent': SANDBOT_USER_AGENT, accept: 'text/html,application/json,text/plain,*/*' },
      lookup: opts.lookup as never
    })
    req.on('error', (e) => settle(e))
    req.on('response', (res) => {
      const flat = flattenHeaders(res)
      res.on('data', (d: Buffer) => {
        if (truncated) return
        if (received + d.length > opts.maxBytes) {
          const room = opts.maxBytes - received
          if (room > 0) chunks.push(d.subarray(0, room))
          truncated = true
          // download interrotto qui: la memoria resta limitata al tetto
          res.destroy()
          settle(null, { status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks), truncated })
          return
        }
        received += d.length
        chunks.push(d)
      })
      res.on('end', () => settle(null, { status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks), truncated }))
      res.on('error', (e) => settle(e))
    })
    req.end()
  })

// ---- captcha/sfida (F5): un falso positivo NON è un blocco ----

/** Firme note di una sfida nello stato 403/429/503 (Cloudflare & simili). */
export const CHALLENGE_SIGNATURES = ['cf-chl', 'just a moment', 'attention required', 'verify you are human'] as const

/** Marcatori di moduli captcha dentro l'HTML. */
const CHALLENGE_MARKERS = /recaptcha|hcaptcha|turnstile|cf-challenge/i

/** Soglia di "pochissimo testo" perché una pagina con captcha sia SOLO la sfida. */
export const CHALLENGE_MIN_TEXT = 200

/**
 * F5 (PURO): una risposta 403/429/503 è una sfida SOLO con una firma nota;
 * una pagina 200 è bloccata SOLO se, dopo l'estrazione, ha pochissimo testo
 * e contiene solo il modulo della sfida. Uno script reCAPTCHA dentro una
 * pagina CON contenuto (il form di prenotazione del ristorante) non blocca.
 */
export function challengeBlocked(status: number, rawHtml: string, extractedText: string): boolean {
  const low = rawHtml.toLowerCase()
  if ((status === 403 || status === 429 || status === 503) && CHALLENGE_SIGNATURES.some((s) => low.includes(s))) return true
  if (CHALLENGE_MARKERS.test(rawHtml) && extractedText.replace(/\s+/g, ' ').trim().length < CHALLENGE_MIN_TEXT) return true
  return false
}

/**
 * Scarica e converte una pagina (locale, nessuna chiave): solo http/https,
 * niente credenziali nell'URL, IP validati ALLA CONNESSIONE (lookup) a OGNI
 * redirect (max 5), scadenza totale 20 s, corpo letto in streaming con tetto
 * di 3 MB (oltre: si tengono i primi 3 MB con nota "pagina troncata").
 * HTML → testo leggibile in markdown; testo e JSON così come sono; altri
 * tipi non supportati. Sfide VERE (403/429/503 con firma nota, o pagina che
 * contiene solo il captcha) → esito "bloccato" esplicito (il bot NON lo
 * aggira e lo segnala all'utente, come ReportSiteBlocked in Grok).
 */
export async function webFetch(rawUrl: string, deps: WebFetchDeps = {}): Promise<WebFetchOutcome> {
  const now = deps.now ?? Date.now
  const check = checkUrl(rawUrl)
  if (!check.ok) return { ok: false, reason: check.reason }
  let current = check.url
  const transport = deps.transport ?? realTransport
  const allowAll = loopbackAllowedForTests()

  // pre-check dell'host (messaggi chiari): gli IP LETTERALI si validano senza
  // DNS; l'ENFORCEMENT vero resta nella lookup alla connessione (anti-TOCTOU)
  const checkHost = async (hostname: string): Promise<string | null> => {
    const literal = literalHostIp(hostname)
    if (literal !== null) {
      return !allowAll && isForbiddenIp(literal)
        ? `internal address (${hostname}): web fetch does not touch the internal network`
        : null
    }
    try {
      const ips = await resolveHost(hostname, deps)
      if (!ips.length) return `host not resolved: ${hostname}`
      if (!allowAll && !resolvedIpsAllowed(ips)) {
        return `host not allowed (${hostname} resolves to a private/internal address): web fetch does not touch the internal network`
      }
      return null
    } catch {
      return `host not resolved: ${hostname}`
    }
  }

  const dnsErr = await checkHost(current.hostname)
  if (dnsErr) return { ok: false, reason: dnsErr }

  // scadenza TOTALE: redirect e lettura del corpo compresi (F4)
  const deadlineAt = now() + WEB_FETCH_TIMEOUT_MS
  let hop: HttpHop
  for (let redirect = 0; ; redirect++) {
    let r: HttpHop
    try {
      r = await transport(current, {
        lookup: validatingLookup((host) => resolveHost(host, deps), allowAll),
        deadlineAt,
        maxBytes: WEB_FETCH_MAX_BYTES
      })
    } catch (e) {
      if (e instanceof ForbiddenAddressError) {
        // la lookup ha rifiutato l'indirizzo ALLA CONNESSIONE (DNS rebinding)
        return { ok: false, reason: `host not allowed (${current.hostname}): ${e.message}` }
      }
      return { ok: false, reason: `request failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (r.status >= 300 && r.status < 400 && r.headers['location']) {
      if (redirect >= WEB_FETCH_MAX_REDIRECTS) return { ok: false, reason: `too many redirects (more than ${WEB_FETCH_MAX_REDIRECTS})` }
      // il redirect si ricontrolla DA CAPO: URL valido E host ammesso
      let next: URL
      try {
        next = resolveRedirect(current, r.headers['location'])
      } catch {
        return { ok: false, reason: 'redirect with invalid location' }
      }
      const nc = checkUrl(next.toString())
      if (!nc.ok) return { ok: false, reason: `redirect not allowed: ${nc.reason}` }
      const nd = await checkHost(next.hostname)
      if (nd) return { ok: false, reason: `redirect not allowed: ${nd}` }
      current = next
      continue
    }
    hop = r
    break
  }

  const bodyText = (): string => {
    // decodifica WHATWG (fatal: false): iso-8859-1 e windows-1252 arrivano
    // bene; un'etichetta sconosciuta ricade su utf-8
    const label = /charset=([\w-]+)/i.exec(hop.headers['content-type'] ?? '')?.[1]
    try {
      return new TextDecoder(label ?? 'utf-8').decode(hop.body)
    } catch {
      return new TextDecoder('utf-8').decode(hop.body)
    }
  }

  // F5: lo stato di sfida si dichiara SOLO con le firme note
  if (hop.status === 403 || hop.status === 429 || hop.status === 503) {
    const sig = CHALLENGE_SIGNATURES.find((s) => hop.body.toString('latin1').toLowerCase().includes(s))
    if (sig) {
      return {
        ok: false,
        blocked: true,
        reason: `the site blocked the request (HTTP ${hop.status}, challenge "${sig}"): DO NOT bypass the block, tell the user that the page cannot be read`
      }
    }
    return { ok: false, reason: `the page responds HTTP ${hop.status}` }
  }
  if (hop.status >= 400) {
    return { ok: false, reason: `the page responds HTTP ${hop.status}` }
  }

  const contentType = (hop.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  const truncatedNote = hop.truncated ? '\n\n[page truncated: past 3 MB I kept the first 3 MB]' : ''

  if (contentType.includes('html')) {
    // G3: la base per i link è l'URL FINALE (dopo i redirect)
    const raw = bodyText()
    const text = htmlToMarkdown(raw, current.toString())
    if (challengeBlocked(hop.status, raw, text)) {
      return { ok: false, blocked: true, reason: 'the page requires a captcha: DO NOT bypass the block, tell the user that the page cannot be read' }
    }
    // fase 11b (punto 2): pagina costruita in JavaScript? Il result di
    // web_fetch lo dichiara al modello (che può aprirla col browser); con un
    // blocco o un captcha non si arriva qui (esiti blocked sopra)
    return {
      ok: true, text: text + truncatedNote, contentType: 'text/html',
      finalUrl: current.toString(), downloadedBytes: hop.body.length,
      ...(hop.truncated ? { truncated: true } : {}),
      ...(looksJsBuiltPage(raw, text) ? { jsBuilt: true } : {})
    }
  }
  if (contentType.startsWith('text/') || contentType.includes('json')) {
    return {
      ok: true, text: bodyText() + truncatedNote, contentType,
      finalUrl: current.toString(), downloadedBytes: hop.body.length,
      ...(hop.truncated ? { truncated: true } : {})
    }
  }
  return {
    ok: false,
    unsupported: true,
    reason: `unsupported type (${contentType || 'unknown'}): I read html, text and json`
  }
}

// ---- conversione HTML → testo leggibile in markdown (puro) ----

/** Entità HTML più comuni + numeriche (puro). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
}

/**
 * G3 (puro): l'href risolto contro la base (l'URL FINALE della pagina), SOLO
 * se il protocollo è http(s) — un href relativo diventa un link citabile
 * fuori dalla pagina; `mailto:`, `javascript:` e simili non sono link. URL
 * irrisolvibile (relativo senza base, malformato) → null: resta il testo.
 */
function resolveLinkHref(href: string, baseUrl?: string): string | null {
  try {
    const u = new URL(href, baseUrl)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * Estrazione dell'articolo e conversione essenziale in markdown (puro): via
 * script/style/nav ealtro rumore; se c'è <article> o <main> si usa quello;
 * heading, link, liste, grassetti e codice diventano markdown; il resto dei
 * tag si elimina. Non è un parser HTML completo: è la lettura essenziale.
 * G3: gli href si risolvono contro baseUrl (l'URL finale): i link in output
 * sono ASSOLUTI e apribili davvero, e solo http(s).
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
  const main = /<article[\s>][\s\S]*?<\/article>/i.exec(s) ?? /<main[\s>][\s\S]*?<\/main>/i.exec(s)
  if (main) s = main[0]
  else {
    const body = /<body[\s>][\s\S]*?<\/body>/i.exec(s)
    if (body) s = body[0]
  }
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim()
      const url = resolveLinkHref(href, baseUrl)
      return label && url ? `[${label}](${url})` : label
    })
    .replace(/<img\s[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt: string) => (alt ? ` ![${alt}]` : ''))
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) => `\n> ${inner.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<(pre|code)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner: string) => `\`${inner.replace(/<[^>]+>/g, '')}\``)
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, inner: string) => `**${inner.replace(/<[^>]+>/g, '')}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, inner: string) => `*${inner.replace(/<[^>]+>/g, '')}*`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|li|h[1-6])>/gi, '\n')
  s = decodeEntities(s.replace(/<[^>]+>/g, ''))
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim()
}

// ---- l'output dei tool (il loop lo incarta nel blocco evidenza) ----

/**
 * web_search: risultati come elenco (titolo, URL, estratto). Fase 15 (S6):
 * con l'etichetta del provider aggiunge la riga finale "Fonte della ricerca:"
 * (lo stesso formato che l'eval simula), così il modello sa da chi arriva la
 * risposta e può dirlo all'utente.
 */
export function webSearchToolOutput(results: WebSearchResult[], sourceLabel?: string): string {
  const list = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') || 'No results.'
  return sourceLabel ? `${list}\n\nSearch source: ${sourceLabel}` : list
}

/** Il testo della finestra richiesto dal modello (offset + indicazione per proseguire). */
export function webFetchWindowOutput(text: string, offset: number | undefined): string {
  const w = sliceWithOffset(text, offset)
  const head = offset ? `[segment from offset ${Math.max(0, Math.floor(offset))} of ${w.totalLength} characters]\n` : ''
  const tail = w.nextOffset !== null ? `\n\n[long page: ${w.totalLength} characters — continue it with web_fetch({url, offset: ${w.nextOffset}})]` : ''
  return head + w.text + tail
}

/** Clamp del numero di risultati: 5 di default, al massimo 10, almeno 1. */
export function clampMaxResults(n: unknown): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v <= 0) return WEB_SEARCH_DEFAULT_RESULTS
  return Math.min(v, WEB_SEARCH_MAX_RESULTS)
}

/** Esito cache: valido se fresco di WEB_FETCH_CACHE_MS (per i test l'orologio è iniettabile). */
export function cacheFresh(at: number, now: number): boolean {
  return now - at < WEB_FETCH_CACHE_MS
}

export { loopbackAllowedForTests }
