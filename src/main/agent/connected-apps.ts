// B4 (fase beta.4): il bot sa quali app ha collegate. Nel turno di Trello
// dell'utente il bot ha fatto 8 passi a vuoto (skill inesistente, memory,
// search_connectors per un connettore nuovo pur avendo Composio,
// list-credentials, cronologia): nel prompt NON c'era nessuna riga che
// dicesse quali app sono collegate. Rakazo ogni turno scrive «Connected
// plugins: … Prefer those plugin tools over the computer browser or web
// search when reading app data» (packages/adapters/src/executor.ts).
// V1 (fase stato-vivo): la riga B4 e la sezione U5 dei server sono diventate
// l'UNICO blocco «Collegamenti ora», ricalcolato a OGNI turno dallo stato
// locale del gateway Composio e dai server MCP del bot (funzionanti E non
// parti); sta nella PARTE CHE CAMBIA del system prompt (mai nel prefisso in
// cache) e VALE PIÙ dei riassunti. Tutto PURO.
import { mcpErrorCategoryText } from '../mcp/error-category'
import type { McpErrorCategory } from '../mcp/error-category'

/**
 * V1 (fase stato-vivo): il tetto (token caratteri/4) del blocco
 * «Collegamenti ora» del prompt, MISURATO sul caso pieno (8 server
 * funzionanti + 4 non parti + 6 app Composio multi-account + le due regole:
 * 487 token): mai alzarlo per far passare un test — il numero sta nel REPORT
 * della fase.
 */
export const CONNECTIONS_NOW_TOKEN_BUDGET = 490

/** V1: quanti server funzionanti al massimo nell'elenco; poi «and N more». */
export const CONNECTIONS_NOW_MAX_SERVERS = 8

/** V1: quanti server NON PARTI al massimo nell'elenco; il resto si conta. */
export const CONNECTIONS_NOW_MAX_FAILING = 4

/** V1: quante app Composio al massimo sulla riga (poi «and N more»): le altre restano in find_tools. */
export const CONNECTIONS_NOW_MAX_APPS = 6

/** Un server che non parte, come serve al blocco: nome + categoria X2 dell'ultima prova. */
export interface FailingServerFacts {
  name: string
  category: McpErrorCategory
}

/** I fatti del blocco «Collegamenti ora»: ricalcolati a ogni turno. */
export interface ConnectionsNowFacts {
  /** i server MCP funzionanti del bot (nome + numero di strumenti) */
  working: ReadonlyArray<{ name: string; toolCount: number }>
  /** i server ACCESI che non partono, con la categoria X2 dell'ultima prova */
  failing: readonly FailingServerFacts[]
  /** le app Composio attive (nome umano + account ATTIVI, CA3) */
  composioApps: readonly ConnectedAppFacts[]
}

/**
 * V1 (fase stato-vivo): il blocco «Collegamenti ora» — i server MCP
 * funzionanti (nome + strumenti), quelli ACCESI che non partono (categoria X2,
 * frase fissa: mai il testo libero dell'errore) e le app Composio attive con
 * i loro account. Con la REGOLA che manca nella chat del 21/11: questo blocco
 * è la verità CORRENTE di tool e collegamenti — se un riassunto o un
 * messaggio precedente dice altro (per esempio «non hai accesso a X»), vince
 * il blocco. PURA: vuota senza nulla; sta nella parte VARIABILE del system
 * prompt (mai nel prefisso in cache), sotto il tetto misurato
 * CONNECTIONS_NOW_TOKEN_BUDGET.
 */
export function connectionsNowSection(facts: ConnectionsNowFacts): string {
  const appsSet = new Set(facts.composioApps.map((a) => a.name.trim().toLowerCase()))
  // i server il cui nome è un'app del gateway Composio non si duplicano:
  // l'app è già nella riga Composio (come mcpServerNames di B4)
  const working = facts.working.filter((s) => {
    const n = s.name.trim().toLowerCase()
    return n !== 'composio' && !appsSet.has(n)
  })
  if (!working.length && !facts.failing.length && !facts.composioApps.length) return ''
  const lines: string[] = []
  const shown = working.slice(0, CONNECTIONS_NOW_MAX_SERVERS)
  for (const s of shown) lines.push(`- ${s.name}: ${s.toolCount} tools`)
  const overWorking = working.length - shown.length
  if (overWorking > 0) lines.push(`- and ${overWorking} more`)
  const failShown = facts.failing.slice(0, CONNECTIONS_NOW_MAX_FAILING)
  for (const s of failShown) lines.push(`- ${s.name}: does not start (${mcpErrorCategoryText(s.category)})`)
  const overFailing = facts.failing.length - failShown.length
  if (overFailing > 0) lines.push(`- and ${overFailing} more do not start`)
  if (facts.composioApps.length) {
    const appsShown = facts.composioApps.slice(0, CONNECTIONS_NOW_MAX_APPS)
    const overApps = facts.composioApps.length - appsShown.length
    const list = appsShown.map(connectedAppPhrase).join('; ') + (overApps > 0 ? `, and ${overApps} more` : '')
    lines.push(`- Composio: ${list}`)
  }
  return [
    '# Connections now',
    ...lines,
    'This block is the current truth about your tools and connections. If a summary or an earlier message says otherwise, this block wins.',
    'For a service in this list use its tools FIRST — find_tools({query: "<server or service name>"}) for its MCP server, COMPOSIO_SEARCH_TOOLS then COMPOSIO_MULTI_EXECUTE_TOOL for a Composio app — not history, memory, the browser, web_fetch, curl or a new connector. Never curl or run-command from the isolated computer.'
  ].join('\n')
}

/** Un account collegato di un'app Composio, come serve alla riga (CA3). */
export interface ConnectedAppAccountFacts {
  alias?: string
  email?: string
  /** BR4 (fase box-rete): l'id dell'account — l'unico nome che Composio ACCETTA in `account` quando l'alias non c'è. */
  accountId?: string
}

/** Un'app Composio collegata: nome umano e account ATTIVI (CA3). */
export interface ConnectedAppFacts {
  name: string
  accounts: readonly ConnectedAppAccountFacts[]
}

/**
 * L'account in breve: «lavoro (fabio@…)» o l'alias o l'email da sola; BR4:
 * senza alias E senza email, il suo accountId (l'ultimo ripiego buono).
 */
function accountBrief(a: ConnectedAppAccountFacts): string {
  if (a.alias && a.email) return `${a.alias} (${a.email})`
  return a.alias ?? a.email ?? a.accountId ?? ''
}

/**
 * L'account come lo deve NOMINARE il modello quando serve `account` (BR4):
 * alias se c'è, ALTRIMENTI l'accountId — che Composio accetta — e solo per
 * ultimo l'email (informazione per l'utente, non un nome che Composio
 * conosce). Mai «account N»: è un nome nostro, Composio non lo sa.
 */
function accountRefBrief(a: ConnectedAppAccountFacts): string {
  if (a.alias) return a.email ? `${a.alias} (${a.email})` : a.alias
  return a.accountId ?? a.email ?? ''
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
  // BR4: nell'elenco multiplo conta il nome che \`account\` ACCETTA — per un
  // account senza alias è il suo accountId
  const shown = app.accounts.slice(0, MAX_SHOWN).map(accountRefBrief).filter(Boolean)
  const over = app.accounts.length - MAX_SHOWN
  const list = shown.join(', ') + (over > 0 ? `, and ${over} more` : '')
  return `${app.name} — accounts: ${list}; pass \`account\` in every MULTI_EXECUTE item for ${app.name}`
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
    // BR4: senza alias il nome è l'accountId (l'email resta annotata dopo «:»)
    const item = (a: ConnectedAppAccountFacts): string => {
      if (a.alias && a.email) return `${a.alias}: ${a.email}`
      if (a.alias) return a.alias
      if (a.accountId) return a.email ? `${a.accountId}: ${a.email}` : a.accountId
      return a.email ?? ''
    }
    if (app.accounts.length === 1) {
      const brief = item(app.accounts[0]!)
      return brief ? `${app.name} (${brief})` : app.name
    }
    const list = app.accounts.map(item).filter(Boolean).join(', ')
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
    brief = accountBrief(app.accounts[0]!)
  } else if (app.accounts.length > 1) {
    // BR4: i nomi dell'elenco sono quelli che \`account\` accetta
    brief = `accounts: ${app.accounts.map(accountRefBrief).filter(Boolean).join(', ')}`
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
