// Difese SSRF e limiti di web_fetch (fase 11, punto 2) — funzioni PURE:
// validazione dell'URL (solo http/https, niente credenziali), classificazione
// degli IP NORMALIZZATI con ipaddr.js (mapped/compatible → IPv4, NAT64 e 6to4
// con l'IPv4 incorporato, Teredo, benchmark 198.18.0.0/15) e troncamento con
// offset. Il DNS e il fetch sono iniettabili: nei test niente rete reale.
import ipaddr from 'ipaddr.js'
import { WEB_FETCH_MAX_CHARS } from '../../shared/web-limits'

export type UrlCheck =
  | { ok: true; url: URL; host: string }
  | { ok: false; reason: string }

/**
 * Solo http e https, niente credenziali nell'URL (user:pass@host), host
 * presente. Puro: costruisce l'oggetto URL senza toccare la rete.
 */
export function checkUrl(raw: string): UrlCheck {
  const trimmed = raw.trim()
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return { ok: false, reason: `URL non valido: "${trimmed.slice(0, 120)}"` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `schema non ammesso (${u.protocol}): solo http e https` }
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'credenziali nell\'URL non ammesse (user:pass@host)' }
  }
  if (!u.hostname) return { ok: false, reason: 'host mancante' }
  return { ok: true, url: u, host: u.hostname }
}

/**
 * L'host è un INDIRIZZO letterale? URL lascia le parentesi negli hostname
 * IPv6 (`new URL('http://[::1]/').hostname` è `[::1]`): qui si tolgono e si
 * riconosce l'IP puro (IPv4 o IPv6). Null se l'host è un nome da risolvere.
 */
export function literalHostIp(hostname: string): string | null {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return ipaddr.isValid(h) ? h : null
}

/** IPv4 rifiutati: reti interne, loopback, link-local (metadati cloud), CGNAT, benchmark 198.18.0.0/15, multicast/riservati. */
const V4_FORBIDDEN_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3'
].map((c) => ipaddr.parseCIDR(c))

/** L'IPv4 costruito da due gruppi da 16 bit (gli ultimi 32 bit di un IPv6). */
function v4FromParts(hi: number, lo: number): ipaddr.IPv4 {
  return new ipaddr.IPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff])
}

function forbiddenV4(addr: ipaddr.IPv4): boolean {
  return V4_FORBIDDEN_CIDRS.some((cidr) => addr.match(cidr))
}

/**
 * IP riservato/interno (PURO, F4): IPv4 e IPv6 NORMALIZZATI prima del
 * confronto, come request-filtering-agent / ssrf-req-filter:
 * - mapped (::ffff:0:0/96) e compatible (::/96) estratti come IPv4
 *   (`::1` e `::` cadono lì: 0.0.0.1 e 0.0.0.0 sono in 0.0.0.0/8);
 * - NAT64 64:ff9b::/96 e 6to4 2002::/16 con l'IPv4 incorporato controllato;
 * - Teredo 2001:0::/32 rifiutato in blocco; 198.18.0.0/15 (benchmark),
 *   ULA fc00::/7, link-local fe80::/10 e multicast ff00::/8 rifiutati.
 * Un indirizzo non parsabile è rifiutato (fail closed).
 */
export function isForbiddenIp(rawIp: string): boolean {
  const literal = literalHostIp(rawIp)
  if (literal === null) return true
  const parsed = ipaddr.parse(literal)
  if (parsed.kind() === 'ipv4') return forbiddenV4(parsed as ipaddr.IPv4)
  const p = (parsed as ipaddr.IPv6).parts
  // mapped e compatible: l'IPv4 sta negli ultimi 32 bit
  if (p.slice(0, 5).every((x) => x === 0) && (p[5] === 0 || p[5] === 0xffff)) {
    return forbiddenV4(v4FromParts(p[6]!, p[7]!))
  }
  // NAT64 64:ff9b::/96: l'IPv4 incorporato negli ultimi 32 bit
  if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) {
    return forbiddenV4(v4FromParts(p[6]!, p[7]!))
  }
  // 6to4 2002::/16: l'IPv4 incorporato nei bit 16..48
  if (p[0] === 0x2002) return forbiddenV4(v4FromParts(p[1]!, p[2]!))
  // Teredo 2001:0::/32 rifiutato in blocco
  if (p[0] === 0x2001 && p[1] === 0) return true
  if ((p[0]! & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((p[0]! & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((p[0]! & 0xff00) === 0xff00) return true // multicast ff00::/8
  return false
}

/**
 * MODALITÀ TEST (verifica d'integrazione): consenti loopback e privati con
 * un flag esplicito che NON esiste in produzione. Serve per puntare web_fetch
 * al server http locale di test (127.0.0.1) senza disattivare la difesa SSRF
 * nel codice vero.
 */
export function loopbackAllowedForTests(): boolean {
  return process.env.SANDBOT_WEB_FETCH_ALLOW_LOOPBACK === '1'
}

/** Gli IP risolti sono tutti ammissibili? (il flag di test scusa i privati) */
export function resolvedIpsAllowed(ips: string[]): boolean {
  if (loopbackAllowedForTests()) return true
  return !ips.some((ip) => isForbiddenIp(ip))
}

/** Il redirect Location risolve contro l'URL corrente (pure). */
export function resolveRedirect(from: URL, location: string): URL {
  return new URL(location, from)
}

// ---- fase 11b (punto 2): il passaggio da web_fetch al browser ----

/** La nota che il result di web_fetch aggiunge su una pagina costruita in JavaScript. */
export const JS_PAGE_HINT = 'La pagina sembra costruita in JavaScript: se ti serve, aprila con browser_open.'

/**
 * Una pagina HTML letta da web_fetch sembra costruita in JavaScript (puro)?
 * Dopo l'estrazione resta pochissimo testo e ci sono molti `<script>`: è il
 * segnale che serve il BROWSER, non la fetch. Con un blocco o un captcha il
 * chiamante non aggiunge NESSUN suggerimento (il browser non aggira i blocchi).
 */
export function looksJsBuiltPage(rawHtml: string, extractedText: string): boolean {
  const scripts = (rawHtml.match(/<script\b/gi) ?? []).length
  const textLen = extractedText.replace(/\s+/g, ' ').trim().length
  return scripts >= 4 && textLen < 500
}

// ---- troncamento con offset (il modello vede al più 20.000 caratteri) ----

export interface TextWindow {
  text: string
  totalLength: number
  /** offset del prossimo segmento (null se il testo è finito) */
  nextOffset: number | null
}

export function sliceWithOffset(text: string, offset?: number): TextWindow {
  const start = Math.max(0, Number.isFinite(offset) ? Math.floor(offset as number) : 0)
  if (start >= text.length) {
    return { text: '', totalLength: text.length, nextOffset: null }
  }
  const slice = text.slice(start, start + WEB_FETCH_MAX_CHARS)
  const next = start + slice.length
  return {
    text: slice,
    totalLength: text.length,
    nextOffset: next < text.length ? next : null
  }
}
