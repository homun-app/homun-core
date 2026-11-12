// B4 (fase beta.4): il bot sa quali app ha collegate. Nel turno di Trello
// dell'utente il bot ha fatto 8 passi a vuoto (skill inesistente, memory,
// search_connectors per un connettore nuovo pur avendo Composio,
// list-credentials, cronologia): nel prompt NON c'era nessuna riga che
// dicesse quali app sono collegate. Rakazo ogni turno scrive «Connected
// plugins: … Prefer those plugin tools over the computer browser or web
// search when reading app data» (packages/adapters/src/executor.ts).
// Qui la riga si costruisce dallo stato locale del gateway Composio (le app
// collegate di C5) e dai server MCP attivi del bot; sta nella PARTE CHE
// CAMBIA del system prompt (mai nel prefisso in cache). Tutto PURO.
import type { ToolDef } from './llm'

/** Quanti nomi al massimo nella riga; poi «and N more». */
export const CONNECTED_APPS_MAX_NAMES = 20

/** Un account collegato di un'app Composio, come serve alla riga (CA3). */
export interface ConnectedAppAccountFacts {
  alias?: string
  email?: string
}

/** Un'app Composio collegata: nome umano e account ATTIVI (CA3). */
export interface ConnectedAppFacts {
  name: string
  accounts: readonly ConnectedAppAccountFacts[]
}

/** I fatti della riga: le app Composio collegate e i server MCP attivi del bot. */
export interface ConnectedAppsFacts {
  /** le app collegate tramite Composio (nome umano, stato ACTIVE del gateway) */
  composioApps: readonly ConnectedAppFacts[]
  /** i server MCP attivi del bot (nome), escluso il trasporto Composio */
  mcpServers: readonly string[]
}

/** L'account in breve: «lavoro (fabio@…)» o l'alias o l'email da sola. */
function accountBrief(a: ConnectedAppAccountFacts): string {
  if (a.alias && a.email) return `${a.alias} (${a.email})`
  return a.alias ?? a.email ?? ''
}

/**
 * La descrizione di UN'app nella riga (PURa): con un solo account l'EMAIL
 * («quale casella ho collegato?» trova risposta), con più account l'elenco
 * «alias (email)» e la regola `account` esplicita; oltre i 3 account i primi
 * 3 più «and N more».
 */
export function connectedAppPhrase(app: ConnectedAppFacts): string {
  if (app.accounts.length === 0) return app.name
  if (app.accounts.length === 1) {
    const brief = accountBrief(app.accounts[0]!)
    return brief ? `${app.name} — ${brief}` : app.name
  }
  const MAX_SHOWN = 3
  const shown = app.accounts.slice(0, MAX_SHOWN).map(accountBrief).filter(Boolean)
  const over = app.accounts.length - MAX_SHOWN
  const list = shown.join(', ') + (over > 0 ? `, and ${over} more` : '')
  return `${app.name} — accounts: ${list}; pass \`account\` in every MULTI_EXECUTE item for ${app.name}`
}

/**
 * La riga del prompt (PURA, inglese come tutto il prompt): vuota senza app
 * né server. Come pluginLine di Rakazo, dice di PREFERIRE questi strumenti
 * per i dati di quelle app — non la cronologia, la memoria, il browser o un
 * connettore nuovo. CA3: ogni app porta i SUOI account (l'email con un
 * account solo, l'elenco e la regola `account` con più di uno). Il tetto di
 * 20 nomi vale PER LA RIGA e CONTA LE APP (prima le app poi i server); lo
 * sforamento si dice UNA volta, in coda all'ultimo elenco.
 */
export function connectedAppsLine(facts: ConnectedAppsFacts): string {
  if (!facts.composioApps.length && !facts.mcpServers.length) return ''
  const appsShown = facts.composioApps.slice(0, CONNECTED_APPS_MAX_NAMES)
  const serversShown = facts.mcpServers.slice(0, Math.max(0, CONNECTED_APPS_MAX_NAMES - appsShown.length))
  const over = facts.composioApps.length + facts.mcpServers.length - appsShown.length - serversShown.length
  let appsPart = appsShown.map(connectedAppPhrase).join('; ')
  let serversNames = serversShown.join(', ')
  if (over > 0) {
    const tail = `, and ${over} more`
    if (serversNames) serversNames += tail
    else appsPart += tail
  }
  const parts: string[] = []
  if (appsPart) {
    parts.push(`Connected apps (via Composio: COMPOSIO_SEARCH_TOOLS to find the action, then COMPOSIO_MULTI_EXECUTE_TOOL): ${appsPart}`)
  }
  if (serversNames) {
    parts.push(`MCP servers: ${serversNames}`)
  }
  return `${parts.join('; ')}. To read or change these apps' data use these tools: not history, memory, the browser or a new connector.`
}

/** Un'app collegata con i suoi account, come serve al prefisso di search_connectors. */
export interface ConnectedAppWithAccounts extends ConnectedAppRef {
  accounts: readonly ConnectedAppAccountFacts[]
}

/**
 * CA3 punto 2 (PURa): il prefisso che il risultato di `search_connectors`
 * COMINCIA con l'elenco di ciò che è GIÀ collegato — «Already connected via
 * Composio: Gmail (lavoro: …, personale: …), Trello. Use those for their
 * data; the results below are apps NOT connected yet.» — vale anche se la
 * query non nomina un'app («email», «posta», «calendario»).
 */
export function alreadyConnectedPrefix(apps: readonly ConnectedAppWithAccounts[]): string {
  const names = apps.map((app) => {
    if (app.accounts.length === 0) return app.name
    if (app.accounts.length === 1) {
      const a = app.accounts[0]!
      const brief = a.alias && a.email ? `${a.alias}: ${a.email}` : (a.alias ?? a.email ?? '')
      return brief ? `${app.name} (${brief})` : app.name
    }
    const list = app.accounts.map((a) => (a.alias && a.email ? `${a.alias}: ${a.email}` : (a.alias ?? a.email ?? ''))).filter(Boolean).join(', ')
    return list ? `${app.name} (${list})` : app.name
  })
  return `Already connected via Composio: ${names.join(', ')}. Use those for their data; the results below are apps NOT connected yet.`
}

/**
 * CA3 punto 2 (PURa): il caso B4 — la query NOMINA un'app collegata — resta
 * com'era, ma ORA con gli account: «"Gmail" is already connected via
 * Composio (accounts: lavoro (…), personale (…)): use COMPOSIO_SEARCH_TOOLS
 * …». Con un account solo l'email fra parentesi.
 */
export function connectedAppHitMessage(app: ConnectedAppWithAccounts): string {
  let brief = ''
  if (app.accounts.length === 1) {
    const a = app.accounts[0]!
    brief = a.alias && a.email ? `${a.alias} (${a.email})` : (a.alias ?? a.email ?? '')
  } else if (app.accounts.length > 1) {
    brief = `accounts: ${app.accounts.map(accountBrief).filter(Boolean).join(', ')}`
  }
  const inParens = brief ? ` (${brief})` : ''
  return `"${app.name}" is already connected via Composio${inParens}: use COMPOSIO_SEARCH_TOOLS to find the action, then COMPOSIO_MULTI_EXECUTE_TOOL.`
}

/** Un'app collegata (dal gateway Composio). */
export interface ConnectedAppRef {
  slug: string
  name: string
}

/**
 * BC4 (fase beta.4 — correzioni): il confronto su PAROLE INTERE (PURA). Il
 * nome o lo slug deve apparire nella query come PAROLA a sé: i confini sono
 * Unicode (qualsiasi cosa non sia lettera o numero), maiuscole irrilevanti.
 * Così «le board di trello» nomina Trello, ma «dropbox» NON nomina «Box»
 * (box sta DENTRO la parola dropbox) e «calendar» da solo non nomina
 * «Google Calendar».
 */
function wholeWordIn(query: string, needle: string): boolean {
  if (!needle) return false
  // il needle si escapa: i nomi possono portare punti, trattini, ecc.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(query)
}

/**
 * L'app già collegata che la query di search_connectors nomina (PURA):
 * nome o slug, su PAROLE INTERE (confine Unicode, maiuscole irrilevanti),
 * anche DENTRO la query («le board di trello»). Null se la query non nomina
 * nessuna app collegata. Generica: chi passa gli account (CA3) li riottiene.
 */
export function connectedAppMatch<T extends ConnectedAppRef>(query: string, connected: readonly T[]): T | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  for (const app of connected) {
    const slug = app.slug.toLowerCase()
    const name = app.name.trim().toLowerCase()
    if (!name) continue
    if (wholeWordIn(q, slug) || wholeWordIn(q, name)) return app
  }
  return null
}

/**
 * I server MCP attivi del bot SENZA il trasporto Composio (le sue app sono
 * già nella riga come app collegate): si escludono i nomi che sono app del
 * gateway o server Composio. PURO rispetto agli input.
 */
export function mcpServerNames(
  servers: ReadonlyArray<{ name: string; tools: ReadonlyArray<ToolDef | { name: string }> }>,
  composioAppNames: readonly string[]
): string[] {
  const apps = new Set(composioAppNames.map((n) => n.trim().toLowerCase()))
  return servers
    .map((s) => s.name)
    .filter((name) => {
      const n = name.trim().toLowerCase()
      if (n === 'composio') return false
      return !apps.has(n)
    })
}
