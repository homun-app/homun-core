// Proxy HTTP di USCITA del browser del bot (fase 11b, punto 3): il daemon lo
// avvia su 127.0.0.1:<porta casuale> e il browser nel container ci passa
// dentro TUTTO il suo traffico (--proxy-server http://host.docker.internal:…).
// È il confine di rete VERO: dal container host.docker.internal raggiunge i
// servizi del Mac legati a 127.0.0.1 (Ollama, la WebSocket del daemon, il
// router di casa) e le opzioni --allowed/--blocked-origins di Playwright MCP
// NON sono un confine di sicurezza (lo dice la loro documentazione).
//
// Regole: per ogni richiesta si risolve l'host e si connette SOLO a indirizzi
// pubblici (stessa isForbiddenIp di web_fetch, niente TOCTOU: si legge la
// decisione sugli IP risolti e ci si connette a QUELLI); porte ammesse 80 e
// 443; 403 con motivo leggibile; nei log solo HOST e PORTA, mai URL completi
// con query string. Il loopback del CONTAINER resta diretto (Chrome non usa
// il proxy per localhost): un server di sviluppo avviato nel box resta leggibile.
//
// MODALITÀ TEST: i target loopback/privati sono ammessi SOLO col flag di test
// SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1 (come web_fetch), così il proxy si prova
// contro un server http locale; il flag non esiste in produzione.
import * as http from 'node:http'
import * as net from 'node:net'
import { lookup } from 'node:dns/promises'
import { isForbiddenIp, literalHostIp, loopbackAllowedForTests } from './web-guard'

export type ProxyDecision =
  | { allow: true }
  | { allow: false; reason: string }

/**
 * La decisione del proxy (PURO): porte ammesse 80 e 443; host risolti SOLO
 * pubblici (privati, loopback, link-local, host.docker.internal → privato —
 * tutto ciò che isForbiddenIp rifiuta). Col flag di test i soli target LOCALI
 * passano su qualunque porta (per il server http del test).
 */
export function proxyDecision(host: string, port: number, ips: string[]): ProxyDecision {
  const local = loopbackAllowedForTests()
  // col flag di test i target loopback/privati passano (server locale del test)
  if (local && ips.length > 0 && ips.every((ip) => isForbiddenIp(ip))) return { allow: true }
  if (port !== 80 && port !== 443) {
    return { allow: false, reason: `porta non ammessa (${port}): il browser del bot esce solo su 80 e 443` }
  }
  if (!ips.length) return { allow: false, reason: `host non risolto: ${host}` }
  if (ips.some((ip) => isForbiddenIp(ip))) {
    return { allow: false, reason: 'indirizzo interno: il browser del bot non accede alla rete locale' }
  }
  return { allow: true }
}

/** Risolve un host (i letterali non passano dal DNS, puro-ish ma iniettabile). */
async function resolveHost(host: string): Promise<string[]> {
  const literal = literalHostIp(host)
  if (literal !== null) return [literal]
  const all = await lookup(host, { all: true })
  return all.map((a) => a.address)
}

/** host:port della richiesta (CONNECT o URI assoluta); porta di default per schema. */
function parseTarget(raw: string, defaultPort: number): { host: string; port: number } | null {
  const i = raw.lastIndexOf(':')
  if (i <= 0 || i === raw.length - 1) return null
  const host = raw.slice(0, i).replace(/^\[|\]$/g, '')
  const port = Number(raw.slice(i + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

const denyConnect = (socket: net.Socket, reason: string): void => {
  // nei log (lato server) solo l'esito, mai l'URL: la reason non contiene l'URL
  socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${reason}\r\n`)
}

/**
 * Le intestazioni hop-by-hop e del proxy che NON si inoltrano a monte (I9):
 * `connection`, `keep-alive`, `te`, `trailer`, `upgrade` muoiono allo hop, e
 * `proxy-connection`/`proxy-authorization` parlano col PROXY, non col server.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade'
])

/**
 * Il server proxy (CONNECT per https, http in forma d'ORIGINE): ogni richiesta
 * risolve l'host, decide con proxyDecision e si connette SOLO agli IP validati
 * (niente seconda risoluzione: anti-TOCTOU come la lookup di web_fetch).
 * A monte vanno `pathname + search` della URL, non la URI assoluta della
 * richiesta di proxy (i server severi rispondono 400 alla forma assoluta, I9).
 * Nessun log di URL completi con query string: solo host e porta.
 */
export function createBrowserProxy(): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      let target: { host: string; port: number } | null = null
      let originPath = ''
      try {
        const u = new URL(req.url ?? '')
        target = parseTarget(`${u.hostname.replace(/^\[|\]$/g, '')}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`, 80)
        originPath = u.pathname + u.search
      } catch {
        target = null
      }
      if (!target) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('richiesta del proxy malformata (serve una URI assoluta http/https)\r\n')
        return
      }
      let ips: string[] = []
      try {
        ips = await resolveHost(target.host)
      } catch {
        ips = []
      }
      const decision = proxyDecision(target.host, target.port, ips)
      if (!decision.allow) {
        console.log(`[browser-proxy] rifiutato ${target.host}:${target.port}: ${decision.reason}`)
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`${decision.reason}\r\n`)
        return
      }
      // le intestazioni end-to-end passano, le hop-by-hop e le proxy-… no (I9)
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
      }
      headers.host = req.headers.host ?? target.host
      // ci si connette all'IP VALIDATO (mai una seconda risoluzione non controllata)
      const upstream = http.request(
        { host: ips[0], port: target.port, method: req.method, path: originPath, headers },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers)
          ur.pipe(res)
        }
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('upstream non raggiungibile\r\n')
      })
      req.pipe(upstream)
    })()
  })
  // CONNECT (https): tunnel di byte verso l'IP validato
  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    void (async () => {
      const target = parseTarget(req.url ?? '', 443)
      if (!target) {
        denyConnect(clientSocket, 'richiesta CONNECT malformata (host:port)')
        return
      }
      let ips: string[] = []
      try {
        ips = await resolveHost(target.host)
      } catch {
        ips = []
      }
      const decision = proxyDecision(target.host, target.port, ips)
      if (!decision.allow) {
        console.log(`[browser-proxy] rifiutato ${target.host}:${target.port}: ${decision.reason}`)
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
      upstream.on('error', () => denyConnect(clientSocket, 'upstream non raggiungibile'))
      clientSocket.on('error', () => upstream.destroy())
    })()
  })
  return server
}

// ---- l'istanza del daemon (lazy alla prima azione di browser) ----

let proxyServer: http.Server | null = null
let proxyPort = 0

/** La porta del proxy (0 se non attivo): per i test del launcher argv. */
export function browserProxyPort(): number {
  return proxyPort
}

/** Solo per i test: rimuove l'istanza del proxy (chiude il server). */
export async function resetBrowserProxyForTests(): Promise<void> {
  const s = proxyServer
  proxyServer = null
  proxyPort = 0
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
}

/**
 * Il proxy del browser, avviato alla PRIMA azione di browser e resta su per
 * la vita del daemon (costa un socket in ascolto su 127.0.0.1, porta casuale).
 */
export async function ensureBrowserProxy(): Promise<number> {
  if (proxyServer && proxyPort) return proxyPort
  const server = createBrowserProxy()
  proxyPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address() && typeof server.address() === 'object' ? (server.address() as net.AddressInfo).port : 0))
  })
  proxyServer = server
  return proxyPort
}
