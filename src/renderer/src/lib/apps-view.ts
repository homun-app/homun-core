// Fase catalogo app (P2/P3): il modello della finestra «App» come FUNZIONE
// PURA. L'elenco UNICO delle app arriva da shared/app-catalog (loadAppCatalog);
// qui si aggiunge lo STATO di collegamento (diretta dal catalogo connettori,
// app Composio del gateway o della chiave), le sezioni (Connesse in cima,
// Consigliate per te, una per categoria) e la griglia di ricerca/filtro.
// La sezione «Collegate» dei server e dei plugin resta quella di fase 16c:
// righe con stato, nomi dei bot e «+N».
import type { ConnectorInfo, ComposioStatusInfo, ComposioGatewayStatusInfo } from '../../../shared/types'
import type { AppCatalogRow, AppCategoryId } from '../../../shared/app-catalog'
import { APP_CATEGORIES, appTaglineOf, searchApps } from '../../../shared/app-catalog'

/** I filtri a pillola della finestra: Tutte, Connesse, le categorie nostre. */
export type AppsFilter = 'all' | 'connected' | AppCategoryId

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

/** A7/P5: da dove passano i dati dell'app. */
export type AppProvenance = 'direct' | 'composio'

export interface AppsViewInput {
  connectors: ConnectorInfo[]
  installed: { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null
  agents: AgentLike[]
  /** le skill dei bot (ownerId = id del bot; i plugin stanno in installed) */
  skillsByOwner?: SkillsByOwner[]
  filter: AppsFilter
  query: string
  /** la lingua attiva per i tagline Localized */
  lang: 'it' | 'en'
}

export interface ConnectedRow {
  kind: 'connected'
  key: string
  /** server MCP | plugin (le app del catalogo stanno nell'elenco unico) */
  source: 'server' | 'plugin'
  id: string
  name: string
  logo: string
  /** quali bot la usano: «Tutti i bot» (all) o i primi 2 nomi + +N */
  botsLabel: { all: boolean; names: string[]; extra: number }
  status: 'connected' | 'reconnect'
  /** A7: la provenienza (i server e i plugin stanno sul Mac) */
  via: AppProvenance
}

/** Una riga dell'elenco unico con il suo stato di collegamento. */
export interface CatalogRowView {
  app: AppCatalogRow
  /** la mezza riga nella lingua attiva (null = niente) */
  tagline: string | null
  connected: 'connected' | 'reconnect' | null
}

export interface AppsViewModel {
  /** «Collegate»: server MCP installati + plugin (le app stanno nell'elenco) */
  connected: ConnectedRow[]
  /** le skill di tutti i bot (riga «Skill dei bot») */
  skills: SkillsByOwner[]
}

/** Una sezione per categoria (P3): le prime 6 per rank e il totale. */
export interface CatalogSection {
  category: AppCategoryId
  rows: CatalogRowView[]
  total: number
}

export interface AppsCatalogInput {
  /** l'elenco unico (loadAppCatalog) già calcolato con le static pronte */
  apps: AppCatalogRow[]
  connectors: ConnectorInfo[]
  composio?: ComposioStatusInfo | null
  composioGateway?: ComposioGatewayStatusInfo | null
  filter: AppsFilter
  query: string
  lang: 'it' | 'en'
}

export interface AppsCatalogModel {
  /** tutte le righe con lo stato di collegamento */
  rows: CatalogRowView[]
  /** «Consigliate per te»: le featured NON connesse, al massimo 6 (Tutte, senza ricerca) */
  featured: CatalogRowView[]
  /** la sezione «Connesse» compatta (Tutte, senza ricerca) */
  connectedRows: CatalogRowView[]
  /** le sezioni per categoria (Tutte, senza ricerca; le connesse stanno in cima) */
  sections: CatalogSection[]
  /** la griglia sola di ricerca/filtro (null = si vedono le sezioni) */
  grid: CatalogRowView[] | null
  /** quante app sono collegate (testata «N connesse ›» e pillola Connesse) */
  connectedCount: number
  /** le categorie che hanno almeno un'app, nell'ordine fisso (le pillole) */
  categoriesPresent: AppCategoryId[]
  /** ricerca senza risultati (il messaggio vuoto gentile) */
  nothingFound: boolean
}

/** I nomi dei bot che usano la voce («Tutti i bot» quando c'è '*'), max 2 + +N. */
export function botsLabelOf(enabledFor: string[] | null | undefined, agents: AgentLike[]): ConnectedRow['botsLabel'] {
  const ids = enabledFor ?? []
  if (ids.includes('*') || ids.length === 0) return { all: true, names: [], extra: 0 }
  const names = ids.map((id) => agents.find((a) => a.id === id)?.name ?? id)
  return { all: false, names: names.slice(0, 2), extra: Math.max(0, names.length - 2) }
}

/**
 * PURA (16c, ridotta alla sezione «Collegate»): i server MCP installati e i
 * plugin con lo stato e i nomi dei bot. Le APP del catalogo non stanno più
 * qui: l'elenco unico di appsCatalogModel le copre con la loro provenienza.
 */
export function appsViewModel(input: AppsViewInput): AppsViewModel {
  const q = input.query.trim().toLowerCase()
  const agents = input.agents
  const connected: ConnectedRow[] = []
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
  const skills = (input.skillsByOwner ?? []).filter((row) => row.skills.length > 0)
  return { connected, skills }
}

function matchesQuery(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // le parole della ricerca devono esserci TUTTE (le frasi trovano le frasi)
  return q.split(/\s+/).every((w) => hay.includes(w))
}

/**
 * PURA (P3): il modello dell'elenco unico. Le righe portano lo stato di
 * collegamento (diretta, gateway o chiave); con «Tutte» e senza ricerca si
 * vedono la sezione «Connesse», le consigliate e le sezioni per categoria
 * (prime 6 per rank); con una ricerca o un filtro, UNA griglia con tutto ciò
 * che corrisponde, senza doppioni.
 */
export function appsCatalogModel(input: AppsCatalogInput): AppsCatalogModel {
  const { filter, query, lang } = input
  const directState = new Map(input.connectors.map((c) => [c.id, c.state.status]))
  const gatewayApp = new Map((input.composioGateway?.connected ?? []).map((a) => [a.slug, a]))
  const keyApp = new Map((input.composio?.connected ?? []).map((a) => [a.slug, a]))

  const connectedOf = (app: AppCatalogRow): CatalogRowView['connected'] => {
    // V13 (prova vera): per le righe a doppio marchio (Notion, Linear…) lo
    // stato DIRETTO conta — collegando la diretta la riga dice «Connessa»
    const s = app.directId ? directState.get(app.directId) : undefined
    if (s === 'connected') return 'connected'
    if (app.directId && !app.composioSlug) {
      if (s === 'needs_auth') return 'reconnect'
      return null
    }
    const slug = app.composioSlug
    if (!slug) return s === 'needs_auth' ? 'reconnect' : null
    const g = gatewayApp.get(slug)
    if (g) return g.status === 'ACTIVE' ? 'connected' : 'reconnect'
    const k = keyApp.get(slug)
    if (k) return k.status === 'ACTIVE' ? 'connected' : 'reconnect'
    return s === 'needs_auth' ? 'reconnect' : null
  }

  const rows: CatalogRowView[] = input.apps.map((app) => ({
    app,
    tagline: appTaglineOf(app, lang),
    connected: connectedOf(app)
  }))
  const connectedRows = rows.filter((r) => r.connected !== null)
  const browsing = filter === 'all' && !query.trim()

  // la griglia di ricerca/filtro: TUTTO ciò che corrisponde, con lo stato
  let grid: CatalogRowView[] | null = null
  if (!browsing) {
    let match: CatalogRowView[]
    if (query.trim()) match = searchApps(rows.map((r) => r.app), query, lang)
      .map((app) => rows.find((r) => r.app === app)!)
    else match = rows
    if (filter === 'connected') grid = match.filter((r) => r.connected !== null)
    else if (filter !== 'all') grid = match.filter((r) => r.app.category === filter)
    else grid = match
  }

  // le categorie presenti (le pillole): anche delle app collegate
  const present = new Set(rows.map((r) => r.app.category))
  const categoriesPresent = APP_CATEGORIES.filter((c) => present.has(c))

  const featured = browsing
    ? rows.filter((r) => r.app.featured && r.connected === null).slice(0, 6)
    : []
  const featuredIds = new Set(featured.map((r) => r.app.id))
  const sections: CatalogSection[] = browsing
    ? APP_CATEGORIES.map((category) => {
      const ofCat = rows.filter((r) => r.app.category === category && !featuredIds.has(r.app.id) && r.connected === null)
      return { category, rows: ofCat.slice(0, 6), total: ofCat.length }
    }).filter((s) => s.rows.length > 0)
    : []

  const nothingFound = Boolean(query.trim())
    && (grid?.length ?? 0) === 0

  return {
    rows,
    featured,
    connectedRows,
    sections,
    grid,
    connectedCount: connectedRows.length,
    categoriesPresent,
    nothingFound
  }
}
