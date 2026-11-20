// E4 (fase mcp-env): il proxy di USCITA per-server dei server MCP npm nel
// box — allowlist PER SERVER (gli host dichiarati + registry.npmjs.org solo
// fino alla prima installazione), 80/443, tutto il resto RIFIUTATO e
// REGISTRATO nel log. Come browser-proxy.test.ts: decisione PURA e il
// server vero provato contro un servizio http locale col SOLO flag di test.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import {
  mcpEgressDecision, mcpEgressEnv, mcpEgressAllowHosts, ensureMcpEgressProxy, resetMcpEgressProxyForTests
} from '../egress-proxy'

const LOOPBACK_FLAG = 'SANDBOT_WEB_FETCH_ALLOW_LOOPBACK'
const HOSTS = ['mattermost.competitoor.com']

describe('E4: mcpEgressDecision (PURO) — solo gli host dichiarati, 80/443', () => {
  it('host dichiarato e pubblico → consentito su 80 e 443', () => {
    expect(mcpEgressDecision('mattermost.competitoor.com', 443, HOSTS, ['93.184.216.34']).allow).toBe(true)
    expect(mcpEgressDecision('mattermost.competitoor.com', 80, HOSTS, ['93.184.216.34']).allow).toBe(true)
  })

  it('host NON dichiarato → rifiutato con motivo leggibile (anche npmjs quando installato)', () => {
    const r = mcpEgressDecision('evil.example', 443, HOSTS, ['93.184.216.34'])
    expect(r.allow).toBe(false)
    if (!r.allow) expect(r.reason).toContain('not in the allowed hosts')
    const npmjs = mcpEgressDecision('registry.npmjs.org', 443, HOSTS, ['93.184.216.34'])
    expect(npmjs.allow).toBe(false)
  })

  it('porte fuori 80/443 → rifiutate anche per l\'host dichiarato', () => {
    const r = mcpEgressDecision('mattermost.competitoor.com', 8080, HOSTS, ['93.184.216.34'])
    expect(r.allow).toBe(false)
    if (!r.allow) expect(r.reason).toContain('port not allowed')
  })

  it('IP privati/loopback del bersaglio → rifiutati (niente LAN dal server)', () => {
    // il flag di test del file (per il proxy in corsa) va tolto QUI: senza
    // flag nemmeno l'host dichiarato può andare su un privato
    const prev = process.env[LOOPBACK_FLAG]
    delete process.env[LOOPBACK_FLAG]
    try {
      for (const ip of ['192.168.65.254', '127.0.0.1', '10.0.0.5', '169.254.169.254']) {
        const r = mcpEgressDecision('mattermost.competitoor.com', 443, HOSTS, [ip])
        expect(r.allow, `ip ${ip}`).toBe(false)
      }
    } finally {
      process.env[LOOPBACK_FLAG] = prev ?? '1'
    }
  })

  it('col flag di TEST i target locali dell\'host DICHIARATO passano (il servizio finto della sonda)', () => {
    const prev = process.env[LOOPBACK_FLAG]
    process.env[LOOPBACK_FLAG] = '1'
    try {
      expect(mcpEgressDecision('servizio-finto.example', 18765, ['servizio-finto.example'], ['127.0.0.1']).allow).toBe(true)
      // un host NON dichiarato resta fuori anche col flag
      expect(mcpEgressDecision('altro.example', 18765, ['servizio-finto.example'], ['127.0.0.1']).allow).toBe(false)
    } finally {
      if (prev === undefined) delete process.env[LOOPBACK_FLAG]
      else process.env[LOOPBACK_FLAG] = prev
    }
  })
})

describe('E4: l\'env del processo e l\'allowlist dinamica', () => {
  it('HTTPS_PROXY/HTTP_PROXY/NO_PROXY + NODE_USE_ENV_PROXY=1 (Node ≥ 24) + la cache npm del server', () => {
    const env = mcpEgressEnv('http://host.docker.internal:3128', '/box/home/bot1/mcp-npm/mattermost')
    expect(env).toEqual({
      HTTPS_PROXY: 'http://host.docker.internal:3128',
      HTTP_PROXY: 'http://host.docker.internal:3128',
      NO_PROXY: 'localhost,127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      npm_config_cache: '/box/home/bot1/mcp-npm/mattermost/.npm'
    })
  })

  it('registry.npmjs.org sta nell\'allowlist SOLO fino alla prima installazione', () => {
    expect(mcpEgressAllowHosts(HOSTS, false)).toEqual([...HOSTS, 'registry.npmjs.org'])
    expect(mcpEgressAllowHosts(HOSTS, true)).toEqual(HOSTS)
  })
})

// ---- il server vero, contro un servizio http locale (solo col flag di test) ----

let proxyPort = 0
let servizio: http.Server
let servizioPort = 0

beforeAll(async () => {
  process.env[LOOPBACK_FLAG] = '1'
  servizio = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('risposta-del-servizio-dichiarato')
  })
  await new Promise<void>((r) => servizio.listen(0, '127.0.0.1', r))
  servizioPort = (servizio.address() as net.AddressInfo).port
  proxyPort = await ensureMcpEgressProxy('srv-test', () => ['127.0.0.1'], { host: '127.0.0.1' })
})

afterAll(async () => {
  await resetMcpEgressProxyForTests()
  servizio.close()
  delete process.env[LOOPBACK_FLAG]
})

function proxyGet(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://${host}:${port}${path}`, headers: { host: `${host}:${port}` } },
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

describe('E4: il proxy in corsa — l\'host dichiarato passa, l\'altro è RIFIUTATO', () => {
  it('richiesta all\'host dichiarato → arriva al servizio e torna la risposta', async () => {
    const r = await proxyGet('127.0.0.1', servizioPort, '/api/echo')
    expect(r.status).toBe(200)
    expect(r.body).toBe('risposta-del-servizio-dichiarato')
  })

  it('host non dichiarato → 403 (registrato nel log), anche sulla stessa porta', async () => {
    const r = await proxyGet('non-dichiarato.example', servizioPort, '/api/echo')
    expect(r.status).toBe(403)
    expect(r.body).toContain('not in the allowed hosts')
  })
})
