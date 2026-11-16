// Fase chat-limiti (CL3): mostrare in chat le foto di una pagina. La chat
// NON carica mai un'immagine direttamente da un sito (vedrebbe l'IP
// dell'utente): la scarica il bot, con le STESSE difese di web_fetch
// (checkUrl, IP privati vietati a ogni redirect, lookup VALIDANTE alla
// connessione, scadenza totale) più le regole da immagine: content-type
// image/jpeg|png|webp|gif, BYTE MAGICI controllati (non solo l'header) e
// tetto di SHOW_IMAGE_MAX_BYTES. Il file prende il nome dallo sha-256 del
// contenuto e vive in <dataDir>/chat-images; il renderer lo carica da
// homun:// (vedi shared/chat-images), MAI dall'URL remoto.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  checkUrl, resolveRedirect, resolvedIpsAllowed, isForbiddenIp, literalHostIp, loopbackAllowedForTests
} from './web-guard'
import {
  realTransport, resolveHost, validatingLookup, ForbiddenAddressError,
  type HttpTransport, type WebFetchDeps
} from './web-tools'
import {
  WEB_FETCH_MAX_REDIRECTS, WEB_FETCH_TIMEOUT_MS, SHOW_IMAGES_MAX_URLS, SHOW_IMAGE_MAX_BYTES
} from '../../shared/web-limits'

/** Gli url http(s) delle immagini che CL2 ha lasciato nel testo di una pagina. */
export function imageUrlsInMarkdown(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

/**
 * Il tipo VERO dei byte (puro): png, jpeg, gif o webp dai magic numbers; null
 * per tutto il resto (una pagina HTML dichiarata image/png non passa).
 */
export function sniffImageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export type ParsedShowImages =
  | { ok: true; urls: string[]; paths: string[]; caption?: string }
  | { ok: false; error: string }

/**
 * La chiamata di show_images (puro): al massimo SHOW_IMAGES_MAX_URLS immagini
 * IN TUTTO tra url e path. Gli url SOLO di immagini visti in un risultato di
 * web_fetch DI QUESTO TURNO (la mappa url → pagina la riempie il loop); i
 * path (SV8, fase schermo-vivo) sono file immagine nel COMPUTER DEL BOT — la
 * sua home o /workspace, come le catture di browser_screenshot — e li legge e
 * li controlla il loop con le funzioni dei file. Un url inventato dal modello
 * o preso da un altro turno è rifiutato in PAROLE, prima di qualsiasi rete.
 */
export function parseShowImagesInput(input: Record<string, unknown>, seen: Map<string, string>): ParsedShowImages {
  const raw = input.urls
  const rawPaths = input.paths
  const hasUrls = Array.isArray(raw) && raw.length > 0
  const hasPaths = Array.isArray(rawPaths) && rawPaths.length > 0
  if (!hasUrls && !hasPaths) {
    return {
      ok: false,
      error: `show_images needs {urls: [image urls]} or {paths: [files in your computer]}: pass the image urls that appeared in a web_fetch result of this turn, or paths of image files in your computer (your home or /workspace, like the screenshots of browser_screenshot). At most ${SHOW_IMAGES_MAX_URLS} images per call, urls and paths together.`
    }
  }
  if (raw !== undefined && !Array.isArray(raw)) {
    return { ok: false, error: 'urls must be an array of image urls.' }
  }
  if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
    return { ok: false, error: 'paths must be an array of files of your computer.' }
  }
  const urls: string[] = []
  for (const u of (hasUrls ? raw : []) as unknown[]) {
    if (typeof u !== 'string') return { ok: false, error: 'Every url in urls must be a string.' }
    if (!seen.has(u)) {
      return {
        ok: false,
        error: `"${u.slice(0, 200)}" is not an image url seen in a web_fetch result of THIS turn: I can only show images that appeared in a page you just read. Read the page with web_fetch first, then pass its image urls.`
      }
    }
    if (!urls.includes(u)) urls.push(u)
  }
  const paths: string[] = []
  for (const p of (hasPaths ? rawPaths : []) as unknown[]) {
    if (typeof p !== 'string') return { ok: false, error: 'Every path in paths must be a string.' }
    if (!paths.includes(p)) paths.push(p)
  }
  if (urls.length + paths.length > SHOW_IMAGES_MAX_URLS) {
    return { ok: false, error: `Too many images (${urls.length + paths.length}): show_images shows at most ${SHOW_IMAGES_MAX_URLS} images per call, urls and paths together.` }
  }
  const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim().slice(0, 500) : undefined
  return { ok: true, urls, paths, ...(caption ? { caption } : {}) }
}

/**
 * SV8: il nome del file di chat per un'immagine letta dal computer del bot —
 * la STESSA forma del download (sha256 del contenuto + estensione dal tipo
 * vero) e la stessa cartella di saveShowImage: la galleria è UNA.
 */
export function showImageFileOf(bytes: Buffer, mime: string): string {
  const ext = MIME_EXT[mime] ?? 'png'
  return `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
}

export type ShowImageDownload =
  | { ok: true; bytes: Buffer; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; file: string }
  | { ok: false; error: string }

export interface ShowImageDeps extends WebFetchDeps {
  transport?: HttpTransport
}

/**
 * Scarica UNA immagine con le guardie di web_fetch (nessun nuovo permesso:
 * è una lettura). IP privati vietati a ogni hop (pre-check chiaro + lookup
 * VALIDANTE alla connessione), redirect ricontrollati da capo, scadenza
 * totale; poi il content-type deve essere un'immagine delle quattro e i BYTE
 * MAGICI devono confermarlo; il corpo oltre SHOW_IMAGE_MAX_BYTES è scartato.
 */
export async function downloadShowImage(rawUrl: string, deps: ShowImageDeps = {}): Promise<ShowImageDownload> {
  const check = checkUrl(rawUrl)
  if (!check.ok) return { ok: false, error: check.reason }
  let current = check.url
  const transport = deps.transport ?? realTransport
  const allowAll = loopbackAllowedForTests()

  const checkHost = async (hostname: string): Promise<string | null> => {
    const literal = literalHostIp(hostname)
    if (literal !== null) {
      return !allowAll && isForbiddenIp(literal)
        ? `internal address (${hostname}): show_images does not touch the internal network`
        : null
    }
    try {
      const ips = await resolveHost(hostname, deps)
      if (!ips.length) return `host not resolved: ${hostname}`
      if (!allowAll && !resolvedIpsAllowed(ips)) {
        return `host not allowed (${hostname} resolves to a private/internal address): show_images does not touch the internal network`
      }
      return null
    } catch {
      return `host not resolved: ${hostname}`
    }
  }

  const dnsErr = await checkHost(current.hostname)
  if (dnsErr) return { ok: false, error: dnsErr }

  const deadlineAt = Date.now() + WEB_FETCH_TIMEOUT_MS
  let hop: import('./web-tools').HttpHop
  for (let redirect = 0; ; redirect++) {
    let r: import('./web-tools').HttpHop
    try {
      r = await transport(current, {
        lookup: validatingLookup((host) => resolveHost(host, deps), allowAll),
        deadlineAt,
        maxBytes: SHOW_IMAGE_MAX_BYTES
      })
    } catch (e) {
      if (e instanceof ForbiddenAddressError) {
        return { ok: false, error: `host not allowed (${current.hostname}): ${e.message}` }
      }
      return { ok: false, error: `request failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (r.status >= 300 && r.status < 400 && r.headers['location']) {
      if (redirect >= WEB_FETCH_MAX_REDIRECTS) return { ok: false, error: `too many redirects (more than ${WEB_FETCH_MAX_REDIRECTS})` }
      let next: URL
      try {
        next = resolveRedirect(current, r.headers['location'])
      } catch {
        return { ok: false, error: 'redirect with invalid location' }
      }
      const nc = checkUrl(next.toString())
      if (!nc.ok) return { ok: false, error: `redirect not allowed: ${nc.reason}` }
      const nd = await checkHost(next.hostname)
      if (nd) return { ok: false, error: `redirect not allowed: ${nd}` }
      current = next
      continue
    }
    hop = r
    break
  }

  if (hop.status >= 400) return { ok: false, error: `the image URL responds HTTP ${hop.status}` }
  const contentType = (hop.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (!(contentType in MIME_EXT)) {
    return { ok: false, error: `not an image (${contentType || 'unknown content-type'}): only jpeg, png, webp and gif can be shown` }
  }
  if (hop.truncated || hop.body.length > SHOW_IMAGE_MAX_BYTES) {
    return { ok: false, error: `image too big: the limit is 8 MB` }
  }
  const mime = sniffImageMime(hop.body)
  if (mime === null) {
    return { ok: false, error: 'not an image: the downloaded bytes are not a valid jpeg, png, webp or gif image' }
  }
  const sha256 = createHash('sha256').update(hop.body).digest('hex')
  return { ok: true, bytes: hop.body, mime, file: `${sha256}.${MIME_EXT[mime]}` }
}

export interface SavedShowImage {
  /** il percorso del file: <dataDir>/chat-images/<sha256>.<ext> */
  path: string
  file: string
}

/** Scrive l'immagine nella cartella chat-images dei dati dell'app (nome dall'hash). */
export async function saveShowImage(dataDir: string, dl: { file: string; bytes: Buffer }): Promise<SavedShowImage> {
  const dir = path.join(dataDir, 'chat-images')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, dl.file)
  await writeFile(file, dl.bytes)
  return { path: file, file: dl.file }
}
