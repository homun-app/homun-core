// N2 (fase mcp-egress-sicurezza): il proxy di uscita manda all'upstream
// SEMPRE l'Host del target VALIDATO (l'autorità dell'URL, con la porta quando
// non è quella predefinita) e RIFIUTA (403, con riga di log host:porta, mai
// l'URL) un Host del client diverso: niente domain fronting su CDN o vhost
// condivisi. Come egress-proxy.test.ts: servizio http locale col flag di test.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import {
  ensureMcpEgressProxy, resetMcpEgressProxyForTests, upstreamHostHeader
} from '../egress-proxy'

const LOOPBACK_FLAG = 'SANDBOT_WEB_FETCH_ALLOW_LOOPBACK'

let proxyPort = 0
let servizio: http.Server
let servizioPort = 0
/** gli Host ricevuti dall'upstream (il servizio li conta) */
const upstreamHosts: string[] = []

beforeAll(async () => {
  process.env[LOOPBACK_FLAG] = '1'
  servizio = http.createServer((req, res) => {
    upstreamHosts.push(String(req.headers.host ?? ''))
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`host-ricevuto:${req.headers.host}`)
  })
  await new Promise<void>((r) => servizio.listen(0, '127.0.0.1', r))
  servizioPort = (servizio.address() as net.AddressInfo).port
  proxyPort = await ensureMcpEgressProxy('srv-host-test', () => ['127.0.0.1'], { host: '127.0.0.1' })
})

afterAll(async () => {
  await resetMcpEgressProxyForTests()
  servizio.close()
  delete process.env[LOOPBACK_FLAG]
})

/** Una richiesta al proxy: URL assoluto + Host header deciso dal test. */
function proxyGet(url: string, hostHeader?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: url,
        ...(hostHeader !== undefined ? { headers: { host: hostHeader } } : { headers: {} })
      },
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

describe('N2: upstreamHostHeader (PURO) — l\'autorità dell\'URL validata', () => {
  it('porta non predefinita → host:porta; porta predefinita → solo host', () => {
    expect(upstreamHostHeader('127.0.0.1', 18765, false)).toBe('127.0.0.1:18765')
    expect(upstreamHostHeader('example.com', 80, false)).toBe('example.com')
    expect(upstreamHostHeader('example.com', 443, true)).toBe('example.com')
    expect(upstreamHostHeader('example.com', 8443, true)).toBe('example.com:8443')
  })
})

describe('N2: il proxy in corsa — l\'Host verso l\'upstream è QUELLO VALIDATO', () => {
  it('Host UGUALE all\'autorità → passa, e l\'upstream riceve l\'Host validato (con la porta)', async () => {
    upstreamHosts.length = 0
    const r = await proxyGet(`http://127.0.0.1:${servizioPort}/api/echo`, `127.0.0.1:${servizioPort}`)
    expect(r.status).toBe(200)
    expect(r.body).toBe(`host-ricevuto:127.0.0.1:${servizioPort}`)
    expect(upstreamHosts).toEqual([`127.0.0.1:${servizioPort}`])
  })

  it('Host DIVERSO dall\'autorità (fronting) → 403 e l\'upstream NON viene raggiunto', async () => {
    upstreamHosts.length = 0
    const r = await proxyGet(`http://127.0.0.1:${servizioPort}/api/echo`, 'fronted.example')
    expect(r.status).toBe(403)
    expect(r.body).toMatch(/host/i)
    expect(upstreamHosts).toEqual([])
  })

  it('Host con la porta SBAGLIATA (autorità diversa) → 403 e l\'upstream NON viene raggiunto', async () => {
    upstreamHosts.length = 0
    const r = await proxyGet(`http://127.0.0.1:${servizioPort}/api/echo`, `127.0.0.1:${servizioPort + 1}`)
    expect(r.status).toBe(403)
    expect(upstreamHosts).toEqual([])
  })
})
