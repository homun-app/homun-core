// E4 (fase mcp-env): il proxy di USCITA dei server MCP npm NEL BOX —
// allowlist PER SERVER sul modello del proxy del browser (browser-proxy.ts):
// solo gli host dichiarati (più registry.npmjs.org finché il pacchetto non
// è installato nella cache del box), porte 80 e 443, IP risolti pubblici,
// niente TOCTOU (ci si connette agli IP validati); ogni altra destinazione
// è RIFIUTATA e REGISTRATA nel log (host e porta, mai l'URL completo). Il
// processo riceve HTTPS_PROXY/HTTP_PROXY/NO_PROXY + NODE_USE_ENV_PROXY=1
// (il fetch di Node ≥ 24 li onora) e la cache npm DELLA CARTELLA DEL SERVER
// (npm_config_cache): il primo avvio scarica, i successivi no.
import * as http from 'node:http'
import * as net from 'node:net'
import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { isForbiddenIp, literalHostIp, loopbackAllowedForTests } from '../agent/web-guard'

/** Il registro npm: consentito SOLO finché il pacchetto non è nella cache del box. */
export const NPM_INSTALL_HOST = 'registry.npmjs.org'

export type McpEgressDecision = { allow: true } | { allow: false; reason: string }

function ipInAnySubnet(ip: string, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    try {
      const parsed = ipaddr.process(ip)
      const range = ipaddr.parseCIDR(cidr)
      if (parsed.kind() === range[0].kind() && parsed.match(range)) return true
    } catch {
      return true // cidr rotto: si NEGA (fail closed)
    }
  }
  return false
}

/**
 * La decisione del proxy di un server (PURO): porte 80/443; host ESATTAMENTE
 * nell'allowlist del server; IP risolti pubblici (privati, loopback,
 * link-local e le sottoreti del box vietati). Col flag di test i target
 * LOCALI dell'host dichiarato passano (il servizio finto della sonda).
 */
export function mcpEgressDecision(host: string, port: number, allowHosts: readonly string[], ips: string[], boxSubnets: readonly string[] = []): McpEgressDecision {
  const local = loopbackAllowedForTests()
  const declared = allowHosts.some((h) => h.toLowerCase() === host.toLowerCase())
  if (!declared) return { allow: false, reason: `host not in the allowed hosts (${host}): this MCP server reaches only its declared hosts` }
  // col flag di test i target loopback/privati dell'host dichiarato passano
  if (local && ips.length > 0 && ips.every((ip) => isForbiddenIp(ip))) return { allow: true }
  if (port !== 80 && port !== 443) return { allow: false, reason: `port not allowed (${port}): this MCP server goes out only on 80 and 443` }
  if (!ips.length) return { allow: false, reason: `host not resolved: ${host}` }
  if (ips.some((ip) => isForbiddenIp(ip) || ipInAnySubnet(ip, boxSubnets))) {
    return { allow: false, reason: 'internal address: this MCP server does not access the local network' }
  }
  return { allow: true }
}

/**
 * L'allowlist corrente di un server: gli host dichiarati + registry.npmjs.org
 * SOLO finché l'installazione non è avvenuta (PURO).
 */
export function mcpEgressAllowHosts(declaredHosts: readonly string[], installed: boolean): string[] {
  return installed ? [...declaredHosts] : [...declaredHosts, NPM_INSTALL_HOST]
}

/**
 * L'env del processo nel box (PURO): il proxy su tutte le uscite http(s), il
 * fetch di Node ≥ 24 che lo onora e la cache npm DEL server (cartella sua:
 * il primo avvio scarica, i successivi no).
 */
export function mcpEgressEnv(proxyUrl: string, serverCacheDir: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    NODE_USE_ENV_PROXY: '1',
    npm_config_cache: `${serverCacheDir}/.npm`
  }
}

async function resolveHost(host: string): Promise<string[]> {
  const literal = literalHostIp(host)
  if (literal !== null) return [literal]
  const all = await lookup(host, { all: true })
  return all.map((a) => a.address)
}

function parseTarget(raw: string, defaultPort: number): { host: string; port: number } | null {
  const i = raw.lastIndexOf(':')
  if (i <= 0 || i === raw.length - 1) return null
  const host = raw.slice(0, i).replace(/^\[|\]$/g, '')
  const port = Number(raw.slice(i + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade'])
const denyConnect = (socket: net.Socket, reason: string): void => {
  socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${reason}\r\n`)
}

/**
 * N2 (fase mcp-egress-sicurezza): l'Host da mandare all'upstream è SEMPRE
 * quello del target VALIDATO — l'autorità dell'URL, con `:porta` solo quando
 * non è quella predefinita del protocollo (PURO).
 */
export function upstreamHostHeader(host: string, port: number, https: boolean): string {
  const defaultPort = https ? 443 : 80
  return port === defaultPort ? host : `${host}:${port}`
}

/** Il server proxy di UN server MCP (come createBrowserProxy, con l'allowlist). */
export function createMcpEgressProxy(serverId: string, getAllowHosts: () => readonly string[]): http.Server {
  const decide = (host: string, port: number, ips: string[]) => mcpEgressDecision(host, port, getAllowHosts(), ips)
  const server = http.createServer((req, res) => {
    void (async () => {
      let target: { host: string; port: number } | null = null
      let originPath = ''
      let httpsTarget = false
      try {
        const u = new URL(req.url ?? '')
        httpsTarget = u.protocol === 'https:'
        target = parseTarget(`${u.hostname.replace(/^\[|\]$/g, '')}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`, 80)
        originPath = u.pathname + u.search
      } catch {
        target = null
      }
      if (!target) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('malformed proxy request (an absolute http/https URI is required)\r\n')
        return
      }
      let ips: string[] = []
      try { ips = await resolveHost(target.host) } catch { ips = [] }
      const decision = decide(target.host, target.port, ips)
      if (!decision.allow) {
        console.log(`[mcp-egress-proxy ${serverId}] rifiutato ${target.host}:${target.port}: ${decision.reason}`)
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`${decision.reason}\r\n`)
        return
      }
      // N2 (fase mcp-egress-sicurezza): l'Host verso l'upstream è SEMPRE quello
      // del target validato; un Host del client DIVERSO dall'autorità dell'URL
      // è domain fronting (CDN/vhost condivisi) → 403 + riga di log (mai l'URL)
      const expectedHost = upstreamHostHeader(target.host, target.port, httpsTarget)
      const sentHost = typeof req.headers.host === 'string' ? req.headers.host : null
      if (sentHost !== null && sentHost.toLowerCase() !== expectedHost.toLowerCase()) {
        console.log(`[mcp-egress-proxy ${serverId}] rifiutato ${target.host}:${target.port}: Host header "${sentHost}" ≠ authority "${expectedHost}" (domain fronting)`)
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`host header does not match the validated target (${target.host}): domain fronting is not allowed\r\n`)
        return
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
      }
      headers.host = expectedHost
      const upstream = http.request(
        { host: ips[0], port: target.port, method: req.method, path: originPath, headers },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers)
          ur.pipe(res)
        }
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('upstream unreachable\r\n')
      })
      req.pipe(upstream)
    })()
  })
  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    void (async () => {
      const target = parseTarget(req.url ?? '', 443)
      if (!target) {
        denyConnect(clientSocket, 'malformed CONNECT request (host:port)')
        return
      }
      let ips: string[] = []
      try { ips = await resolveHost(target.host) } catch { ips = [] }
      const decision = decide(target.host, target.port, ips)
      if (!decision.allow) {
        console.log(`[mcp-egress-proxy ${serverId}] rifiutato ${target.host}:${target.port}: ${decision.reason}`)
        denyConnect(clientSocket, decision.reason)
        return
      }
      const upstream = net.connect({ host: ips[0]!, port: target.port })
      upstream.on('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => denyConnect(clientSocket, 'upstream unreachable'))
      clientSocket.on('error', () => upstream.destroy())
    })()
  })
  return server
}

// ---- le istanze per server (lazy alla prima connessione, per la vita del daemon) ----

interface EgressProxyEntry {
  server: http.Server
  port: number
}
const proxies = new Map<string, EgressProxyEntry>()

export interface EnsureMcpEgressOpts {
  /** su quale indirizzo ascoltare (default 127.0.0.1; il box raggiunge il Mac da lì o dal gateway) */
  host?: string
}

/**
 * Il proxy di un server MCP npm (UNO per server, porta casuale): l'allowlist
 * si LEGGE a ogni richiesta (getAllowHosts) così registry.npmjs.org sparisce
 * da solo appena l'installazione è avvenuta.
 */
export async function ensureMcpEgressProxy(
  serverId: string,
  getAllowHosts: () => readonly string[],
  opts: EnsureMcpEgressOpts = {}
): Promise<number> {
  const hit = proxies.get(serverId)
  if (hit) return hit.port
  const server = createMcpEgressProxy(serverId, getAllowHosts)
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, opts.host ?? '127.0.0.1', () => {
      const a = server.address()
      resolve(a && typeof a === 'object' ? (a as net.AddressInfo).port : 0)
    })
  })
  proxies.set(serverId, { server, port })
  return port
}

// ---- BR2-style: col motore Apple il box raggiunge il Mac al GATEWAY della
// rete vmnet (host.docker.internal non esiste) — il proxy apre un SECONDO
// ascolto lì, MAI su 0.0.0.0, e accetta SOLO i client della sottorete del box

import { gatewayClientAllowed } from '../agent/browser-proxy'

const gatewayListens = new Map<string, { server: http.Server; host: string; port: number; subnet: string }>()

/**
 * Il secondo ascolto del proxy di un server sul gateway del box (come
 * ensureBrowserProxyGateway: stesso host quando possibile è scartato qui per
 * semplicità — porta propria; il filtro d'ingresso è la sottorete del box).
 */
export async function ensureMcpEgressProxyGateway(
  serverId: string,
  getAllowHosts: () => readonly string[],
  host: string,
  subnet: string
): Promise<{ host: string; port: number }> {
  const hit = gatewayListens.get(serverId)
  if (hit && hit.host === host && hit.subnet === subnet) return { host: hit.host, port: hit.port }
  if (hit) await new Promise<void>((resolve) => hit.server.close(() => resolve()))
  const server = createMcpEgressProxy(serverId, getAllowHosts)
  server.on('connection', (socket: net.Socket) => {
    if (!gatewayClientAllowed(socket.remoteAddress, subnet)) {
      console.log(`[mcp-egress-proxy ${serverId}] connessione al secondo ascolto chiusa: indirizzo fuori dalla rete del box`)
      socket.destroy()
    }
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      const a = server.address()
      resolve(a && typeof a === 'object' ? (a as net.AddressInfo).port : 0)
    })
  })
  gatewayListens.set(serverId, { server, host, port, subnet })
  return { host, port }
}

/** Solo per i test: chiude tutti i proxy per-server. */
export async function resetMcpEgressProxyForTests(): Promise<void> {
  const all = [...proxies.values()]
  proxies.clear()
  const gateways = [...gatewayListens.values()]
  gatewayListens.clear()
  await Promise.all([
    ...all.map((e) => new Promise<void>((resolve) => e.server.close(() => resolve()))),
    ...gateways.map((e) => new Promise<void>((resolve) => e.server.close(() => resolve())))
  ])
}
