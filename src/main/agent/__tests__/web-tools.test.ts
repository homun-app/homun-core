// Tool web (fase 11, punto 2): la chiave nel vault sigillato, il provider
// sostituibile (finto nei test), web_fetch con difese SSRF (DNS e redirect
// iniettabili + un server http LOCALE col flag di test), conversione HTML,
// limiti, offset e cache. Nessuna rete reale: il loopback è ammesso SOLO col
// flag SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1 (verifica d'integrazione).
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-webtools-test-'))
// lo store dei settings (dove vive il campo CIFRATO della chiave) su temporanea
vi.mock('../../store/db', () => ({
  getSetting: vi.fn(<T>(_key: string, fallback: T): T => fallback),
  setSetting: vi.fn()
}))

const {
  getWebSearchKey, setWebSearchKey, isWebSearchKeySet, clearWebSearchKey,
  ollamaWebSearchProvider, getWebSearchProvider, setWebSearchProviderForTests,
  setWebSearchKeyGetter, webFetch, webFetchCached, clearWebFetchCache,
  htmlToMarkdown, decodeEntities, webSearchToolOutput, webFetchWindowOutput,
  clampMaxResults, cacheFresh, WEB_SEARCH_INACTIVE, WEB_SEARCH_UNAVAILABLE, getWebFetchFn, setWebFetchForTests,
  searchWeb, resetWebSearchStateForTests, providerCoolingDown, noteSearchRateLimit,
  noteSearchSuccess, noteSearchTransientFailure, normalizeSearchQuery, fakeWebSearchChainForTests,
  webSearchStatus, RATE_LIMIT_RETRY_AFTER_CAP_MS, RATE_LIMIT_BACKOFF_BASE_MS, RATE_LIMIT_BACKOFF_MAX_MS
} = await import('../web-tools')
import {
  type ExaMcpClient, type ExaMcpClientFactory
} from '../web-search-providers'
import { getSetting, setSetting } from '../../store/db'
import { WEB_FETCH_MAX_BYTES, WEB_FETCH_TIMEOUT_MS, WEB_FETCH_CACHE_MS } from '../../../shared/web-limits'

// il vault sigillato con chiave iniettata (niente Keychain reale)
const KEY = Buffer.alloc(32, 7)
const sealedDeps = { getKey: async () => KEY }
const publicFetchImpl = vi.fn()

beforeAll(() => {
  // fase 15: anche il setting webSearch.keyless passa dallo stesso store
  // (fase 11: il campo CIFRATO della chiave vive in connectors.secrets)
  vi.mocked(getSetting).mockImplementation(<T>(key: string, fallback: T): T =>
    webSettings[key] !== undefined ? (webSettings[key] as T) : fallback)
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
beforeEach(() => {
  vi.mocked(setSetting).mockImplementation((key: string, value: unknown) => { webSettings[key] = value })
  webSettings = {}
  setWebSearchProviderForTests(null)
  setWebSearchKeyGetter(null)
  setWebFetchForTests(null)
  publicFetchImpl.mockReset()
  clearWebFetchCache()
  resetWebSearchStateForTests()
})

// lo stato dei settings catturato dai mock (campo cifrato della chiave)
let webSettings: Record<string, unknown> = {}

describe('chiave della ricerca web: SOLO nel vault sigillato', () => {
  it('roundtrip set/get/clear: nei settings finisce solo il campo CIFRATO (envelope sandVault)', async () => {
    expect(await isWebSearchKeySet(sealedDeps)).toBe(false)
    await setWebSearchKey('sk-web-123', sealedDeps)
    expect(await isWebSearchKeySet(sealedDeps)).toBe(true)
    expect(await getWebSearchKey(sealedDeps)).toBe('sk-web-123')
    const stored = webSettings['connectors.secrets'] as Record<string, Record<string, { sandVault: number; data: string }>>
    const sealed = stored.websearch?.apiKey
    expect(sealed?.sandVault).toBe(1)
    // MAI in chiaro: il valore non compare nel setting cifrato
    expect(JSON.stringify(stored)).not.toContain('sk-web-123')
    await clearWebSearchKey(sealedDeps)
    expect(await isWebSearchKeySet(sealedDeps)).toBe(false)
  })

  it('provider attivo SOLO con la chiave (o con quello iniettato per i test)', async () => {
    expect(await getWebSearchProvider()).toBeNull()
    setWebSearchKeyGetter(async () => KEY)
    expect(await getWebSearchProvider()).toBeNull() // chiave ancora assente
    await setWebSearchKey('k', sealedDeps)
    expect(await getWebSearchProvider()).not.toBeNull()
  })

  it("implementazione Ollama: POST /api/web_search con Bearer (chiave SOLO nell'header), parsing tollerante", async () => {
    const captured: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
    publicFetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      captured.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ results: [
        { title: 'Trattoria da Leo', url: 'https://da-leo.example', snippet: 'vegetariano a Bologna' },
        { name: 'Altro', link: 'https://altro.example', description: ' secondo risultato' }
      ] }), { status: 200 })
    })
    const p = ollamaWebSearchProvider('sk-test', { fetchImpl: publicFetchImpl as unknown as typeof fetch })
    const results = await p.search('ristoranti vegetariani bologna', 5)
    expect(results).toEqual([
      { title: 'Trattoria da Leo', url: 'https://da-leo.example', snippet: 'vegetariano a Bologna' },
      { title: 'Altro', url: 'https://altro.example', snippet: ' secondo risultato' }
    ])
    expect(captured[0]!.url).toBe('https://ollama.com/api/web_search')
    expect(captured[0]!.headers.authorization).toBe('Bearer sk-test')
    expect(captured[0]!.body).toEqual({ query: 'ristoranti vegetariani bologna', max_results: 5 })
  })
})

describe('output dei tool', () => {
  it('web_search: elenco titolo/URL/estratto', () => {
    const out = webSearchToolOutput([{ title: 'A', url: 'https://a.example', snippet: 'sa' }, { title: 'B', url: 'https://b.example', snippet: 'sb' }])
    expect(out).toContain('1. A')
    expect(out).toContain('https://a.example')
    expect(out).toContain('2. B')
    expect(webSearchToolOutput([])).toBe('No results.')
  })

  it('clamp dei risultati: default 5, minimo 1, massimo 10', () => {
    expect(clampMaxResults(undefined)).toBe(5)
    expect(clampMaxResults(0)).toBe(5)
    expect(clampMaxResults(3)).toBe(3)
    expect(clampMaxResults(50)).toBe(10)
  })

  it('web_fetch window: 20k caratteri e suggerimento dell\'offset', () => {
    const out = webFetchWindowOutput('x'.repeat(21_000), undefined)
    expect(out.startsWith('x'.repeat(20_000))).toBe(true)
    expect(out).toContain('long page: 21000 characters')
    expect(out).toContain('offset: 20000')
    expect(webFetchWindowOutput('corto', undefined)).toBe('corto')
    expect(webFetchWindowOutput('0123456789', 5)).toBe('[segment from offset 5 of 10 characters]\n56789')
  })

  it("il messaggio della ricerca non attiva dice all'utente cosa fare", () => {
    expect(WEB_SEARCH_INACTIVE).toContain('disabled in the settings')
    expect(WEB_SEARCH_INACTIVE.toLowerCase()).toContain('settings')
    expect(WEB_SEARCH_INACTIVE.toLowerCase()).toContain('do not search on search engines with the browser')
  })

  it('fase 15 (S6): WEB_SEARCH_UNAVAILABLE — tutti falliti o in raffreddamento', () => {
    expect(WEB_SEARCH_UNAVAILABLE).toContain('not available right now')
    expect(WEB_SEARCH_UNAVAILABLE).toContain('web_fetch')
    expect(WEB_SEARCH_UNAVAILABLE.toLowerCase()).toContain('do not search on search engines with the browser')
  })

  it('fase 15 (S6): webSearchToolOutput con la fonte aggiunge la riga finale', () => {
    const out = webSearchToolOutput([{ title: 'A', url: 'https://a.example', snippet: 'sa' }], 'You.com')
    expect(out.endsWith('Search source: You.com')).toBe(true)
    // senza fonte il formato è quello di sempre
    expect(webSearchToolOutput([])).toBe('No results.')
    expect(webSearchToolOutput([], 'Exa')).toBe('No results.\n\nSearch source: Exa')
  })
})

// ---- fase 15 (S2-S5): la catena, il raffreddamento, la cache e i setting ----
// Nessuna rete: fetch ed Exa MCP sono finti e iniettati nelle deps di searchWeb.

describe('fase 15 S2: la catena dei provider', () => {
  /** fetch finto: You.com ok (un risultato), Tavily 500, Ollama (se chiamato) 500. */
  function chainFetch(log: string[]): typeof fetch {
    return vi.fn(async (url: string | URL) => {
      const s = String(url)
      if (s.startsWith('https://api.you.com')) {
        log.push('you')
        return new Response(JSON.stringify({ results: { web: [{ url: 'https://ris.example/1', title: 'Risultato You', snippets: ['estratto you'] }] } }), { status: 200 })
      }
      if (s.startsWith('https://api.tavily.com')) {
        log.push('tavily')
        return new Response('boom', { status: 500 })
      }
      log.push('ollama:' + s)
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch
  }

  /** fetch finto: You.com 429, Tavily 500. */
  function you429Fetch(log: string[], retryAfter?: string): typeof fetch {
    return vi.fn(async (url: string | URL) => {
      const s = String(url)
      if (s.startsWith('https://api.you.com')) {
        log.push('you')
        return new Response('slow down', { status: 429, ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}) })
      }
      log.push('tavily')
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch
  }

  /** Il client Exa finto che risponde con un risultato. */
  function exaOk(log: string[], calls: Array<{ name: string; arguments?: Record<string, unknown> }>): ExaMcpClientFactory {
    return async () => ({
      async callTool(params) {
        log.push('exa')
        calls.push({ name: params.name, arguments: params.arguments })
        return { content: [{ type: 'text', text: 'Title: Da Exa\nURL: https://ris.example/2\nHighlights:\nestratto exa' }] }
      },
      async close() { /* finto */ }
    })
  }

  it('senza chiave: ordine You.com → Exa → Tavily; You.com risponde e gli altri NON vengono chiamati', async () => {
    const log: string[] = []
    const r = await searchWeb('orari musei', 5, { fetchImpl: chainFetch(log), makeExaClient: exaOk(log, []) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.provider).toEqual({ name: 'you', label: 'You.com' })
      expect(r.results[0]).toEqual({ title: 'Risultato You', url: 'https://ris.example/1', snippet: 'estratto you' })
    }
    expect(log).toEqual(['you'])
  })

  it('con la chiave Ollama: prima Ollama, poi (se fallisce) i keyless nello stesso ordine', async () => {
    setWebSearchKeyGetter(async () => KEY)
    await setWebSearchKey('sk-test', sealedDeps)
    const log: string[] = []
    const r = await searchWeb('orari musei', 5, { fetchImpl: chainFetch(log), makeExaClient: exaOk(log, []) })
    // ollama → 500, you → ok: ordine rispettato, nessun secondo tentativo
    expect(log).toEqual(['ollama:https://ollama.com/api/web_search', 'you'])
    expect(r.ok && r.provider.name).toBe('you')
  })

  it('429 su You.com → risposta da Exa nella STESSA chiamata, provider exa; You.com chiamato UNA volta sola', async () => {
    const log: string[] = []
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    const r = await searchWeb('orari musei', 5, { fetchImpl: you429Fetch(log), makeExaClient: exaOk(log, calls) })
    expect(r.ok && r.provider).toEqual({ name: 'exa', label: 'Exa' })
    expect(log).toEqual(['you', 'exa']) // you UNA volta, poi exa: mai due tentativi allo stesso provider
    expect(calls[0]!.arguments).toEqual({ query: 'orari musei', objective: 'orari musei', numResults: 5 })
  })

  it('tutti in errore → all-failed col motivo per provider (tipo e status), MAI la query', async () => {
    const log: string[] = []
    const exaKo: ExaMcpClientFactory = async () => ({
      async callTool() { log.push('exa'); throw new Error('rete giù') },
      async close() { /* finto */ }
    })
    const r = await searchWeb('orari musei', 5, { fetchImpl: you429Fetch(log), makeExaClient: exaKo })
    expect(r).toMatchObject({ ok: false, error: 'all-failed' })
    if (!r.ok) {
      expect(r.failures).toEqual([
        { name: 'you', kind: 'rate-limit', status: 429 },
        { name: 'exa', kind: 'network' },
        { name: 'tavily', kind: 'http', status: 500 }
      ])
      // privacy (S2.5): la query MAI negli esiti
      expect(JSON.stringify(r.failures)).not.toContain('orari')
    }
  })

  it('zero risultati è una risposta VALIDA: nessun passaggio al successivo', async () => {
    const log: string[] = []
    const emptyYou: typeof fetch = vi.fn(async (url: string | URL) => {
      log.push(String(url).includes('you.com') ? 'you' : 'altro')
      return new Response(JSON.stringify({ results: { web: [] } }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await searchWeb('query senza risultati', 5, { fetchImpl: emptyYou, makeExaClient: exaOk(log, []) })
    expect(r).toMatchObject({ ok: true, provider: { name: 'you' }, results: [] })
    expect(log).toEqual(['you']) // exa mai chiamato
  })
})

describe('fase 15 S3: raffreddamento dopo i rifiuti (orologio finto)', () => {
  const T0 = 1_700_000_000_000

  it('Retry-After: 120 rispettato; il provider in raffreddamento si SALTA senza chiamarlo', async () => {
    const log: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const s = String(url)
      if (s.startsWith('https://api.you.com')) {
        log.push('you')
        return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })
      }
      log.push('tavily')
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch
    const makeExaClient: ExaMcpClientFactory = async () => ({
      async callTool() {
        log.push('exa')
        return { content: [{ type: 'text', text: 'Title: Da Exa\nURL: https://ris.example/2\nHighlights:\nestratto exa' }] }
      },
      async close() { /* finto */ }
    })
    let now = T0
    const deps = () => ({ now: () => now, fetchImpl, makeExaClient })
    const r1 = await searchWeb('orari musei', 5, deps())
    expect(r1.ok && r1.provider.name).toBe('exa') // you 429 → exa nella STESSA chiamata
    // you in raffreddamento per 120 s: un'altra ricerca NON lo chiama
    now = T0 + 60_000
    log.length = 0
    await searchWeb('altra query', 5, deps())
    expect(log).not.toContain('you')
    expect(log).toContain('exa') // la risposta arriva comunque
    // a 121 s il raffreddamento è scaduto: you viene riprovato (e il nuovo
    // 429 riapre il raffreddamento di 120 s da ADESSO)
    now = T0 + 121_000
    log.length = 0
    await searchWeb('terza query', 5, deps())
    expect(log).toContain('you')
    expect(providerCoolingDown('you', T0 + 121_000)).toBe(T0 + 121_000 + 120_000)
  })

  it('senza Retry-After le attese raddoppiano: 1 → 2 → 4 min, tetto 1 h; il successo azzera', () => {
    let now = T0
    noteSearchRateLimit('you', undefined, now)
    expect(providerCoolingDown('you', now) - now).toBe(RATE_LIMIT_BACKOFF_BASE_MS)
    now += 1
    noteSearchRateLimit('you', undefined, now)
    expect(providerCoolingDown('you', now) - now).toBe(2 * RATE_LIMIT_BACKOFF_BASE_MS)
    now += 1
    noteSearchRateLimit('you', undefined, now)
    expect(providerCoolingDown('you', now) - now).toBe(4 * RATE_LIMIT_BACKOFF_BASE_MS)
    // raddoppio fin oltre l'ora: il tetto è 1 h
    for (let i = 0; i < 10; i++) noteSearchRateLimit('you', undefined, now)
    expect(providerCoolingDown('you', now) - now).toBe(RATE_LIMIT_BACKOFF_MAX_MS)
    // Retry-After enorme: tetto 6 h
    noteSearchRateLimit('you', 24 * 60 * 60_000, now)
    expect(providerCoolingDown('you', now) - now).toBe(RATE_LIMIT_RETRY_AFTER_CAP_MS)
    // il primo successo azzera tutto
    noteSearchSuccess('you', now)
    expect(providerCoolingDown('you', now)).toBe(0)
  })

  it('http 5xx / timeout / network: raffreddamento di 1 minuto', () => {
    noteSearchTransientFailure('tavily', 'http', T0)
    expect(providerCoolingDown('tavily', T0) - T0).toBe(60_000)
    expect(providerCoolingDown('tavily', T0 + 60_000)).toBe(0)
    noteSearchTransientFailure('exa', 'timeout', T0)
    expect(providerCoolingDown('exa', T0 + 59_999) - T0).toBe(60_000)
  })
})

describe('fase 15 S4: cache delle ricerche (15 minuti)', () => {
  const T0 = 1_700_000_000_000
  let now = T0
  const log: string[] = []
  const fetchImpl = vi.fn(async () => {
    log.push('fetch')
    return new Response(JSON.stringify({ results: { web: [{ url: 'https://ris.example/1', title: 'Risultato You', snippets: ['estratto'] }] } }), { status: 200 })
  }) as unknown as typeof fetch
  const deps = () => ({ now: () => now, fetchImpl, makeExaClient: undefined })

  it('la stessa query (maiuscole e spazi diversi) entro 15 min fa ZERO chiamate; dopo 15 min richiama', async () => {
    now = T0
    await searchWeb('orari   Musei Vaticani', 5, deps())
    expect(log.length).toBe(1)
    // stessa ricerca, maiuscole e spazi diversi: cache
    await searchWeb('orari musei vaticani', 5, deps())
    expect(log.length).toBe(1)
    // maxResults diverso → chiave diversa → chiamata
    await searchWeb('orari musei vaticani', 3, deps())
    expect(log.length).toBe(2)
    // dopo 15 minuti (e un secondo) la cache è scaduta
    now = T0 + WEB_FETCH_CACHE_MS + 1_000
    await searchWeb('orari musei vaticani', 5, deps())
    expect(log.length).toBe(3)
  })

  it('normalizzazione: minuscole, spazi compressi, trim', () => {
    expect(normalizeSearchQuery('  Orari   MUSEI  ')).toBe('orari musei')
  })

  it('tetto di 200 voci: la più vecchia viene espulsa', async () => {
    resetWebSearchStateForTests()
    log.length = 0
    now = T0
    for (let i = 0; i < 201; i++) await searchWeb(`query numero ${i}`, 5, deps())
    expect(log.length).toBe(201)
    // la prima ("query numero 0") è stata espulsa: richiamarla fa una richiesta;
    // la 200a è ancora in cache: richiederla NON fa nulla
    const before = log.length
    await searchWeb('query numero 0', 5, deps())
    expect(log.length).toBe(before + 1)
    await searchWeb('query numero 200', 5, deps())
    expect(log.length).toBe(before + 1)
  })
})

describe('fase 15 S5: impostazioni e stato', () => {
  it('webSearch.keyless = false SENZA chiave → inactive (WEB_SEARCH_INACTIVE al tool)', async () => {
    webSettings['webSearch.keyless'] = false
    const r = await searchWeb('orari musei', 5, { fetchImpl: vi.fn() as unknown as typeof fetch })
    expect(r).toEqual({ ok: false, error: 'inactive', failures: [] })
  })

  it('webSearch.keyless = false CON la chiave Ollama → solo Ollama', async () => {
    webSettings['webSearch.keyless'] = false
    setWebSearchKeyGetter(async () => KEY)
    await setWebSearchKey('sk-test', sealedDeps)
    const log: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL) => {
      log.push(String(url))
      return new Response(JSON.stringify({ results: [{ title: 'Da Ollama', url: 'https://ris.example/o', snippet: 'estratto ollama' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await searchWeb('orari musei', 5, { fetchImpl })
    expect(r.ok && r.provider).toEqual({ name: 'ollama', label: 'Ollama' })
    expect(log).toEqual(['https://ollama.com/api/web_search']) // NESSUN keyless chiamato
  })

  it('lo stato per la UI: disponibile, in raffreddamento o ultimo errore', async () => {
    let st = await webSearchStatus({ now: () => 1000 })
    expect(st.keyless).toBe(true)
    expect(st.keyedConfigured).toBe(false)
    expect(st.providers.map((p) => p.name)).toEqual(['you', 'exa', 'tavily'])
    expect(st.providers[0]).toEqual({ name: 'you', label: 'You.com' }) // disponibile
    noteSearchRateLimit('you', 60_000, 1000)
    st = await webSearchStatus({ now: () => 1000 })
    expect(st.providers.find((p) => p.name === 'you')).toMatchObject({ cooldownUntil: 61_000, lastError: { kind: 'rate-limit', status: 429 } })
    // con la chiave configurata compare anche Ollama
    setWebSearchKeyGetter(async () => KEY)
    await setWebSearchKey('sk-test', sealedDeps)
    st = await webSearchStatus({ now: () => 1000 })
    expect(st.keyedConfigured).toBe(true)
    expect(st.providers.map((p) => p.name)).toContain('ollama')
  })

  it('SANDBOT_TEST_FAKE_WEB_SEARCH_CHAIN: You.com 429 → Exa ok (flag di test, mai in produzione)', () => {
    process.env.SANDBOT_TEST_FAKE_WEB_SEARCH_CHAIN = '1'
    try {
      const chain = fakeWebSearchChainForTests()
      expect(chain?.map((p) => p.name)).toEqual(['you', 'exa'])
    } finally {
      delete process.env.SANDBOT_TEST_FAKE_WEB_SEARCH_CHAIN
    }
    expect(fakeWebSearchChainForTests()).toBeNull()
  })
})

describe('htmlToMarkdown (puro)', () => {
  it('estrae l\'articolo e converte i tag essenziali', () => {
    const html = [
      '<html><head><title>Ignorato</title><style>a{}</style></head>',
      '<body><nav>menu rumore</nav>',
      '<article>',
      '<h1>Titolo</h1>',
      '<p>Primo <strong>importante</strong> paragrafo con <a href="https://x.example">un link</a>.</p>',
      '<h2>Sotto</h2>',
      '<ul><li>uno</li><li>due</li></ul>',
      '<script>alert(1)</script>',
      '</article>',
      '<footer>piè rumore</footer></body></html>'
    ].join('')
    const md = htmlToMarkdown(html)
    expect(md).toContain('# Titolo')
    expect(md).toContain('## Sotto')
    expect(md).toContain('**importante**')
    expect(md).toContain('[un link](https://x.example/)') // G3: URL normalizzato da new URL
    expect(md).toContain('- uno')
    expect(md).toContain('- due')
    expect(md).not.toContain('menu rumore')
    expect(md).not.toContain('piè rumore')
    expect(md).not.toContain('alert(1)')
  })

  it('entità decodificate', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &nbsp;')).toBe("a & b <c> \"d\" 'e'  ")
  })

  it('G3: un href RELATIVO diventa assoluto risolto contro la base (URL finale della pagina)', () => {
    const html = '<article><p>Vedi <a href="/wiki/Speciale:Map/Trastevere">la mappa</a> e <a href="../Luoghi">i luoghi</a>.</p></article>'
    const md = htmlToMarkdown(html, 'https://it.wikipedia.org/wiki/Trastevere')
    expect(md).toContain('[la mappa](https://it.wikipedia.org/wiki/Speciale:Map/Trastevere)')
    expect(md).toContain('[i luoghi](https://it.wikipedia.org/Luoghi)')
    expect(md).not.toContain('](/wiki/')
  })

  it('G3: javascript:, mailto: e tel: restano TESTO senza link (solo http(s) sono link)', () => {
    const html = [
      '<article>',
      '<a href="javascript:alert(1)">clicca</a>',
      '<a href="mailto:info@example.org">scrivici</a>',
      '<a href="tel:+39061234">chiamaci</a>',
      '<a href="https://x.example/ok">un link vero</a>',
      '</article>'
    ].join('')
    const md = htmlToMarkdown(html, 'https://base.example/pagina')
    expect(md).toContain('clicca')
    expect(md).toContain('scrivici')
    expect(md).toContain('chiamaci')
    // i protocolli non-http(s) non compaiono MAI come link
    expect(md).not.toContain('javascript:')
    expect(md).not.toContain('mailto:')
    expect(md).not.toContain('tel:')
    expect(md).toContain('[un link vero](https://x.example/ok)')
  })

  it('G3: href relativo SENZA base non diventa un link rotto (resta testo)', () => {
    const md = htmlToMarkdown('<article><a href="/altrove">vai</a></article>')
    expect(md).toBe('vai')
  })
})

// ---- webFetch con lookup/trasporto iniettabili (SSRF: nessuna rete) ----

/**
 * Un trasporto FINTO che si comporta come node alla connessione: PRIMA chiama
 * la lookup VALIDANTE (è lei a decidere se e verso cosa aprire il socket),
 * POI conta la connessione e risponde. Così i test provano che la difesa sta
 * davvero al momento della connessione, non in un pre-check aggirabile.
 */
function fakeTransport(respond: (url: URL) => { status: number; body?: string; headers?: Record<string, string> }) {
  const connections: string[] = []
  const seenOpts: Array<{ url: string; deadlineAt: number; maxBytes: number }> = []
  const transport: import('../web-tools').HttpTransport = async (url, opts) => {
    await new Promise<void>((resolve, reject) => {
      opts.lookup(url.hostname, { all: true }, (err) => { if (err) reject(err); else resolve() })
    })
    connections.push(url.hostname)
    seenOpts.push({ url: url.toString(), deadlineAt: opts.deadlineAt, maxBytes: opts.maxBytes })
    const r = respond(url)
    return { status: r.status, headers: r.headers ?? {}, body: Buffer.from(r.body ?? ''), truncated: false }
  }
  return { transport, connections, seenOpts }
}

const hop200 = { status: 200, body: 'contenuto', headers: { 'content-type': 'text/plain' } }

describe('webFetch: difese SSRF (validazione ALLA CONNESSIONE, F4)', () => {
  it('DNS che risolve a privato → rifiuto PRIMA della connessione', async () => {
    const f = fakeTransport(() => hop200)
    const r = await webFetch('https://internal.example/', {
      transport: f.transport,
      lookup: async () => ['10.0.0.5']
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('private/internal')
    expect(f.connections).toHaveLength(0)
  })

  it('anti-TOCTOU: lookup pubblico al primo colpo e loopback al secondo → NESSUNA connessione', async () => {
    // il vecchio percorso risolveva DUE volte (checkDns e poi fetch): un
    // dominio con TTL 0 passava il pre-check e connetteva al loopback. Ora il
    // pre-check passa (primo colpo pubblico) ma la lookup DELLA CONNESSIONE
    // rifiuta il secondo colpo: il socket non si apre
    let calls = 0
    const lookup = async (): Promise<string[]> => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1'])
    const f = fakeTransport(() => hop200)
    const r = await webFetch('http://rebinding.example/', { transport: f.transport, lookup })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('host not allowed')
    expect(calls).toBe(2)
    expect(f.connections).toHaveLength(0)
  })

  it('IP letterali IPv6 rifiutati col motivo "indirizzo interno" (non "non risolto")', async () => {
    const f = fakeTransport(() => hop200)
    for (const u of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/']) {
      const r = await webFetch(u, { transport: f.transport })
      expect(r.ok, u).toBe(false)
      if (!r.ok) {
        expect(r.reason, u).toContain('internal address')
        expect(r.reason, u).not.toContain('not resolved')
      }
    }
    expect(f.connections).toHaveLength(0)
  })

  it('redirect verso host privato → rifiuto A OGNI hop (il redirect si ricontrolla)', async () => {
    const f = fakeTransport((url) => {
      if (url.hostname === 'public.example') {
        return { status: 302, headers: { location: 'http://private.local/segreto' } }
      }
      return hop200
    })
    const r = await webFetch('http://public.example/', {
      transport: f.transport,
      lookup: async (host) => (host === 'private.local' ? ['192.168.1.9'] : ['93.184.216.34'])
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('redirect not allowed')
    // solo il primo hop (pubblico) si è connesso: il secondo mai
    expect(f.connections).toEqual(['public.example'])
  })

  it('troppi redirect → rifiuto (massimo 5)', async () => {
    const f = fakeTransport(() => ({ status: 302, headers: { location: '/next' } }))
    const r = await webFetch('http://public.example/a', { transport: f.transport, lookup: async () => ['93.184.216.34'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('redirect')
  })

  it('G3: dopo un redirect i link della pagina si risolvono contro l\'URL FINALE', async () => {
    const f = fakeTransport((url): { status: number; headers: Record<string, string>; body?: string } => {
      if (url.pathname === '/partenza') return { status: 302, headers: { location: '/arrivo/pagina' } }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: '<article><a href="relativo">un link</a></article>' }
    })
    const r = await webFetch('http://public.example/partenza', { transport: f.transport, lookup: async () => ['93.184.216.34'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.finalUrl).toBe('http://public.example/arrivo/pagina')
      // href RELATIVO (senza /): si risolve contro l'URL FINALE, non la partenza
      expect(r.text).toContain('[un link](http://public.example/arrivo/relativo)')
    }
  })

  it('scadenza TOTALE di 20 s e tetto dei 3 MB passati al trasporto', async () => {
    const t0 = 1_000_000
    const f = fakeTransport(() => hop200)
    const r = await webFetch('http://public.example/', { transport: f.transport, lookup: async () => ['93.184.216.34'], now: () => t0 })
    expect(r.ok).toBe(true)
    expect(f.seenOpts[0]!.deadlineAt).toBe(t0 + WEB_FETCH_TIMEOUT_MS)
    expect(f.seenOpts[0]!.maxBytes).toBe(WEB_FETCH_MAX_BYTES)
  })

  it('testo e JSON passano così come sono', async () => {
    const f = fakeTransport(() => ({ status: 200, body: '{"a":1}', headers: { 'content-type': 'application/json' } }))
    const r = await webFetch('http://public.example/data.json', { transport: f.transport, lookup: async () => ['93.184.216.34'] })
    expect(r.ok && r.text).toBe('{"a":1}')
  })
})

describe('webFetch: sfide e captcha (F5, niente falsi positivi)', () => {
  it('403/429/503 con firma nota di sfida → blocco esplicito (NON aggirare)', async () => {
    for (const status of [403, 429, 503]) {
      const f = fakeTransport(() => ({ status, body: '<html><title>Just a moment...</title></html>', headers: { 'content-type': 'text/html' } }))
      const r = await webFetch('http://public.example/x', { transport: f.transport, lookup: async () => ['93.184.216.34'] })
      expect(r.ok, String(status)).toBe(false)
      if (!r.ok) {
        expect(r.blocked, String(status)).toBe(true)
        expect(r.reason).toContain('DO NOT bypass')
      }
    }
  })

  it('403 SENZA firma di sfida → errore HTTP, non "bloccato dal captcha"', async () => {
    const f = fakeTransport(() => ({ status: 403, body: '<html><body>Forbidden</body></html>', headers: { 'content-type': 'text/html' } }))
    const r = await webFetch('http://public.example/x', { transport: f.transport, lookup: async () => ['93.184.216.34'] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.blocked).toBeUndefined()
      expect(r.reason).toContain('HTTP 403')
    }
  })

  it('pagina con SOLO il captcha → blocco; reCAPTCHA in una pagina CON contenuto → si legge', async () => {
    // solo sfida: pochissimo testo dopo l'estrazione
    const solo = fakeTransport(() => ({
      status: 200,
      body: '<html><body><script src="https://www.google.com/recaptcha/api.js"></script></body></html>',
      headers: { 'content-type': 'text/html' }
    }))
    const r1 = await webFetch('http://public.example/login', { transport: solo.transport, lookup: async () => ['93.184.216.34'] })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.blocked).toBe(true)
    // il ristorante col form di prenotazione: il modulo reCAPTCHA c'è, ma la
    // pagina ha contenuto — leggerla NON è un blocco
    const conContenuto = fakeTransport(() => ({
      status: 200,
      body: '<html><body><article><h1>Trattoria da Leo</h1><p>Menu vegetariano, prenotazioni al telefono. '.repeat(10) +
        '</p><form action="/prenota"><script src="https://www.google.com/recaptcha/api.js"></script></form></article></body></html>',
      headers: { 'content-type': 'text/html' }
    }))
    const r2 = await webFetch('http://public.example/menu', { transport: conContenuto.transport, lookup: async () => ['93.184.216.34'] })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.text).toContain('Trattoria da Leo')
  })

  it('altri tipi (pdf, binari) → tipo non supportato', async () => {
    for (const ct of ['application/pdf', 'application/octet-stream', 'image/png']) {
      const f = fakeTransport(() => ({ status: 200, body: '%PDF-1.4', headers: { 'content-type': ct } }))
      const r = await webFetch('http://public.example/f', { transport: f.transport, lookup: async () => ['93.184.216.34'] })
      expect(r.ok, ct).toBe(false)
      if (!r.ok) expect(r.unsupported).toBe(true)
    }
  })
})

// ---- il server LOCALE con il flag di test (come la verifica d'integrazione) ----

describe('web_fetch contro un server http locale (flag di test)', () => {
  let server: Server
  let url: string
  let hits = 0
  let lastUserAgent = ''

  beforeAll(async () => {
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = '1'
    server = createServer((req, res) => {
      hits++
      lastUserAgent = String(req.headers['user-agent'] ?? '')
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/arrivo' })
        res.end()
        return
      }
      if (req.url === '/bloccato') {
        res.writeHead(403, { 'content-type': 'text/html' })
        res.end('<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>')
        return
      }
      if (req.url === '/charset-latin1') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' })
        res.end(Buffer.from('caffè più dài àéì latin1', 'latin1'))
        return
      }
      if (req.url === '/charset-1252') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=windows-1252' })
        // 0x92 = apostrofo tipografico in windows-1252
        res.end(Buffer.concat([Buffer.from('l ', 'latin1'), Buffer.from([0x92]), Buffer.from('apostrofo', 'latin1')]))
        return
      }
      if (req.url === '/grande') {
        // corpo CHUNKED da 10 MB senza content-length: il lettore in streaming
        // deve tenersi 3 MB e interrompere il download
        res.writeHead(200, { 'content-type': 'text/plain' })
        const piece = 'x'.repeat(1024)
        let sent = 0
        const pump = () => {
          while (sent < 10 * 1024 * 1024) {
            const ok = res.write(piece)
            sent += piece.length
            if (!ok) { res.once('drain', pump); return }
          }
          res.end()
        }
        pump()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><article><h1>Page title</h1><p>Page content with <a href="/x">link</a>.</p></article></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    url = `http://127.0.0.1:${addr.port}`
  })
  afterAll(async () => {
    delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('senza flag il loopback è RIFIUTATO (la difesa resta attiva in produzione)', async () => {
    const saved = process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    delete process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK
    const r = await webFetch(`${url}/`, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('internal address')
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = saved
  })

  it('pagina HTML convertita in markdown, redirect locale seguito', async () => {
    const r = await webFetch(`${url}/redirect`, {})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.finalUrl).toBe(`${url}/arrivo`)
      expect(r.text).toContain('# Page title')
      expect(r.text).toContain(`[link](${url}/x)`) // G3: link assoluto contro l'URL finale
    }
  })

  it('corpo chunked da 10 MB: si tengono 3 MB e si interrompe (memoria limitata)', async () => {
    const r = await webFetch(`${url}/grande`, {})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.truncated).toBe(true)
      expect(r.downloadedBytes).toBe(WEB_FETCH_MAX_BYTES)
      // i 3 MB di corpo + la sola nota "pagina troncata": nient'altro in memoria
      expect(r.text.length).toBeLessThanOrEqual(WEB_FETCH_MAX_BYTES + 100)
      expect(r.text.endsWith('x\n\n[page truncated: past 3 MB I kept the first 3 MB]')).toBe(true)
    }
  })

  it('latin1 e windows-1252 decodificati bene (TextDecoder, F4)', async () => {
    const a = await webFetch(`${url}/charset-latin1`, {})
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.text).toContain('caffè più dài àéì latin1')
    const b = await webFetch(`${url}/charset-1252`, {})
    expect(b.ok).toBe(true)
    // 0x92 in windows-1252 è l'apostrofo tipografico U+2019 (prima: eccezione e ricada su utf8)
    if (b.ok) expect(b.text).toContain('l ’apostrofo')
  })

  it('cache per URL: seconda lettura senza nuove richieste al server', async () => {
    clearWebFetchCache()
    const before = hits
    const a = await webFetchCached(`${url}/arrivo`, {})
    const b = await webFetchCached(`${url}/arrivo`, {})
    expect(a.ok && b.ok).toBe(true)
    expect(hits).toBe(before + 1)
    // scaduta la cache (15 minuti) si rifà la richiesta
    let fakeNow = Date.now()
    const c = await webFetchCached(`${url}/arrivo`, { now: () => fakeNow })
    expect(c.ok).toBe(true)
    fakeNow += 16 * 60_000
    const d = await webFetchCached(`${url}/arrivo`, { now: () => fakeNow })
    expect(d.ok).toBe(true)
    // due richieste in tutto: la prima (a) e quella dopo la scadenza (d)
    expect(hits).toBe(before + 2)
    expect(cacheFresh(Date.now() - 14 * 60_000, Date.now())).toBe(true)
    expect(cacheFresh(Date.now() - 16 * 60_000, Date.now())).toBe(false)
  })

  it('403 con la firma di una sfida dal server locale → esito bloccato', async () => {
    const r = await webFetch(`${url}/bloccato`, {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.blocked).toBe(true)
      expect(r.reason).toContain('challenge')
    }
  })

  it('user-agent onesto Homun/<versione>', async () => {
    const r = await webFetch(`${url}/arrivo`, {})
    expect(r.ok).toBe(true)
    expect(lastUserAgent).toMatch(/^Homun\/[\d.]+$/)
  })
})
