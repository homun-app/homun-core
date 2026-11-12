// CA1 (fase composio-account): più account per la stessa app. Composio
// supporta più account per toolkit (COMPOSIO_MANAGE_CONNECTIONS con action
// add/rename/list/remove, il campo `account` di ogni voce di
// COMPOSIO_MULTI_EXECUTE_TOOL): lo stato locale del gateway passa da
// «un account per app, sempre l'ultimo» a un ELENCO di account per app.
// Qui le funzioni PURE: la migrazione del formato vecchio (idempotente), la
// normalizzazione degli alias (minuscole, senza spazi, unici nel toolkit),
// l'alias predefinito (la parte locale dell'email, appena nota; altrimenti
// «account 2», «account 3») e lo stato dell'app dai suoi account.
// Modulo PURO: nessuna dipendenza, testabile in nodo puro.

/** Lo stato di un account collegato (lo «ACTIVE»/«RECONNECT»/«FAILED» di sempre). */
export type GatewayAccountStatus = 'ACTIVE' | 'RECONNECT' | 'FAILED'

/** Un account collegato di un'app del gateway. */
export interface GatewayAccount {
  accountId: string | null
  alias?: string
  email?: string
  status: GatewayAccountStatus
  connectedAt: number
  /** l'account che Composio preferisce per quel toolkit (is_default di `list`) */
  isDefault?: boolean
}

/** Un'app collegata: nome umano ed elenco di account (CA1: non più uno solo). */
export interface GatewayAppStored {
  name: string
  accounts: GatewayAccount[]
}

/** Lo stato salvato (composioGateway.apps), NORMALIZZATO in lettura e scrittura. */
export type GatewayAppsStored = Record<string, GatewayAppStored>

const isStatus = (v: unknown): v is GatewayAccountStatus => v === 'ACTIVE' || v === 'RECONNECT' || v === 'FAILED'

/** Una voce dell'elenco account: tollerante sui tipi (arriva da JSON su disco). */
function normalizeAccount(raw: unknown): GatewayAccount | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const accountId = typeof r.accountId === 'string' && r.accountId ? r.accountId : null
  const status = isStatus(r.status) ? r.status : 'RECONNECT'
  return {
    accountId,
    status,
    connectedAt: typeof r.connectedAt === 'number' && Number.isFinite(r.connectedAt) ? r.connectedAt : 0,
    ...(typeof r.alias === 'string' && r.alias.trim() ? { alias: r.alias } : {}),
    ...(typeof r.email === 'string' && r.email.trim() ? { email: r.email } : {}),
    ...(r.isDefault === true ? { isDefault: true } : {})
  }
}

/**
 * La migrazione PURA e IDEMPOTENTE del formato dello stato: il vecchio
 * (un account piatto per app: `{ name, accountId, status, connectedAt,
 * email? }`) diventa `{ name, accounts: [quell'account] }`; il nuovo passa
 * invariato. Voci rotte non tirano giù tutto: la riga senza nome prende lo
 * slug come nome, l'elenco mancante resta vuoto.
 */
export function normalizeGatewayApps(raw: unknown): GatewayAppsStored {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: GatewayAppsStored = {}
  for (const [slug, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== 'object') continue
    const entry = entryRaw as Record<string, unknown>
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : slug
    if (Array.isArray(entry.accounts)) {
      const accounts = entry.accounts.map(normalizeAccount).filter((a): a is GatewayAccount => a !== null)
      out[slug] = { name, accounts }
      continue
    }
    // il formato VECCHIO: l'account unico piatto diventa l'unico dell'elenco
    // (una voce SENZA nessun campo d'account non ne inventa uno)
    const hasAnyAccountField = 'accountId' in entry || 'status' in entry || 'email' in entry || 'connectedAt' in entry
    const single = hasAnyAccountField ? normalizeAccount(entry) : null
    out[slug] = { name, accounts: single ? [single] : [] }
  }
  return out
}

/** L'alias in forma normale: minuscolo, senza spazi (dentro e ai bordi). */
export function normalizeAlias(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * L'alias univoco nel toolkit: se il base è già preso si suffissa (-2, -3…),
 * come fanno gli alias generati dalle email uguali (fabio → fabio-2).
 */
export function uniqueAlias(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * L'alias predefinito di un account (CA1 punto 2): la parte locale
 * dell'email, appena nota; altrimenti «account 2», «account 3» — il PRIMO
 * account senza email resta senza alias (non serve distinguerlo da niente).
 */
export function defaultAliasFor(email: string | undefined, index1: number): string {
  const local = typeof email === 'string' ? email.split('@')[0] ?? '' : ''
  if (local.trim()) return normalizeAlias(local)
  return index1 > 1 ? `account ${index1}` : ''
}

/**
 * Assegna gli alias predefiniti agli account SENZA alias (CA1 punto 2): la
 * parte locale dell'email quando c'è, «account N» altrimenti, sempre UNIVOCI
 * nel toolkit. Gli alias già presenti (il rename dell'utente) non si toccano.
 */
export function assignDefaultAliases(accounts: readonly GatewayAccount[]): GatewayAccount[] {
  const taken = new Set<string>()
  for (const a of accounts) if (a.alias) taken.add(a.alias)
  return accounts.map((a, i) => {
    if (a.alias) return a
    const base = defaultAliasFor(a.email, i + 1)
    if (!base) return a
    const alias = uniqueAlias(base, taken)
    taken.add(alias)
    return { ...a, alias }
  })
}

/**
 * Lo stato dell'APP dai suoi account (CA1): ACTIVE se almeno un account è
 * attivo; altrimenti RECONNECT se c'è qualcosa da ricollegare; FAILED quando
 * non resta altro (l'esito «Non riuscito» di sempre per l'app senza account
 * attivi connessi da Homun).
 */
export function gatewayAppStatusOf(app: GatewayAppStored): GatewayAccountStatus {
  if (app.accounts.some((a) => a.status === 'ACTIVE')) return 'ACTIVE'
  if (app.accounts.some((a) => a.status === 'RECONNECT')) return 'RECONNECT'
  return 'FAILED'
}
