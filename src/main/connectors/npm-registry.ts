// E4 (fase mcp-env): il registro npm, SOLA LETTURA via daemon — i metadati
// del pacchetto per la card di conferma di un server MCP npm: (autore,
// mantenitori, data di pubblicazione dell'ULTIMA o della versione chiesta,
// download settimanali) e la VERSIONE da fissare. La versione NON si insegue
// mai a ogni avvio: se il bot non la dà, si risolve l'ultima stabile UNA
// volta (dist-tags.latest) e quella resta — un aggiornamento di versione è
// una card NUOVA. Parse PURI sulle risposte vere; la lettura usa il fetch
// con guardia SSRF della fase 11 (come registry.ts), host FISSI.
import { webFetchCached, type WebFetchOutcome } from '../agent/web-tools'

/** L'host fisso del registro npm: l'unico packument che questo modulo legge. */
export const NPM_REGISTRY_BASE = process.env.SANDBOT_TEST_NPM_REGISTRY_URL || 'https://registry.npmjs.org'
/** L'host fisso delle statistiche di download. */
export const NPM_DOWNLOADS_BASE = process.env.SANDBOT_TEST_NPM_DOWNLOADS_URL || 'https://api.npmjs.org'

/** L'id npm: di add_mcp_server (PURO). «latest» e le tag sono VIETATE. */
export function parseNpmServerId(id: string): { kind: 'npm'; name: string; version?: string } | { error: string } {
  if (!id.startsWith('npm:')) return { error: 'invalid id: use npm:<package>[@<version>], registry:<name> or url:https://…' }
  const rest = id.slice('npm:'.length)
  // la versione è l'ULTIMO @ di un nome scoped: @donach/x@1.2.3 → (@donach/x, 1.2.3)
  const at = rest.lastIndexOf('@')
  const name = at > 0 ? rest.slice(0, at) : rest
  const version = at > 0 ? rest.slice(at + 1) : undefined
  if (!name || name === '@' || name.startsWith('/') || name.endsWith('/')) return { error: `invalid npm package name: ${rest}` }
  if (version !== undefined) {
    if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) return { error: `npm version must be pinned (a number like 1.2.3), not a tag: ${version}` }
  }
  return { kind: 'npm', name, ...(version ? { version } : {}) }
}

/** L'URL del packument (PURO; gli scoped vanno codificati con %2F). */
export function npmPackumentUrl(name: string): string {
  return `${NPM_REGISTRY_BASE}/${name.replace('/', '%2F')}`
}

/** L'URL dei download dell'ultima settimana (PURO). */
export function npmDownloadsUrl(name: string): string {
  return `${NPM_DOWNLOADS_BASE}/downloads/point/last-week/${name.replace('/', '%2F')}`
}

/** I metadati del pacchetto che la card mostra. */
export interface NpmPackageInfo {
  name: string
  version: string
  author: string | null
  maintainers: string[]
  publishedAt: string | null
  weeklyDownloads: number
}

/** Un packument npm (la forma che ci serve, PURO da qualsiasi altra chiave). */
interface PackumentLike {
  'dist-tags'?: { latest?: unknown }
  time?: Record<string, unknown>
  versions?: Record<string, unknown>
  author?: { name?: unknown } | string
  maintainers?: Array<{ name?: unknown }>
}

/**
 * Il packument → la versione FISSATA e i suoi metadati (PURO). Senza versione
 * richiesta vince l'ultima stabile (dist-tags.latest); una versione chiesta
 * deve ESISTERE nelle versions. Autore/mantenitori/data di pubblicazione
 * come li mostra npm. Mai un crash su input rotto.
 */
export function parseNpmPackument(json: unknown, wantedVersion?: string): { version: string; publishedAt: string | null; author: string | null; maintainers: string[] } | { error: string } {
  const p = json as PackumentLike | null
  if (!p || typeof p !== 'object' || !p.versions) return { error: 'npm registry: malformed packument' }
  const latest = typeof p['dist-tags']?.latest === 'string' ? p['dist-tags']!.latest as string : undefined
  const version = wantedVersion ?? latest
  if (!version) return { error: 'npm registry: no stable version (dist-tags.latest missing)' }
  if (!(version in p.versions)) return { error: `npm registry: version ${wantedVersion ?? '(latest)'} not found for this package` }
  const publishedAt = typeof p.time?.[version] === 'string' ? (p.time![version] as string) : null
  const author = typeof p.author === 'string' ? p.author : typeof p.author?.name === 'string' ? p.author.name : null
  const maintainers = (p.maintainers ?? []).map((m) => (typeof m?.name === 'string' ? m.name : '')).filter(Boolean)
  return { version, publishedAt, author, maintainers }
}

/** I download settimanali (PURO, 0 se la risposta non li porta). */
export function npmDownloadsParseSafe(json: unknown): number {
  const n = (json as { downloads?: unknown } | null)?.downloads
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}
// (alias del nome usato dai test)
export const parseNpmDownloads = npmDownloadsParseSafe

export interface NpmFetchDeps {
  fetchOutcome?(url: string): Promise<WebFetchOutcome>
}

/**
 * Legge il registro (rete, host fissi, sola lettura): packument + download
 * settimanale, con la versione FISSATA. La fetch è iniettabile nei test.
 */
export async function fetchNpmPackageInfo(name: string, version: string | undefined, deps: NpmFetchDeps = {}): Promise<NpmPackageInfo> {
  const fetchOutcome = deps.fetchOutcome ?? ((url: string) => webFetchCached(url))
  let packument: unknown
  try {
    const res = await fetchOutcome(npmPackumentUrl(name))
    if (!res.ok) throw new Error(`npm registry: package not found (${(res as { status?: number }).status ?? 'error'})`)
    packument = JSON.parse(res.text)
  } catch (e) {
    throw new Error(`npm registry: ${e instanceof Error ? e.message : String(e)}`)
  }
  const parsed = parseNpmPackument(packument, version)
  if ('error' in parsed) throw new Error(parsed.error)
  let weeklyDownloads = 0
  try {
    const d = await fetchOutcome(npmDownloadsUrl(name))
    if (d.ok) weeklyDownloads = npmDownloadsParseSafe(JSON.parse(d.text))
  } catch {
    weeklyDownloads = 0 // le statistiche sono facoltative: la card va avanti
  }
  return {
    name,
    version: parsed.version,
    author: parsed.author,
    maintainers: parsed.maintainers,
    publishedAt: parsed.publishedAt,
    weeklyDownloads
  }
}
