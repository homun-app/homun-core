// Fase app (A2–A5): tutto il codice Composio sta nel daemon. Un'unica chiave
// d'API dell'utente (account Composio SUO: nessun server nostro) nello store
// CIFRATO dei connettori; l'identità verso Composio è un userId casuale
// «homun-<uuid>» (mai email o nome). Il catalogo (toolkits.get, tutte le
// pagine quando il client le espone) è in cache nel daemon per 24 h e su
// disco nella cartella dati; la ricerca è LOCALE sulla cache. Ogni azione
// dell'API diretta diventa uno strumento VERO (composio__<toolkit>__<ACTION>),
// NON un meta-strumento di sessione: valgono card, bozze, find_tools ed
// enabledFor per bot come per i server MCP. Le chiamate hanno timeout (30 s,
// 5 minuti solo per waitForConnection); senza rete, errore chiaro al modello
// e alla UI, mai un turno bloccato. Il client è INIETTABILE (come il
// Portachiavi finto): i test usano composio-fake.ts, la sonda
// SANDBOT_TEST_FAKE_COMPOSIO=<file json> (solo insieme alle altre
// SANDBOT_TEST_*). Nessuna chiamata vera fuori dai flussi dell'utente.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SandbotEvent, ToolDefLike } from '../../shared/types'
import { CURATED_COMPOSIO_SLUGS } from '../../shared/types'
import type { UiLanguage } from '../../shared/ui-language'
import { localizedActionName } from '../../shared/composio-names'
import type { ConnectorsSecretStore } from './sealed-store'
import {
  composioToolName, readableActionSlug, sanitizeComposioError, redactComposioSecrets
} from './composio-actions'

// ---- il client come lo usa il daemon (l'adapter dell'SDK lo implementa) ----

export interface ComposioToolkitData {
  slug: string
  name: string
  logo?: string | null
  description?: string | null
  category?: string | null
  noAuth?: boolean
  /** false = nessun login gestito da Composio (serve lo sviluppatore) */
  managedAuth?: boolean
}

export interface ComposioRawTool {
  slug: string
  name?: string
  description?: string
  inputParameters?: Record<string, unknown>
  version?: string
  toolkit?: { slug: string; name?: string }
  isNoAuth?: boolean
}

export interface ComposioConnectedAccount {
  id: string
  status: string
  toolkit: { slug: string }
  createdAt?: string
}

export interface ComposioConnectionRequest {
  id: string
  status?: string
  redirectUrl?: string | null
  waitForConnection(timeout?: number): Promise<ComposioConnectedAccount>
}

export interface ComposioExecuteResult {
  data: Record<string, unknown>
  error: string | null
  successful: boolean
}

/** La superficie dell'SDK che il daemon usa (le firme verificate nei .d.mts di 0.25.0). */
export interface ComposioClientLike {
  toolkits: {
    page(query?: { limit?: number; cursor?: string }, signal?: AbortSignal): Promise<{ items: ComposioToolkitData[]; nextCursor?: string | null }>
    authorize(userId: string, slug: string, signal?: AbortSignal): Promise<ComposioConnectionRequest>
  }
  connectedAccounts: {
    list(query?: { userIds?: string[]; statuses?: string[]; toolkitSlugs?: string[]; limit?: number; cursor?: string }, signal?: AbortSignal): Promise<{ items: ComposioConnectedAccount[]; nextCursor?: string | null }>
    waitForConnection(id: string, timeout?: number): Promise<ComposioConnectedAccount>
    delete(id: string, signal?: AbortSignal): Promise<unknown>
  }
  tools: {
    raw(toolkits: string[], signal?: AbortSignal): Promise<ComposioRawTool[]>
    execute(slug: string, body: { userId?: string; arguments?: Record<string, unknown>; version?: string }, signal?: AbortSignal): Promise<ComposioExecuteResult>
  }
}

// ---- costanti della fase ----

/** Timeout delle chiamate a Composio (A5): 30 s; waitForConnection 5 minuti. */
export const COMPOSIO_CALL_TIMEOUT_MS = 30_000
export const COMPOSIO_LOGIN_TIMEOUT_MS = 5 * 60_000
/** La cache del catalogo e degli schemi dura 24 h (A3/A5). */
export const COMPOSIO_CACHE_TTL_MS = 24 * 60 * 60_000
/** Ogni quanti minuti si rilegge lo stato degli account mentre la UI è aperta (A4). */
export const COMPOSIO_REFRESH_MS = 10 * 60_000
/** Le pagine del catalogo richieste al client (il finto le impagina a 50). */
const CATALOG_PAGE_SIZE = 200
/** Quante righe Composio al massimo nella risposta del catalogo (con logo data:). */
const CATALOG_ROWS_LIMIT = 100
/** Massima dimensione di un logo scaricato (A3: al massimo 256 KB, solo immagini). */
const LOGO_MAX_BYTES = 256 * 1024
/** Il dominio dei loghi di Composio: si scarica SOLO da qui (A3). */
const LOGO_ALLOWED_HOSTS = /^([a-z0-9-]+\.)*composio\.(dev|com)$/i

/**
 * A3: le curate VINCONO. Se un toolkit Composio ha lo stesso servizio di una
 * curata, la riga è una sola (quella curata e diretta); nel dettaglio della
 * curata c'è «Collega tramite Composio» come alternativa secondaria.
 * Mappa in codice (una sola copia, condivisa col renderer): shared/types.ts.
 */
export { CURATED_COMPOSIO_SLUGS }

/** Il campo dello store cifrato e i setting (mai la chiave nei settings). */
const KEY_SERVER = 'composio'
const KEY_FIELD = 'apiKey'
const S_USER = 'composio.userId'
const S_ACCOUNTS = 'composio.accounts'
const S_ENABLED_FOR = 'composio.enabledFor'
const S_ACTIVE = 'composio.active'

export type ComposioAccountStatus = 'ACTIVE' | 'RECONNECT'

interface StoredAccount {
  accountId: string | null
  status: ComposioAccountStatus
  name: string
  connectedAt: number
}

/** Lo stato locale di un collegamento (specchio di connectedAccounts). */
type AccountsSetting = Record<string, StoredAccount>

export interface ComposioManagerDeps {
  store: ConnectorsSecretStore
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  /** Apre il browser di sistema (HostBridge della UI). */
  openExternal(url: string): Promise<void>
  hasUi(): boolean
  emit(e: SandbotEvent): void
  dataDir(): string
  /** iniettabile: i test passano il finto, la sonda l'env SANDBOT_TEST_FAKE_COMPOSIO */
  clientFactory?(): Promise<ComposioClientLike>
  fetchImpl?: typeof fetch
  now?(): number
}

const TIMEOUT_SIGNAL = (): AbortSignal => AbortSignal.timeout(COMPOSIO_CALL_TIMEOUT_MS)

/** Il client VERO: adapter dell'SDK 0.25.0 (import pigro, solo con una chiave). */
async function createSdkClient(apiKey: string): Promise<ComposioClientLike> {
  const { Composio } = await import('@composio/core')
  const sdk = new Composio({ apiKey, allowTracking: false, dangerouslyAllowAutoUploadDownloadFiles: false })
  const mapToolkit = (t: {
    slug: string; name: string; noAuth?: boolean
    meta?: { logo?: string; description?: string; categories?: Array<{ slug?: string; name?: string }> }
    composioManagedAuthSchemes?: string[]
  }): ComposioToolkitData => ({
    slug: t.slug,
    name: t.name,
    ...(t.meta?.logo ? { logo: t.meta.logo } : {}),
    ...(t.meta?.description ? { description: t.meta.description } : {}),
    ...(t.meta?.categories?.[0]?.name ? { category: t.meta.categories[0].name } : {}),
    ...(t.noAuth ? { noAuth: true } : {}),
    ...(Array.isArray(t.composioManagedAuthSchemes) ? { managedAuth: t.composioManagedAuthSchemes.length > 0 } : {})
  })
  return {
    toolkits: {
      page: async (query, signal) => {
        // toolkits.get in 0.25.0 restituisce l'array della pagina e NON espone
        // il cursore di risposta: si chiede la pagina più larga in una chiamata
        // e si dichiara la pagina completa (il finto impagina davvero e il
        // loader segue nextCursor quando c'è). Da riprovare con una chiave vera.
        const items = await sdk.toolkits.get(
          { ...(query?.limit !== undefined ? { limit: query.limit } : {}), ...(query?.cursor ? { cursor: query.cursor } : {}) },
          { signal }
        )
        return { items: (items ?? []).map(mapToolkit), nextCursor: null }
      },
      authorize: (userId, slug, signal) => sdk.toolkits.authorize(userId, slug, undefined, { signal })
    },
    connectedAccounts: {
      list: (q, signal) =>
        sdk.connectedAccounts.list(
          {
            ...(q?.userIds ? { userIds: q.userIds } : {}),
            ...(q?.statuses ? { statuses: q.statuses as never } : {}),
            ...(q?.toolkitSlugs ? { toolkitSlugs: q.toolkitSlugs } : {}),
            ...(q?.limit !== undefined ? { limit: q.limit } : {}),
            ...(q?.cursor ? { cursor: q.cursor } : {})
          },
          { signal }
        ),
      waitForConnection: (id, timeout) => sdk.connectedAccounts.waitForConnection(id, timeout),
      delete: (id, signal) => sdk.connectedAccounts.delete(id, { signal })
    },
    tools: {
      raw: (toolkits, signal) => sdk.tools.getRawComposioTools({ toolkits }, undefined, { signal }),
      execute: (slug, body, signal) =>
        sdk.tools.execute(slug, { userId: body.userId, arguments: body.arguments, version: body.version } as never, { signal })
    }
  }
}

/** Le pagine del finto dell'env della sonda (solo insieme a SANDBOT_TEST_USER_DATA). */
async function createFakeClientFromEnv(): Promise<ComposioClientLike | null> {
  const path = process.env.SANDBOT_TEST_FAKE_COMPOSIO
  if (!path || !process.env.SANDBOT_TEST_USER_DATA) return null
  const { FakeComposioClient } = await import('./composio-fake')
  return FakeComposioClient.fromFileSync((p) => readFileSync(p, 'utf8'), path)
}

export interface ComposioConnectedAppRpc {
  slug: string
  name: string
  status: ComposioAccountStatus
  accountId: string | null
  toolsCount: number
  /** per quali bot è abilitato il toolkit (['*'] = tutti, predefinito) */
  enabledFor: string[]
  /** R4 (ritocchi): le azioni del toolkit per la tabella del dettaglio (nome nella lingua della UI) */
  tools: Array<{ slug: string; name: string }>
}

export interface ComposioStatusRpc {
  active: boolean
  hasKey: boolean
  keyHint: string | null
  pending: { slug: string; name: string; since: number } | null
  connected: ComposioConnectedAppRpc[]
}

export interface ComposioCatalogRowRpc {
  slug: string
  name: string
  tagline: string | null
  category: string | null
  /** il logo come data: URL (il renderer non carica MAI immagini remote) */
  logo: string | null
  connectable: 'yes' | 'no-auth' | 'developer-config'
}

export interface ComposioCatalogRpc {
  count: number
  rows: ComposioCatalogRowRpc[]
  error?: string
}

export type ComposioManager = ReturnType<typeof createComposioManager>

export function createComposioManager(deps: ComposioManagerDeps) {
  const now = (): number => deps.now?.() ?? Date.now()
  const cacheDir = (): string => join(deps.dataDir(), 'composio')
  const catalogFile = (): string => join(cacheDir(), 'catalog.json')
  const toolsFile = (): string => join(cacheDir(), 'tools.json')
  const logosDir = (): string => join(cacheDir(), 'loghi')

  /** la chiave provvisoria del foglio di attivazione: salvata SOLO da test() riuscito */
  let pendingKey: string | null = null
  let client: ComposioClientLike | null = null
  /** i collegamenti in corso (slug → quando è partito / annullato) */
  const pending = new Map<string, { since: number; cancelled: boolean; requestId?: string }>()
  let lastAccountRefresh = 0

  // ---- la chiave e l'identità (A2) ----

  const storedKey = async (): Promise<string | null> => (await deps.store.read<string>(KEY_SERVER, KEY_FIELD)) ?? null

  const userId = (): string => {
    const existing = deps.getSetting<string | null>(S_USER, null)
    if (existing) return existing
    const id = `homun-${randomUUID()}`
    deps.setSetting(S_USER, id)
    return id
  }

  /** Il client attivo: finto (env sonda) → iniettato (test) → SDK con la chiave. */
  const activeClient = async (): Promise<ComposioClientLike | null> => {
    if (client) return client
    const fake = await createFakeClientFromEnv().catch(() => null)
    if (fake) {
      client = fake
      return client
    }
    if (deps.clientFactory) {
      client = await deps.clientFactory()
      return client
    }
    const key = pendingKey ?? (await storedKey())
    if (!key) return null
    client = await createSdkClient(key)
    return client
  }

  const accounts = (): AccountsSetting => deps.getSetting<AccountsSetting>(S_ACCOUNTS, {})
  const setAccounts = (next: AccountsSetting): void => {
    deps.setSetting(S_ACCOUNTS, next)
    deps.emit({ type: 'connectors' })
  }
  const accountOf = (slug: string): StoredAccount | undefined => accounts()[slug.toLowerCase()]

  const enabledForOf = (slug: string): string[] => deps.getSetting<Record<string, string[]>>(S_ENABLED_FOR, {})[slug.toLowerCase()] ?? ['*']
  const setEnabledFor = (slug: string, ids: string[]): void => {
    const all = deps.getSetting<Record<string, string[]>>(S_ENABLED_FOR, {})
    const key = slug.toLowerCase()
    if (ids.includes('*')) all[key] = ['*']
    else if (ids.length === 0) delete all[key]
    else all[key] = ids
    deps.setSetting(S_ENABLED_FOR, all)
    deps.emit({ type: 'connectors' })
  }

  // ---- il catalogo in cache (A3) ----

  interface CatalogCache {
    fetchedAt: number
    items: ComposioToolkitData[]
  }

  const readCatalogCache = (): CatalogCache => {
    try {
      const raw = readFileSync(catalogFile(), 'utf8')
      const parsed = JSON.parse(raw) as CatalogCache
      if (Array.isArray(parsed.items)) return parsed
    } catch { /* cache assente o rotta: si rifà */ }
    return { fetchedAt: 0, items: [] }
  }

  const ensureDir = (): void => {
    if (!existsSync(cacheDir())) mkdirSync(cacheDir(), { recursive: true })
  }

  /** toolkits.get seguendo i cursori del client quando li espone (tutte le pagine). */
  const fetchCatalog = async (): Promise<ComposioToolkitData[]> => {
    const c = await activeClient()
    if (!c) return []
    const items: ComposioToolkitData[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const result = await c.toolkits.page({ limit: CATALOG_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, TIMEOUT_SIGNAL())
      for (const item of result.items) {
        const key = item.slug?.toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        items.push({ ...item, slug: key })
      }
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    return items
  }

  /** Il catalogo: cache 24 h in memoria e su disco; scaduta → si riscarica. */
  const ensureCatalog = async (): Promise<{ items: ComposioToolkitData[]; error?: string }> => {
    const cache = readCatalogCache()
    if (cache.items.length && now() - cache.fetchedAt < COMPOSIO_CACHE_TTL_MS) return { items: cache.items }
    try {
      const items = await fetchCatalog()
      if (items.length) {
        ensureDir()
        writeFileSync(catalogFile(), JSON.stringify({ fetchedAt: now(), items } satisfies CatalogCache))
        return { items }
      }
      // nessuna voce (rete giù?): resta la cache scaduta, meglio di niente
      return cache.items.length ? { items: cache.items, error: 'stale' } : { items: [], error: 'empty' }
    } catch (e) {
      // senza rete: errore chiaro alla UI, mai un'eccezione senza testo
      if (cache.items.length) return { items: cache.items, error: sanitizeComposioError(e) }
      return { items: [], error: sanitizeComposioError(e) }
    }
  }

  /** Il logo di un toolkit: scaricato dal daemon (https, dominio Composio, ≤256 KB, solo immagini), cache su disco, data: URL al renderer. */
  const logoDataUrl = async (url: string | null | undefined): Promise<string | null> => {
    if (!url || !/^https:\/\//i.test(url)) return null
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return null
    }
    if (!LOGO_ALLOWED_HOSTS.test(host)) return null
    const { createHash } = await import('node:crypto')
    const name = `${createHash('sha256').update(url).digest('hex').slice(0, 16)}${(url.match(/\.(png|jpe?g|webp|gif|svg)$/i)?.[0] ?? '.img').toLowerCase()}`
    const file = join(logosDir(), name)
    try {
      if (existsSync(file)) {
        const buf = readFileSync(file)
        const mime = name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.png') ? 'image/png' : name.endsWith('.gif') ? 'image/gif' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
        return `data:${mime};base64,${buf.toString('base64')}`
      }
      const fetchImpl = deps.fetchImpl ?? fetch
      // R5 (ritocchi): i redirect NON si seguono — un URL del dominio Composio
      // potrebbe finire su un altro host. Si accetta SOLO una risposta 200
      // diretta, e l'host finale (res.url) si ricontrolla con la allowlist
      const res = await fetchImpl(url, { signal: TIMEOUT_SIGNAL(), redirect: 'manual' })
      if (res.status !== 200 || !res.ok) return null
      try {
        if (!LOGO_ALLOWED_HOSTS.test(new URL(res.url || url).hostname)) return null
      } catch {
        return null
      }
      const type = res.headers.get('content-type') ?? ''
      if (!type.startsWith('image/')) return null
      const length = Number(res.headers.get('content-length') ?? 0)
      if (length > LOGO_MAX_BYTES) return null
      // R5: senza content-length si legge IN STREAMING fermandosi al limite —
      // un corpo enorme non si scarica per intero per poi scartarlo
      const chunks: Buffer[] = []
      let total = 0
      let tooBig = false
      const reader = res.body?.getReader?.()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > LOGO_MAX_BYTES) {
            tooBig = true
            await reader.cancel().catch(() => undefined)
            break
          }
          chunks.push(Buffer.from(value))
        }
      } else {
        const raw = Buffer.from(await res.arrayBuffer())
        total = raw.byteLength
        chunks.push(raw)
      }
      if (tooBig || total === 0 || total > LOGO_MAX_BYTES) return null
      const buf = Buffer.concat(chunks)
      if (!existsSync(logosDir())) mkdirSync(logosDir(), { recursive: true })
      writeFileSync(file, buf)
      return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`
    } catch {
      return null // un logo mancante non è un errore: l'iniziale su un cerchio
    }
  }

  /** La ricerca LOCALE sulla cache: nome, slug, categoria (A3). */
  const searchCatalogItems = (items: ComposioToolkitData[], query: string): ComposioToolkitData[] => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    const words = q.split(/\s+/)
    return items.filter((t) => {
      const hay = `${t.name} ${t.slug} ${t.category ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }

  // ---- gli schemi delle azioni in cache (A5) ----

  interface ToolsCache {
    fetchedAt: Record<string, number>
    tools: Record<string, ComposioRawTool[]>
  }

  const readToolsCache = (): ToolsCache => {
    try {
      const parsed = JSON.parse(readFileSync(toolsFile(), 'utf8')) as ToolsCache
      if (parsed.tools && typeof parsed.tools === 'object') return { fetchedAt: parsed.fetchedAt ?? {}, tools: parsed.tools }
    } catch { /* assente: si rifà */ }
    return { fetchedAt: {}, tools: {} }
  }
  const writeToolsCache = (cache: ToolsCache): void => {
    ensureDir()
    writeFileSync(toolsFile(), JSON.stringify(cache))
  }

  /** Scarica gli schemi delle azioni di un toolkit collegato (con versione). */
  const refreshTools = async (slug: string): Promise<ComposioRawTool[]> => {
    const c = await activeClient()
    if (!c) return []
    const tools = await c.tools.raw([slug], TIMEOUT_SIGNAL())
    const cache = readToolsCache()
    const key = slug.toLowerCase()
    cache.tools[key] = tools
    cache.fetchedAt[key] = now()
    writeToolsCache(cache)
    return tools
  }
  const toolsOf = (slug: string): ComposioRawTool[] => readToolsCache().tools[slug.toLowerCase()] ?? []
  /** Gli schemi collegati: refresh a 24 h (in background, mai un turno bloccato). */
  const ensureToolsFresh = (slug: string): void => {
    const key = slug.toLowerCase()
    const fetched = readToolsCache().fetchedAt[key] ?? 0
    if (now() - fetched >= COMPOSIO_CACHE_TTL_MS) void refreshTools(key).catch(() => undefined)
  }

  // ---- i ToolDef per la pipeline (A5) ----

  interface RegistryEntry {
    toolkit: string
    toolkitName: string
    slug: string
    version?: string
  }

  const connectedActiveSlugs = (): string[] =>
    Object.entries(accounts())
      .filter(([, a]) => a.status === 'ACTIVE')
      .map(([slug]) => slug)

  /** R4: la lingua attiva dell'interfaccia per i nomi delle azioni (come ui-language, dal setting iniettato). */
  const activeUiLanguage = (): UiLanguage => {
    const v = deps.getSetting<unknown>('ui.activeLanguage', null)
    return v === 'it' ? 'it' : 'en'
  }

  /** R4: il nome di un'azione nella lingua della UI — localizzato PER INTERO o il nome originale di Composio. */
  const localizedToolName = (tool: ComposioRawTool, lang: UiLanguage): string =>
    localizedActionName(tool.slug, lang) ?? tool.name ?? readableActionSlug(tool.slug)

  /** nome completo → entry (la mappa nome ↔ slug del daemon, A5). */
  const registry = (): Map<string, RegistryEntry> => {
    const out = new Map<string, RegistryEntry>()
    for (const slug of connectedActiveSlugs()) {
      const account = accountOf(slug)
      for (const tool of toolsOf(slug)) {
        out.set(composioToolName(slug, tool.slug), {
          toolkit: slug,
          toolkitName: account?.name ?? slug,
          slug: tool.slug,
          ...(tool.version ? { version: tool.version } : {})
        })
      }
    }
    return out
  }

  const toolDefsFor = (slugs: string[]): ToolDefLike[] => {
    const defs: ToolDefLike[] = []
    for (const slug of slugs) {
      const account = accountOf(slug)
      for (const tool of toolsOf(slug)) {
        defs.push({
          name: composioToolName(slug, tool.slug),
          description: `[Composio:${account?.name ?? slug}] ${tool.description ?? tool.name ?? tool.slug}`.slice(0, 400),
          parameters: tool.inputParameters ?? { type: 'object', properties: {} }
        })
      }
    }
    return defs
  }

  // ---- lo stato degli account (A4) ----

  /** connectedAccounts.list per userId (tutte le pagine): lo specchio locale. */
  const refreshAccounts = async (): Promise<void> => {
    const c = await activeClient()
    if (!c || !deps.getSetting<boolean>(S_ACTIVE, false)) return
    const remote: ComposioConnectedAccount[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await c.connectedAccounts.list(
        { userIds: [userId()], ...(cursor ? { cursor } : {}) },
        TIMEOUT_SIGNAL()
      )
      remote.push(...(result.items ?? []))
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    const byToolkit = new Map<string, ComposioConnectedAccount>()
    for (const account of remote) {
      const slug = account.toolkit?.slug?.toLowerCase()
      if (!slug) continue
      byToolkit.set(slug, account)
    }
    const current = accounts()
    const next: AccountsSetting = {}
    let changed = false
    for (const [slug, local] of Object.entries(current)) {
      const remoteAccount = byToolkit.get(slug)
      // stesso servizio per lo stesso utente: mai un account diverso da quello
      // collegato — non più ACTIVE → «da ricollegare» e strumenti tolti.
      // I toolkit SENZA login (accountId null) sono collegati in locale e non
      // hanno un account remoto da leggere.
      const status: ComposioAccountStatus =
        local.accountId === null || remoteAccount?.status === 'ACTIVE' ? 'ACTIVE' : 'RECONNECT'
      next[slug] = { ...local, status }
      if (status !== local.status) changed = true
    }
    if (changed) setAccounts(next)
  }

  const maybeRefreshAccounts = (): void => {
    if (!deps.getSetting<boolean>(S_ACTIVE, false)) return
    if (!deps.hasUi()) return
    if (now() - lastAccountRefresh < COMPOSIO_REFRESH_MS) return
    lastAccountRefresh = now()
    void refreshAccounts().catch(() => undefined)
  }

  // ---- il flusso di collegamento (A4) ----

  const isNoAuthError = (e: unknown): boolean => {
    const message = e instanceof Error ? e.message : String(e)
    return message.includes('ToolkitsIsNoAuth') || message.includes('does not require authentication')
  }
  const isNoManagedAuthError = (e: unknown): boolean => {
    const message = e instanceof Error ? e.message : String(e)
    return /no.?managed.?auth/i.test(message) || message.includes('ToolRouterV2_NoManagedAuth') || /auth.?config.{0,40}(not.?found|missing|required)/i.test(message)
  }

  const runConnect = async (slugRaw: string): Promise<void> => {
    const slug = slugRaw.toLowerCase()
    const catalogItem = readCatalogCache().items.find((t) => t.slug.toLowerCase() === slug)
    const name = catalogItem?.name ?? slug
    const markAccount = (patch: StoredAccount): void => {
      setAccounts({ ...accounts(), [slug]: patch })
    }
    // il toolkit che su Composio richiede la configurazione dello sviluppatore
    // (nessun login gestito): riga chiara, non un errore generico
    if (catalogItem?.managedAuth === false) {
      deps.emit({ type: 'connectors' })
      return
    }
    // toolkit senza login: collegato subito, nessun account remoto
    if (catalogItem?.noAuth) {
      markAccount({ accountId: null, status: 'ACTIVE', name, connectedAt: now() })
      void refreshTools(slug).then(() => deps.emit({ type: 'connectors' })).catch(() => undefined)
      return
    }
    const c = await activeClient()
    if (!c) return
    const state: { since: number; cancelled: boolean; requestId?: string } = { since: now(), cancelled: false }
    pending.set(slug, state)
    deps.emit({ type: 'connectors' })
    try {
      const request = await c.toolkits.authorize(userId(), slug, TIMEOUT_SIGNAL())
      state.requestId = request.id
      if (request.redirectUrl) {
        // si apre nel browser di sistema; la UI mostra «In attesa del login…»
        await deps.openExternal(request.redirectUrl)
      }
      const account = await request.waitForConnection(COMPOSIO_LOGIN_TIMEOUT_MS)
      if (state.cancelled) {
        // annullato dall'utente: la richiesta va invalidata (delete, ignora 404)
        await c.connectedAccounts.delete(account.id).catch(() => undefined)
        return
      }
      markAccount({ accountId: account.id, status: 'ACTIVE', name, connectedAt: now() })
      await refreshTools(slug).catch(() => undefined)
    } catch (e) {
      if (state.cancelled) {
        if (state.requestId) await c.connectedAccounts.delete(state.requestId).catch(() => undefined)
        return
      }
      if (isNoAuthError(e)) {
        markAccount({ accountId: null, status: 'ACTIVE', name, connectedAt: now() })
        void refreshTools(slug).then(() => deps.emit({ type: 'connectors' })).catch(() => undefined)
        return
      }
      if (isNoManagedAuthError(e)) {
        // riga «da sviluppatore»: si segna nel catalogo (managedAuth false)
        const cache = readCatalogCache()
        const item = cache.items.find((t) => t.slug.toLowerCase() === slug)
        if (item) {
          item.managedAuth = false
          ensureDir()
          writeFileSync(catalogFile(), JSON.stringify(cache))
        }
        deps.emit({ type: 'connectors' })
        return
      }
      // errore in parole: pulito, mai con dentro la chiave
      const message = sanitizeComposioError(e)
      const current = accountOf(slug)
      if (current) setAccounts({ ...accounts(), [slug]: { ...current, status: 'RECONNECT' } })
      deps.setSetting('composio.lastError', `${name}: ${message}`)
      deps.emit({ type: 'connectors' })
    } finally {
      pending.delete(slug)
      deps.emit({ type: 'connectors' })
    }
  }

  // ---- l'esecuzione (A5) ----

  const execute = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
    const c = await activeClient()
    if (!c) return 'Composio is not active: ask the user to activate it from the "App" window.'
    const entry = registry().get(toolName)
    if (!entry) return `Composio tool ${toolName} is not available (reconnect the app from the "App" window).`
    const account = accountOf(entry.toolkit)
    if (account?.status !== 'ACTIVE') {
      return `The ${account?.name ?? entry.toolkit} connection is no longer active: ask the user to reconnect it from the "App" window.`
    }
    // la STESSA versione dello schema mostrato, mai dangerouslySkipVersionCheck
    const result = await c.tools.execute(
      entry.slug,
      { userId: userId(), arguments: args, ...(entry.version ? { version: entry.version } : {}) },
      TIMEOUT_SIGNAL()
    )
    if (result.error) return `Error: ${redactComposioSecrets(result.error)}`
    return JSON.stringify(result.data)
  }

  return {
    /** A2: lo stato per la UI (mai la chiave: solo hasKey e le ultime 4). */
    async status(): Promise<ComposioStatusRpc> {
      maybeRefreshAccounts()
      const key = pendingKey ?? (await storedKey())
      const lang = activeUiLanguage()
      const rows: ComposioConnectedAppRpc[] = Object.entries(accounts()).map(([slug, a]) => ({
        slug,
        name: a.name,
        status: a.status,
        accountId: a.accountId,
        toolsCount: a.status === 'ACTIVE' ? toolsOf(slug).length : 0,
        enabledFor: enabledForOf(slug),
        // R4: le azioni col nome nella lingua della UI per la tabella del
        // dettaglio dell'app (slug per la ri-localizzazione nel renderer)
        tools: a.status === 'ACTIVE'
          ? toolsOf(slug).map((t) => ({ slug: t.slug, name: localizedToolName(t, lang) }))
          : []
      }))
      rows.sort((a, b) => a.name.localeCompare(b.name))
      const pendingRow = pending.size > 0 ? [...pending.entries()][0] : undefined
      const pendingSlug = pendingRow?.[0]
      return {
        active: deps.getSetting<boolean>(S_ACTIVE, false),
        hasKey: !!key,
        keyHint: key ? `…${key.slice(-4)}` : null,
        pending: pendingSlug
          ? {
              slug: pendingSlug,
              name: readCatalogCache().items.find((t) => t.slug.toLowerCase() === pendingSlug)?.name ?? pendingSlug,
              since: pendingRow[1].since
            }
          : null,
        connected: rows
      }
    },

    /** A2 passo 2: la chiave incollata resta in MEMORIA finché il test non riesce. */
    setKey(key: string): { ok: boolean } {
      const trimmed = key.trim()
      if (!trimmed || trimmed.length < 8) return { ok: false }
      pendingKey = trimmed
      client = null // il client vecchio non deve riusare una chiave sbagliata
      return { ok: true }
    },

    /** A2 passo 3: il daemon crea il client e chiama toolkits.get con limite minimo. */
    async test(): Promise<{ ok: boolean; reason?: 'invalid-key' | 'unreachable'; error?: string }> {
      const key = pendingKey ?? (await storedKey())
      if (!key) return { ok: false, reason: 'invalid-key' }
      try {
        // finto (env sonda) o iniettato (test) → activeClient; altrimenti SDK
        const fakeOrInjected = !!deps.clientFactory || !!process.env.SANDBOT_TEST_FAKE_COMPOSIO
        const c = fakeOrInjected
          ? ((await activeClient()) ?? (await createSdkClient(key)))
          : await createSdkClient(key)
        await c.toolkits.page({ limit: 1 }, TIMEOUT_SIGNAL())
        // riuscito: la chiave si salva ADESSO nello store cifrato e l'identità
        // homun-<uuid> nasce UNA volta (mai email o nome dell'utente)
        if (pendingKey) await deps.store.write(KEY_SERVER, KEY_FIELD, pendingKey)
        pendingKey = null
        client = c
        deps.setSetting(S_ACTIVE, true)
        void userId()
        deps.emit({ type: 'connectors' })
        void ensureCatalog().catch(() => undefined)
        return { ok: true }
      } catch (e) {
        // fallito: la chiave NON resta salvata (pendingKey resta in memoria per
        // riprovare senza ridigitare, ma in nessun setting né store)
        const message = e instanceof Error ? e.message : String(e)
        const reason = /fetch|network|ENOTFOUND|ECONNREFUSED|timeout|timed out|abort/i.test(message)
          ? 'unreachable'
          : 'invalid-key'
        return { ok: false, reason, error: sanitizeComposioError(e) }
      }
    },

    /** A2: disattiva — chiave via, strumenti via da tutti i bot, righe via. NON cancella gli account su Composio. */
    async disable(): Promise<{ ok: true }> {
      await deps.store.remove(KEY_SERVER, [KEY_FIELD]).catch(() => undefined)
      pendingKey = null
      client = null
      deps.setSetting(S_ACTIVE, false)
      deps.setSetting(S_ACCOUNTS, {})
      deps.setSetting(S_ENABLED_FOR, {})
      deps.setSetting('composio.lastError', '')
      deps.emit({ type: 'connectors' })
      return { ok: true }
    },

    /** A3: il catalogo (curate escluse: vincono loro) con ricerca locale. */
    async catalog(query = ''): Promise<ComposioCatalogRpc> {
      if (!deps.getSetting<boolean>(S_ACTIVE, false)) return { count: 0, rows: [] }
      const { items, error } = await ensureCatalog()
      const connected = new Set(connectedActiveSlugs())
      const curatedSlugs = new Set(Object.values(CURATED_COMPOSIO_SLUGS).map((s) => s.toLowerCase()))
      const available = items.filter((t) => !connected.has(t.slug.toLowerCase()) && !curatedSlugs.has(t.slug.toLowerCase()))
      const matched = searchCatalogItems(available, query)
      matched.sort((a, b) => a.name.localeCompare(b.name))
      const page = matched.slice(0, CATALOG_ROWS_LIMIT)
      const rows: ComposioCatalogRowRpc[] = []
      for (const t of page) {
        rows.push({
          slug: t.slug,
          name: t.name,
          tagline: t.description ? t.description.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
          category: t.category ?? null,
          logo: await logoDataUrl(t.logo),
          connectable: t.managedAuth === false ? 'developer-config' : t.noAuth ? 'no-auth' : 'yes'
        })
      }
      return { count: matched.length, rows, ...(error && matched.length === 0 ? { error: sanitizeComposioError(error) } : {}) }
    },

    /** A4: Collega (parte in parallelo; la UI segue gli eventi {type:'connectors'}). */
    connect(slug: string): { started: boolean; developerConfig?: boolean; error?: string } {
      const item = readCatalogCache().items.find((t) => t.slug.toLowerCase() === slug.toLowerCase())
      if (item?.managedAuth === false) return { started: false, developerConfig: true }
      if (!deps.getSetting<boolean>(S_ACTIVE, false)) return { started: false, error: 'not-active' }
      // noAuth: collegato subito; con redirect: browser + attesa (5 minuti,
      // annullabile); tutto dentro runConnect
      void runConnect(slug)
      return { started: true }
    },

    /** A4: Scollega (e Annulla mentre aspetta il login). */
    async disconnect(slugRaw: string): Promise<{ ok: true }> {
      const slug = slugRaw.toLowerCase()
      const wait = pending.get(slug)
      if (wait) {
        wait.cancelled = true
        // l'account INITIATED della richiesta si cancella da Composio (404 ok)
        if (wait.requestId) {
          const c = await activeClient()
          await c?.connectedAccounts.delete(wait.requestId).catch(() => undefined)
        }
        pending.delete(slug)
      }
      const account = accountOf(slug)
      if (account?.accountId) {
        const c = await activeClient()
        await c?.connectedAccounts.delete(account.accountId, TIMEOUT_SIGNAL()).catch(() => undefined)
      }
      const next = { ...accounts() }
      delete next[slug]
      // gli strumenti del toolkit spariscono anche dalla cache degli schemi
      const toolsCache = readToolsCache()
      delete toolsCache.tools[slug]
      delete toolsCache.fetchedAt[slug]
      writeToolsCache(toolsCache)
      setAccounts(next)
      return { ok: true }
    },

    /** A4: lo stato per bot (enabledFor per toolkit, predefinito tutti). */
    setEnabledFor,
    enabledForOf,

    /** A5: gli schemi collegati (solo ACTIVE) per un bot. */
    toolsForAgent(agentId: string | undefined, parentId?: string): ToolDefLike[] {
      const slugs = connectedActiveSlugs().filter(
        (slug) => agentId === undefined || (() => {
          const ids = enabledForOf(slug)
          return ids.includes('*') || ids.includes(agentId) || (parentId !== undefined && ids.includes(parentId))
        })()
      )
      for (const slug of slugs) ensureToolsFresh(slug)
      return toolDefsFor(slugs)
    },

    /** A5: i server Composio di un bot per la sezione «Connettori attivi». */
    serversForAgent(agentId: string | undefined, parentId?: string): Array<{ id: string; name: string; tools: ToolDefLike[] }> {
      const slugs = connectedActiveSlugs().filter(
        (slug) => agentId === undefined || (() => {
          const ids = enabledForOf(slug)
          return ids.includes('*') || ids.includes(agentId) || (parentId !== undefined && ids.includes(parentId))
        })()
      )
      return slugs.map((slug) => ({
        id: `composio:${slug}`,
        name: accountOf(slug)?.name ?? slug,
        tools: toolDefsFor([slug])
      }))
    },

    /** A5: esegue uno strumento con la versione dello schema (sanitizzato). */
    execute,

    /** A8: i nomi umani delle app Composio abilitate per un bot. */
    appsOfAgent(agentId: string | undefined, parentId?: string): string[] {
      return connectedActiveSlugs()
        .filter((slug) => {
          if (agentId === undefined) return true
          const ids = enabledForOf(slug)
          return ids.includes('*') || ids.includes(agentId) || (parentId !== undefined && ids.includes(parentId))
        })
        .map((slug) => accountOf(slug)?.name ?? slug)
    },

    /** La descrizione di uno strumento per la card (A6/A7: «Gmail · Invia email»).
     *  R4 (ritocchi): l'azione è nella lingua della UI quando la traduzione è
     *  PER INTERO (verbo + oggetto), altrimenti il nome originale di Composio;
     *  lo slug, la versione e il nome ORIGINALE viaggiano col nome localizzato
     *  per la card (che in inglese torna al nome di Composio). */
    describeTool(toolName: string): { app: string; action: string; slug: string; version?: string; original?: string } | null {
      const entry = registry().get(toolName)
      if (!entry) return null
      const tool = toolsOf(entry.toolkit).find((t) => t.slug === entry.slug)
      return {
        app: entry.toolkitName,
        action: tool ? localizedToolName(tool, activeUiLanguage()) : readableActionSlug(entry.slug),
        slug: entry.slug,
        ...(entry.version ? { version: entry.version } : {}),
        ...(tool?.name ? { original: tool.name } : {})
      }
    },

    /** A4 punto 6: il catalogo per offer_connector / search_connectors. */
    async searchApps(query: string): Promise<Array<{ slug: string; name: string; description: string | null }>> {
      if (!deps.getSetting<boolean>(S_ACTIVE, false)) return []
      const { items } = await ensureCatalog()
      return searchCatalogItems(items, query)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((t) => ({ slug: t.slug, name: t.name, description: t.description ?? null }))
    },

    /** Lo specchio degli account, per test e sonde. */
    refreshAccounts,
    /** A4: il refresh con throttle (10 minuti) e solo a finestra aperta — lo chiama lo scheduler del daemon. */
    maybeRefreshAccounts
  }
}

// ---- i punti d'ingresso per loop/mcp/permissions (niente import inversi) ----

let active: ComposioManager | null = null

/** Il daemon registra QUI il manager (runtime.ts); null = Composio non attivo. */
export function setActiveComposio(manager: ComposioManager | null): void {
  active = manager
}

/** A5: gli strumenti Composio di un bot per la pipeline MCP (vuoto senza manager). */
export function composioToolsForAgent(agentId?: string): ToolDefLike[] {
  try {
    return active?.toolsForAgent(agentId) ?? []
  } catch {
    return []
  }
}

/** A5: i server Composio di un bot per la sezione «Connettori attivi». */
export function composioServersForAgent(agentId?: string): Array<{ id: string; name: string; tools: ToolDefLike[] }> {
  try {
    return active?.serversForAgent(agentId) ?? []
  } catch {
    return []
  }
}

/** A5: esegue composio__<toolkit>__<ACTION> con la versione dello schema. */
export async function callComposioTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!active) return 'Composio is not active.'
  return active.execute(name, args)
}

/** A8: i nomi delle app Composio abilitate per un bot. */
export function composioAppsOf(agentId?: string): string[] {
  try {
    return active?.appsOfAgent(agentId) ?? []
  } catch {
    return []
  }
}

/** A6/A7: «Gmail · Invia email» per la card d'approvazione (null se non Composio).
 *  R4 (ritocchi): porta anche slug e versione per la lingua e i Dettagli tecnici. */
export function describeComposioTool(name: string): { app: string; action: string; slug: string; version?: string; original?: string } | null {
  try {
    if (!active) return null
    return active.describeTool(name)
  } catch {
    return null
  }
}

/** A4 punto 6: il catalogo Composio per search_connectors / offer_connector. */
export async function searchComposioApps(query: string): Promise<Array<{ slug: string; name: string; description: string | null }>> {
  if (!active) return []
  return active.searchApps(query)
}
