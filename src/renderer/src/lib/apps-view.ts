// Fase 16c (C4): il modello della finestra «Collega app e skill» come
// FUNZIONE PURA (tavola 6): le consigliate (ordine fisso, al massimo 4, non
// collegate), le collegate (connettore del catalogo, server MCP installato,
// plugin) con i nomi dei bot e il «+N», il filtro per categoria e la ricerca.
// Fase app (A1/A3/A4): UNA lista sola — le curate PRIMA e le app Composio
// DOPO in ordine alfabetico; le curate vincono sui toolkit Composio dello
// stesso servizio (l'esclusione la fa il daemon con la tabella di slug);
// «Collegate» comprende anche le app Composio, con lo stato «da ricollegare».
// Ogni riga porta la PROVENIENZA (A7): 'direct' (curata) o 'composio'.
import type { ConnectorInfo, ComposioCatalogRow, ComposioStatusInfo, ComposioGatewayStatusInfo, Localized } from '../../../shared/types'

/** L'ordine fisso delle consigliate (l'idea di featured-connectors di Rakazo). */
export const FEATURED_ORDER = ['gmail', 'gcalendar', 'gdrive', 'notion', 'linear'] as const

/** I filtri a pillola della finestra. */
export type AppsFilter = 'all' | 'connected' | 'mail-calendar' | 'documents' | 'development' | 'communication' | 'skills'

export interface InstalledServerLike {
  id: string
  name: string
  enabledFor?: string[] | null
  needsReauth?: boolean
  source?: { kind?: string; name?: string } | null
}

export interface InstalledPluginLike {
  name: string
  marketplace: string
  sha12?: string
  skills: Array<{ name: string }>
  servers: string[]
  enabledFor?: string[] | null
}

/** Un bot come serve a appsViewModel: id e nome. */
export interface AgentLike {
  id: string
  name: string
}

/** Le skill di un bot (da skills:list) o di un plugin, per la riga «Skill dei bot». */
export interface SkillsByOwner {
  ownerId: string
  ownerName: string
  skills: string[]
}

/** A7: da dove passano i dati dell'app. */
export type AppProvenance = 'direct' | 'composio'

export interface AppsViewInput {
  catalog: ConnectorInfo[]
  connectors: ConnectorInfo[]
  installed: { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null
  agents: AgentLike[]
  /** le skill dei bot (ownerId = id del bot; i plugin stanno in installed) */
  skillsByOwner?: SkillsByOwner[]
  filter: AppsFilter
  query: string
  /** la lingua attiva per i tagline Localized */
  lang: 'it' | 'en'
  /** fase app: lo stato Composio (null = RPC non disponibile) */
  composio?: ComposioStatusInfo | null
  /** fase app: le righe del catalogo Composio già filtrate dal daemon (curate escluse) */
  composioRows?: ComposioCatalogRow[]
  /** fase Composio OAuth (C5): le app dentro il server Composio collegato col login */
  composioGateway?: ComposioGatewayStatusInfo | null
}

export interface FeaturedRow {
  kind: 'featured'
  id: string
  name: string
  logo: string
  tagline: string | null
}

export interface ConnectedRow {
  kind: 'connected'
  key: string
  /** connettore del catalogo | server MCP | plugin | app Composio */
  source: 'connector' | 'server' | 'plugin' | 'composio'
  id: string
  name: string
  logo: string
  /** quali bot la usano: «Tutti i bot» (all) o i primi 2 nomi + +N */
  botsLabel: { all: boolean; names: string[]; extra: number }
  status: 'connected' | 'reconnect'
  /** A7: la provenienza (le curate/server sono dirette, Composio passa dai suoi server) */
  via: AppProvenance
  /** solo source 'composio': lo slug del toolkit (Collega/Scollega/Ricollega) */
  composioSlug?: string
  /** fase Composio OAuth (C5): lo slug di un'app del GATEWAY (login, non chiave) */
  gatewaySlug?: string
  /** fase Composio OAuth (C6): la riga apre il dettaglio del gateway Composio */
  gateway?: boolean
}

/** Una riga Composio di «Tutte le app» (A3). */
export interface ComposioAppRow {
  slug: string
  name: string
  tagline: string | null
  logo: string | null
  connectable: 'yes' | 'no-auth' | 'developer-config'
}

export interface AppsViewModel {
  /** «Consigliate per te»: al massimo 4, non collegate, ordine fisso */
  featured: FeaturedRow[]
  /** «Collegate»: connettori collegati + server installati + plugin + app Composio */
  connected: ConnectedRow[]
  /** le voci del catalogo NON collegate che passano filtro e ricerca */
  catalogRows: ConnectorInfo[]
  /** fase app: le app Composio non collegate (dopo le curate, ordine del daemon) */
  composioApps: ComposioAppRow[]
  /** quante app sono collegate in tutto (per «N collegate ›») */
  connectedCount: number
  /** le skill di tutti i bot (riga «Skill dei bot») */
  skills: SkillsByOwner[]
  /** la categoria «Comunicazione» esiste solo se il catalogo ha voci di quel tipo */
  hasCommunication: boolean
}

function matchesQuery(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // le parole della ricerca devono esserci TUTTE (le frasi trovano le frasi)
  return q.split(/\s+/).every((w) => hay.includes(w))
}

/** Il tagline nella lingua scelta (le stringhe semplici restano com'erano). */
export function taglineOf(tagline: Localized | undefined, lang: 'it' | 'en'): string | null {
  if (!tagline) return null
  return typeof tagline === 'string' ? tagline : tagline[lang]
}

/** I nomi dei bot che usano la voce («Tutti i bot» quando c'è '*'), max 2 + +N. */
export function botsLabelOf(enabledFor: string[] | null | undefined, agents: AgentLike[]): ConnectedRow['botsLabel'] {
  const ids = enabledFor ?? []
  if (ids.includes('*') || ids.length === 0) return { all: true, names: [], extra: 0 }
  const names = ids.map((id) => agents.find((a) => a.id === id)?.name ?? id)
  return { all: false, names: names.slice(0, 2), extra: Math.max(0, names.length - 2) }
}

/**
 * PURA (tavola 6): il modello della vista. Le consigliate sono al massimo 4
 * voci NON collegate del catalogo nell'ordine fisso FEATURED_ORDER; le
 * collegate uniscono connettori collegati, server installati, plugin e app
 * Composio (con lo stato); la ricerca filtra catalogo, Composio e collegate
 * per nome (e id per il catalogo, slug per Composio).
 */
export function appsViewModel(input: AppsViewInput): AppsViewModel {
  const q = input.query.trim().toLowerCase()
  const lang = input.lang
  const connectedStates = new Set(
    input.connectors.filter((c) => c.state.status === 'connected' || c.state.status === 'needs_auth').map((c) => c.id)
  )
  const agents = input.agents
  const composio = input.composio ?? null

  // -- le consigliate: ordine fisso, non collegate, al massimo 4 --
  const featured: FeaturedRow[] = []
  for (const id of FEATURED_ORDER) {
    if (featured.length >= 4) break
    const entry = input.catalog.find((c) => c.id === id)
    if (!entry || connectedStates.has(entry.id)) continue
    featured.push({
      kind: 'featured',
      id: entry.id,
      name: entry.name,
      logo: entry.logo,
      tagline: taglineOf(entry.tagline, lang)
    })
  }

  // -- le collegate: connettori del catalogo collegati (o da ricollegare) --
  const connected: ConnectedRow[] = []
  for (const c of input.connectors) {
    if (c.state.status !== 'connected' && c.state.status !== 'needs_auth') continue
    if (q && !matchesQuery(`${c.name} ${c.id}`.toLowerCase(), q)) continue
    connected.push({
      kind: 'connected',
      key: `connector:${c.id}`,
      source: 'connector',
      id: c.id,
      name: c.name,
      logo: c.logo,
      botsLabel: { all: true, names: [], extra: 0 },
      status: c.state.status === 'connected' ? 'connected' : 'reconnect',
      via: 'direct',
      // fase Composio OAuth (C6): la voce Composio del catalogo apre il
      // dettaglio del gateway (app collegate, Collega un'app, Disattiva)
      ...(c.gateway ? { gateway: true } : {})
    })
  }
  // -- i server MCP installati (registro, plugin, gateway, manuale) --
  for (const s of input.installed?.servers ?? []) {
    if (q && !matchesQuery(s.name.toLowerCase(), q)) continue
    connected.push({
      kind: 'connected',
      key: `server:${s.id}`,
      source: 'server',
      id: s.id,
      name: s.name,
      logo: '✦',
      botsLabel: botsLabelOf(s.enabledFor ?? null, agents),
      status: s.needsReauth ? 'reconnect' : 'connected',
      via: 'direct'
    })
  }
  // -- i plugin (con le loro skill) --
  for (const p of input.installed?.plugins ?? []) {
    if (q && !matchesQuery(p.name.toLowerCase(), q)) continue
    connected.push({
      kind: 'connected',
      key: `plugin:${p.marketplace}/${p.name}`,
      source: 'plugin',
      id: p.name,
      name: p.name,
      logo: '🧩',
      botsLabel: botsLabelOf(p.enabledFor ?? null, agents),
      status: 'connected',
      via: 'direct'
    })
  }
  // -- fase Composio OAuth (C5): le app dentro il server Composio (login) --
  const gatewayApps = input.composioGateway?.connected ?? []
  for (const app of gatewayApps) {
    if (q && !matchesQuery(`${app.name} ${app.slug}`.toLowerCase(), q)) continue
    connected.push({
      kind: 'connected',
      key: `gateway-app:${app.slug}`,
      source: 'composio',
      id: app.slug,
      name: app.name,
      logo: '🌐',
      botsLabel: { all: true, names: [], extra: 0 },
      status: app.status === 'ACTIVE' ? 'connected' : 'reconnect',
      via: 'composio',
      gatewaySlug: app.slug
    })
  }
  // -- le app Composio collegate (o «da ricollegare») --
  for (const app of composio?.connected ?? []) {
    if (q && !matchesQuery(`${app.name} ${app.slug}`.toLowerCase(), q)) continue
    connected.push({
      kind: 'connected',
      key: `composio:${app.slug}`,
      source: 'composio',
      id: app.slug,
      name: app.name,
      logo: '🌐',
      botsLabel: { all: true, names: [], extra: 0 },
      status: app.status === 'ACTIVE' ? 'connected' : 'reconnect',
      via: 'composio',
      composioSlug: app.slug
    })
  }

  // -- il catalogo per filtro e ricerca (viste Tutte / categoria) --
  // fase 16c correzioni (R8.1): la sezione «Consigliate per te» esiste SOLO
  // con la pillola Tutte e nessuna ricerca; in quel caso la lista qui sotto
  // ESCLUDE quelle voci e diventa «Altre app» — prima le quattro consigliate
  // comparivano DUE volte. Con una categoria scelta o una ricerca la sezione
  // consigliate non c'è e si vede TUTTO ciò che corrisponde, senza doppioni
  const featuredSectionVisible = !q && input.filter === 'all' && featured.length > 0
  const featuredIds = new Set(featured.map((f) => f.id))
  const catalogRows = input.catalog.filter((c) => {
    if (connectedStates.has(c.id)) return false
    if (input.filter !== 'all' && input.filter !== 'connected' && c.category !== input.filter) return false
    if (q && !matchesQuery(`${c.name} ${c.id} ${taglineOf(c.tagline, lang) ?? ''}`.toLowerCase(), q)) return false
    if (featuredSectionVisible && featuredIds.has(c.id)) return false
    return true
  })

  // -- le app Composio non collegate (A3: dopo le curate, ordine del daemon) --
  const composioApps: ComposioAppRow[] = (input.composioRows ?? [])
    .filter((r) => matchesQuery(`${r.name} ${r.slug} ${r.tagline ?? ''}`.toLowerCase(), q))
    .map((r) => ({ slug: r.slug, name: r.name, tagline: r.tagline, logo: r.logo, connectable: r.connectable }))

  // -- le skill dei bot (la riga «Skill dei bot · N skill») --
  const skills = (input.skillsByOwner ?? []).filter((row) => row.skills.length > 0)

  return {
    featured,
    connected,
    catalogRows,
    composioApps,
    connectedCount: connected.length,
    skills,
    hasCommunication: input.catalog.some((c) => c.category === 'communication')
  }
}
