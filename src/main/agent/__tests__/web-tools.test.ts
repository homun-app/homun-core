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
import { WEB_FETCH_MAX_BYTES, WEB_FETCH_TIMEOUT_MS } from '../../../shared/web-limits'

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
    if (!r.ok) expect(r.reason).toContain('privato/interno')
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
    if (!r.ok) expect(r.reason).toContain('host non ammesso')
    expect(calls).toBe(2)
    expect(f.connections).toHaveLength(0)
  })

  it('IP letterali IPv6 rifiutati col motivo "indirizzo interno" (non "non risolto")', async () => {
    const f = fakeTransport(() => hop200)
    for (const u of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/']) {
      const r = await webFetch(u, { transport: f.transport })
      expect(r.ok, u).toBe(false)
      if (!r.ok) {
        expect(r.reason, u).toContain('indirizzo interno')
        expect(r.reason, u).not.toContain('non risolto')
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
    if (!r.ok) expect(r.reason).toContain('redirect non ammesso')
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
        expect(r.reason).toContain('NON aggirare')
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
    if (!r.ok) expect(r.reason).toContain('indirizzo interno')
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
      expect(r.text.endsWith('x\n\n[pagina troncata: oltre i 3 MB ho tenuto i primi 3 MB]')).toBe(true)
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
      expect(r.reason).toContain('sfida')
    }
  })

  it('user-agent onesto SandBot/<versione>', async () => {
    const r = await webFetch(`${url}/arrivo`, {})
    expect(r.ok).toBe(true)
    expect(lastUserAgent).toMatch(/^SandBot\/[\d.]+$/)
  })
})
