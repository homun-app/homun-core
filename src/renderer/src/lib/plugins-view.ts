// Fase plugin (PL1): il modello della pagina «Plugin» come FUNZIONE PURA —
// le righe di «I tuoi» (connettori Composio, connettori diretti del
// catalogo, server MCP installati, plugin, skill), la riga grigia
// «tipo · strada · origine» e lo stato con l'azione. Le FINESTRE di oggi
// restano le padrone dei loro pezzi (righe, form, import, editor): qui si
// ordina e si dichiara, non si riscrive. Lo stato riprende le decisioni di
// apps-view (serverRowStatus) e dei fogli di oggi: onesto su ciò che non
// parte, su ciò che va ricollegato e su ciò che aspetta la configurazione.
import type { ConnectorInfo, ComposioStatusInfo, ComposioGatewayStatusInfo, SkillLibraryItem } from '../../../shared/types'
import type { InstalledServerLike, InstalledPluginLike, AgentLike, CatalogRowView } from './apps-view'
import { botsLabelOf } from './apps-view'

/** I segmenti della pagina: Tutto · Connettori · Skill · Collegati. */
export type PluginSegment = 'all' | 'connectors' | 'skills' | 'connected'

/** Il tipo della riga grigia: cosa dà capacità al bot. */
export type PluginType = 'connector' | 'server' | 'plugin' | 'skill'

/**
 * La STRADA che usa il collegamento (PL4): la più diretta prima — il server
 * MCP del fornitore, il registro/npm, Composio — più dove GIRA (sul Mac o
 * nel computer isolato). La chiave alimenta anche il badge di «Collegati».
 */
export type PluginStrada =
  | 'direct'
  | 'composio'
  | 'mac'
  | 'registry'
  | 'box-npm'
  | 'plugin'
  | 'gateway'
  | 'skill'

/** Lo stato della riga: attivo, non parte, accesso scaduto, da completare. */
export type PluginState = 'active' | 'broken' | 'expired' | 'setup' | 'invalid'

export interface YourPluginRow {
  key: string
  kind: PluginType
  name: string
  /** il file del logo nel repo (si risolve con AppLogo), null = l'iniziale */
  logo: string | null
  /** la riga grigia: tipo · strada · origine (le parti, il testo lo compone grayLineOf) */
  gray: { type: PluginType; strada: PluginStrada; origin?: string }
  state: PluginState
  /** verificato: solo quando la strada è l'MCP di prima parte del fornitore (PL4) */
  verified: boolean
  bots: { all: boolean; names: string[]; extra: number }
  /** quante volte compare nella pagina per aprire la sua scheda (PL2) */
  open: { kind: 'app'; appId: string } | { kind: 'server'; serverId: string } | { kind: 'plugin'; name: string } | { kind: 'skill'; folder: string }
}

export interface PluginViewInput {
  /** le righe del catalogo con lo stato (appsCatalogModel().connectedRows) */
  connectedApps: CatalogRowView[]
  composio: ComposioStatusInfo | null
  composioGateway: ComposioGatewayStatusInfo | null
  installed: { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null
  skills: SkillLibraryItem[] | null
  agents: AgentLike[]
  query: string
}

/** Un server come lo dichiara il daemon (il `source` con i suoi campi). */
export type InstalledServerSourceLike = Pick<InstalledServerLike, 'id' | 'name'> & {
  source?: { kind?: string; name?: string; package?: string; version?: string } | null
}

/** Lo stato di un server installato, con l'errore che lo separa dal verde. */
export function pluginStateOfServer(s: InstalledServerLike): PluginState {
  if (s.needsAuth) return 'setup'
  if (s.needsReauth) return 'expired'
  if (s.stateStatus === 'error') return 'broken'
  if (s.stateStatus === 'needs_auth') return 'expired'
  return 'active'
}

/** La strada di un server MCP installato, dal suo `source` (onesta: ciò che c'è). */
export function stradaOfServer(s: InstalledServerSourceLike): PluginStrada {
  const kind = s.source?.kind
  if (kind === 'registry') return 'registry'
  if (kind === 'plugin') return 'plugin'
  if (kind === 'gateway') return 'gateway'
  if (kind === 'npm') return 'box-npm'
  return 'mac'
}

function matchesQuery(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return q.split(/\s+/).every((w) => hay.includes(w))
}

/**
 * PURA (PL1): le righe di «I tuoi» — i plugin collegati o attivi. Connettori
 * del catalogo (diretti e Composio), server MCP installati, plugin, skill
 * della libreria. Ogni riga dice il tipo, la strada e l'origine, e lo stato
 * con l'azione. NIENTE campi inventati: ciò che il dato non ha non si mostra.
 */
export function yourPlugins(input: PluginViewInput): YourPluginRow[] {
  const rows: YourPluginRow[] = []
  const q = input.query.trim().toLowerCase()

  // -- le app del catalogo COLLEGATE (dirette o Composio) --
  for (const r of input.connectedApps) {
    if (q && !matchesQuery(r.app.name.toLowerCase(), q)) continue
    rows.push({
      key: `app:${r.app.id}`,
      kind: 'connector',
      name: r.app.name,
      logo: r.app.logo,
      gray: r.app.via === 'direct'
        ? { type: 'connector', strada: 'direct', origin: r.app.name }
        : { type: 'connector', strada: 'composio' },
      state: r.connected === 'connected' ? 'active' : 'expired',
      verified: r.app.via === 'direct',
      bots: { all: true, names: [], extra: 0 },
      open: { kind: 'app', appId: r.app.id }
    })
  }

  // -- i server MCP installati (registro, plugin, gateway, npm, manuali) --
  for (const s of input.installed?.servers ?? []) {
    if (q && !matchesQuery(s.name.toLowerCase(), q)) continue
    rows.push({
      key: `server:${s.id}`,
      kind: 'server',
      name: s.name,
      logo: null,
      gray: { type: 'server', strada: stradaOfServer(s), origin: s.source?.name },
      state: pluginStateOfServer(s),
      verified: false,
      bots: botsLabelOf(s.enabledFor ?? null, input.agents),
      open: { kind: 'server', serverId: s.id }
    })
  }

  // -- i plugin (con le loro skill) --
  for (const p of input.installed?.plugins ?? []) {
    if (q && !matchesQuery(p.name.toLowerCase(), q)) continue
    rows.push({
      key: `plugin:${p.marketplace}/${p.name}`,
      kind: 'plugin',
      name: p.name,
      logo: null,
      gray: { type: 'plugin', strada: 'plugin', origin: p.marketplace },
      state: 'active',
      verified: false,
      bots: botsLabelOf(p.enabledFor ?? null, input.agents),
      open: { kind: 'plugin', name: p.name }
    })
  }

  // -- le skill della libreria (PL5 le porta in pagina come le altre) --
  for (const s of input.skills ?? []) {
    if (q && !matchesQuery(s.name.toLowerCase(), q) && !matchesQuery(s.description.toLowerCase(), q)) continue
    rows.push({
      key: `skill:${s.folder}`,
      kind: 'skill',
      name: s.name,
      logo: null,
      gray: { type: 'skill', strada: 'skill', origin: skillOriginKey(s) },
      state: s.valid ? 'active' : 'invalid',
      verified: false,
      bots: botsLabelOf(s.enabledFor, input.agents),
      open: { kind: 'skill', folder: s.folder }
    })
  }

  return rows
}

/** La chiave d'origine di una skill (la traduce la UI, il fatto sta qui). */
export function skillOriginKey(s: SkillLibraryItem): 'homun' | 'user' | 'bot' | 'github' | 'migrated' {
  if (s.source === 'github' || s.importedModified) return 'github'
  if (s.source === 'bot') return 'bot'
  if (s.source === 'migrated') return 'migrated'
  if (s.source === 'user') return s.createdBy ? 'bot' : 'user'
  return 'homun'
}

// ---- il testo delle righe (IT/EN, i termini universali restano) ----

const TYPE_LABEL: Record<PluginType, { it: string; en: string }> = {
  connector: { it: 'Connettore', en: 'Connector' },
  server: { it: 'Server MCP', en: 'MCP server' },
  plugin: { it: 'Plugin', en: 'Plugin' },
  skill: { it: 'Skill', en: 'Skill' }
}

/** L'etichetta della strada: «MCP diretto di Notion», «sul Mac», «tramite Composio»… */
export function stradaLabel(strada: PluginStrada, origin: string | undefined, lang: 'it' | 'en'): string {
  const via = (it: string, en: string): string => (lang === 'en' ? en : it)
  switch (strada) {
    case 'direct': return origin ? via(`MCP diretto di ${origin}`, `direct MCP from ${origin}`) : via('MCP diretto', 'direct MCP')
    case 'composio': return via('tramite Composio', 'via Composio')
    case 'mac': return via('sul Mac', 'on your Mac')
    case 'registry': return via('registro MCP', 'MCP registry')
    case 'box-npm': return via('nel computer isolato', 'in the sandboxed computer')
    case 'plugin': return via('da plugin', 'from a plugin')
    case 'gateway': return via('gateway', 'gateway')
    case 'skill': return via('Homun', 'Homun')
  }
}

/** La riga grigia completa: «Connettore · MCP diretto di Notion». */
export function grayLineOf(row: YourPluginRow, lang: 'it' | 'en'): string {
  const parts = [TYPE_LABEL[row.gray.type][lang]]
  if (row.gray.strada === 'skill') {
    // l'origine della skill: GitHub quando ci ARRIVATA (o lo conserva),
    // altrimenti Homun — mai un'origine inventata
    parts.push(row.gray.origin === 'github' ? 'GitHub' : stradaLabel('skill', undefined, lang))
  } else {
    parts.push(stradaLabel(row.gray.strada, row.gray.origin, lang))
    if (row.gray.origin && row.gray.strada !== 'direct') parts.push(row.gray.origin)
  }
  return parts.join(' · ')
}

/** L'etichetta dello stato, con l'azione che propone. */
export function stateLabelOf(state: PluginState, lang: 'it' | 'en'): { label: string; action: 'why' | 'reconnect' | 'setup' | null } {
  const via = (it: string, en: string): string => (lang === 'en' ? en : it)
  switch (state) {
    case 'active': return { label: via('attivo', 'active'), action: null }
    case 'broken': return { label: via('non parte', 'not working'), action: 'why' }
    case 'expired': return { label: via('accesso scaduto', 'access expired'), action: 'reconnect' }
    case 'setup': return { label: via('da completare', 'needs setup'), action: 'setup' }
    case 'invalid': return { label: via('non valida', 'invalid'), action: 'why' }
  }
}
