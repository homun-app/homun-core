// Difese SSRF e limiti di web_fetch (fase 11, punto 2) — funzioni PURE:
// validazione dell'URL (solo http/https, niente credenziali), classificazione
// degli IP (privati, loopback, link-local, ULA, 0.0.0.0, metadati cloud) e
// troncamento con offset. Il DNS e il fetch sono iniettabili: nei test
// niente rete reale.
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
 * IP riservato/privato (puro): loopback, privati RFC1918, CGNAT, link-local
 * (comprende i metadati cloud 169.254.169.254), 0.0.0.0, multicast/riservati,
 * ULA fc00::/7, link-local IPv6, IPv4-mapped IPv6.
 */
export function isForbiddenIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true // 0.0.0.0, privati, loopback
    if (a === 169 && b === 254) return true // link-local + endpoint metadati cloud
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast e riservati
    return false
  }
  const v6 = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
  if (mapped) return isForbiddenIp(mapped[1]!)
  if (v6 === '::' || v6 === '::1') return true // unspecified e loopback
  if (/^f[cd][0-9a-f]{2}:/.test(v6) || v6.startsWith('fd') || v6.startsWith('fc')) return true // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true // link-local fe80::/10
  if (v6.startsWith('ff')) return true // multicast
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
