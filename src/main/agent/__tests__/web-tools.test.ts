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
  clampMaxResults, cacheFresh, WEB_SEARCH_INACTIVE, getWebFetchFn, setWebFetchForTests
} = await import('../web-tools')
import { getSetting, setSetting } from '../../store/db'

// il vault sigillato con chiave iniettata (niente Keychain reale)
const KEY = Buffer.alloc(32, 7)
const sealedDeps = { getKey: async () => KEY }
const publicFetchImpl = vi.fn()

beforeAll(() => {
  vi.mocked(getSetting).mockImplementation(<T>(key: string, fallback: T): T =>
    (key === 'connectors.secrets' && webSettings[key] !== undefined ? (webSettings[key] as T) : fallback))
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
    expect(webSearchToolOutput([])).toBe('Nessun risultato.')
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
    expect(out).toContain('pagina lunga: 21000 caratteri')
    expect(out).toContain('offset: 20000')
    expect(webFetchWindowOutput('corto', undefined)).toBe('corto')
    expect(webFetchWindowOutput('0123456789', 5)).toBe('[segmento da offset 5 di 10 caratteri]\n56789')
  })

  it("il messaggio della ricerca non attiva dice all'utente cosa fare", () => {
    expect(WEB_SEARCH_INACTIVE).toContain('non è attiva')
    expect(WEB_SEARCH_INACTIVE.toLowerCase()).toContain('impostazioni')
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
    expect(md).toContain('[un link](https://x.example)')
    expect(md).toContain('- uno')
    expect(md).toContain('- due')
    expect(md).not.toContain('menu rumore')
    expect(md).not.toContain('piè rumore')
    expect(md).not.toContain('alert(1)')
  })

  it('entità decodificate', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &nbsp;')).toBe("a & b <c> \"d\" 'e'  ")
  })
})

// ---- web_fetch con DNS/fetch iniettabili (SSRF: nessuna rete) ----

const fetchReturning = (status: number, body = '', headers: Record<string, string> = {}): typeof fetch =>
  (vi.fn(async () => new Response(body, { status, headers }))) as unknown as typeof fetch

describe('webFetch: difese SSRF (DNS iniettabile)', () => {
  it('DNS che risolve a privato → rifiuto', async () => {
    const r = await webFetch('https://internal.example/', {
      fetchImpl: publicFetchImpl as unknown as typeof fetch,
      lookup: async () => ['10.0.0.5']
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('privato/interno')
    expect(publicFetchImpl).not.toHaveBeenCalled()
  })

  it('DNS che risolve a metadati cloud → rifiuto', async () => {
    const r = await webFetch('http://169.254.169.254/latest/meta-data/', {
      fetchImpl: publicFetchImpl as unknown as typeof fetch,
      lookup: async () => ['169.254.169.254']
    })
    expect(r.ok).toBe(false)
  })

  it('redirect verso host privato → rifiuto A OGNI hop (il redirect si ricontrolla)', async () => {
    let hop = 0
    const impl = (async (_url: string, init?: RequestInit) => {
      const u = new URL(_url)
      if (hop++ === 0 && u.hostname === 'public.example') {
        return new Response('', { status: 302, headers: { location: 'http://private.local/segreto' } }
        )
      }
      return new Response('contenuto', { status: 200 })
    }) as unknown as typeof fetch
    const r = await webFetch('http://public.example/', {
      fetchImpl: impl,
      lookup: async (host) => (host === 'private.local' ? ['192.168.1.9'] : ['93.184.216.34'])
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('redirect non ammesso')
  })

  it('troppi redirect → rifiuto (massimo 5)', async () => {
    const impl = (async (_u: string) => new Response('', { status: 302, headers: { location: '/next' } })) as unknown as typeof fetch
    const r = await webFetch('http://public.example/a', { fetchImpl: impl, lookup: async () => ['93.184.216.34'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('redirect')
  })

  it('403 e 429 → esito BLOCCATO esplicito (niente aggiramenti)', async () => {
    for (const status of [403, 429]) {
      const r = await webFetch('http://public.example/x', {
        fetchImpl: fetchReturning(status, '', { 'content-type': 'text/html' }),
        lookup: async () => ['93.184.216.34']
      })
      expect(r.ok, String(status)).toBe(false)
      if (!r.ok) {
        expect(r.blocked).toBe(true)
        expect(r.reason).toContain('NON aggirare')
      }
    }
  })

  it('captcha nella pagina → blocco esplicito', async () => {
    const r = await webFetch('http://public.example/login', {
      fetchImpl: fetchReturning(200, '<html><body><script src="https://www.google.com/recaptcha/api.js"></script></body></html>', { 'content-type': 'text/html' }),
      lookup: async () => ['93.184.216.34']
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.blocked).toBe(true)
  })

  it('altri tipi (pdf, binari) → tipo non supportato', async () => {
    for (const ct of ['application/pdf', 'application/octet-stream', 'image/png']) {
      const r = await webFetch('http://public.example/f', {
        fetchImpl: fetchReturning(200, '%PDF-1.4', { 'content-type': ct }),
        lookup: async () => ['93.184.216.34']
      })
      expect(r.ok, ct).toBe(false)
      if (!r.ok) expect(r.unsupported).toBe(true)
    }
  })

  it('content-length dichiarato oltre 3 MB → rifiuto', async () => {
    const r = await webFetch('http://public.example/big', {
      fetchImpl: fetchReturning(200, 'x', { 'content-type': 'text/plain', 'content-length': String(4 * 1024 * 1024) }),
      lookup: async () => ['93.184.216.34']
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('troppo grande')
  })

  it('testo e JSON passano così come sono', async () => {
    const r = await webFetch('http://public.example/data.json', {
      fetchImpl: fetchReturning(200, '{"a":1}', { 'content-type': 'application/json' }),
      lookup: async () => ['93.184.216.34']
    })
    expect(r.ok && r.text).toBe('{"a":1}')
  })
})

// ---- il server LOCALE con il flag di test (come la verifica d'integrazione) ----

describe('web_fetch contro un server http locale (flag di test)', () => {
  let server: Server
  let url: string
  let hits = 0

  beforeAll(async () => {
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = '1'
    server = createServer((req, res) => {
      hits++
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/arrivo' })
        res.end()
        return
      }
      if (req.url === '/bloccato') {
        res.writeHead(403, { 'content-type': 'text/html' })
        res.end('<html><body>no</body></html>')
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
    if (!r.ok) expect(r.reason).toContain('privato/interno')
    process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK = saved
  })

  it('pagina HTML convertita in markdown, redirect locale seguito', async () => {
    const r = await webFetch(`${url}/redirect`, {})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.finalUrl).toBe(`${url}/arrivo`)
      expect(r.text).toContain('# Page title')
      expect(r.text).toContain('[link](/x)')
    }
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

  it('403 dal server locale → esito bloccato', async () => {
    const r = await webFetch(`${url}/bloccato`, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.blocked).toBe(true)
  })

  it('user-agent onesto SandBot/<versione>', async () => {
    let ua = ''
    const impl = (async (_u: string, init?: RequestInit) => {
      ua = (init?.headers as Record<string, string>)['user-agent']
      return new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    const r = await webFetch('http://public.example/ua', { fetchImpl: impl, lookup: async () => ['93.184.216.34'] })
    expect(r.ok).toBe(true)
    expect(ua).toMatch(/^SandBot\/[\d.]+$/)
  })
})
