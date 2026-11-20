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
import ipaddr from 'ipaddr.js'
import { isForbiddenIp, literalHostIp, loopbackAllowedForTests } from './web-guard'

export type ProxyDecision =
  | { allow: true }
  | { allow: false; reason: string }

/** BR2 (fase box-rete): l'IP sta in una delle sottoreti vietate? CIDR rotto → SÌ (fail closed). */
function ipInAnySubnet(ip: string, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    try {
      const parsed = ipaddr.process(ip)
      const range = ipaddr.parseCIDR(cidr)
      if (parsed.kind() === range[0].kind() && parsed.match(range)) return true
    } catch {
      return true // cidr non valido: si NEGA, mai un buco
    }
  }
  return false
}

/**
 * La decisione del proxy (PURO): porte ammesse 80 e 443; host risolti SOLO
 * pubblici (privati, loopback, link-local, host.docker.internal → privato —
 * tutto ciò che isForbiddenIp rifiuta). Col flag di test i soli target LOCALI
 * passano su qualunque porta (per il server http del test).
 * BR2: `boxSubnets` sono le sottoreti del box (CIDR) — le loro destinazioni
 * sono VIETATE qualunque siano gli intervalli (192.0.x.y non è un privato
 * classico: la lista dei privati non basta; il box non usa il proxy per
 * raggiungere servizi del Mac su quell'interfaccia).
 */
export function proxyDecision(host: string, port: number, ips: string[], boxSubnets: readonly string[] = []): ProxyDecision {
  const local = loopbackAllowedForTests()
  // col flag di test i target loopback/privati passano (server locale del test)
  if (local && ips.length > 0 && ips.every((ip) => isForbiddenIp(ip))) return { allow: true }
  if (port !== 80 && port !== 443) {
    return { allow: false, reason: `port not allowed (${port}): the bot's browser goes out only on 80 and 443` }
  }
  if (!ips.length) return { allow: false, reason: `host not resolved: ${host}` }
  if (ips.some((ip) => isForbiddenIp(ip) || ipInAnySubnet(ip, boxSubnets))) {
    return { allow: false, reason: 'internal address: the bot\'s browser does not access the local network' }
  }
  return { allow: true }
}

/** Risolve un host (i letterali non passano dal DNS, puro-ish ma iniettabile). */
async function resolveHost(host: string): Promise<string[]> {
  if (resolveOverrideForTests) return resolveOverrideForTests(host)
  const literal = literalHostIp(host)
  if (literal !== null) return [literal]
  const all = await lookup(host, { all: true })
  return all.map((a) => a.address)
}

/** Solo per i test: la risoluzione DNS del proxy (DNS FINTO, nessuna rete). */
let resolveOverrideForTests: ((host: string) => Promise<string[]>) | null = null

export function setBrowserProxyResolveForTests(fn: ((host: string) => Promise<string[]>) | null): void {
  resolveOverrideForTests = fn
}

// ---- T2 (fase web-strategia): il DNS fallito è DISTINGUIBILE ----
//
// Chromium davanti a un CONNECT rifiutato dice solo ERR_TUNNEL_CONNECTION_FAILED,
// senza IL PERCHÉ. Il proxy registra gli host rifiutati perché NON risolvono
// (con tetto e scadenza): browser_open guarda il registro e traduce l'errore
// generico nella riga «questo indirizzo non esiste».

const dnsRefusedHosts = new Map<string, number>()
const DNS_REFUSAL_TTL_MS = 10 * 60_000
const DNS_REFUSAL_MAX = 64

function noteDnsRefusal(host: string): void {
  const now = Date.now()
  for (const [h, t] of dnsRefusedHosts) {
    if (now - t > DNS_REFUSAL_TTL_MS) dnsRefusedHosts.delete(h)
  }
  if (dnsRefusedHosts.size >= DNS_REFUSAL_MAX) {
    const oldest = dnsRefusedHosts.keys().next().value
    if (oldest !== undefined) dnsRefusedHosts.delete(oldest)
  }
  dnsRefusedHosts.set(host.toLowerCase(), now)
}

/** T2: QUESTO host è stato rifiultato dal proxy perché il DNS non lo risolve? */
export function browserProxyDnsRefusedRecently(host: string): boolean {
  const t = dnsRefusedHosts.get(host.toLowerCase())
  return t !== undefined && Date.now() - t <= DNS_REFUSAL_TTL_MS
}

/** Solo per i test: azzera il registro dei rifiuti DNS. */
export function resetBrowserProxyDnsRefusalsForTests(): void {
  dnsRefusedHosts.clear()
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
        res.end('malformed proxy request (an absolute http/https URI is required)\r\n')
        return
      }
      let ips: string[] = []
      try {
        ips = await resolveHost(target.host)
      } catch {
        ips = []
      }
      // T2: il DNS che non risolve si REGISTRA (il browser vede solo un
      // tunnel rifiutato; il registro distingue «non esiste» da «vietato»)
      if (!ips.length) noteDnsRefusal(target.host)
      const decision = proxyDecision(target.host, target.port, ips, boxEgressSubnets())
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
        res.end('upstream unreachable\r\n')
      })
      req.pipe(upstream)
    })()
  })
  // CONNECT (https): tunnel di byte verso l'IP validato
  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    void (async () => {
      const target = parseTarget(req.url ?? '', 443)
      if (!target) {
        denyConnect(clientSocket, 'malformed CONNECT request (host:port)')
        return
      }
      let ips: string[] = []
      try {
        ips = await resolveHost(target.host)
      } catch {
        ips = []
      }
      // T2: come per la URI assoluta — il DNS fallito finisce nel registro
      if (!ips.length) noteDnsRefusal(target.host)
      const decision = proxyDecision(target.host, target.port, ips, boxEgressSubnets())
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
      upstream.on('error', () => denyConnect(clientSocket, 'upstream unreachable'))
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
  await closeGatewayListen()
  boxSubnet = null
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

// ---- BR2 (fase box-rete): il SECONDO ascolto, sul gateway di homun-box ----
//
// Col motore Apple il browser del box raggiunge il Mac all'IP del GATEWAY
// della rete vmnet homun-box, non al loopback (host.docker.internal non
// esiste): senza un secondo ascolto lì, il browser del bot resterebbe senza
// rete anche in bridge. Regole: MAI su 0.0.0.0 (sarebbe la LAN), MAI sul
// gateway della rete isolata homun-box-isolated, e sul secondo ascolto
// passano SOLO i client della sottorete di homun-box.

/** La sottorete del box: le destinazioni VIETATE in uscita da ENTRAMBI gli ascolti. */
let boxSubnet: string | null = null

/** Le sottoreti d'uscita correnti (il proxy decide a OGNI richiesta). */
function boxEgressSubnets(): string[] {
  return boxSubnet ? [boxSubnet] : []
}

let gatewayServer: http.Server | null = null
let gatewayListen: { host: string; port: number; subnet: string } | null = null

/** BR2: il secondo ascolto del proxy, com'è (host, porta, sottorete del filtro). */
export interface GatewayProxyListen {
  host: string
  port: number
  subnet: string
}

/**
 * BR2 (PURO): `remoteAddress` può parlare col secondo ascolto? Sì SOLO se
 * sta nella sottorete di homun-box (CIDR, letta dall'inspect come il
 * gateway). Gli indirizzi mappati (::ffff:a.b.c.d) contano come IPv4; IP o
 * subnet non validi, o senza indirizzo, NON passano mai (fail closed).
 */
export function gatewayClientAllowed(remoteAddress: string | undefined, subnetCidr: string): boolean {
  if (!remoteAddress) return false
  let subnet: [ipaddr.IPv4 | ipaddr.IPv6, number]
  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    subnet = ipaddr.parseCIDR(subnetCidr)
    addr = ipaddr.process(remoteAddress.trim())
  } catch {
    return false
  }
  if (addr.kind() !== subnet[0].kind()) return false // IPv6 contro una subnet IPv4: fuori
  return addr.match(subnet)
}

/** BR2: le parole del secondo ascolto che non riesce ad aprirsi. */
export const BROWSER_PROXY_GATEWAY_FAILED_MESSAGE = 'Non riesco ad aprire il proxy del browser sull\'indirizzo della rete del box: per sicurezza il browser del bot non parte'

/** Un tentativo d'ascolto: ok con la porta, o il codice d'errore. */
function tryListen(server: http.Server, host: string, port: number): Promise<{ ok: true; port: number } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => resolve({ ok: false, code: e.code ?? 'UNKNOWN' })
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const a = server.address()
      resolve({ ok: true, port: typeof a === 'object' && a ? a.port : 0 })
    })
  })
}

/** BR2: chiude il secondo ascolto (cambio gateway o reset dei test). */
async function closeGatewayListen(): Promise<void> {
  const s = gatewayServer
  gatewayServer = null
  gatewayListen = null
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
}

/**
 * BR2: apre (o aggiorna) il SECONDO ascolto del proxy sul gateway di
 * homun-box. L'host è INIETTABILE (nei test 127.0.0.1: la logica è quale
 * indirizzo, quale porta e il filtro). Regole:
 * - stessa porta del primo ascolto SE POSSIBILE, altrimenti un'ALTRA porta
 *   (è quella che i flag del browser useranno);
 * - MAI 0.0.0.0: si ascolta PROPRIO l'IP del gateway;
 * - il gateway esiste solo a rete vmnet attiva: su EADDRNOTAVAIL poche prove
 *   con pausa crescente, poi una riga nel log e il browser del bot fallisce
 *   in parole;
 * - il gateway (o la sottorete) CAMBIA — rete ricreata —: il vecchio ascolto
 *   si chiude e se ne apre uno nuovo;
 * - i client fuori dalla sottorete si chiudono subito, senza dati della
 *   richiesta nel log; la sottorete diventa anche la regola d'uscita di
 *   ENTRAMBI gli ascolti (destinazioni del box vietate).
 */
export async function ensureBrowserProxyGateway(
  host: string,
  subnet: string,
  opts: { attempts?: number; baseDelayMs?: number } = {}
): Promise<GatewayProxyListen> {
  const attempts = opts.attempts ?? 4
  const baseDelayMs = opts.baseDelayMs ?? 250
  // già aperto su questo gateway con questa sottorete: tutto a posto
  if (gatewayServer && gatewayListen && gatewayListen.host === host && gatewayListen.subnet === subnet) {
    return gatewayListen
  }
  // gateway o sottorete cambiate (rete ricreata): il vecchio ascolto si chiude
  await closeGatewayListen()
  boxSubnet = subnet
  const server = createBrowserProxy()
  // il filtro d'ingresso: SOLO la sottorete del box, chiusura subito (il log
  // non porta dati della richiesta: solo l'esito)
  server.on('connection', (socket: net.Socket) => {
    if (!gatewayClientAllowed(socket.remoteAddress, subnet)) {
      console.log('[browser-proxy] connessione al secondo ascolto chiusa: indirizzo fuori dalla rete del box')
      socket.destroy()
    }
  })
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)))
    // alla PRIMA prova si chiede la PORTA del primo ascolto (se è libera su
    // questo indirizzo è la stessa per il browser); altrimenti una a caso
    for (const want of attempt === 0 && proxyPort > 0 ? [proxyPort, 0] : [0]) {
      const r = await tryListen(server, host, want)
      if (r.ok) {
        gatewayServer = server
        gatewayListen = { host, port: r.port, subnet }
        return gatewayListen
      }
      if (r.code === 'EADDRNOTAVAIL') break // il gateway non c'è: pausa crescente e si riprova
      if (r.code === 'EADDRINUSE' && want !== 0) continue // porta del primo ascolto già presa qui: un'altra
      await closeGatewayListen()
      boxSubnet = null
      throw new Error(`cannot listen on ${host} for the box proxy: ${r.code}`)
    }
    console.warn(`[browser-proxy] il gateway ${host} non c'è ancora (EADDRNOTAVAIL), riprovo (${attempt + 1}/${attempts})`)
  }
  await closeGatewayListen()
  boxSubnet = null
  console.error(`[browser-proxy] il gateway ${host} non è mai comparso: il browser del box non ha proxy (secondo ascolto non aperto)`)
  throw new Error(BROWSER_PROXY_GATEWAY_FAILED_MESSAGE)
}
