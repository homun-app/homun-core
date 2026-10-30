// Fase 15 (S1): i tre provider di ricerca web SENZA CHIAVE — canali ufficiali
// offerti dai fornitori (niente scraping di motori, niente CAPTCHA da
// aggirare): You.com (GET pubblico), Exa (server MCP ospitato, "No API key is
// required") e Tavily (access-mode keyless). Dipendenze iniettabili
// (fetchImpl, fabbrica del client MCP): i test non aprono MAI la rete.
//
// Regole di ogni chiamata (S1.3): timeout 15 s, nessun cookie, User-Agent
// SandBot/<versione>, e SOLO la query e il numero di risultati in gioco —
// mai id di agenti, path o dati del vault. Gli errori sono tipizzati
// (WebSearchProviderError) così la catena può raffreddare i rifiuti 429
// (policy di You.com) e passare al provider successivo.
import type { WebSearchProvider, WebSearchResult } from './web-tools'
import { SANDBOT_USER_AGENT, WEB_SEARCH_TIMEOUT_MS } from '../../shared/web-limits'

/** I nomi dei provider della catena (S1.2). */
export type WebSearchProviderName = 'you' | 'exa' | 'tavily' | 'ollama'

export type WebSearchErrorKind = 'rate-limit' | 'http' | 'timeout' | 'network' | 'parse' | 'tool-error'

/**
 * L'errore tipizzato di un provider (S1.5): `kind` guida la catena (429 →
 * raffreddamento con la policy di You.com; 5xx/timeout/network → raffreddamento
 * breve), `status` è quello HTTP, `retryAfterMs` viene dall'header Retry-After.
 */
export class WebSearchProviderError extends Error {
  constructor(
    readonly kind: WebSearchErrorKind,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(`search provider failed (${kind}${status !== undefined ? `, HTTP ${status}` : ''}${retryAfterMs !== undefined ? `, retry-after ${retryAfterMs} ms` : ''})`)
    this.name = 'WebSearchProviderError'
  }
}

/** Il client MCP di Exa come lo usa il provider (il default è l'SDK; i test iniettano un finto). */
export interface ExaMcpClient {
  callTool(params: {
    name: string
    arguments?: Record<string, unknown>
  }): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>
  close(): Promise<void>
}
export type ExaMcpClientFactory = () => Promise<ExaMcpClient>

/** La fabbrica di default: il client MCP che il repo già usa (StreamableHTTPClientTransport). */
async function defaultExaClient(): Promise<ExaMcpClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'sandbot', version: '0.1.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://mcp.exa.ai/mcp'), {
      requestInit: { headers: { 'user-agent': SANDBOT_USER_AGENT } }
    })
  )
  return client as unknown as ExaMcpClient
}

// ---- helper comuni ----

/**
 * Retry-After (S1.5): secondi oppure data HTTP. Torna i ms d'attesa, o
 * undefined se l'header manca o non ha senso (data nel passato).
 */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (!Number.isNaN(at)) {
    const delta = at - now
    return delta > 0 ? delta : 0
  }
  return undefined
}

/** Un errore di trasporto (fetch/timeout) diventa tipizzato. */
function classifyTransportError(e: unknown): WebSearchProviderError {
  const name = e instanceof Error ? e.name : ''
  if (name === 'TimeoutError' || name === 'AbortError' || /tempo scaduto|timeout/i.test(String(e))) {
    return new WebSearchProviderError('timeout')
  }
  return new WebSearchProviderError('network')
}

/** Tagli e filtri comuni (S1.4): titolo 200, estratto 500, SOLO URL http(s). */
export const WEB_SEARCH_TITLE_MAX = 200
export const WEB_SEARCH_SNIPPET_MAX = 500

export function sanitizeWebSearchResults(list: WebSearchResult[], maxResults = Infinity): WebSearchResult[] {
  const out: WebSearchResult[] = []
  for (const raw of list) {
    if (out.length >= maxResults) break
    let u: URL
    try {
      u = new URL(raw.url)
    } catch {
      continue
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    out.push({
      title: raw.title.slice(0, WEB_SEARCH_TITLE_MAX),
      url: raw.url,
      snippet: raw.snippet.slice(0, WEB_SEARCH_SNIPPET_MAX)
    })
  }
  return out
}

/** Il JSON della risposta, con gli errori tipizzati (429 → rate-limit con Retry-After). */
async function responseJson(r: Response): Promise<unknown> {
  if (r.status === 429) {
    throw new WebSearchProviderError('rate-limit', 429, parseRetryAfterMs(r.headers.get('retry-after')))
  }
  if (!r.ok) throw new WebSearchProviderError('http', r.status)
  try {
    return await r.json()
  } catch {
    throw new WebSearchProviderError('parse', r.status)
  }
}

export interface KeylessProviderDeps {
  fetchImpl?: typeof fetch
  /** fabbrica del client MCP (Exa): nei test un finto, in produzione l'SDK */
  makeClient?: ExaMcpClientFactory
}

// ---- You.com (primo della catena) ----

/**
 * GET https://api.you.com/v1/agents/search SENZA autenticazione. Mappatura:
 * title, url, snippet = snippets[0] (se manca, description); miniature e
 * favicon ignorate. Policy d'uso: dopo un 429 la catena mette il provider in
 * raffreddamento con attese crescenti (S3) e la cache (S4) riduce il carico.
 */
export function youKeylessProvider(deps: KeylessProviderDeps = {}): WebSearchProvider {
  const doFetch = deps.fetchImpl ?? fetch
  return {
    name: 'you',
    label: 'You.com',
    async search(query, maxResults) {
      const url = `https://api.you.com/v1/agents/search?${new URLSearchParams({ query, count: String(maxResults) })}`
      let r: Response
      try {
        r = await doFetch(url, {
          headers: { accept: 'application/json', 'user-agent': SANDBOT_USER_AGENT },
          credentials: 'omit',
          signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)
        })
      } catch (e) {
        throw classifyTransportError(e)
      }
      const j = await responseJson(r)
      const web = (j as { results?: { web?: unknown } }).results?.web
      if (!Array.isArray(web)) throw new WebSearchProviderError('parse', r.status)
      return sanitizeWebSearchResults(
        web.map((raw) => {
          const e = raw as Record<string, unknown>
          const snippets = Array.isArray(e.snippets) ? e.snippets : []
          const first = snippets.find((s) => typeof s === 'string' && s.trim() !== '')
          return {
            title: String(e.title ?? ''),
            url: String(e.url ?? ''),
            snippet: typeof first === 'string' ? first : String(e.description ?? '')
          }
        }),
        maxResults
      )
    }
  }
}

// ---- Exa (secondo): server MCP ospitato ----

/**
 * Il testo di web_search_exa è una sequenza di blocchi separati da
 * "\n\n---\n\n": riga "Title:", riga "URL:", estratto dopo "Highlights:".
 * Un blocco senza URL valido si scarta (S1/Exa parsing).
 */
export function parseExaResults(text: string, maxResults = Infinity): WebSearchResult[] {
  const out: WebSearchResult[] = []
  for (const block of text.split('\n\n---\n\n')) {
    if (out.length >= maxResults) break
    const url = /^URL: (\S+)/m.exec(block)?.[1]
    if (!url) continue // blocco senza URL: si scarta
    let u: URL
    try {
      u = new URL(url)
    } catch {
      continue
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    const title = /^Title: (.*)$/m.exec(block)?.[1] ?? ''
    const at = block.indexOf('Highlights:')
    const snippet = at >= 0 ? block.slice(at + 'Highlights:'.length) : ''
    out.push({
      title,
      url,
      snippet: snippet.replace(/\s+/g, ' ').trim()
    })
  }
  return out
}

/**
 * tools/call web_search_exa sul server MCP ospitato di Exa (nessuna
 * credenziale). `objective` è obbligatorio: passa la query stessa. Il tool
 * web_fetch_exa è VIETATO (la lettura resta web_fetch locale, con le difese
 * SSRF); un result MCP con isError:true è un errore del provider.
 */
export function exaMcpKeylessProvider(deps: KeylessProviderDeps = {}): WebSearchProvider {
  const makeClient = deps.makeClient ?? defaultExaClient
  return {
    name: 'exa',
    label: 'Exa',
    async search(query, maxResults) {
      let client: ExaMcpClient | null = null
      try {
        // timeout 15 s su CONNESSIONE+chiamata: la corsa scarta la promessa
        // lenta e il finally chiude il client
        client = await Promise.race([
          makeClient(),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new WebSearchProviderError('timeout')), WEB_SEARCH_TIMEOUT_MS)
            t.unref?.()
          })
        ])
        const res = await Promise.race([
          client.callTool({
            name: 'web_search_exa',
            arguments: { query, objective: query, numResults: maxResults }
          }),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new WebSearchProviderError('timeout')), WEB_SEARCH_TIMEOUT_MS)
            t.unref?.()
          })
        ])
        if (res.isError === true) throw new WebSearchProviderError('tool-error')
        const text = (res.content ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('\n')
        if (!text) throw new WebSearchProviderError('parse')
        return sanitizeWebSearchResults(parseExaResults(text), maxResults)
      } catch (e) {
        if (e instanceof WebSearchProviderError) throw e
        throw classifyTransportError(e)
      } finally {
        if (client) void client.close().catch(() => undefined)
      }
    }
  }
}

// ---- Tavily (terzo) ----

/** Il markdown essenziale via dallo snippet Tavily (`#` dei titoli, spazi). */
export function stripEssentialMarkdown(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/^\s*#{1,6}\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * POST https://api.tavily.com/search con X-Tavily-Access-Mode: keyless.
 * Mappatura: title, url, snippet = content ripulito dal markdown essenziale.
 */
export function tavilyKeylessProvider(deps: KeylessProviderDeps = {}): WebSearchProvider {
  const doFetch = deps.fetchImpl ?? fetch
  return {
    name: 'tavily',
    label: 'Tavily',
    async search(query, maxResults) {
      let r: Response
      try {
        r = await doFetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tavily-access-mode': 'keyless',
            'user-agent': SANDBOT_USER_AGENT
          },
          credentials: 'omit',
          body: JSON.stringify({ query, max_results: maxResults }),
          signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)
        })
      } catch (e) {
        throw classifyTransportError(e)
      }
      const j = await responseJson(r)
      const results = (j as { results?: unknown }).results
      if (!Array.isArray(results)) throw new WebSearchProviderError('parse', r.status)
      return sanitizeWebSearchResults(
        results.map((raw) => {
          const e = raw as Record<string, unknown>
          return {
            title: String(e.title ?? ''),
            url: String(e.url ?? ''),
            snippet: stripEssentialMarkdown(String(e.content ?? ''))
          }
        }),
        maxResults
      )
    }
  }
}
