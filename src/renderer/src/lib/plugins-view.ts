// Fase plugin (PL1): il modello della pagina «Plugin» come FUNZIONE PURA —
// le righe di «I tuoi» (connettori Composio, connettori diretti del
// catalogo, server MCP installati, plugin, skill), la riga grigia
// «tipo · strada · origine» e lo stato con l'azione. Le FINESTRE di oggi
// restano le padrone dei loro pezzi (righe, form, import, editor): qui si
// ordina e si dichiara, non si riscrive. Lo stato riprende le decisioni di
// apps-view (serverRowStatus) e dei fogli di oggi: onesto su ciò che non
// parte, su ciò che va ricollegato e su ciò che aspetta la configurazione.
import type { ConnectorInfo, ComposioStatusInfo, ComposioGatewayStatusInfo, SkillLibraryItem, PermissionsConfig } from '../../../shared/types'
import type { InstalledServerLike, InstalledPluginLike, AgentLike, CatalogRowView } from './apps-view'
import { botsLabelOf } from './apps-view'
// PL3: il prefisso stabile degli strumenti (mcp__<toolSlug>__), lo stesso del sistema
import { toolSlugOf } from '../../../main/mcp/slug'

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
  /** PL3: lo slug degli strumenti del server (mcp__<slug>__), per l'indice dell'uso */
  serverSlug?: string
  /** PL3: lo slug Composio (composio__<slug>__), per l'indice dell'uso */
  composioSlug?: string
  /** PL3: il dettaglio onesto della riga — il comando del server, «N skill» del plugin */
  countLabel?: string
  /** PL3: l'account onesto della riga (alias/email Composio, token, o nessun account) */
  accountLabel?: string
}

export interface PluginViewInput {
  /** le righe del catalogo con lo stato (appsCatalogModel().connectedRows) */
  connectedApps: CatalogRowView[]
  composio: ComposioStatusInfo | null
  composioGateway: ComposioGatewayStatusInfo | null
  installed: { servers: Array<InstalledServerLike & { toolSlug?: string; command?: string; args?: string[]; url?: string; auth?: { kind?: 'oauth' | 'bearer' | 'headers' } | null }> | null; plugins: InstalledPluginLike[] | null } | null
  skills: SkillLibraryItem[] | null
  /** PL5: le skill dei PLUGIN (gruppi per plugin, in sola lettura) */
  pluginSkills?: Array<{ plugin: string; skills: Array<{ name: string; description: string }> }> | null
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
      open: { kind: 'app', appId: r.app.id },
      ...(r.app.composioSlug ? { composioSlug: r.app.composioSlug } : {}),
      ...(r.app.composioSlug ? accountLabelOfApp(input, r.app.composioSlug) : {})
    })
  }

  // -- i server MCP installati (registro, plugin, gateway, npm, manuali) --
  for (const s of input.installed?.servers ?? []) {
    if (q && !matchesQuery(s.name.toLowerCase(), q)) continue
    const serverSlug = toolSlugOf({ toolSlug: s.toolSlug, name: s.name })
    rows.push({
      key: `server:${s.id}`,
      kind: 'server',
      name: s.name,
      logo: null,
      gray: { type: 'server', strada: stradaOfServer(s), origin: s.source?.name },
      state: pluginStateOfServer(s),
      verified: false,
      bots: botsLabelOf(s.enabledFor ?? null, input.agents),
      open: { kind: 'server', serverId: s.id },
      serverSlug,
      countLabel: serverDetailOf(s),
      accountLabel: accountLabelOfServer(s)
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
      open: { kind: 'plugin', name: p.name },
      countLabel: `${p.skills.length} skill`
    })
  }

  // -- PL5: le skill dei PLUGIN (in sola lettura: si aggiornano col plugin) --
  for (const group of input.pluginSkills ?? []) {
    for (const sk of group.skills) {
      if (q && !matchesQuery(sk.name.toLowerCase(), q) && !matchesQuery(sk.description.toLowerCase(), q)) continue
      rows.push({
        key: `pluginskill:${group.plugin}/${sk.name}`,
        kind: 'skill',
        name: sk.name,
        logo: null,
        gray: { type: 'skill', strada: 'plugin', origin: group.plugin },
        state: 'active',
        verified: false,
        bots: { all: true, names: [], extra: 0 },
        open: { kind: 'skill', folder: sk.name },
        countLabel: `/${sk.name}`
      })
    }
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

/** Gli account onesti di un'app Composio collegata (alias o email, mai l'id tecnico). */
function accountLabelOfApp(input: PluginViewInput, slug: string): { accountLabel?: string } {
  const app = input.composioGateway?.connected.find((a) => a.slug === slug)
  if (app && (app.accounts ?? []).length > 0) {
    return { accountLabel: (app.accounts ?? []).map((acc) => acc.alias ?? acc.email ?? '').filter(Boolean).join(', ') }
  }
  if (app?.email) return { accountLabel: app.email }
  return app ? { accountLabel: '' } : {}
}

/** L'account onesto di un server: token quando c'è un segreto, altrimenti niente. */
function accountLabelOfServer(s: { auth?: { kind?: 'oauth' | 'bearer' | 'headers' } | null }): string {
  if (s.auth?.kind === 'bearer' || s.auth?.kind === 'headers') return 'token'
  return ''
}

/** Il dettaglio onesto di un server: il comando locale o l'indirizzo (mai di più). */
function serverDetailOf(s: { command?: string; args?: string[]; url?: string }): string | undefined {
  if (s.url) return s.url
  if (s.command) return [s.command, ...(s.args ?? [])].join(' ')
  return undefined
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
  } else if (row.gray.strada === 'plugin' && row.gray.type === 'skill') {
    // PL5: una skill di plugin: «Skill · da plugin · <nome>»
    parts.push(stradaLabel('plugin', undefined, lang))
    if (row.gray.origin) parts.push(row.gray.origin)
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

// ---- PL3 (fase plugin): la tabella «Collegati» (tavola 10) ----

/** Il filtro per strada della tabella Collegati. */
export type ConnectedFilter = 'all' | 'direct' | 'composio' | 'mac' | 'box'

/** L'uso di un plugin: ultimo uso (epoch ms) e conteggio della settimana. */
export interface PluginUse {
  last: number
  week: number
}

/** Le regole specifiche di un plugin, contate («6 sempre · 8 chiedi · 1 blocca»). */
export interface PluginPermCounts {
  always: number
  ask: number
  blocked: number
}

export interface ConnectedTableRow {
  row: YourPluginRow
  /** «N strumenti» quando NOTO, altrimenti il comando o /nome (mai inventato) */
  countLabel: string | null
  usage: PluginUse | null
  perms: PluginPermCounts | null
  /** non parte o accesso scaduto o da completare: va sistemato */
  daSistemare: boolean
}

/** Il prefisso degli strumenti del plugin nell'indice dell'uso (null: nessuno). */
export function usagePrefixOf(row: YourPluginRow): string | null {
  if (row.kind === 'server' && row.serverSlug) return `mcp__${row.serverSlug}__`
  if (row.kind === 'connector' && row.gray.strada === 'composio' && row.composioSlug) return `composio__${row.composioSlug}__`
  if (row.kind === 'skill') return `skill:${row.name}`
  return null
}

/** L'uso del plugin dall'indice (ultimo e settimana, somma dei suoi strumenti). */
export function useOfRow(summaries: ReadonlyArray<{ tool: string; last: number; week: number }>, prefix: string | null): PluginUse | null {
  if (!prefix) return null
  let last = -1
  let week = 0
  for (const s of summaries) {
    if (!s.tool.startsWith(prefix)) continue
    if (s.last > last) last = s.last
    week += s.week
  }
  return last < 0 ? null : { last, week }
}

/** Le regole specifiche del plugin, contate per modo (null: nessuna regola specifica). */
export function permCountsOf(perms: PermissionsConfig | null, prefix: string | null): PluginPermCounts | null {
  if (!perms || !prefix) return null
  let always = 0
  let ask = 0
  let blocked = 0
  for (const r of perms.rules) {
    if (r.pattern !== '*' || !r.tool.startsWith(prefix)) continue
    if (r.mode === 'always_allow') always++
    else if (r.mode === 'blocked') blocked++
    else ask++
  }
  return always + ask + blocked === 0 ? null : { always, ask, blocked }
}

/**
 * PURA (PL3): le righe della tabella «Collegati» — ogni collegamento con la
 * sua strada (badge), l'account onesto, lo stato con l'azione, i permessi in
 * breve (le regole specifiche scritte), i bot e l'ultimo uso con il conteggio
 * della settimana dall'INDICE (mai dai transcript). `daSistemare` raccoglie
 * quelli che non partono o hanno l'accesso scaduto.
 */
export function connectedTable(input: {
  rows: YourPluginRow[]
  usage: ReadonlyArray<{ tool: string; last: number; week: number }>
  perms: PermissionsConfig | null
  filter: ConnectedFilter
  onlyDaSistemare: boolean
}): ConnectedTableRow[] {
  const stradaOfFilter = (f: ConnectedFilter, row: YourPluginRow): boolean => {
    if (f === 'all') return true
    if (f === 'direct') return row.gray.strada === 'direct' || row.gray.strada === 'gateway' || row.gray.strada === 'registry'
    if (f === 'composio') return row.gray.strada === 'composio'
    if (f === 'mac') return row.gray.strada === 'mac'
    return row.gray.strada === 'box-npm'
  }
  const out: ConnectedTableRow[] = []
  for (const row of input.rows) {
    if (!stradaOfFilter(input.filter, row)) continue
    const daSistemare = row.state === 'broken' || row.state === 'expired' || row.state === 'invalid'
    if (input.onlyDaSistemare && !daSistemare) continue
    out.push({
      row,
      countLabel: row.kind === 'skill' ? `/${row.name}` : row.countLabel ?? null,
      usage: useOfRow(input.usage, usagePrefixOf(row)),
      perms: permCountsOf(input.perms, usagePrefixOf(row)),
      daSistemare
    })
  }
  return out
}

/** Quanti collegati vanno sistemati (non partono o accesso scaduto). */
export function daSistemareCount(rows: ReadonlyArray<YourPluginRow>): number {
  return rows.filter((r) => r.state === 'broken' || r.state === 'expired' || r.state === 'invalid').length
}
