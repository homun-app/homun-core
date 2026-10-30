// Registro ufficiale MCP (fase 13, punto 1): registry.modelcontextprotocol.io,
// API v0.1 congelata, lettura senza autenticazione. Il registro NON è vagliato:
// l'unico segnale di fiducia è lo SPAZIO DEI NOMI, che il registro verifica
// alla pubblicazione (nomi a DNS inverso = dominio verificato;
// io.github.<utente> = solo l'account GitHub). Parse e fiducia sono funzioni
// PURE testate sulle risposte REALI catturate dal revisore (fixtures); la
// lettura di rete usa il fetch con guardia SSRF della fase 11, host FISSO,
// timeout 8 s e cache di 10 minuti per query.
import { webFetchCached, type WebFetchOutcome } from '../agent/web-tools'

/** L'host fisso del registro: l'unico che questo modulo contatta (hook di test per la verifica d'integrazione). */
export const REGISTRY_BASE = process.env.SANDBOT_TEST_REGISTRY_URL || 'https://registry.modelcontextprotocol.io'

/** Timeout della lettura del registro (la ricerca non deve fermare il turno). */
export const REGISTRY_TIMEOUT_MS = 8_000

/** Cache per query: 10 minuti. */
export const REGISTRY_CACHE_MS = 10 * 60_000

/** Una voce del campo `servers[]` della risposta (campi `server` e `_meta`). */
export interface RegistryEntry {
  server: {
    name: string
    description?: string
    version?: string
    repository?: { url?: string } | Record<string, unknown>
    remotes?: Array<{
      type?: string
      url?: string
      headers?: Array<{ name?: string; value?: string; isSecret?: boolean; isRequired?: boolean; description?: string }>
    }>
    packages?: Array<{
      registryType?: string
      registryBaseUrl?: string
      identifier?: string
      version?: string
      runtimeHint?: string
      transport?: { type?: string }
      environmentVariables?: Array<{ name?: string; description?: string; isRequired?: boolean; format?: string }>
    }>
  }
  _meta?: Record<string, unknown>
}

/** La fiducia di un nome del registro, dallo spazio dei nomi (pura). */
export type RegistryTrust =
  | { kind: 'verified-domain'; domain: string; label: string }
  | { kind: 'github-account'; user: string; label: string }
  | { kind: 'unverified'; label: string }

/**
 * registryTrust(name) (pura): lo spazio dei nomi PRIMA della "/" decide.
 * - `com.notion/mcp`, `com.microsoft/…` → DNS inverso ≥ 2 etichette valide =
 *   dominio verificato (le etichette invertite: com.notion → notion.com);
 * - `io.github.<utente>/…` → solo l'account GitHub verificato;
 * - tutto il resto (namespace di una sola etichetta, nomi nudi, host non
 *   validi) → non verificato.
 */
export function registryTrust(name: string): RegistryTrust {
  // fase 17c (C5): il label è il testo PER IL MODELLO (inglese); la UI traduce dal kind
  const ns = name.includes('/') ? name.slice(0, name.indexOf('/')) : ''
  if (!ns) return { kind: 'unverified', label: 'unverified' }
  const labels = ns.split('.')
  // io.github.<utente>/… — l'account GitHub verificato, non il dominio
  if (labels.length >= 3 && labels[0] === 'io' && labels[1] === 'github') {
    const user = labels.slice(2).join('.')
    return { kind: 'github-account', user, label: `GitHub account (${user})` }
  }
  // DNS inverso: etichette hostname valide, almeno due (com.notion, ai.smithery)
  const hostLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i
  if (labels.length >= 2 && labels.every((l) => hostLabel.test(l))) {
    const domain = [...labels].reverse().join('.')
    return { kind: 'verified-domain', domain, label: `verified domain (${domain})` }
  }
  return { kind: 'unverified', label: 'unverified' }
}

/**
 * parseRegistryResponse(json) (pura): tiene solo le voci `isLatest` con
 * `status: active` (senza `version=latest` ogni versione sarebbe una voce
 * separata — per "notion" 50 righe). Torna le voci valide NELL'ORDINE del
 * registro; input malformato → array vuoto (il chiamante mostra la riga di
 * registro non raggiungibile).
 */
export function parseRegistryResponse(json: unknown): RegistryEntry[] {
  const root = json as { servers?: unknown } | null
  if (!root || !Array.isArray(root.servers)) return []
  const out: RegistryEntry[] = []
  for (const raw of root.servers) {
    const e = raw as RegistryEntry | null
    if (!e || typeof e?.server?.name !== 'string' || !e.server.name) continue
    const meta = e._meta?.['io.modelcontextprotocol.registry/official'] as
      | { status?: unknown; isLatest?: unknown }
      | undefined
    if (meta?.status !== 'active' || meta?.isLatest !== true) continue
    out.push(e)
  }
  return out
}

/** L'URL di ricerca dell'API v0.1 (puro): search + version=latest + limit. */
export function registrySearchUrl(query: string, limit = 8): string {
  const q = encodeURIComponent(query.trim())
  return `${REGISTRY_BASE}/v0.1/servers?search=${q}&version=latest&limit=${limit}`
}

/** Dipendenze della lettura del registro (fetch iniettabile per i test). */
export interface RegistryFetchDeps {
  /** lettura con guardia SSRF (default: il webFetch della fase 11, cache 15') */
  fetchOutcome?: (url: string) => Promise<WebFetchOutcome>
  now?: () => number
}

const queryCache = new Map<string, { at: number; entries: RegistryEntry[] }>()

/** Svuota la cache delle query (test). */
export function clearRegistryCache(): void {
  queryCache.clear()
}

/**
 * Cerca nel registro (rete, host fisso): le voci trovate (anche ZERO: il
 * registro che risponde con `{servers:[]}` non è "giù"), oppure null per
 * errore di rete o risposta non JSON — il chiamante risponde comunque con le
 * altre fonti e una riga "registro pubblico non raggiungibile". L8: null NON
 * si mette in cache (prima un errore faceva credere "giù" alla prima chiamata
 * e "zero risultati" alla seconda); i risultati validi restano in cache 10
 * minuti per query; il timeout è quello della webFetch (8 s qui, non i
 * minuti del browser).
 */
export async function fetchRegistryEntries(
  query: string,
  limit = 8,
  deps: RegistryFetchDeps = {}
): Promise<RegistryEntry[] | null> {
  const now = deps.now ?? Date.now
  const key = `${query.trim()}::${limit}`
  const hit = queryCache.get(key)
  if (hit && now() - hit.at < REGISTRY_CACHE_MS) return hit.entries
  const fetchOutcome = deps.fetchOutcome ?? ((url: string) => webFetchCached(url))
  let entries: RegistryEntry[] | null = null
  try {
    const outcome = await fetchOutcome(registrySearchUrl(query, limit))
    if (outcome.ok) entries = parseRegistryResponse(JSON.parse(outcome.text))
  } catch {
    entries = null // risposta non JSON o rete giù: riga di registro irraggiungibile
  }
  if (entries === null) return null // errore: niente cache, alla prossima si riprova
  queryCache.set(key, { at: now(), entries })
  return entries
}

/**
 * Trova la voce ESATTA per nome (add_mcp_server: l'id arriva dalla ricerca):
 * cerca nel registro per nome e torna la voce con quel name, null se assente.
 */
export async function findRegistryEntry(
  name: string,
  deps: RegistryFetchDeps = {}
): Promise<RegistryEntry | null> {
  const entries = await fetchRegistryEntries(name, 16, deps)
  return entries?.find((e) => e.server.name === name) ?? null
}

// ---- come gira una voce del registro (puro, usato da ricerca e card) ----

export type RegistryRuntime =
  | { kind: 'remote'; url: string; secretHeader?: string }
  | { kind: 'box-npm'; identifier: string; version: string }
  | { kind: 'not-installable'; registryType: string; reason?: string }

/** Hook di test della verifica d'integrazione: remoto http locale (in produzione SOLO https). */
const remoteUrlOk = (u: string): boolean =>
  u.startsWith('https://') || (process.env.SANDBOT_TEST_ALLOW_HTTP_REMOTES === '1' && u.startsWith('http://'))

/**
 * La modalità di esecuzione di una voce del registro (pura): i `remotes`
 * vincono sui `packages` (il server ufficiale espone entrambi); un remote con
 * header `isSecret` richiede una chiave; un pacchetto npm stdio gira NEL BOX
 * (docker exec) con la versione FISSATA a quella dichiarata — un pacchetto
 * senza `version` NON si installa (con "latest" il codice girato cambierebbe
 * in silenzio); pypi/oci/altro non si installano in questa fase.
 */
export function registryRuntime(e: RegistryEntry): RegistryRuntime | null {
  const remote = (e.server.remotes ?? []).find((r) => typeof r.url === 'string' && remoteUrlOk(r.url))
  if (remote) {
    const secret = (remote.headers ?? []).find((h) => h.isSecret === true && h.name)
    return { kind: 'remote', url: remote.url!, ...(secret ? { secretHeader: secret.name! } : {}) }
  }
  const pkg = (e.server.packages ?? []).find((p) => p.transport?.type === 'stdio' && p.registryType === 'npm' && p.identifier)
  if (pkg) {
    if (!pkg.version) return { kind: 'not-installable', registryType: 'npm', reason: 'version not declared' }
    return { kind: 'box-npm', identifier: pkg.identifier!, version: pkg.version }
  }
  const other = (e.server.packages ?? [])[0]
  if (other?.registryType) return { kind: 'not-installable', registryType: other.registryType }
  return null
}

/** Le variabili d'ambiente richieste da una voce npm stdio (pura). */
export function registryEnvVars(e: RegistryEntry): Array<{ name: string; required: boolean; description?: string }> {
  const pkg = (e.server.packages ?? []).find((p) => p.transport?.type === 'stdio' && p.registryType === 'npm')
  return (pkg?.environmentVariables ?? [])
    .filter((v) => typeof v.name === 'string' && v.name)
    .map((v) => ({ name: v.name!, required: v.isRequired === true, ...(v.description ? { description: v.description } : {}) }))
}

/** L'URL del sito/repository della voce, se dichiarato (puro). */
export function registrySiteUrl(e: RegistryEntry): string | null {
  const url = (e.server.repository as { url?: unknown } | undefined)?.url
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null
}
