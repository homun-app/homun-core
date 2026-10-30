// Fase 15 (S7): i tre provider di ricerca SENZA CHIAVE — parsing delle
// fixture SINTETICHE con la stessa forma delle risposte vere (misurate dal
// revisore il 2026-10-29), header e corpo inviati, niente rete. Nessun
// header di autenticazione, User-Agent onesto, SOLO query e numero.
import { describe, expect, it, vi } from 'vitest'
import {
  youKeylessProvider, tavilyKeylessProvider, exaMcpKeylessProvider,
  parseExaResults, stripEssentialMarkdown, parseRetryAfterMs,
  sanitizeWebSearchResults, WEB_SEARCH_TITLE_MAX, WEB_SEARCH_SNIPPET_MAX,
  type ExaMcpClient, type ExaMcpClientFactory
} from '../web-search-providers'

// ---- fixture SINTETICHE (stessa forma, testo inventato) ----

const YOU_BODY = {
  results: {
    web: [
      {
        url: 'https://musei.example/orari',
        title: 'Giorni & Orari di apertura',
        description: 'Descrizione di riserva del primo risultato.',
        snippets: ['Dal lunedì al sabato ore 8.00 - 20.00 (ultimo ingresso 18.00).', 'Secondo estratto, ignorato.'],
        thumbnail_url: 'https://img.example/t.jpg',
        original_thumbnail_url: 'https://img.example/o.jpg',
        favicon_url: 'https://img.example/f.ico'
      },
      {
        url: 'https://biglietti.example',
        title: 'Biglietti e prenotazioni',
        description: 'Descrizione usata perché mancano gli snippets.'
      }
    ]
  },
  metadata: { query: 'orari musei', search_uuid: 'synthetic', latency: 0.42 }
}

const EXA_TEXT = [
  'Title: Giorni & Orari di apertura',
  'URL: https://musei.example/orari',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'Giorni & Orari di apertura',
  '',
  '## Giorni e Orari di apertura',
  '',
  'Dal lunedì al sabato ore 8.00 - 20.00.',
  '',
  '---',
  '',
  'Title: Musei — Sito ufficiale',
  'URL: https://musei.example/',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'Il sito ufficiale dei musei.',
  '',
  '---',
  '',
  'Title: Blocco senza URL',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'Questo blocco va scartato.'
].join('\n')

const TAVILY_BODY = {
  query: 'orari musei',
  follow_up_questions: null,
  answer: null,
  images: [],
  results: [
    {
      url: 'https://musei.example/it/orari',
      title: 'Musei & Cappella > Orari, biglietti',
      content: '## Orari\n\nGli orari di apertura sono Dal lunedì al sabato.',
      score: 0.9,
      raw_content: null,
      id: 'synthetic-1'
    }
  ],
  response_time: 1.47,
  request_id: 'synthetic'
}

// ---- i fetch finti catturano la richiesta ----

interface Captured { url: string; method?: string; headers: Record<string, string>; body?: unknown }

function capturingFetch(captured: Captured[], respond: (url: string) => Response): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    })
    return respond(String(url))
  }) as unknown as typeof fetch
}

/** Il client MCP di Exa FINTO: registra la chiamata e risponde col testo dato. */
function fakeExaClient(calls: Array<{ name: string; arguments?: Record<string, unknown> }>, text: string, isError = false): ExaMcpClientFactory {
  return async () => {
    const client: ExaMcpClient = {
      async callTool(params) {
        calls.push({ name: params.name, arguments: params.arguments })
        return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
      },
      async close() { /* finto: niente da chiudere */ }
    }
    return client
  }
}

describe('fase 15 S1: You.com keyless', () => {
  it('GET con query e count; MAI header di autenticazione; User-Agent presente; parsing snippets[0] o description', async () => {
    const captured: Captured[] = []
    const fetchImpl = capturingFetch(captured, () => new Response(JSON.stringify(YOU_BODY), { status: 200, headers: { 'content-type': 'application/json' } }))
    const results = await youKeylessProvider({ fetchImpl }).search('orari musei', 5)
    expect(results).toEqual([
      { title: 'Giorni & Orari di apertura', url: 'https://musei.example/orari', snippet: 'Dal lunedì al sabato ore 8.00 - 20.00 (ultimo ingresso 18.00).' },
      { title: 'Biglietti e prenotazioni', url: 'https://biglietti.example', snippet: 'Descrizione usata perché mancano gli snippets.' }
    ])
    const u = new URL(captured[0]!.url)
    expect(u.origin + u.pathname).toBe('https://api.you.com/v1/agents/search')
    expect(u.searchParams.get('query')).toBe('orari musei')
    expect(u.searchParams.get('count')).toBe('5')
    // nessuna credenziale, agente onesto, niente cookie
    expect(captured[0]!.headers.authorization).toBeUndefined()
    expect(captured[0]!.headers['X-API-Key']).toBeUndefined()
    expect(captured[0]!.headers['user-agent']).toMatch(/^Homun\//)
    expect(captured[0]!.headers.cookie).toBeUndefined()
  })

  it('429 → rate-limit con Retry-After in secondi', async () => {
    const fetchImpl = capturingFetch([], () => new Response('too many requests', { status: 429, headers: { 'retry-after': '120' } }))
    await expect(youKeylessProvider({ fetchImpl }).search('q', 5)).rejects.toMatchObject({ name: 'WebSearchProviderError', kind: 'rate-limit', status: 429, retryAfterMs: 120_000 })
  })

  it('JSON non valido → parse', async () => {
    const fetchImpl = capturingFetch([], () => new Response('<html>non è json</html>', { status: 200 }))
    await expect(youKeylessProvider({ fetchImpl }).search('q', 5)).rejects.toMatchObject({ kind: 'parse' })
    const fetchImpl2 = capturingFetch([], () => new Response('{"results": 42}', { status: 200 }))
    await expect(youKeylessProvider({ fetchImpl: fetchImpl2 }).search('q', 5)).rejects.toMatchObject({ kind: 'parse' })
  })

  it('URL non http(s) scartati', async () => {
    const body = { results: { web: [
      { url: 'ftp://musei.example/orari', title: 'ftp scartato', snippets: ['x'] },
      { url: 'javascript:alert(1)', title: 'js scartato', snippets: ['x'] },
      { url: 'https://ok.example', title: 'Ok', snippets: ['tenuto'] }
    ] } }
    const fetchImpl = capturingFetch([], () => new Response(JSON.stringify(body), { status: 200 }))
    const results = await youKeylessProvider({ fetchImpl }).search('q', 5)
    expect(results).toEqual([{ title: 'Ok', url: 'https://ok.example', snippet: 'tenuto' }])
  })
})

describe('fase 15 S1: Exa MCP keyless', () => {
  it('tools/call web_search_exa con objective = query; tre blocchi, quello senza URL scartato', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    const results = await exaMcpKeylessProvider({ makeClient: fakeExaClient(calls, EXA_TEXT) }).search('orari musei', 3)
    expect(results).toEqual([
      { title: 'Giorni & Orari di apertura', url: 'https://musei.example/orari', snippet: 'Giorni & Orari di apertura ## Giorni e Orari di apertura Dal lunedì al sabato ore 8.00 - 20.00.' },
      { title: 'Musei — Sito ufficiale', url: 'https://musei.example/', snippet: 'Il sito ufficiale dei musei.' }
    ])
    // la chiamata MCP: SOLO query, objective (= la query) e numResults
    expect(calls[0]!.name).toBe('web_search_exa')
    expect(calls[0]!.arguments).toEqual({ query: 'orari musei', objective: 'orari musei', numResults: 3 })
  })

  it('isError: true → tool-error (errore del provider)', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    await expect(
      exaMcpKeylessProvider({ makeClient: fakeExaClient(calls, 'errore del tool', true) }).search('q', 3)
    ).rejects.toMatchObject({ kind: 'tool-error' })
  })

  it('nessun testo nel result → parse', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    await expect(
      exaMcpKeylessProvider({ makeClient: fakeExaClient(calls, '') }).search('q', 3)
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('parsing puro: blocco senza Highlights → snippet vuota; URL non http scartato', () => {
    const blocks = 'Title: A\nURL: https://a.example\nPublished: N/A\n\n---\n\nTitle: B\nURL: ftp://b.example\nHighlights: scartato'
    expect(parseExaResults(blocks)).toEqual([{ title: 'A', url: 'https://a.example', snippet: '' }])
  })
})

describe('fase 15 S1: Tavily keyless', () => {
  it('POST con X-Tavily-Access-Mode: keyless e max_results; MAI autenticazione; snippet ripulita dal markdown', async () => {
    const captured: Captured[] = []
    const fetchImpl = capturingFetch(captured, () => new Response(JSON.stringify(TAVILY_BODY), { status: 200 }))
    const results = await tavilyKeylessProvider({ fetchImpl }).search('orari musei', 5)
    expect(results).toEqual([
      { title: 'Musei & Cappella > Orari, biglietti', url: 'https://musei.example/it/orari', snippet: 'Orari Gli orari di apertura sono Dal lunedì al sabato.' }
    ])
    expect(captured[0]!.url).toBe('https://api.tavily.com/search')
    expect(captured[0]!.method).toBe('POST')
    expect(captured[0]!.headers['x-tavily-access-mode']).toBe('keyless')
    expect(captured[0]!.headers['content-type']).toBe('application/json')
    expect(captured[0]!.headers.authorization).toBeUndefined()
    expect(captured[0]!.headers['user-agent']).toMatch(/^Homun\//)
    expect(captured[0]!.body).toEqual({ query: 'orari musei', max_results: 5 })
  })

  it('500 → http', async () => {
    const fetchImpl = capturingFetch([], () => new Response('boom', { status: 500 }))
    await expect(tavilyKeylessProvider({ fetchImpl }).search('q', 5)).rejects.toMatchObject({ kind: 'http', status: 500 })
  })
})

describe('fase 15 S1: helper condivisi', () => {
  it('tagli: titolo 200, estratto 500', () => {
    const long = 'x'.repeat(1000)
    const [r] = sanitizeWebSearchResults([{ title: long, url: 'https://a.example', snippet: long }])
    expect(r!.title.length).toBe(WEB_SEARCH_TITLE_MAX)
    expect(r!.snippet.length).toBe(WEB_SEARCH_SNIPPET_MAX)
    expect(sanitizeWebSearchResults([{ title: 'a', url: 'https://a.example', snippet: 's' }], 0)).toEqual([])
  })

  it('Retry-After: secondi o data HTTP; assente o passato → undefined', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000)
    expect(parseRetryAfterMs('  30 ')).toBe(30_000)
    const in2min = new Date(Date.now() + 120_000).toUTCString()
    expect(parseRetryAfterMs(in2min)).toBeGreaterThan(119_000)
    expect(parseRetryAfterMs(in2min)).toBeLessThanOrEqual(120_000)
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(parseRetryAfterMs(past)).toBe(0)
    expect(parseRetryAfterMs(undefined)).toBeUndefined()
    expect(parseRetryAfterMs('martedì')).toBeUndefined()
  })

  it('stripEssentialMarkdown: via i # dei titoli, spazi compressi', () => {
    expect(stripEssentialMarkdown('## Orari\n\nGli orari di apertura\n-Dal lunedì')).toBe('Orari Gli orari di apertura -Dal lunedì')
  })
})
