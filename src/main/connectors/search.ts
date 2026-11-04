// Ricerca unificata dei connettori (fase 13, punto 1): search_connectors
// diventa la porta unica su TRE fonti, in ordine di fiducia — catalogo
// verificato → plugin dei marketplace registrati → registro pubblico MCP.
// mergeConnectorResults e formatConnectorLine sono PURE (testate sulle
// fixture reali del registro); l'orchestrazione tocca la rete SOLO per
// l'host fisso del registro (fetch con guardia SSRF, cache 10 minuti) e per
// i marketplace già registrati. Le descrizioni di registro e marketplace
// sono TESTO DI TERZI: il result del tool va nel blocco dati esterni e
// contamina il turno (come web_fetch).
import type { CatalogEntry, ConnectorState } from './index'
import { searchCatalog } from './index'
import {
  fetchRegistryEntries, registryRuntime, registrySiteUrl, registryTitle, registryTrust,
  type RegistryEntry
} from './registry'
import type { MarketplacePlugin } from './marketplace'
import { pickLang } from '../../shared/localized'

/** "come gira" per il modello e la card. */
export type ConnectorRuntimeKind = 'remote-oauth' | 'remote-key' | 'box-npm' | 'plugin' | 'not-installable'

export interface ConnectorSearchRow {
  /** id usabile con gli altri tool: catalog:<id> | plugin:<nome>@<marketplace> | registry:<nome> */
  id: string
  name: string
  source: 'catalog' | 'plugin' | 'registry'
  /** il risultato dice sempre la fonte: catalogo / nome del marketplace / registro MCP */
  sourceLabel: string
  trust: string
  trustKind: 'verified' | 'marketplace' | 'verified-domain' | 'github-account' | 'unverified'
  runtime: ConnectorRuntimeKind
  runtimeLabel: string
  /** stato se già presente (connesso, installato, …) */
  status?: string
  description: string
}

/** Il Marketplace ufficiale: etichetta "official marketplace", gli altri "marketplace added by you". */
export function marketplaceTrustLabel(official: boolean): string {
  return official ? 'official marketplace' : 'marketplace added by you'
}

export const RUNTIME_LABELS: Record<ConnectorRuntimeKind, string> = {
  'remote-oauth': 'remote (OAuth)',
  'remote-key': 'remote (needs a key)',
  'box-npm': 'in the box (npm)',
  plugin: 'plugin (skills and MCP servers)',
  'not-installable': 'not installable here'
}

/**
 * Fase 17b correzioni (B2): la fiducia di una voce del registro per il result
 * del tool, in inglese. Il label italiano di registryTrust resta per la card
 * (MU, se ne occupa la 17c).
 */
export function registryTrustEnLabel(t: ReturnType<typeof registryTrust>): string {
  // fase 17c (C5): il label di registryTrust è già il testo inglese per il modello
  return t.label
}

/** Massimo righe in totale (catalogo e plugin prima). */
export const SEARCH_MAX_ROWS = 8

/** La descrizione in ogni riga è troncata a 160 caratteri. */
export const DESCRIPTION_MAX_CHARS = 160

export function truncateDescription(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > DESCRIPTION_MAX_CHARS ? clean.slice(0, DESCRIPTION_MAX_CHARS - 1) + '…' : clean
}

/** Rango della fiducia nell'ordinamento (minore = più fidato). */
function trustRank(t: ConnectorSearchRow['trustKind']): number {
  return { verified: 0, 'verified-domain': 1, marketplace: 2, 'github-account': 3, unverified: 4 }[t]
}

/** Corrispondenza del nome con la query (minore = meglio). */
function relevance(name: string, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 2
  const n = name.toLowerCase()
  if (n === q) return 0
  if (n.startsWith(q)) return 1
  if (n.includes(q)) return 2
  return 3
}

export interface MergeInput {
  /** voci del catalogo verificato con il loro stato (già filtrate o intere: il merge applica la query) */
  catalog: Array<{ entry: CatalogEntry; state?: ConnectorState }>
  /** plugin dei marketplace registrati, con nome marketplace e flag ufficiale */
  plugins: Array<{ marketplace: string; official: boolean; plugin: MarketplacePlugin }>
  /** voci del registro GIÀ parsate per questa query; null = registro irraggiungibile */
  registry: RegistryEntry[] | null
}

export interface MergeOutput {
  rows: ConnectorSearchRow[]
  registryDown: boolean
}

/**
 * mergeConnectorResults (pura): le tre fonti in ordine di fiducia, deduplica
 * (una voce del registro il cui remotes[].url coincide con l'mcpUrl di una
 * voce del catalogo NON compare: resta quella del catalogo), ordinamento
 * fonte → fiducia → corrispondenza del nome, tetto di 8 righe in totale.
 */
export function mergeConnectorResults(input: MergeInput, query: string): MergeOutput {
  const rows: ConnectorSearchRow[] = []
  // 1. catalogo verificato: fiducia "verificato", gira remoto con OAuth
  for (const { entry, state } of searchCatalog(input.catalog.map((c) => c.entry), query).map((entry) => {
    const withState = input.catalog.find((c) => c.entry.id === entry.id)
    return { entry, state: withState?.state }
  })) {
    const status = state?.status
    rows.push({
      id: `catalog:${entry.id}`,
      name: entry.name,
      source: 'catalog',
      sourceLabel: 'catalog',
      trust: 'verified',
      trustKind: 'verified',
      runtime: 'remote-oauth',
      runtimeLabel: RUNTIME_LABELS['remote-oauth'],
      ...(status && status !== 'not_connected' ? { status: status === 'connected' ? 'connected' : status === 'needs_auth' ? 'needs authorization' : 'error' } : {}),
      description: truncateDescription(pickLang(entry.notes, 'en'))
    })
  }
  // 2. plugin dei marketplace registrati: fiducia "marketplace:<nome>"
  const q = query.trim().toLowerCase()
  const words = q ? q.split(/\s+/) : []
  for (const { marketplace, official, plugin } of input.plugins) {
    const hay = `${plugin.name} ${plugin.description ?? ''} ${plugin.author ?? ''}`.toLowerCase()
    if (words.length && !words.some((w) => hay.includes(w))) continue
    rows.push({
      id: `plugin:${plugin.name}@${marketplace}`,
      name: plugin.name,
      source: 'plugin',
      sourceLabel: `marketplace ${marketplace}`,
      trust: marketplaceTrustLabel(official),
      trustKind: 'marketplace',
      runtime: 'plugin',
      runtimeLabel: RUNTIME_LABELS.plugin,
      description: truncateDescription(plugin.description ?? `plugin ${plugin.name} from the ${marketplace} marketplace`)
    })
  }
  // 3. registro pubblico: fiducia dallo spazio dei nomi
  if (input.registry !== null) {
    for (const e of input.registry) {
      const rt = registryRuntime(e)
      const trust = registryTrust(e.server.name)
      // fase mcp-setup (M2): la riga mostra il TITOLO («Mattermost»); il nome
      // tecnico resta nell'id. (M1.2): «remote-key» SOLO con l'header
      // OBBLIGATORIO — header facoltativi = OAuth, il token è l'alternativa
      const needsKey = rt?.kind === 'remote' && rt.auth === 'headers'
      rows.push({
        id: `registry:${e.server.name}`,
        name: registryTitle(e),
        source: 'registry',
        sourceLabel: 'MCP registry',
        trust: registryTrustEnLabel(trust),
        trustKind: trust.kind === 'verified-domain' ? 'verified-domain' : trust.kind === 'github-account' ? 'github-account' : 'unverified',
        runtime: rt === null
          ? 'not-installable'
          : rt.kind === 'remote'
            ? needsKey ? 'remote-key' : 'remote-oauth'
            : rt.kind === 'box-npm' ? 'box-npm' : 'not-installable',
        runtimeLabel: rt === null
          ? RUNTIME_LABELS['not-installable']
          : rt.kind === 'remote'
            ? RUNTIME_LABELS[needsKey ? 'remote-key' : 'remote-oauth']
            : RUNTIME_LABELS[rt.kind === 'box-npm' ? 'box-npm' : 'not-installable'],
        description: truncateDescription(e.server.description ?? e.server.name)
      })
    }
  }
  // deduplica: la voce del registro il cui remote coincide con l'mcpUrl del
  // catalogo NON compare (resta quella del catalogo, che è più fidata)
  const catalogUrls = new Set(input.catalog.map((c) => c.entry.mcpUrl))
  const deduped = rows.filter((r) => {
    if (r.source !== 'registry' || input.registry === null) return true
    const e = input.registry.find((x) => `registry:${x.server.name}` === r.id)
    const urls = (e?.server.remotes ?? []).map((x) => x.url).filter((u): u is string => typeof u === 'string')
    return !urls.some((u) => catalogUrls.has(u))
  })
  // ordinamento: fonte, poi fiducia, poi corrispondenza del nome; tetto di 8
  const sourceRank = { catalog: 0, plugin: 1, registry: 2 } as const
  const ordered = deduped
    .map((r) => ({ r, k: `${sourceRank[r.source]}:${trustRank(r.trustKind)}:${relevance(r.name, query)}:${r.name.toLowerCase()}` }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map((x) => x.r)
  return { rows: ordered.slice(0, SEARCH_MAX_ROWS), registryDown: input.registry === null }
}

/** formatConnectorLine(r) (pura): la riga che il modello vede in search_connectors. */
export function formatConnectorLine(r: ConnectorSearchRow): string {
  const status = r.status ? ` · ${r.status}` : ''
  return `- ${r.id} — ${r.name} · source: ${r.sourceLabel} · trust: ${r.trust} · ${r.runtimeLabel}${status}: ${truncateDescription(r.description)}`
}

/** La riga che dice che il registro pubblico non è raggiungibile (le altre fonti rispondono comunque). */
export const REGISTRY_DOWN_LINE = '- public registry unreachable'

/** Il testo completo del result di search_connectors (puro). */
export function formatSearchResults(out: MergeOutput): string {
  const lines = out.rows.map(formatConnectorLine)
  if (out.registryDown) lines.push(REGISTRY_DOWN_LINE)
  return lines.length ? lines.join('\n') : 'No connector found for this search.'
}

/**
 * L'orchestrazione del tool search_connectors: catalogo + plugin dai
 * marketplace registrati (già scaricati e cachati) + registro (rete, host
 * fisso, 8 s, cache 10 minuti). Se il registro non risponde, le altre fonti
 * rispondono comunque e la riga REGISTRY_DOWN_LINE lo dice.
 */
export async function searchAllConnectors(
  query: string,
  input: Omit<MergeInput, 'registry'> & { fetchRegistry?: typeof fetchRegistryEntries }
): Promise<MergeOutput> {
  const fetchRegistry = input.fetchRegistry ?? fetchRegistryEntries
  const registry = await fetchRegistry(query).catch(() => null)
  return mergeConnectorResults({ catalog: input.catalog, plugins: input.plugins, registry }, query)
}
