// Test del PROXY di uscita del browser (fase 11b, punto 3): la decisione è
// PURA (porte ammesse, IP privati rifiutati, rebinding); il server si prova
// contro un server http locale con il SOLO flag di test
// SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1 (come web_fetch). Nessuna rete esterna.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import { proxyDecision, ensureBrowserProxy, resetBrowserProxyForTests } from '../browser-proxy'

const LOOPBACK_FLAG = 'SANDBOT_WEB_FETCH_ALLOW_LOOPBACK'

describe('proxyDecision (PURO): confine di rete del browser', () => {
  it('porte ammesse: SOLO 80 e 443, le altre 403 con motivo leggibile', () => {
    const r = proxyDecision('api.esempio', 8080, ['93.184.216.34'])
    expect(r.allow).toBe(false)
    if (!r.allow) expect(r.reason).toContain('port not allowed (8080)')
    expect(proxyDecision('api.esempio', 80, ['93.184.216.34']).allow).toBe(true)
    expect(proxyDecision('api.esempio', 443, ['93.184.216.34']).allow).toBe(true)
  })
  it('host non risolto → rifiutato', () => {
    expect(proxyDecision('mai.esempio', 443, []).allow).toBe(false)
  })
  it('IP privati/loopback/link-local rifiutati: host.docker.internal, Ollama, il router di casa', () => {
    for (const ip of ['192.168.65.254', '127.0.0.1', '10.0.0.5', '169.254.169.254', '172.16.2.3', '::ffff:127.0.0.1', 'fc00::1']) {
      const r = proxyDecision('bersaglio', 443, [ip])
      expect(r.allow, `ip ${ip}`).toBe(false)
      if (!r.allow) expect(r.reason).toContain('internal address')
    }
  })
  it('rebinding: lookup con un pubblico E un privato → NESSUNA connessione', () => {
    expect(proxyDecision('ribinding.esempio', 443, ['93.184.216.34', '127.0.0.1']).allow).toBe(false)
    expect(proxyDecision('ribinding.esempio', 443, ['192.168.1.1', '93.184.216.34']).allow).toBe(false)
  })
  it('col flag di TEST i soli target locali passano su qualunque porta (server del test)', () => {
    const prev = process.env[LOOPBACK_FLAG]
    process.env[LOOPBACK_FLAG] = '1'
    try {
      expect(proxyDecision('locale', 18765, ['127.0.0.1']).allow).toBe(true)
      // un PUBBLICO su porta strana resta rifiutato anche col flag
      expect(proxyDecision('pub.esempio', 8080, ['93.184.216.34']).allow).toBe(false)
    } finally {
      if (prev === undefined) delete process.env[LOOPBACK_FLAG]
      else process.env[LOOPBACK_FLAG] = prev
    }
  })
})

// ---- il server, contro un server http locale (solo col flag di test) ----

let proxyPort = 0
let echo: net.Server
let echoPort = 0
let web: http.Server
let webPort = 0
// I9: cosa ha ricevuto il server a monte (path in forma d'origine e header)
let seen: { url?: string; headers: http.IncomingHttpHeaders } = { headers: {} }

beforeAll(async () => {
  // un server TCP che fa eco (per il tunnel CONNECT) e un server http (per la
  // URI assoluta): entrambi SOLO loopback del test
  echo = net.createServer((socket) => socket.pipe(socket))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  echoPort = (echo.address() as net.AddressInfo).port
  web = http.createServer((req, res) => {
    if (req.url?.includes('segreta')) {
      seen = { url: req.url, headers: req.headers }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('risposta-del-server-locale')
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r))
  webPort = (web.address() as net.AddressInfo).port
  proxyPort = await ensureBrowserProxy()
})

afterAll(async () => {
  await resetBrowserProxyForTests()
  echo.close()
  web.close()
})

/** Richiesta http attraverso il proxy (URI assoluta, come fa Chrome). */
function proxyGet(url: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: u.host, ...extraHeaders } },
      (res) => {
        let body = ''
        res.on('data', (d: Buffer) => { body += d.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** Una richiesta CONNECT attraverso il proxy (tunnel di byte). */
function proxyConnect(target: string): Promise<{ statusLine: string; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1')
    let acc = ''
    let done = false
    let phase: 'status' | 'tunnel' = 'status'
    const finish = (r: { statusLine: string; echoed?: string }): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(r)
    }
    socket.on('data', (d: Buffer) => {
      acc += d.toString()
      if (phase === 'status' && acc.includes('\r\n\r\n')) {
        const line = acc.split('\r\n')[0]!
        if (line.includes('403')) {
          finish({ statusLine: line })
          return
        }
        phase = 'tunnel'
        socket.write('ping-eco')
      } else if (phase === 'tunnel' && acc.includes('ping-eco')) {
        finish({ statusLine: acc.split('\r\n')[0]!, echoed: 'ping-eco' })
      }
    })
    socket.on('error', (e) => {
      if (!done) reject(e)
    })
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    // se il proxy non risponde, si chiude con quello che c'è
    setTimeout(() => finish({ statusLine: acc.split('\r\n')[0] ?? '(nessuna risposta)' }), 3_000).unref?.()
  })
}

describe('il server proxy (flag di test per il loopback)', () => {
  it('http (URI assoluta): il server locale risponde ATTRAVERSO il proxy', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    process.env[LOOPBACK_FLAG] = '1'
    try {
      const r = await proxyGet(`http://127.0.0.1:${webPort}/?segreta=1`)
      expect(r.status).toBe(200)
      expect(r.body).toContain('risposta-del-server-locale')
    } finally {
      if (prev === undefined) delete process.env[LOOPBACK_FLAG]
      else process.env[LOOPBACK_FLAG] = prev
    }
  })

  it('I9: a monte va il path in FORMA D\'ORIGINE (pathname+search), non la URI assoluta', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    process.env[LOOPBACK_FLAG] = '1'
    try {
      seen = { headers: {} }
      const r = await proxyGet(`http://127.0.0.1:${webPort}/pagina?segreta=1&x=2`)
      expect(r.status).toBe(200)
      expect(seen.url).toBe('/pagina?segreta=1&x=2') // mai http://127.0.0.1:…/pagina?…
    } finally {
      if (prev === undefined) delete process.env[LOOPBACK_FLAG]
      else process.env[LOOPBACK_FLAG] = prev
    }
  })

  it('I9: le intestazioni hop-by-hop e del proxy NON arrivano al server', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    process.env[LOOPBACK_FLAG] = '1'
    try {
      seen = { headers: {} }
      const r = await proxyGet(`http://127.0.0.1:${webPort}/?segreta=1`, {
        'proxy-authorization': 'Basic dXNlcjpwYXNz',
        'proxy-connection': 'keep-alive',
        connection: 'keep-alive'
      })
      expect(r.status).toBe(200)
      expect(seen.headers['proxy-authorization']).toBeUndefined()
      expect(seen.headers['proxy-connection']).toBeUndefined()
      // gli header end-to-end passano
      expect(seen.headers.host).toBe(`127.0.0.1:${webPort}`)
    } finally {
      if (prev === undefined) delete process.env[LOOPBACK_FLAG]
      else process.env[LOOPBACK_FLAG] = prev
    }
  })

  it('http verso il loopback SENZA flag (porta ammessa) → 403 "indirizzo interno"', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    delete process.env[LOOPBACK_FLAG]
    try {
      // porta 443 ammessa: a fermare la richiesta è l'IP, non la porta
      const r = await proxyGet('http://127.0.0.1:443/?segreta=1')
      expect(r.status).toBe(403)
      expect(r.body).toContain('internal address')
    } finally {
      if (prev !== undefined) process.env[LOOPBACK_FLAG] = prev
    }
  })

  it('porta non ammessa (pubblico su 8080) → 403 con la porta nel motivo, NESSUNA connessione', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    delete process.env[LOOPBACK_FLAG]
    try {
      const r = await proxyGet('http://93.184.216.34:8080/x')
      expect(r.status).toBe(403)
      expect(r.body).toContain('port not allowed (8080)')
    } finally {
      if (prev !== undefined) process.env[LOOPBACK_FLAG] = prev
    }
  })

  it('CONNECT (https): tunnel di byte al server locale, l\'eco attraversa il proxy', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    process.env[LOOPBACK_FLAG] = '1'
    try {
      const r = await proxyConnect(`127.0.0.1:${echoPort}`)
      expect(r.statusLine).toContain('200')
      expect(r.echoed).toBe('ping-eco')
    } finally {
      if (prev === undefined) delete process.env[LOOPBACK_FLAG]
      else process.env[LOOPBACK_FLAG] = prev
    }
  })

  it('CONNECT verso il loopback SENZA flag → 403 col motivo', async () => {
    const prev = process.env[LOOPBACK_FLAG]
    delete process.env[LOOPBACK_FLAG]
    try {
      const r = await proxyConnect(`127.0.0.1:${echoPort}`)
      expect(r.statusLine).toContain('403')
      expect(r.echoed).toBeUndefined() // nessun tunnel: l'eco non passa
    } finally {
      if (prev !== undefined) process.env[LOOPBACK_FLAG] = prev
    }
  })
})
