// Tool web (fase 11, punto 2): la RICERCA usa un servizio esterno dietro
// l'interfaccia sostituibile WebSearchProvider (implementazione reale: la web
// search API di Ollama, chiave SOLO nel vault sigillato); la LETTURA
// (web_fetch) gira in LOCALE nel daemon: nessuna chiave, nessun credito, con
// difese SSRF (web-guard, puro). L'output di entrambi è DATO NON FIDATO: il
// loop lo incarta nel blocco evidenza e contamina il turno (niente
// auto-review sulle azioni con effetti).
//
// Dipendenze iniettabili (fetch, DNS, orologio): i test non toccano la rete
// reale; il loopback è ammesso SOLO col flag di test
// SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1 (che non esiste in produzione).
import { createConnectorsSecretStore } from '../connectors/sealed-store'
import { getSetting, setSetting } from '../store/db'
import {
  checkUrl, resolveRedirect, resolvedIpsAllowed, sliceWithOffset,
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

let realKeyGetter: (() => Promise<Buffer>) | null = null
/** Registra il getter della chiave del vault (wiring del daemon: Keychain); null lo rimuove. */
export function setWebSearchKeyGetter(getKey: (() => Promise<Buffer>) | null): void {
  realKeyGetter = getKey
}

/** Il provider attivo, o null se la ricerca non è attiva (nessuna chiave). */
export async function getWebSearchProvider(): Promise<WebSearchProvider | null> {
  if (providerOverride) return providerOverride
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
  fetchImpl?: typeof fetch
  /** risoluzione DNS iniettabile: torna TUTTI gli indirizzi dell'host */
  lookup?: (host: string) => Promise<string[]>
  now?: () => number
}

export type WebFetchOutcome =
  | { ok: true; text: string; contentType: string; finalUrl: string; downloadedBytes: number }
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
 * Scarica e converte una pagina (locale, nessuna chiave): solo http/https,
 * DNS risolto e IP privati rifiutati A OGNI redirect (max 5), niente
 * credenziali nell'URL, timeout 20 s, download 3 MB. HTML → testo leggibile
 * in markdown; testo e JSON così come sono; altri tipi non supportati.
 * 403/429/captcha → esito "bloccato" esplicito (il bot NON lo aggira e lo
 * segnala all'utente, come ReportSiteBlocked in Grok).
 */
export async function webFetch(rawUrl: string, deps: WebFetchDeps = {}): Promise<WebFetchOutcome> {
  const now = deps.now ?? Date.now
  const check = checkUrl(rawUrl)
  if (!check.ok) return { ok: false, reason: check.reason }
  let current = check.url
  const doFetch = deps.fetchImpl ?? fetch

  // DNS: gli IP risolti devono essere pubblici (flag di test a parte)
  const checkDns = async (u: URL): Promise<string | null> => {
    try {
      const ips = await resolveHost(u.hostname, deps)
      if (!ips.length) return `host non risolto: ${u.hostname}`
      if (!resolvedIpsAllowed(ips)) {
        return `host non ammesso (${u.hostname} risolve su un indirizzo privato/interno): la lettura web non tocca la rete interna`
      }
      return null
    } catch {
      return `host non risolto: ${u.hostname}`
    }
  }

  const dnsErr = await checkDns(current)
  if (dnsErr) return { ok: false, reason: dnsErr }

  let response: Response
  for (let hop = 0; ; hop++) {
    let r: Response
    try {
      r = await doFetch(current.toString(), {
        redirect: 'manual',
        headers: { 'user-agent': SANDBOT_USER_AGENT, accept: 'text/html,application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
      })
    } catch (e) {
      return { ok: false, reason: `richiesta non riuscita: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      if (hop >= WEB_FETCH_MAX_REDIRECTS) return { ok: false, reason: `troppi redirect (più di ${WEB_FETCH_MAX_REDIRECTS})` }
      // il redirect si ricontrolla DA CAPO: URL valido E DNS ammesso
      let next: URL
      try {
        next = resolveRedirect(current, r.headers.get('location')!)
      } catch {
        return { ok: false, reason: 'redirect con location non valida' }
      }
      const nc = checkUrl(next.toString())
      if (!nc.ok) return { ok: false, reason: `redirect non ammesso: ${nc.reason}` }
      const nd = await checkDns(next)
      if (nd) return { ok: false, reason: `redirect non ammesso: ${nd}` }
      current = next
      continue
    }
    response = r
    break
  }

  if (response.status === 403 || response.status === 429) {
    return {
      ok: false,
      blocked: true,
      reason: `il sito ha bloccato la richiesta (HTTP ${response.status}): NON aggirare il blocco, segnala all'utente che la pagina non è leggibile`
    }
  }
  if (response.status >= 400) {
    return { ok: false, reason: `la pagina risponde HTTP ${response.status}` }
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > WEB_FETCH_MAX_BYTES) {
    return { ok: false, reason: `pagina troppo grande (${declared} byte dichiarati, limite ${WEB_FETCH_MAX_BYTES})` }
  }
  const buf = Buffer.from(await response.arrayBuffer())
  const bytes = Math.min(buf.length, WEB_FETCH_MAX_BYTES)
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]
  const decode = (b: Buffer): string => {
    try {
      return b.toString((charset && charset !== 'iso-8859-1' ? charset : 'utf8') as BufferEncoding)
    } catch {
      return b.toString('utf8')
    }
  }
  const text = decode(buf.subarray(0, bytes))

  if (contentType.includes('html')) {
    if (/recaptcha|hcaptcha|turnstile|cf-challenge/i.test(text)) {
      return { ok: false, blocked: true, reason: 'la pagina richiede un captcha: NON aggirare il blocco, segnala all\'utente che la pagina non è leggibile' }
    }
    return { ok: true, text: htmlToMarkdown(text), contentType: 'text/html', finalUrl: current.toString(), downloadedBytes: bytes }
  }
  if (contentType.startsWith('text/') || contentType.includes('json')) {
    return { ok: true, text, contentType, finalUrl: current.toString(), downloadedBytes: bytes }
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
 * Estrazione dell'articolo e conversione essenziale in markdown (puro): via
 * script/style/nav ealtro rumore; se c'è <article> o <main> si usa quello;
 * heading, link, liste, grassetti e codice diventano markdown; il resto dei
 * tag si elimina. Non è un parser HTML completo: è la lettura essenziale.
 */
export function htmlToMarkdown(html: string): string {
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
      return label && href && !href.startsWith('javascript:') ? `[${label}](${href})` : label
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
