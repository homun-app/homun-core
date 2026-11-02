// Fase 16c (C4): la ricerca nel registro MCP esposta alla finestra «Collega
// app» (RPC di sola lettura connectors:search-registry). La STESSA fonte di
// search_connectors (registro pubblico, stessa fiducia e stessa deduplica
// con il catalogo: una voce il cui remote coincide con l'mcpUrl del catalogo
// NON compare) ma senza il tetto di 8 righe condiviso: qui il catalogo non
// consuma posti, il client l'ha già cercato per conto suo.
import { loadCatalog } from './index'
import { fetchRegistryEntries, registryRuntime, registryTrust } from './registry'
import { truncateDescription, DESCRIPTION_MAX_CHARS } from './search'

export interface RegistrySearchDeps {
  /** iniettabile nei test (server finto su 127.0.0.1); default: il registro vero */
  fetchRegistry?: typeof fetchRegistryEntries
}

/** Al massimo 8 righe «dal registro» (lo stesso limite di search_connectors). */
const REGISTRY_ROWS_CAP = 8

/**
 * Le righe del registro per una query (sotto 2 caratteri: nessuna). Deduplica
 * come search_connectors: una voce del registro il cui URL coincide con il
 * catalogo NON compare (resta quella del catalogo, più fidata).
 */
export async function registrySearchRows(query: string, deps: RegistrySearchDeps = {}): Promise<import('../../shared/types').AppsRegistryResult[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const registry = await (deps.fetchRegistry ?? fetchRegistryEntries)(q).catch(() => null)
  if (registry === null || registry.length === 0) return []
  // deduplica con il catalogo: gli URL già coperti non si ripropongono
  const catalogUrls = new Set(loadCatalog().map((e) => e.mcpUrl))
  const out: import('../../shared/types').AppsRegistryResult[] = []
  for (const e of registry) {
    if (out.length >= REGISTRY_ROWS_CAP) break
    const urls = (e.server.remotes ?? []).map((x) => x.url).filter((u): u is string => typeof u === 'string')
    if (urls.some((u) => catalogUrls.has(u))) continue
    const rt = registryRuntime(e)
    const trust = registryTrust(e.server.name)
    out.push({
      id: `registry:${e.server.name}`,
      name: e.server.name.split('/').pop() ?? e.server.name,
      trustKind: trust.kind === 'verified-domain' ? 'verified-domain' : trust.kind === 'github-account' ? 'github-account' : 'unverified',
      description: truncateDescription(e.server.description ?? e.server.name).slice(0, DESCRIPTION_MAX_CHARS),
      runtime: rt === null
        ? 'not-installable'
        : rt.kind === 'remote'
          ? rt.secretHeader ? 'remote-key' : 'remote-oauth'
          : rt.kind === 'box-npm' ? 'box-npm' : 'not-installable'
    })
  }
  return out
}
