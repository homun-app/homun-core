// Fase Composio OAuth (C2): il blocco di Composio si giudica AZIONE PER
// AZIONE. Sul modello di Rakazo: packages/adapters/src/composio-batch.ts
// (composioToolBatch), packages/core/src/action-approval.ts:455–477
// (batchActions) e 482+ (resolveActionApprovalForTools), qui adattati al
// server MCP «For You»: COMPOSIO_MULTI_EXECUTE_TOOL esegue fino a 50 azioni
// in parallelo, ognuna nominata in tools[].tool_slug con i suoi arguments —
// RICONOSCIUTO PER NOME su qualunque server MCP lo esponga (come Rakazo,
// remote-mcp.ts:95–104 e mcp-connector.ts:517), non solo sul server di
// Composio collegato da Homun.
//
// Regole del gate (Rakazo, run-tool-gate.ts:150–300): regole e controllo
// lettura/scrittura sulle AZIONI, mai sullo strumento del blocco. Lo
// strumento del blocco dichiarato in scrittura (readOnlyHint false, come
// dichiara il server) rende tutte le azioni scritture? NO: le annotazioni
// del server sullo strumento del blocco non si usano per il blocco (C2
// punto 4) — lo giudicano le azioni col classificatore dei nomi
// (composio-actions.ts, regola di Rakazo action-approval.ts:79–113).
//
// Modulo PURO: nessuna dipendenza dal daemon, testabile in nodo puro.
import { classifyComposioToolName, composioActionOfToolName, composioSendLikeName, redactComposioSecrets, stripToolkitPrefix } from './composio-actions'
import { composioToolkitName } from './composio-meta'
// K6 (ritocchi): composioToolkitOfSlug vive in shared (lo usa anche il renderer)
import { composioToolkitOfSlug, localizedActionName, localizedConnectionsAction, localizedProxyRequestAction } from '../../shared/composio-names'

/** Lo strumento del blocco di Composio (nome originale, su qualunque server MCP). */
export const COMPOSIO_MULTI_EXECUTE_TOOL = 'COMPOSIO_MULTI_EXECUTE_TOOL'

/** La forma del blocco (come ToolBatch di Rakazo, più il campo account). */
export interface ComposioBatchShape {
  items: 'tools'
  action: 'tool_slug'
  arguments: 'arguments'
  account: 'account'
}

/** La forma del blocco, riconosciuta PER NOME su qualunque server MCP. */
export function toolBatchOf(originalToolName: string): ComposioBatchShape | undefined {
  return originalToolName === COMPOSIO_MULTI_EXECUTE_TOOL
    ? { items: 'tools', action: 'tool_slug', arguments: 'arguments', account: 'account' }
    : undefined
}

/** Una voce del blocco: slug, argomenti (sempre oggetto) e account opzionale. */
export interface ComposioBatchItem {
  slug: string
  arguments: Record<string, unknown>
  account?: string
}

/** Le azioni di una chiamata al blocco (batchActions di Rakazo + le voci). */
export interface ComposioBatchActions {
  /** gli slug DISTINCT nell'ordine della chiamata */
  actions: string[]
  /** le voci nell'ordine della chiamata (arguments sempre oggetto) */
  items: ComposioBatchItem[]
  /**
   * false se `tools` manca o è vuoto, o se una voce non ha un tool_slug
   * stringa non vuota (batchActions di Rakazo): niente da mostrare, la
   * chiamata chiede SEMPRE.
   */
  complete: boolean
}

/** Gli argomenti di una voce, come oggetto o stringa JSON (objectArguments di Rakazo). */
export function objectArguments(value: unknown): Record<string, unknown> {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

/**
 * Le azioni di una chiamata al blocco: `actions` sono gli slug distinti,
 * `items` le voci nell'ordine (con gli argomenti già oggetto). `complete`
 * è false quando una voce non nomina un'azione o il blocco è vuoto (Rakazo
 * batchActions:455–477) → la chiamata chiede sempre.
 */
export function batchActions(shape: ComposioBatchShape, args: unknown): ComposioBatchActions {
  const items = args && typeof args === 'object' ? (args as Record<string, unknown>)[shape.items] : undefined
  if (!Array.isArray(items)) return { actions: [], items: [], complete: false }
  const actions = new Set<string>()
  const out: ComposioBatchItem[] = []
  let complete = items.length > 0
  for (const item of items) {
    const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const slug = entry[shape.action]
    if (typeof slug === 'string' && slug.trim()) {
      const trimmed = slug.trim()
      actions.add(trimmed)
      const account = entry[shape.account]
      out.push({
        slug: trimmed,
        arguments: objectArguments(entry[shape.arguments]),
        ...(typeof account === 'string' && account.trim() ? { account: account.trim() } : {})
      })
    } else {
      complete = false
      out.push({ slug: '', arguments: objectArguments(entry[shape.arguments]) })
    }
  }
  return { actions: [...actions], items: out, complete }
}

// ---- il toolkit di un'azione e la severità del blocco (C2 punto 1–2) ----

/**
 * Il toolkit di uno slug d'azione (A6 punto 1 / C2): il prefisso più lungo
 * fra gli slug noti (i toolkit collegati + la tabella dei comuni),
 * altrimenti il primo segmento. Il prefisso si TOGLIE prima di classificare
 * (GMAIL_SEND_EMAIL → SEND_EMAIL); sugli slug interi i pattern valgono
 * comunque (SEND_EMAIL contiene «send» con o senza GMAIL_). Da K6 dei
 * ritocchi l'implementazione sta in shared/composio-names.ts (la usa anche
 * il renderer) e qui si riesporta.
 */
export { composioToolkitOfSlug }

/** La classificazione di una voce del blocco: sullo slug SENZA il prefisso del toolkit. */
export function classifyBatchAction(slug: string, connectedSlugs: readonly string[] = []): 'read' | 'send' | 'write' | 'destructive' {
  const toolkit = composioToolkitOfSlug(slug, connectedSlugs)
  return classifyComposioToolName(stripToolkitPrefix(toolkit, slug))
}

/** La severità del blocco (C2 punto 2): decide l'azione PIÙ severa. */
export type ComposioBatchSeverity = 'read' | 'send' | 'write' | 'destructive'

const SEVERITY_ORDER: Record<ComposioBatchSeverity, number> = { read: 0, send: 1, write: 2, destructive: 3 }

/**
 * Decide l'azione più severa (Rakazo resolveActionApprovalForTools:482+):
 * destructive > write > send > read. Un'azione consentita non si porta dietro le altre. Il «send» resta sotto write: le voci d'invio escono dal
 * blocco e diventano bozze PRIMA del gate (C7 punto 3); se una resta
 * (bozza già in attesa), il blocco chiede come una scrittura.
 */
export function batchSeverity(kinds: readonly (ComposioBatchSeverity | 'connect')[]): ComposioBatchSeverity {
  return kinds.reduce<ComposioBatchSeverity>(
    (worst, k) => {
      const severity: ComposioBatchSeverity = k === 'connect' ? 'write' : k
      return SEVERITY_ORDER[severity] > SEVERITY_ORDER[worst] ? severity : worst
    },
    'read'
  )
}

/** La severità di una chiamata al blocco dalle sue azioni (fail closed: lista vuota → write). */
export function batchSeverityOfActions(actions: readonly string[], connectedSlugs: readonly string[] = []): ComposioBatchSeverity {
  if (actions.length === 0) return 'write'
  return batchSeverity(actions.map((slug) => classifyBatchAction(slug, connectedSlugs) as ComposioBatchSeverity))
}

// ---- i consensi per azione (C2 punto 3) ----

/** La chiave di regola/grant di un'azione del blocco: mai per lo strumento del blocco. */
export function composioActionKey(slug: string): string {
  return `composio-action:${slug.trim().toUpperCase()}`
}

// ---- sync_response_to_workbench (C3) ----

/**
 * Il server richiede `sync_response_to_workbench` nello schema (required),
 * ma la workbench NON è offerta al modello (C3): il file salvato là non
 * servirebbe al bot. Si forza SEMPRE false negli argomenti prima del gate e
 * dell'esecuzione, così anche la card mostra ciò che verrà davvero eseguito.
 */
export function forceSyncResponseToWorkbenchOff(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, sync_response_to_workbench: false }
}

// ---- la risposta «salvata nella workbench» (V3 della prova vera) ----

/**
 * V3 (grave, dalla prova vera): anche con sync_response_to_workbench false,
 * per una risposta grande Composio restituisce solo un'anteprima
 * (data_preview, structure_info), il percorso di un file REMOTO e un
 * next_steps che dice di scrivere codice per leggere il file salvato — e il
 * bot è andato a cercare il file SUL MAC dell'utente. La workbench non è
 * offerta (C3): la nota fissa dice al modello che il file è remoto, che non
 * sta su questo computer e di NON cercarlo mai in locale.
 */
export const WORKBENCH_SPILL_NOTE =
  "The full response was stored in Composio's remote workbench, which is not available in Homun and is not on this computer: never search for it locally. Use the preview above, or call the action again asking for less data (for example fewer results, metadata only, or a narrower query)."

/** Un campo stringa è un percorso di file remoto della workbench? */
function isRemoteFilePath(key: string, value: string): boolean {
  if (!value.startsWith('/')) return false
  return /(?:file|path|response)/i.test(key) || /\/workbench\//i.test(value)
}

/** Un nodo del risultato è «salvato nella workbench»? (anteprima, struttura, file remoto o next_steps che parla di codice) */
function isWorkbenchSpillNode(record: Record<string, unknown>): boolean {
  if ('data_preview' in record || 'structure_info' in record) return true
  const nextSteps = typeof record.next_steps === 'string' ? record.next_steps : ''
  if (nextSteps && /\b(code|parse|saved|workbench|file)\b/i.test(nextSteps)) return true
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && isRemoteFilePath(key, value)) return true
  }
  return false
}

/**
 * V3: riconosce una risposta «salvata nella workbench» e la PULISCE per il
 * modello: tolti next_steps, structure_info e i percorsi di file remoti
 * (le istruzioni sul codice e sui file), tenuta l'anteprima (data_preview),
 * e in coda la nota fissa WORKBENCH_SPILL_NOTE. Null per una risposta
 * normale: il chiamante mantiene il testo identico.
 */
export function workbenchSpillOf(output: string): string | null {
  let root: unknown
  try {
    root = JSON.parse(output)
  } catch {
    return null
  }
  let spilled = false
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean)
    if (!node || typeof node !== 'object') return node
    const record = node as Record<string, unknown>
    const spill = isWorkbenchSpillNode(record)
    if (spill) spilled = true
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      // tolto dal testo per il modello: le istruzioni sul codice e sui file
      if (spill && (key === 'next_steps' || key === 'structure_info')) continue
      if (spill && typeof value === 'string' && isRemoteFilePath(key, value)) continue
      out[key] = clean(value)
    }
    return out
  }
  const cleaned = clean(root)
  if (!spilled) return null
  return `${JSON.stringify(cleaned)}\n${WORKBENCH_SPILL_NOTE}`
}

// ---- gli errori del blocco (C7 punto 4) ----

/**
 * COMPOSIO_MULTI_EXECUTE_TOOL riporta un blocco fallito come «N out of M
 * tools failed» e mette l'errore VERO di ogni azione in `data.results`
 * (Rakazo composio-connector.ts:1033–1060, composioResultError): si
 * tengono, troncati a 500 caratteri e al massimo 5, ripuliti dai segreti —
 * altrimenti il modello non distingue «messaggio non trovato» da
 * un'integrazione rotta.
 */
export function composioResultError(summary: string, data: unknown): string {
  const results = (data as { results?: unknown } | null | undefined)?.results
  if (!Array.isArray(results)) return summary
  const details = results.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as {
      tool_slug?: unknown
      error?: unknown
      response?: { error?: unknown } | null
    }
    const error = [item.error, item.response?.error].find(
      (value): value is string => typeof value === 'string' && value.length > 0
    )
    if (!error) return []
    const redacted = redactComposioSecrets(error)
    const detail = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted
    return [typeof item.tool_slug === 'string' ? `${item.tool_slug}: ${detail}` : detail]
  })
  if (details.length === 0) return summary
  const shown = details.slice(0, 5)
  const more = details.length - shown.length
  return `${summary}: ${shown.join('; ')}${more > 0 ? `; +${more} more` : ''}`
}

/** Cerca in un risultato MCP del blocco il campo data (JSON) per composioResultError. */
export function batchResultData(output: string): unknown {
  try {
    const parsed = JSON.parse(output) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      return record.data ?? record
    }
    return parsed
  } catch {
    return undefined
  }
}

// ---- i segreti in ogni foglia (C7 punto 1) ----

/**
 * Maschera i segreti in OGNI FOGLIA del valore (redactLeaves di Rakazo,
 * approval-ask.ts:308–317): l'escaping JSON potrebbe nascondere un segreto
 * alla redazione del solo testo pianeggiante.
 */
export function redactBatchLeaves<T>(value: T): T {
  if (typeof value === 'string') return redactComposioSecrets(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => redactBatchLeaves(item)) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, item]) => [k, redactBatchLeaves(item)])
    ) as unknown as T
  }
  return value
}

/**
 * Le voci del blocco per la CARD (C7 punto 1): argomenti brevi prima e testi
 * lunghi dopo (argumentLines di Rakazo, approval-ask.ts:281–297), i segreti
 * mascherati in ogni foglia, l'account quando c'è. «…» per una voce senza
 * nome (complete false).
 */
export const BATCH_ARGUMENT_SHORT_LENGTH = 200

/** Le righe degli argomenti di una voce: `first` i valori brevi (e i
 *  strutturati), `last` i testi lunghi, così i destinatari vengono prima. */
export function batchArgumentLines(values: Record<string, unknown>): { first: Array<[string, string]>; last: Array<[string, string]> } {
  const first: Array<[string, string]> = []
  const last: Array<[string, string]> = []
  for (const [key, raw] of Object.entries(values)) {
    const text = batchArgumentText(raw)
    if (!text) continue
    const line: [string, string] = [key, text]
    if (text.length <= BATCH_ARGUMENT_SHORT_LENGTH) first.push(line)
    else last.push(line)
  }
  return { first, last }
}

function batchArgumentText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')) {
    return value.map(String).join(', ')
  }
  return JSON.stringify(value) ?? ''
}

// ---- il titolo del blocco dalla lingua della UI (C7 punto 1) ----

/**
 * Il nome dell'azione del blocco localizzato con localizedActionName (shared/
 * composio-names.ts): «Invia email» in italiano, il nome originale in inglese.
 * Lo slug arriva COME LO MANDA IL SERVER (GMAIL_SEND_EMAIL): bareActionSlug
 * di composio-names sa togliere il prefisso del toolkit.
 */
export function localizedBatchActionName(slug: string, uiLang: 'it' | 'en', fallback?: string): string {
  return localizedActionName(slug, uiLang) ?? fallback ?? slug
}

/** Il nome del toolkit di uno slug per la card: nome umano se noto, altrimenti lo slug. */
export function batchAppLabel(slug: string, connectedSlugs: readonly string[] = []): string {
  return composioToolkitName(composioToolkitOfSlug(slug, connectedSlugs))
}

// ---- il riconoscimento degli invii dentro il blocco (C7 punto 3) ----

/** La voce del blocco è un invio? (composioSendLikeName sullo slug senza prefisso). */
export function batchItemIsSend(item: ComposioBatchItem, connectedSlugs: readonly string[] = []): boolean {
  const toolkit = composioToolkitOfSlug(item.slug, connectedSlugs)
  return composioSendLikeName(stripToolkitPrefix(toolkit, item.slug))
}

/**
 * C7 punto 3: le voci d'invio ESCONO dal blocco e diventano una bozza
 * ciascuna; le altre restano e passano dal gate C2. Il risultato dice al
 * modello quali azioni sono diventate bozze.
 */
export function extractBatchSends(
  args: Record<string, unknown>,
  connectedSlugs: readonly string[] = []
): { sends: ComposioBatchItem[]; rest: ComposioBatchItem[]; restArgs: Record<string, unknown> | null } {
  const shape = toolBatchOf(COMPOSIO_MULTI_EXECUTE_TOOL)!
  const parsed = batchActions(shape, args)
  const sends: ComposioBatchItem[] = []
  const rest: ComposioBatchItem[] = []
  for (const item of parsed.items) {
    if (item.slug && batchItemIsSend(item, connectedSlugs)) sends.push(item)
    else if (item.slug) rest.push(item)
    // le voci SENZA slug non sono invii: restano nel blocco (complete false → card)
    else rest.push(item)
  }
  if (sends.length === 0) return { sends, rest, restArgs: null }
  const restArgs: Record<string, unknown> = {
    ...args,
    tools: rest.map((item) => ({
      tool_slug: item.slug,
      arguments: item.arguments,
      ...(item.account ? { account: item.account } : {})
    })),
    sync_response_to_workbench: false
  }
  return { sends, rest, restArgs }
}

/** La via della bozza di una voce d'invio: lo STESSO strumento del blocco con UNA sola voce. */
export function batchSendViaArgs(item: ComposioBatchItem): Record<string, unknown> {
  return {
    tools: [{ tool_slug: item.slug, arguments: item.arguments, ...(item.account ? { account: item.account } : {}) }],
    sync_response_to_workbench: false
  }
}

// ---- COMPOSIO_MANAGE_CONNECTIONS (C5) ----

/** Il modo di una voce di toolkits[] di COMPOSIO_MANAGE_CONNECTIONS. */
export type ComposioConnectionEntryKind = 'read' | 'connect' | 'write' | 'destructive'

/** Le voci di toolkits[] di una chiamata a COMPOSIO_MANAGE_CONNECTIONS (tolerante). */
export function manageConnectionsEntries(
  args: Record<string, unknown>
): Array<{ name: string; action: 'add' | 'rename' | 'list' | 'remove'; account_id?: string; alias?: string; named: boolean }> {
  const toolkits = args.toolkits
  if (!Array.isArray(toolkits)) return []
  return toolkits.map((raw) => {
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const name = entry.name
    const action = entry.action
    const account = entry.account_id
    const alias = entry.alias
    return {
      name: typeof name === 'string' && name.trim() ? name.trim() : '',
      action: action === 'rename' || action === 'list' || action === 'remove' ? action : 'add',
      ...(typeof account === 'string' && account.trim() ? { account_id: account.trim() } : {}),
      ...(typeof alias === 'string' && alias.trim() ? { alias: alias.trim() } : {}),
      named: typeof name === 'string' && !!name.trim()
    }
  })
}

/** Il modo di una voce di toolkits[] (C5 punto 1: list lettura, add card di collegamento, rename card, remove distruttiva). */
export function manageConnectionsEntryKind(action: 'add' | 'rename' | 'list' | 'remove'): ComposioConnectionEntryKind {
  switch (action) {
    case 'list':
      return 'read'
    case 'add':
      return 'connect'
    case 'rename':
      return 'write'
    case 'remove':
      return 'destructive'
  }
}

/**
 * Il risultato tollerante di COMPOSIO_MANAGE_CONNECTIONS (C5 punto 3). V8
 * (prova vera): la forma VERA — `data.results.<toolkit>.status` con
 * `accounts[].id/status/is_default` e `user_info.email`, stati in
 * minuscolo — si legge PER PRIMA; il walk ricorsivo resta come ripiego
 * tollerante per le altre forme.
 */
export interface ParsedConnectionsAccount {
  id?: string
  status?: string
  alias?: string
  toolkit?: string
  /** la forma vera lo dice: l'account da preferire per quel toolkit */
  isDefault?: boolean
  /** l'email dell'account quando `list` la dà (user_info.email) */
  email?: string
}

export interface ParsedConnectionsResult {
  /** i link di autorizzazione trovati (redirect_url), con il toolkit vicino se c'è */
  redirectUrls: Array<{ url: string; toolkit?: string }>
  /** gli account trovati: id, stato, alias, is_default ed email quando ci sono */
  accounts: ParsedConnectionsAccount[]
  /** il session_id che il server chiede di ripassare nelle chiamate successive */
  sessionId?: string
}

/** La forma VERA di `list` (V8): data.results.<toolkit> con status e accounts[]. */
function parseRealConnectionsShape(root: unknown, out: ParsedConnectionsResult): boolean {
  const data = (root as { data?: unknown } | null | undefined)?.data
  const results = (data as { results?: unknown } | null | undefined)?.results
  if (!results || typeof results !== 'object' || Array.isArray(results)) return false
  let any = false
  for (const [toolkit, raw] of Object.entries(results as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as Record<string, unknown>
    const status = typeof v.status === 'string' ? v.status.toLowerCase() : undefined
    if (status !== undefined) any = true
    if (Array.isArray(v.accounts)) {
      for (const accRaw of v.accounts) {
        if (!accRaw || typeof accRaw !== 'object') continue
        const acc = accRaw as Record<string, unknown>
        out.accounts.push({
          toolkit,
          ...(typeof acc.id === 'string' && acc.id ? { id: acc.id } : {}),
          ...(typeof acc.status === 'string' && acc.status ? { status: acc.status.toLowerCase() } : {}),
          ...(acc.is_default === true ? { isDefault: true } : {}),
          ...(typeof (acc.user_info as { email?: unknown } | null | undefined)?.email === 'string'
            ? { email: (acc.user_info as { email: string }).email }
            : {})
        })
        any = true
      }
    }
  }
  return any
}

/** Cerca ricorsivamente le chiavi note in un JSON qualsiasi (tollerante). */
export function parseConnectionsResult(output: string): ParsedConnectionsResult {
  let root: unknown
  try {
    root = JSON.parse(output)
  } catch {
    return { redirectUrls: [], accounts: [] }
  }
  const out: ParsedConnectionsResult = { redirectUrls: [], accounts: [] }
  // V8: il session_id del workflow (data.session.id) quando c'è
  const session = (root as { data?: { session?: { id?: unknown } } } | null | undefined)?.data?.session
  if (session && typeof session.id === 'string' && session.id) out.sessionId = session.id
  // V8: la forma VERA per prima — i suoi account stanno in testa (il chiamante
  // li preferisce: is_default, email, stato in minuscolo)
  if (parseRealConnectionsShape(root, out)) {
    walkTolerant(root, out, undefined)
    return out
  }
  walkTolerant(root, out, undefined)
  return out
}

function walkTolerant(node: unknown, out: ParsedConnectionsResult, toolkitHint?: string): void {
  if (Array.isArray(node)) {
    for (const item of node) walkTolerant(item, out, toolkitHint)
    return
  }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  const toolkit =
    typeof record.toolkit === 'string'
      ? record.toolkit
      : typeof record.toolkit_slug === 'string'
        ? record.toolkit_slug
        : typeof record.name === 'string' && !('redirect_url' in record)
          ? record.name
          : toolkitHint
  for (const [key, value] of Object.entries(record)) {
    if ((key === 'redirect_url' || key === 'redirectUrl' || key === 'auth_url') && typeof value === 'string' && /^https?:\/\//.test(value)) {
      out.redirectUrls.push({ url: value, ...(toolkit ? { toolkit } : {}) })
    }
  }
  const id = typeof record.account_id === 'string' ? record.account_id : typeof record.id === 'string' && record.status !== undefined ? record.id : undefined
  const status = typeof record.status === 'string' ? record.status : undefined
  const alias = typeof record.alias === 'string' ? record.alias : undefined
  if ((id !== undefined || status !== undefined) && (toolkit !== undefined || alias !== undefined || id !== undefined)) {
    out.accounts.push({ ...(id !== undefined ? { id } : {}), ...(status !== undefined ? { status } : {}), ...(alias !== undefined ? { alias } : {}), ...(toolkit !== undefined ? { toolkit } : {}) })
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') walkTolerant(value, out, toolkit)
  }
}

/**
 * V8: gli account di un toolkit dal risultato di `list`, nell'ordine che
 * interessa al gateway: prima l'account is_default, poi gli attivi, poi il
 * resto (la forma vera li mette in testa; il ripiego tollerante segue).
 */
export function connectionsAccountsOf(parsed: ParsedConnectionsResult, toolkit: string): ParsedConnectionsAccount[] {
  const slug = toolkit.toLowerCase()
  const ofToolkit = parsed.accounts.filter((a) => (a.toolkit ?? '').toLowerCase() === slug)
  const rank = (a: ParsedConnectionsAccount): number => {
    if (a.isDefault) return 0
    if (String(a.status ?? '').toLowerCase() === 'active') return 1
    return 2
  }
  return ofToolkit.sort((a, b) => rank(a) - rank(b))
}

/**
 * Il risultato di COMPOSIO_MANAGE_CONNECTIONS `add` AL MODELLO: il link NON
 * passa nel testo libero (C5 punto 1) — sta nella card, il risultato dice
 * che è lì e di aspettare la conferma dell'utente.
 */
export function manageConnectionsAgentResult(output: string, links: Array<{ toolkit?: string }>): string {
  if (links.length === 0) return output
  const names = links.map((l) => l.toolkit ?? 'the app').join(', ')
  return [
    `The authorization link for ${names} has been shown to the user in a connection card: they must click it to finish the login in the browser.`,
    'Wait for the user confirmation; Homun checks the connection and updates the card. Do not print or repeat the link.'
  ].join(' ')
}

/** Il toolkit di uno strumento composio__<tk>__ACTION del vecchio flusso SDK (qui per simmetria). */
export function toolkitOfComposioToolName(toolName: string): string | null {
  return composioActionOfToolName(toolName)?.toolkit ?? null
}

// ---- il gate del blocco e di MANAGE_CONNECTIONS (C2/C5, PURO) ----

/** Una regola/una grant come le vede il gate del blocco (sottoinsieme di PermissionRule). */
export interface ComposioRuleLike {
  tool: string
  mode: 'always_allow' | 'needs_approval' | 'blocked'
}

/** La fiducia del turno (C4): contaminato + toolkit già usati o approvati. */
export interface ComposioTrustInput {
  tainted: boolean
  trustedApps: readonly string[]
}

/** Un'azione del blocco come la vede la CARD (C7 punto 1). */
export interface ComposioBatchActionInfo {
  slug: string
  app: string
  action: string
  kind: ComposioBatchSeverity | 'connect'
  arguments: Record<string, unknown>
  account?: string
}

export interface ComposioGateInput {
  /** il nome completo dello strumento (mcp__<server>__COMPOSIO_…) */
  toolName: string
  args: Record<string, unknown>
  rules: readonly ComposioRuleLike[]
  /** i tool con grant «sempre» (target '*', chiavi composio-action:…) */
  grants: readonly string[]
  /** C4: la fiducia del turno (assente = non contaminato) */
  trust?: ComposioTrustInput
  /** gli slug dei toolkit collegati (per ricavare il toolkit e il nome) */
  connectedSlugs?: readonly string[]
  uiLang: 'it' | 'en'
}

export type ComposioGateOutcome =
  | { kind: 'allow'; via: 'rule' | 'grant' }
  | { kind: 'deny' }
  | {
      kind: 'ask'
      /** la severità del blocco (destructive > write > send > read) */
      severity: ComposioBatchSeverity
      actions: ComposioBatchActionInfo[]
      incomplete: boolean
      /** perché si chiede: azione non letta | voce senza nome | fiducia (C4) | regola ask */
      reason: 'action' | 'incomplete' | 'trust' | 'rule'
      /** niente «Consenti sempre» (distruttivo, incompleto, proxy, remove) */
      noAlways: boolean
      destructive: boolean
    }

/** Le azioni del blocco per la card: nomi localizzati, argomenti ripuliti, account. */
function batchActionInfos(parsed: ComposioBatchActions, connectedSlugs: readonly string[], uiLang: 'it' | 'en'): ComposioBatchActionInfo[] {
  return parsed.items
    .filter((item) => item.slug)
    .map((item) => ({
      slug: item.slug,
      app: batchAppLabel(item.slug, connectedSlugs),
      action: localizedBatchActionName(item.slug, uiLang, readableSlug(item.slug)),
      kind: classifyBatchAction(item.slug, connectedSlugs),
      arguments: redactBatchLeaves(item.arguments),
      ...(item.account ? { account: item.account } : {})
    }))
}

/** Lo slug reso leggibile: SEND_EMAIL → «Send email». */
function readableSlug(slug: string): string {
  const toolkit = composioToolkitOfSlug(slug)
  return stripToolkitPrefix(toolkit, slug)
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Il gate del blocco (C2, puro — Rakazo resolveActionApprovalForTools:482+):
 * regole e consensi si cercano PER AZIONE (chiave composio-action:<SLUG>),
 * MAI per lo strumento del blocco; una regola blocked sullo strumento del
 * blocco (o sul server, via mcp__*) blocca tutto; una regola always_allow
 * sullo strumento del blocco NON conta; il blocco è consentito da regola
 * solo se lo è OGNI azione; una voce senza nome chiede SEMPRE; decide
 * l'azione più severa; dopo la contaminazione una lettura su un toolkit
 * non ancora usato né approvato chiede (C4).
 */
export function composioBatchGate(input: ComposioGateInput): ComposioGateOutcome {
  const { toolName, args, rules, grants } = input
  const uiLang = input.uiLang
  const connectedSlugs = input.connectedSlugs ?? []
  const shape = toolBatchOf(toolName.split('__').slice(2).join('__'))!
  const parsed = batchActions(shape, args)
  // 1. il wrapper può solo BLOCCARE (regola blocked sullo strumento o mcp__*)
  if (rules.some((r) => r.mode === 'blocked' && ruleMatchesTool(r.tool, toolName))) {
    return { kind: 'deny' }
  }
  // 2. regole per azione: blocked nega tutto; always/grant consentono UNA azione
  const actionAllowed = (slug: string): boolean =>
    grants.includes(composioActionKey(slug)) ||
    rules.some((r) => r.tool === composioActionKey(slug) && r.mode === 'always_allow')
  const actionForcedAsk = (slug: string): boolean =>
    rules.some((r) => r.tool === composioActionKey(slug) && r.mode === 'needs_approval')
  for (const slug of parsed.actions) {
    if (rules.some((r) => r.tool === composioActionKey(slug) && r.mode === 'blocked')) return { kind: 'deny' }
  }
  const infos = batchActionInfos(parsed, connectedSlugs, uiLang)
  const severity = batchSeverity(infos.length ? infos.map((a) => a.kind) : ['write'])
  const ask = (reason: 'action' | 'incomplete' | 'trust' | 'rule'): ComposioGateOutcome => ({
    kind: 'ask',
    severity,
    actions: infos,
    incomplete: !parsed.complete,
    reason,
    noAlways: !parsed.complete || severity === 'destructive',
    destructive: severity === 'destructive'
  })
  // 3. una voce senza nome (o blocco vuoto): si chiede SEMPRE (Rakazo batchActions)
  if (!parsed.complete) return ask('incomplete')
  // 4. la fiducia per app (C4): letture su un toolkit NON ancora usato né
  //    approvato, dopo la contaminazione, chiedono (le altre restano libere)
  const allRead = infos.every((a) => a.kind === 'read')
  if (allRead) {
    if (infos.some((a) => actionForcedAsk(a.slug))) return ask('rule')
    if (input.trust) {
      const trusted = new Set(input.trust.trustedApps)
      const toolkits = composioTrustKeys(parsed, connectedSlugs)
      const untrusted = toolkits.filter((tk) => !trusted.has(tk))
      if (input.trust.tainted && untrusted.length > 0) return ask('trust')
    }
    return { kind: 'allow', via: 'rule' }
  }
  // 5. scritture (o miste): consentite da regola/grant solo se lo è OGNI azione
  if (parsed.actions.length > 0 && parsed.actions.every((slug) => actionAllowed(slug))) {
    return { kind: 'allow', via: grants.includes(composioActionKey(parsed.actions[0]!)) ? 'grant' : 'rule' }
  }
  return ask('action')
}

/** La regola copre lo strumento? ('*', prefisso 'x*', nome esatto) — come ruleToolMatches. */
function ruleMatchesTool(ruleTool: string, tool: string): boolean {
  if (ruleTool === '*') return true
  if (ruleTool.endsWith('*')) return tool.startsWith(ruleTool.slice(0, -1))
  return ruleTool === tool
}

/** I toolkit delle azioni di una chiamata al blocco (chiavi di fiducia C4). */
function composioTrustKeys(parsed: ComposioBatchActions, connectedSlugs: readonly string[]): string[] {
  return [...new Set(parsed.actions.map((slug) => composioToolkitOfSlug(slug, connectedSlugs)))]
}

/**
 * Il gate di COMPOSIO_MANAGE_CONNECTIONS (C5, puro): per VOCE di toolkits[] —
 * list è lettura, add è la card di collegamento, rename chiede, remove è
 * distruttiva SENZA «sempre». Decide la voce più severa; una voce senza nome
 * chiede sempre (non si vede QUALE app), tranne una `list` senza nome che
 * resta una lettura (V8: il server risponderà con l'errore «Required … name»
 * e il modello correggerà da solo).
 */
export function manageConnectionsGate(input: ComposioGateInput): ComposioGateOutcome {
  const { toolName, args, rules } = input
  if (rules.some((r) => r.mode === 'blocked' && ruleMatchesTool(r.tool, toolName))) return { kind: 'deny' }
  const entries = manageConnectionsEntries(args)
  if (entries.length === 0) {
    return {
      kind: 'ask', severity: 'write', actions: [], incomplete: true,
      reason: 'incomplete', noAlways: true, destructive: false
    }
  }
  const kinds = entries.map((e) => {
    const kind = manageConnectionsEntryKind(e.action)
    return kind === 'connect' ? ('write' as const) : kind
  })
  const severity = batchSeverity(kinds)
  // V8: solo le voci CON EFFETTI senza nome chiedono (una list senza name è una lettura)
  const unnamedBlocking = entries.some((e) => !e.named && e.action !== 'list')
  const apps = entries.filter((e) => e.named).map((e) => ({
    slug: e.name,
    app: composioToolkitName(e.name),
    // K3 (ritocchi): l'azione nella lingua della UI (add → «Collega»), mai
    // la parola del server nella card o nella riga decisa
    action: localizedConnectionsAction(e.action, input.uiLang),
    kind: manageConnectionsEntryKind(e.action),
    arguments: redactBatchLeaves(
      e.action === 'add'
        ? { toolkit: e.name }
        : { toolkit: e.name, ...(e.account_id ? { account_id: e.account_id } : {}), ...(e.alias ? { alias: e.alias } : {}) }
    )
  }))
  const ask = (reason: 'action' | 'incomplete' | 'rule'): ComposioGateOutcome => ({
    kind: 'ask',
    severity,
    actions: apps,
    incomplete: unnamedBlocking,
    reason,
    noAlways: unnamedBlocking || severity === 'destructive' || entries.some((e) => e.action === 'add'),
    destructive: severity === 'destructive'
  })
  if (unnamedBlocking) return ask('incomplete')
  if (kinds.every((k) => k === 'read')) return { kind: 'allow', via: 'rule' }
  return ask('action')
}

/**
 * Il gate di COMPOSIO_PROXY_EXECUTE (C3, puro): una richiesta HTTP grezza
 * all'API di un'app — SEMPRE card, MAI «Consenti sempre»; per i metodi
 * diversi da GET la card lo dice (kind write). Conta come scrittura del
 * toolkit per la fiducia (C4: il chiamante registra il toolkit).
 */
export function proxyExecuteGate(input: ComposioGateInput): ComposioGateOutcome {
  const { toolName, args, rules } = input
  if (rules.some((r) => r.mode === 'blocked' && ruleMatchesTool(r.tool, toolName))) return { kind: 'deny' }
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
  const toolkit = typeof args.toolkit_slug === 'string' ? args.toolkit_slug : ''
  const endpoint = typeof args.endpoint === 'string' ? args.endpoint : ''
  return {
    kind: 'ask',
    severity: method === 'GET' || method === 'HEAD' ? 'read' : 'write',
    actions: [{
      slug: 'PROXY',
      app: composioToolkitName(toolkit || 'app'),
      // K3 (ritocchi): «Gmail · Richiesta diretta GET /…», mai «PROXY»
      action: localizedProxyRequestAction(method, endpoint, input.uiLang),
      kind: method === 'GET' || method === 'HEAD' ? 'read' : 'write',
      arguments: redactBatchLeaves({
        ...(toolkit ? { toolkit_slug: toolkit } : {}),
        ...(typeof args.endpoint === 'string' ? { endpoint: args.endpoint } : {}),
        method,
        ...(Array.isArray(args.parameters) ? { parameters: args.parameters } : {}),
        ...(args.body !== undefined ? { body: args.body } : {})
      })
    }],
    incomplete: false,
    reason: 'action',
    noAlways: true,
    destructive: false
  }
}
