// T2 (fase web-strategia): gli errori del web dicono la CAUSA giusta —
// una riga in testa al result di browser_open/web_fetch che distingue:
// host inesistente (NXDOMAIN), pagina inesistente (404 o redirect a una
// pagina «non trovata»), blocco anti-bot, pagina di manutenzione. Dal caso
// vero: il bot concluse «Trenitalia blocca il mio computer» davanti a host
// che non risolvevano (biglietti.trenitalia.com, m.trenitalia.com) e a
// pagine 404, senza mai aprire la home vera.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import {
  WEB_ERROR_LINES, isHostNotResolvedReason, pageMissing, maintenancePage,
  classifyWebFetchOutcome, classifyBrowserOpenError, type WebErrorKind
} from '../web-errors'
import { webFetch } from '../web-tools'
import { executeTool } from '../tools'
import { setWebFetchForTests } from '../web-tools'
import { ensureBrowserProxy, resetBrowserProxyForTests, setBrowserProxyResolveForTests, browserProxyDnsRefusedRecently, resetBrowserProxyDnsRefusalsForTests } from '../browser-proxy'

const LOOPBACK_FLAG = 'SANDBOT_WEB_FETCH_ALLOW_LOOPBACK'

describe('T2: le quattro righe in parole (IT del modello: EN, il bot traduce)', () => {
  it('host inesistente: dice CHE non è un blocco e rimanda alla home del sito', () => {
    expect(WEB_ERROR_LINES['host-missing']).toMatch(/does not exist/i)
    expect(WEB_ERROR_LINES['host-missing']).toMatch(/not a block/i)
    expect(WEB_ERROR_LINES['host-missing']).toMatch(/home/i)
  })
  it('pagina inesistente: torna alla home e usa la ricerca del sito', () => {
    expect(WEB_ERROR_LINES['page-missing']).toMatch(/does not exist/i)
    expect(WEB_ERROR_LINES['page-missing']).toMatch(/home/i)
  })
  it('blocco anti-bot: un\'altra fonte o l\'utente (Prendi il controllo)', () => {
    expect(WEB_ERROR_LINES['anti-bot']).toMatch(/blocking automated access/i)
    expect(WEB_ERROR_LINES['anti-bot']).toMatch(/another source|the user/i)
  })
  it('manutenzione: il sito lo dice', () => {
    expect(WEB_ERROR_LINES['maintenance']).toMatch(/maintenance/i)
  })
})

describe('T2: i segnali puri', () => {
  it('isHostNotResolvedReason: il motivo del DNS che non risolve (anche nei redirect)', () => {
    expect(isHostNotResolvedReason('host not resolved: biglietti.trenitalia.com')).toBe(true)
    expect(isHostNotResolvedReason('redirect not allowed: host not resolved: m.trenitalia.com')).toBe(true)
    expect(isHostNotResolvedReason('internal address: …')).toBe(false)
    expect(isHostNotResolvedReason('the page responds HTTP 404')).toBe(false)
  })

  it('pageMissing: 404 oppure l\'URL finale che è una pagina «non trovata» del sito', () => {
    expect(pageMissing(404, 'https://www.trenitalia.com/it/acquista/cerca-soluzioni')).toBe(true)
    expect(pageMissing(200, 'https://www.trenitalia.com/it/page-not-found')).toBe(true)
    expect(pageMissing(200, 'https://www.trenitalia.com/it/pagina-non-trovata')).toBe(true)
    expect(pageMissing(200, 'https://www.trenitalia.com/it/notfound')).toBe(true)
    expect(pageMissing(200, 'https://www.trenitalia.com/it.html')).toBe(false)
    expect(pageMissing(200, 'https://www.trenitalia.com/')).toBe(false)
    expect(pageMissing(200, 'https://e656.net/orari')).toBe(false)
  })

  it('maintenancePage: solo se la TESTA della pagina lo dice (il corpo che ne parla non basta)', () => {
    expect(maintenancePage('Trenitalia.it\nSito in manutenzione, torneremo presto.')).toBe(true)
    expect(maintenancePage('Scheduled maintenance — we will be back shortly.')).toBe(true)
    expect(maintenancePage("We'll be back soon")).toBe(true)
    expect(maintenancePage('Orari treni Milano Roma\nPartenza 8:30, binario 7\nLa manutenzione dei binari è prevista a gennaio.')).toBe(false)
    expect(maintenancePage('Orari, biglietti e offerte | Trenitalia')).toBe(false)
  })
})

describe('T2: classifyWebFetchOutcome (puro) — la causa giusta per web_fetch', () => {
  it('host che non risolve → host-missing (NON anti-bot)', () => {
    expect(classifyWebFetchOutcome({ ok: false, reason: 'host not resolved: biglietti.trenitalia.com' })).toBe<WebErrorKind>('host-missing')
  })
  it('404 → page-missing; redirect a una pagina not-found (200) → page-missing', () => {
    expect(classifyWebFetchOutcome({ ok: false, reason: 'the page responds HTTP 404', status: 404, elapsedMs: 120 })).toBe<WebErrorKind>('page-missing')
    expect(classifyWebFetchOutcome({ ok: true, text: 'Pagina non trovata', contentType: 'text/html', finalUrl: 'https://www.trenitalia.com/it/page-not-found', downloadedBytes: 10, status: 200, elapsedMs: 90 })).toBe<WebErrorKind>('page-missing')
  })
  it('blocco con firma di sfida → anti-bot', () => {
    expect(classifyWebFetchOutcome({ ok: false, blocked: true, reason: 'the site blocked the request (HTTP 403, challenge "just a moment")' })).toBe<WebErrorKind>('anti-bot')
  })
  it('pagina di manutenzione (testa) → maintenance', () => {
    expect(classifyWebFetchOutcome({ ok: true, text: 'Sito in manutenzione\nTorneremo presto', contentType: 'text/html', finalUrl: 'https://x.example/', downloadedBytes: 10, status: 200, elapsedMs: 80 })).toBe<WebErrorKind>('maintenance')
  })
  it('una pagina normale e gli altri errori → NESSUNA riga', () => {
    expect(classifyWebFetchOutcome({ ok: true, text: 'Orari treni', contentType: 'text/html', finalUrl: 'https://www.trenitalia.com/it.html', downloadedBytes: 10, status: 200, elapsedMs: 70 })).toBeNull()
    expect(classifyWebFetchOutcome({ ok: false, reason: 'request failed: boom' })).toBeNull()
    expect(classifyWebFetchOutcome({ ok: false, reason: 'internal address: …' })).toBeNull()
  })
})

describe('T2: classifyBrowserOpenError (puro) — la causa giusta per browser_open', () => {
  it('tunnel del proxy rifiutato per DNS (registro del proxy) → host-missing', () => {
    expect(classifyBrowserOpenError({
      resultText: 'Error: net::ERR_TUNNEL_CONNECTION_FAILED at https://biglietti.trenitalia.com/',
      finalUrl: 'https://biglietti.trenitalia.com/',
      hostDnsRefused: true
    })).toBe<WebErrorKind>('host-missing')
  })
  it('tunnel rifiutato MA il registro non ha quel host (altro motivo) → nessuna riga', () => {
    expect(classifyBrowserOpenError({
      resultText: 'Error: net::ERR_TUNNEL_CONNECTION_FAILED at https://x.example/',
      finalUrl: 'https://x.example/',
      hostDnsRefused: false
    })).toBeNull()
  })
  it('URL finale che è una pagina not-found → page-missing', () => {
    expect(classifyBrowserOpenError({
      resultText: '### Page content\nPagina non trovata',
      finalUrl: 'https://www.trenitalia.com/it/page-not-found',
      hostDnsRefused: false
    })).toBe<WebErrorKind>('page-missing')
  })
  it('pagina con «Just a moment…» → anti-bot', () => {
    expect(classifyBrowserOpenError({
      resultText: 'Just a moment...\nEnable JavaScript and cookies to continue',
      finalUrl: 'https://biglietti.example/checkout',
      hostDnsRefused: false
    })).toBe<WebErrorKind>('anti-bot')
  })
  it('testa della pagina in manutenzione → maintenance', () => {
    expect(classifyBrowserOpenError({
      resultText: 'Sito in manutenzione\nTorneremo presto',
      finalUrl: 'https://x.example/',
      hostDnsRefused: false
    })).toBe<WebErrorKind>('maintenance')
  })
  it('pagina normale → nessuna riga', () => {
    expect(classifyBrowserOpenError({
      resultText: '### Page content\nOrari treni Milano Roma',
      finalUrl: 'https://www.trenitalia.com/it.html',
      hostDnsRefused: false
    })).toBeNull()
  })
})

describe('T2: il result di web_fetch porta la riga in testa (executeTool)', () => {
  beforeAll(() => { process.env[LOOPBACK_FLAG] = '1' })
  afterAll(() => {
    setWebFetchForTests(null)
    delete process.env[LOOPBACK_FLAG]
  })

  it('host inesistente → «This address does not exist» prima del motivo', async () => {
    setWebFetchForTests(async () => ({ ok: false, reason: 'host not resolved: biglietti.trenitalia.com' }))
    const r = await executeTool('agent_t2', 'web_fetch', { url: 'https://biglietti.trenitalia.com/' })
    expect(r.output.startsWith(WEB_ERROR_LINES['host-missing'])).toBe(true)
    expect(r.output).toContain('host not resolved: biglietti.trenitalia.com')
    expect(r.meta.webError).toBe('host-missing')
  })

  it('pagina 404 → «This page does not exist on this site»', async () => {
    setWebFetchForTests(async () => ({ ok: false, reason: 'the page responds HTTP 404', status: 404, elapsedMs: 100 }))
    const r = await executeTool('agent_t2', 'web_fetch', { url: 'https://www.trenitalia.com/it/acquista/cerca-soluzioni' })
    expect(r.output.startsWith(WEB_ERROR_LINES['page-missing'])).toBe(true)
    expect(r.meta.webError).toBe('page-missing')
  })

  it('redirect a una pagina not-found (200) → «This page does not exist on this site»', async () => {
    setWebFetchForTests(async () => ({ ok: true, text: 'Pagina non trovata', contentType: 'text/html', finalUrl: 'https://www.trenitalia.com/it/page-not-found', downloadedBytes: 12, status: 200, elapsedMs: 60 }))
    const r = await executeTool('agent_t2', 'web_fetch', { url: 'https://www.trenitalia.com/it/inventata' })
    expect(r.output.startsWith(WEB_ERROR_LINES['page-missing'])).toBe(true)
  })

  it('blocco anti-bot → «The site is blocking automated access»', async () => {
    setWebFetchForTests(async () => ({ ok: false, blocked: true, reason: 'the site blocked the request (HTTP 403, challenge "just a moment")', status: 403, elapsedMs: 200 }))
    const r = await executeTool('agent_t2', 'web_fetch', { url: 'https://www.example.com/checkout' })
    expect(r.output.startsWith(WEB_ERROR_LINES['anti-bot'])).toBe(true)
    expect(r.meta.webError).toBe('anti-bot')
  })

  it('pagina di manutenzione → «The site says it is under maintenance»', async () => {
    setWebFetchForTests(async () => ({ ok: true, text: 'Sito in manutenzione\nTorneremo presto', contentType: 'text/html', finalUrl: 'https://x.example/', downloadedBytes: 20, status: 200, elapsedMs: 40 }))
    const r = await executeTool('agent_t2', 'web_fetch', { url: 'https://x.example/' })
    expect(r.output.startsWith(WEB_ERROR_LINES['maintenance'])).toBe(true)
  })

  it('pagina normale → NESSUNA riga in testa', async () => {
    setWebFetchForTests(async () => ({ ok: true, text: '# Orari treni\nMilano Roma 8:30', contentType: 'text/html', finalUrl: 'https://www.trenitalia.com/it.html', downloadedBytes: 40, status: 200, elapsedMs: 55 }))
    const r = await executeTool('agent_t2', 'web_fetch', { url: 'https://www.trenitalia.com/it.html' })
    expect(r.output.startsWith('HTTP 200')).toBe(true)
    expect(r.output).not.toMatch(/does not exist|blocking automated access|maintenance/)
  })
})

describe('T2: il web_fetch vero con DNS FINTO che non risolve', () => {
  it('lookup vuota → host-missing (nessuna rete: si ferma prima del trasporto)', async () => {
    process.env[LOOPBACK_FLAG] = '1'
    try {
      const outcome = await webFetch('https://biglietti.trenitalia.com/', { lookup: async () => [] })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toMatch(/host not resolved/)
      expect(classifyWebFetchOutcome(outcome)).toBe<WebErrorKind>('host-missing')
    } finally {
      delete process.env[LOOPBACK_FLAG]
    }
  })
})

// ---- il proxy del browser: il DNS fallito è DISTINGUIBILE (registro) ----

describe('T2: il proxy del browser registra l\'host che NON risolve', () => {
  let proxyPort = 0
  beforeAll(async () => {
    process.env[LOOPBACK_FLAG] = '1'
    proxyPort = await ensureBrowserProxy()
  })
  afterAll(async () => {
    setBrowserProxyResolveForTests(null)
    resetBrowserProxyDnsRefusalsForTests()
    await resetBrowserProxyForTests()
    delete process.env[LOOPBACK_FLAG]
  })

  const proxyGet = (url: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url }, (res) => {
        let body = ''
        res.on('data', (d: Buffer) => { body += d.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })

  it('richiesta a un host che il DNS FINTO non risolve → 403 leggibile e il registro lo dice', async () => {
    resetBrowserProxyDnsRefusalsForTests()
    setBrowserProxyResolveForTests(async () => [])
    const r = await proxyGet('http://biglietti.trenitalia.com.finto/servizi')
    expect(r.status).toBe(403)
    expect(r.body).toMatch(/host not resolved/)
    expect(browserProxyDnsRefusedRecently('biglietti.trenitalia.com.finto')).toBe(true)
    expect(browserProxyDnsRefusedRecently('altro.host.finto')).toBe(false)
  })

  it('il CONNECT a un host che non risolve finisce nello stesso registro', async () => {
    resetBrowserProxyDnsRefusalsForTests()
    setBrowserProxyResolveForTests(async () => { throw new Error('NXDOMAIN finto') })
    const r: { status: number; body: string } = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: proxyPort }, () => {
        sock.write('CONNECT m.trenitalia.com.finto:443 HTTP/1.1\r\nHost: m.trenitalia.com.finto:443\r\n\r\n')
      })
      let body = ''
      sock.on('data', (d: Buffer) => { body += d.toString() })
      sock.on('end', () => resolve({ status: parseInt(/^HTTP\/1.\d (\d+)/.exec(body)?.[1] ?? '0', 10), body }))
      sock.on('error', reject)
    })
    expect(r.status).toBe(403)
    expect(r.body).toMatch(/host not resolved/)
    expect(browserProxyDnsRefusedRecently('m.trenitalia.com.finto')).toBe(true)
  })
})
