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
  loopbackAllowedForTests
} from './web-guard'
import {
  WEB_FETCH_TIMEOUT_MS, WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_REDIRECTS, WEB_FETCH_CACHE_MS,
  WEB_SEARCH_DEFAULT_RESULTS, WEB_SEARCH_MAX_RESULTS
} from '../../shared/web-limits'

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
  search(query: string, maxResults: number): Promise<WebSearchResult[]>
}

/** Il messaggio quando la ricerca non è attiva (il bot lo dice all'utente, niente strade alternative). */
export const WEB_SEARCH_INACTIVE =
  'La ricerca web non è attiva: serve la chiave per la ricerca web nelle impostazioni del provider Ollama. Dì all\'utente che può attivarla da lì; non tentare strade alternative.'

/**
 * L'implementazione reale: POST https://ollama.com/api/web_search con la
 * chiave API di Ollama. La chiave viaggia SOLO nell'header Authorization:
 * mai nel contesto del modello, nei log o in argv. Il parsing della risposta
 * è tollerante (title/name, url/link, snippet/description/content).
 */
export function ollamaWebSearchProvider(
  key: string,
  deps: { fetchImpl?: typeof fetch; baseUrl?: string } = {}
): WebSearchProvider {
  const doFetch = deps.fetchImpl ?? fetch
  const base = (deps.baseUrl ?? 'https://ollama.com').replace(/\/$/, '')
  return {
    async search(query, maxResults) {
      const r = await doFetch(`${base}/api/web_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: maxResults }),
        signal: AbortSignal.timeout(30_000)
      })
      if (!r.ok) throw new Error(`ricerca web non riuscita (HTTP ${r.status})`)
      const j = (await r.json()) as unknown
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
    async search() {
      return [
        { title: 'Weekend a Roma: luoghi da vedere e dove mangiare', url: target, snippet: 'I luoghi consigliati per un weekend di due persone a Roma.' }
      ]
    }
  }
}

let realKeyGetter: (() => Promise<Buffer>) | null = null
/** Registra il getter della chiave del vault (wiring del daemon: Keychain); null lo rimuove. */
export function setWebSearchKeyGetter(getKey: (() => Promise<Buffer>) | null): void {
  realKeyGetter = getKey
}

/** Il provider attivo, o null se la ricerca non è attiva (nessuna chiave). */
export async function getWebSearchProvider(): Promise<WebSearchProvider | null> {
  if (providerOverride) return providerOverride
  const fake = fakeWebSearchProviderForTests()
  if (fake) return fake
  if (!realKeyGetter) return null
  const key = await getWebSearchKey({ getKey: realKeyGetter })
  return key ? ollamaWebSearchProvider(key) : null
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
  | { ok: true; text: string; contentType: string; finalUrl: string; downloadedBytes: number; truncated?: boolean }
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

/** User-agent onesto (SandBot/<versione>). */
export const SANDBOT_USER_AGENT = 'SandBot/0.1.0'

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
    super(`indirizzo interno: ${hostname} risolve su ${ips.join(', ') || 'nessun indirizzo'}`)
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
      () => settle(new Error(`tempo scaduto (${Math.round(WEB_FETCH_TIMEOUT_MS / 1000)} s totali per richiesta, redirect e lettura del corpo)`)),
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
        ? `indirizzo interno (${hostname}): la lettura web non tocca la rete interna`
        : null
    }
    try {
      const ips = await resolveHost(hostname, deps)
      if (!ips.length) return `host non risolto: ${hostname}`
      if (!allowAll && !resolvedIpsAllowed(ips)) {
        return `host non ammesso (${hostname} risolve su un indirizzo privato/interno): la lettura web non tocca la rete interna`
      }
      return null
    } catch {
      return `host non risolto: ${hostname}`
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
        return { ok: false, reason: `host non ammesso (${current.hostname}): ${e.message}` }
      }
      return { ok: false, reason: `richiesta non riuscita: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (r.status >= 300 && r.status < 400 && r.headers['location']) {
      if (redirect >= WEB_FETCH_MAX_REDIRECTS) return { ok: false, reason: `troppi redirect (più di ${WEB_FETCH_MAX_REDIRECTS})` }
      // il redirect si ricontrolla DA CAPO: URL valido E host ammesso
      let next: URL
      try {
        next = resolveRedirect(current, r.headers['location'])
      } catch {
        return { ok: false, reason: 'redirect con location non valida' }
      }
      const nc = checkUrl(next.toString())
      if (!nc.ok) return { ok: false, reason: `redirect non ammesso: ${nc.reason}` }
      const nd = await checkHost(next.hostname)
      if (nd) return { ok: false, reason: `redirect non ammesso: ${nd}` }
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
        reason: `il sito ha bloccato la richiesta (HTTP ${hop.status}, sfida "${sig}"): NON aggirare il blocco, segnala all'utente che la pagina non è leggibile`
      }
    }
    return { ok: false, reason: `la pagina risponde HTTP ${hop.status}` }
  }
  if (hop.status >= 400) {
    return { ok: false, reason: `la pagina risponde HTTP ${hop.status}` }
  }

  const contentType = (hop.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  const truncatedNote = hop.truncated ? '\n\n[pagina troncata: oltre i 3 MB ho tenuto i primi 3 MB]' : ''

  if (contentType.includes('html')) {
    // G3: la base per i link è l'URL FINALE (dopo i redirect)
    const text = htmlToMarkdown(bodyText(), current.toString())
    if (challengeBlocked(hop.status, bodyText(), text)) {
      return { ok: false, blocked: true, reason: 'la pagina richiede un captcha: NON aggirare il blocco, segnala all\'utente che la pagina non è leggibile' }
    }
    return {
      ok: true, text: text + truncatedNote, contentType: 'text/html',
      finalUrl: current.toString(), downloadedBytes: hop.body.length,
      ...(hop.truncated ? { truncated: true } : {})
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
    reason: `tipo non supportato (${contentType || 'sconosciuto'}): leggo html, testo e json`
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

/** web_search: risultati come elenco (titolo, URL, estratto). */
export function webSearchToolOutput(results: WebSearchResult[]): string {
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') || 'Nessun risultato.'
}

/** Il testo della finestra richiesto dal modello (offset + indicazione per proseguire). */
export function webFetchWindowOutput(text: string, offset: number | undefined): string {
  const w = sliceWithOffset(text, offset)
  const head = offset ? `[segmento da offset ${Math.max(0, Math.floor(offset))} di ${w.totalLength} caratteri]\n` : ''
  const tail = w.nextOffset !== null ? `\n\n[pagina lunga: ${w.totalLength} caratteri — proseguila con web_fetch({url, offset: ${w.nextOffset}})]` : ''
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
