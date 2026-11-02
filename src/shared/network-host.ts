// Fase 16c correzioni (R5.1): dove sta FISICAMENTE un provider — questa
// macchina, la rete della persona, o internet — deciso dall'HOST del baseUrl
// (niente più «Trovato da solo · gratis e privato» per un server remoto solo
// perché il kind è openai-compatible). I predicati sono adattati da Rakazo
// (packages/contracts/src/network-host.ts, commit 29cd6da, Apache-2.0),
// ridotti a quelli che servono qui: loopback (localhost, *.localhost,
// 127.0.0.0/8, ::1 e forme mappate), rete privata (RFC 1918, CGNAT, ULA,
// .local; MAI link-local né i metadata cloud). Modulo PURO, zero dipendenze:
// lo usano il renderer e, se serve, il daemon.
//
// Regola dei predicati presa da Rakazo: gli ALLOW (isLoopbackHost,
// isPrivateNetworkHost) non si fidano dei nomi col punto finale («localhost.»
// va al DNS per alcuni resolver); i BLOCK (metadata cloud) lo tolgono, così
// quella forma non li scavalca.

type Ipv4 = number
/** Otto gruppi da 16 bit: numeri, niente BigInt. */
type Ipv6 = readonly number[]

/** Endpoint dei metadata cloud: mai «rete della persona». */
const CLOUD_METADATA_IPV4 = new Set<number>([0xa9fe_a9fe, 0xa9fe_aa02, 0x6464_64c8])
const CLOUD_METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog'])
/** AWS IMDS su IPv6, fd00:ec2::254. */
const AWS_IMDS_IPV6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254] as const

/** Le reti IPv4 che una persona usa in casa/in ufficio: loopback, RFC 1918, CGNAT. */
const PRIVATE_NETWORK_IPV4 = ranges([
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16]
])

/** Minuscolo, senza parentesi quadre, senza un punto finale. */
function canonical(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '')
}

function parseIpv4(value: string): Ipv4 | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return undefined
  let result = 0
  for (const octet of match.slice(1)) {
    // gli zeri iniziali si leggono ottali in alcuni parser: non è un IP qui
    if (octet.length > 1 && octet.startsWith('0')) return undefined
    const n = Number(octet)
    if (n > 255) return undefined
    result = result * 256 + n
  }
  return result
}

function parseIpv6(value: string): Ipv6 | undefined {
  if (!value.includes(':')) return undefined
  // una zona (fe80::1%en0) scope l'indirizzo all'interfaccia, non cambia la classe
  const zone = value.indexOf('%')
  const address = zone === -1 ? value : value.slice(0, zone)
  if (zone !== -1 && !/^[0-9a-z._~-]+$/.test(value.slice(zone + 1))) return undefined
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const parts = halves.map((half) => (half === '' ? [] : half.split(':')))
  const tail = parts[parts.length - 1]
  const last = tail?.[tail.length - 1]
  if (tail && last?.includes('.')) {
    // IPv4 in coda: si scompone nei due gruppi bassi
    const v4 = parseIpv4(last)
    if (v4 === undefined) return undefined
    tail.splice(-1, 1, (v4 >>> 16).toString(16), (v4 & 0xffff).toString(16))
  }
  const groups: number[] = []
  for (const part of parts.flat()) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined
    groups.push(Number.parseInt(part, 16))
  }
  if (halves.length === 1) return groups.length === 8 ? groups : undefined
  if (groups.length > 7) return undefined
  const left = parts[0]?.length ?? 0
  return [...groups.slice(0, left), ...Array<number>(8 - groups.length).fill(0), ...groups.slice(left)]
}

const group = (v6: Ipv6, i: number): number => v6[i] ?? 0
const isUnspecifiedPrefix = (v6: Ipv6, n: number): boolean => v6.slice(0, n).every((p) => p === 0)
const isIpv6Loopback = (v6: Ipv6): boolean => isUnspecifiedPrefix(v6, 7) && group(v6, 7) === 1
const lowIpv4 = (v6: Ipv6): Ipv4 => group(v6, 6) * 0x10000 + group(v6, 7)
/** SOLO ::ffff:0:0/96: il loopback non si fida di niente di più largo. */
function mappedIpv4(v6: Ipv6): Ipv4 | undefined {
  return isUnspecifiedPrefix(v6, 5) && group(v6, 5) === 0xffff ? lowIpv4(v6) : undefined
}

function isLinkLocalIpv4(v: Ipv4): boolean {
  return v >>> 16 === 0xa9fe
}

/** 127.0.0.0/8, ::1 e le loro forme IPv4-mappate. */
export function isLoopbackAddress(address: string): boolean {
  const value = canonical(address)
  const v4 = parseIpv4(value)
  if (v4 !== undefined) return v4 >>> 24 === 127
  const v6 = parseIpv6(value)
  if (v6 === undefined) return false
  const mapped = mappedIpv4(v6)
  if (mapped !== undefined) return mapped >>> 24 === 127
  return isIpv6Loopback(v6)
}

/** Endpoint dei metadata cloud (IPv4, forme mappate/NAT64/6to4 incluse). */
export function isCloudMetadataAddress(address: string): boolean {
  const value = canonical(address)
  const v4 = parseIpv4(value)
  if (v4 !== undefined) return CLOUD_METADATA_IPV4.has(v4)
  const v6 = parseIpv6(value)
  if (v6 === undefined) return false
  if (v6.every((p, i) => p === AWS_IMDS_IPV6[i])) return true
  const embedded = embeddedIpv4(v6)
  return embedded !== undefined && CLOUD_METADATA_IPV4.has(embedded)
}

/** Ogni forma IPv6 che porta un IPv4 come destinazione. */
function embeddedIpv4(v6: Ipv6): Ipv4 | undefined {
  const mapped = mappedIpv4(v6)
  if (mapped !== undefined) return mapped
  if (isUnspecifiedPrefix(v6, 6)) return lowIpv4(v6) // ::/96, deprecato
  if (group(v6, 0) === 0x64 && group(v6, 1) === 0xff9b && v6.slice(2, 6).every((p) => p === 0)) return lowIpv4(v6) // NAT64
  if (group(v6, 0) === 0x2002) return group(v6, 1) * 0x10000 + group(v6, 2) // 6to4
  return undefined
}

/**
 * Un indirizzo della rete della persona: loopback, RFC 1918, CGNAT
 * 100.64.0.0/10 o ULA fc00::/7. Link-local e metadata cloud ESCLUSI: lì
 * vivono servizi di infrastruttura, mai un server legittimo della persona.
 */
export function isPrivateNetworkAddress(address: string): boolean {
  const value = canonical(address)
  if (isCloudMetadataAddress(value)) return false
  const v4 = parseIpv4(value)
  if (v4 !== undefined) return PRIVATE_NETWORK_IPV4.some(({ network, mask }) => (v4 & mask) >>> 0 === network)
  const v6 = parseIpv6(value)
  if (v6 === undefined) return false
  return isIpv6Loopback(v6) || (group(v6, 0) & 0xfe00) === 0xfc00
}

/** 4 o 6 per un IP letterale, 0 per tutto il resto (come node:net isIP). */
export function ipVersion(host: string): 0 | 4 | 6 {
  const value = canonical(host)
  if (parseIpv4(value) !== undefined) return 4
  return parseIpv6(value) === undefined ? 0 : 6
}

/** `localhost`, 127.0.0.0/8, ::1: gli host che raggiungono QUESTA macchina senza DNS. */
export function isLocalhostOrLoopbackIp(host: string): boolean {
  const h = canonical(host)
  if (h === 'localhost') return true
  const v4 = parseIpv4(h)
  if (v4 !== undefined) return v4 >>> 24 === 127
  const v6 = parseIpv6(h)
  return v6 !== undefined && isIpv6Loopback(v6)
}

/** Questa macchina: `localhost`, `*.localhost` (RFC 6761), 127.0.0.0/8, ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = canonical(host)
  if (isLocalhostOrLoopbackIp(h) || h.endsWith('.localhost')) return true
  // R5.1: anche le FORME MAPPATE di 127.0.0.0/8 (::ffff:127.0.0.1) raggiungono
  // questa macchina — isLocalhostOrLoopbackIp resta com'è in Rakazo, qui il
  // confine del «Sul tuo Mac» prende anche quelle
  return ipVersion(h) === 6 && isLoopbackAddress(h)
}

/**
 * Questa macchina o la rete della persona: host di loopback, nomi mDNS
 * `.local` e IP letterali di rete privata. (Link-local e metadata cloud
 * restano FUORI: isPrivateNetworkAddress li esclude.)
 */
export function isPrivateNetworkHost(host: string): boolean {
  const h = canonical(host)
  if (isLoopbackHost(h) || h.endsWith('.local')) return true
  return ipVersion(h) !== 0 && isPrivateNetworkAddress(h)
}

function ranges(entries: ReadonlyArray<readonly [string, number]>): Array<{ network: number; mask: number }> {
  return entries.map(([network, prefix]) => {
    const parsed = parseIpv4(network)
    if (parsed === undefined) throw new Error(`Invalid IPv4 constant ${network}`)
    return { network: parsed, mask: prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0 }
  })
}

// ---- R5.1: il posto di un provider ----

/** Dove sta fisicamente un provider. */
export type ProviderPlace = 'mac' | 'rete' | 'internet'

/** L'host di un baseUrl (minimo comune: scheme o meno, IPv6 tra parentesi). */
export function hostOfBaseUrl(baseUrl: string): string | null {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    return new URL(withScheme).hostname
  } catch {
    return null
  }
}

/**
 * R5.1, PURA: il posto di un provider dall'HOST del suo baseUrl.
 * - 'mac': loopback (localhost, *.localhost, tutto 127.0.0.0/8, ::1, forme
 *   mappate) → «Sul tuo Mac · gratis e privato»;
 * - 'rete': rete della persona (`.local`, RFC 1918, CGNAT, ULA; mai link-local
 *   né metadata cloud) → «Sulla tua rete» (i dati ESCONO dal Mac);
 * - 'internet': tutto il resto.
 * `discovered` e `kind` NON contano: decide l'host (uno scoperto sta comunque
 * su localhost, quindi il risultato non cambia; un openai-compatible su un
 * server remoto NON è «gratis e privato»).
 */
export function providerPlace(p: { baseUrl?: string | null; discovered?: boolean; kind?: string }): ProviderPlace {
  void p.discovered
  void p.kind
  const host = hostOfBaseUrl(p.baseUrl ?? '')
  if (host === null) return 'internet'
  if (isLoopbackHost(host)) return 'mac'
  if (isPrivateNetworkHost(host)) return 'rete'
  return 'internet'
}
