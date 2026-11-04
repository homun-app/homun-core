// Connettori "Connetti app" (fase 5, §3.6/§6.1b): catalogo come dati + OAuth
// generico via OAuthClientProvider dell'SDK. Il manager orchestra la
// connessione (loopback RFC 8252 + discovery/PKCE/DCR dell'SDK), lo stato per
// connettore (non connesso / connesso / needs_auth / errore), i tool
// disattivati e le istruzioni personalizzate per server. Tutto a dipendenze
// iniettabili: i test usano un authorization server finto in memoria.
//
// L'agente NON può connettere da solo: offer_connector crea solo la card con
// il bottone "Connetti" — la connessione parte dal click dell'utente.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import catalogJson from './catalog.json'
// fase 17c (C3/C5): gli errori di stato seguono la lingua dell'interfaccia;
// il catalogo ha campi Localized (note) scelti con pickLang
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import { pickLang, isLocalized } from '../../shared/localized'
import type { Localized, ConnectorCategory } from '../../shared/types'
import { createOAuthProvider, authorizeWithLoopback, type StaticClientCredentials } from './oauth-provider'
import type { ConnectorsSecretStore } from './sealed-store'

export interface CatalogEntry {
  id: string
  name: string
  logo: string
  mcpUrl: string
  clientRegistration: 'dynamic' | 'static'
  scopes?: string[]
  docsUrl: string
  /** fase 17c (C5): le note sono bilingue (la UI sceglie, il modello riceve en) */
  notes: Localized
  /** fase 16c (C4): la categoria per i filtri della finestra Collega app */
  category?: ConnectorCategory
  /** fase 16c (C4): mezza riga localizzata sotto il nome (per esempio «Pagine e database») */
  tagline?: Localized
  /**
   * Fase Composio OAuth (C1): la voce è un «gateway» di app — non un servizio
   * solo: dentro ci si collegano altre app (Composio). La UI la tratta come
   * la card «Accedi» di A2/A7 e il dettaglio elenca le app collegate (C5).
   */
  gateway?: boolean
}

export type ConnectorStatus = 'not_connected' | 'connected' | 'needs_auth' | 'error'

export interface ConnectorState {
  status: ConnectorStatus
  error?: string
  disabledTools: string[]
  instructions: string
}

/** Un tool del connettore come lo vede la UI (nome completo mcp__<slug>__<tool>). */
export interface ConnectorToolInfo {
  name: string
  description: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
}

export interface ConnectorView extends CatalogEntry {
  state: ConnectorState
  tools: ConnectorToolInfo[]
  hasStaticCredentials?: boolean
}

// ---- validazione del catalogo (pura, testata) ----

/** Errori di validazione del catalogo (schema, URL https, docsUrl presente). */
export function validateCatalog(entries: unknown): string[] {
  const errors: string[] = []
  if (!Array.isArray(entries)) return ['il catalogo non è un array']
  const ids = new Set<string>()
  entries.forEach((e, i) => {
    const where = `voce ${i}`
    if (!e || typeof e !== 'object') return errors.push(`${where}: non è un oggetto`)
    const c = e as Record<string, unknown>
    if (typeof c.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(c.id)) errors.push(`${where}: id non valido`)
    if (ids.has(String(c.id))) errors.push(`${where}: id duplicato "${String(c.id)}"`)
    ids.add(String(c.id))
    if (typeof c.name !== 'string' || !c.name.trim()) errors.push(`${where}: nome mancante`)
    if (typeof c.mcpUrl !== 'string' || !c.mcpUrl.startsWith('https://')) errors.push(`${where}: mcpUrl non https (${String(c.mcpUrl)})`)
    if (c.clientRegistration !== 'dynamic' && c.clientRegistration !== 'static') errors.push(`${where}: clientRegistration non valido`)
    if (typeof c.docsUrl !== 'string' || !/^https:\/\//.test(c.docsUrl)) errors.push(`${where}: docsUrl mancante o non https`)
    // fase 17c (C5): le note accettano la forma stringa (dati vecchi) e {it,en}
    if (!isLocalized(c.notes)) errors.push(`${where}: notes mancanti`)
    // fase 16c (C4): ogni voce ha categoria e tagline IT/EN (i filtri e le
    // mezze righe della finestra Collega app dipendono da loro)
    const CATEGORIES = ['mail-calendar', 'documents', 'development', 'communication'] as const
    if (typeof c.category !== 'string' || !CATEGORIES.includes(c.category as (typeof CATEGORIES)[number])) {
      errors.push(`${where}: category mancante o non valida (${CATEGORIES.join(' | ')})`)
    }
    if (
      !c.tagline || typeof c.tagline !== 'object' ||
      typeof (c.tagline as { it?: unknown }).it !== 'string' || !(c.tagline as { it?: string }).it!.trim() ||
      typeof (c.tagline as { en?: unknown }).en !== 'string' || !(c.tagline as { en?: string }).en!.trim()
    ) {
      errors.push(`${where}: tagline mancante (serve {it, en})`)
    }
    if (c.scopes !== undefined && (!Array.isArray(c.scopes) || c.scopes.some((s) => typeof s !== 'string'))) errors.push(`${where}: scopes non validi`)
    // fase Composio OAuth (C1): il flag gateway (facoltativo, booleano)
    if (c.gateway !== undefined && typeof c.gateway !== 'boolean') errors.push(`${where}: gateway non booleano`)
  })
  return errors
}

/**
 * Catalogo verificato (vedi "notes" di ogni voce per la fonte ufficiale).
 * Fase Composio OAuth (C1): nella SONDA la voce di Composio punta al server
 * MCP finto locale con SANDBOT_TEST_COMPOSIO_MCP_URL — valida SOLO insieme a
 * SANDBOT_TEST_USER_DATA (mai un https di produzione verso una sonda).
 */
export function loadCatalog(): CatalogEntry[] {
  const errors = validateCatalog(catalogJson)
  if (errors.length) throw new Error(`catalogo connettori non valido: ${errors.join('; ')}`)
  const entries = catalogJson as CatalogEntry[]
  const testUrl = process.env.SANDBOT_TEST_COMPOSIO_MCP_URL
  if (!testUrl || !process.env.SANDBOT_TEST_USER_DATA) return entries
  return entries.map((e) => (e.id === 'composio' ? { ...e, mcpUrl: testUrl } : e))
}

// ---- ricerca nel catalogo (search_connectors del modello) ----

/** Cerca nel catalogo per nome/id/note; query vuota → tutto il catalogo. */
export function searchCatalog(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  const words = q.split(/\s+/)
  return entries.filter((e) => {
    // fase 17c (C5): la query può arrivare in entrambe le lingue — si cerca
    // in tutte le forme del campo Localized
    const hay = `${e.id} ${e.name} ${localizedText(e.notes)}`.toLowerCase()
    return words.some((w) => hay.includes(w))
  })
}

/** Il testo completo di un campo Localized (per la ricerca, entrambe le lingue). */
function localizedText(v: Localized): string {
  return typeof v === 'string' ? v : `${v.it} ${v.en}`
}

/** Stato testuale di un connettore per il modello (search_connectors): le note in inglese. */
export function connectorStatusLine(e: CatalogEntry, state: ConnectorState): string {
  const labels: Record<ConnectorStatus, string> = {
    not_connected: 'not connected',
    connected: 'connected',
    needs_auth: 'needs authorization (the user must click)',
    error: 'error'
  }
  const extra = state.status === 'error' && state.error ? ` — ${state.error}` : ''
  // fase 17c (C5): il modello legge la descrizione in inglese
  return `- ${e.name} (${e.id}): ${labels[state.status]}${extra}. ${pickLang(e.notes, 'en')}`
}

// ---- istruzioni per server nel system prompt (mcpCustomInstructionsByServerId) ----

/**
 * Sezione "# Istruzioni per i connettori" del system prompt: le istruzioni
 * personalizzate dell'utente per i server CONNESSI (pura).
 */
export function connectorsInstructionsSection(
  connected: Array<{ name: string; instructions: string }>
): string {
  const withText = connected.filter((c) => c.instructions.trim())
  if (!withText.length) return ''
  const parts = withText.map((c) => `## ${c.name}\n${c.instructions.trim()}`)
  return ['# Connector instructions', ...parts].join('\n\n')
}

/**
 * Sezione istruzioni calcolata dai soli settings (per il system prompt del
 * loop, senza il manager): server MCP con catalogId il cui connettore è
 * connesso e ha istruzioni non vuote.
 */
export function connectorInstructionsFromSettings(
  servers: Array<{ name: string; catalogId?: string }>,
  states: Record<string, ConnectorState>
): string {
  const connected = servers
    .filter((s) => s.catalogId && states[s.catalogId]?.status === 'connected')
    .map((s) => ({ name: s.name, instructions: states[s.catalogId!]?.instructions ?? '' }))
  return connectorsInstructionsSection(connected)
}

// ---- manager ----

export interface ConnectorsManagerDeps {
  store: ConnectorsSecretStore
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  /** Apre il browser di sistema tramite la UI (HostBridge); throwa senza UI. */
  openExternal(url: string): Promise<void>
  hasUi(): boolean
  /** Tool del server già registrato (lo connette con i token appena salvati). */
  toolsOf(serverId: string): Promise<ConnectorToolInfo[]>
  registerServer(cfg: { id: string; name: string; url: string }): void
  removeServer(id: string): void
  serverExists(id: string): boolean
  /** Notifica il cambio di stato (eventi alla UI). */
  onChange(): void
}

const STATE_SETTING = 'connectors.state'

function emptyState(): ConnectorState {
  return { status: 'not_connected', disabledTools: [], instructions: '' }
}

export function createConnectorsManager(deps: ConnectorsManagerDeps) {
  const catalog = loadCatalog()
  /**
   * Connettori con autorizzazione in sospesa (UI chiusa): si tiene L'ENTRY
   * richiesta, così il ripasso usa esattamente quella quando la finestra
   * viene aperta.
   */
  const pendingAuth = new Map<string, CatalogEntry>()

  const states = (): Record<string, ConnectorState> => deps.getSetting(STATE_SETTING, {})
  const setState = (id: string, patch: Partial<ConnectorState>): void => {
    const all = states()
    const cur = all[id] ?? emptyState()
    deps.setSetting(STATE_SETTING, { ...all, [id]: { ...cur, ...patch } })
    deps.onChange()
  }
  const stateOf = (id: string): ConnectorState => ({ ...emptyState(), ...(states()[id] ?? {}) })

  const staticCreds = (id: string): (() => Promise<StaticClientCredentials | null>) | undefined =>
    async () => (await deps.store.read<StaticClientCredentials>(id, 'staticClient')) ?? null

  /**
   * Il provider della connessione in corso: redirect = il callback server di
   * questa porta; per i server statici (Google) si aggiungono i parametri che
   * garantiscono il refresh token duraturo (access_type=offline). Fase 13
   * (punto 6): clientMetadataUrl dell'impostazione connectors.oauth.clientMetadataUrl
   * quando l'utente ospita un Client ID Metadata Document (CIMD).
   */
  const providerFor = (
    entry: CatalogEntry,
    redirectUrl: string,
    stateFactory: () => string
  ): OAuthClientProvider =>
    createOAuthProvider(
      {
        serverId: entry.id,
        redirectUrl,
        scope: entry.scopes?.join(' '),
        openExternal: deps.openExternal,
        store: deps.store,
        ...(entry.clientRegistration === 'static' ? { staticClient: staticCreds(entry.id) } : {}),
        ...(entry.clientRegistration === 'static'
          ? { extraAuthParams: { access_type: 'offline', prompt: 'consent' } }
          : {}),
        ...(deps.getSetting<string>('connectors.oauth.clientMetadataUrl', '') || undefined
          ? { clientMetadataUrl: deps.getSetting<string>('connectors.oauth.clientMetadataUrl', '') }
          : {}),
        stateFactory
      },
      (scope) => {
        // refresh fallito o credenziali rifiutate: serve di nuovo l'utente
        if (scope === 'tokens' || scope === 'all') {
          setState(entry.id, { status: 'needs_auth', error: uiText(UI.connSessionExpired) })
        }
      }
    )

  return {
    catalog,

    stateOf,

    /** Forza lo stato needs_auth (refresh fallito mentre il server era in uso). */
    markNeedsAuth(id: string, message: string): void {
      if (!catalog.some((e) => e.id === id)) return
      setState(id, { status: 'needs_auth', error: message })
    },

    /** Catalogo + stato + tool per la vista "Connetti app". */
    async list(): Promise<ConnectorView[]> {
      const out: ConnectorView[] = []
      for (const e of catalog) {
        const state = stateOf(e.id)
        let tools: ConnectorToolInfo[] = []
        if (deps.serverExists(e.id)) {
          try {
            tools = await deps.toolsOf(e.id)
            if (state.status !== 'connected') setState(e.id, { status: 'connected', error: undefined })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (state.status === 'connected') setState(e.id, { status: 'needs_auth', error: msg })
          }
        }
        out.push({
          ...e,
          state: stateOf(e.id),
          tools,
          ...(e.clientRegistration === 'static'
            ? { hasStaticCredentials: !!(await deps.store.read(e.id, 'staticClient')) }
            : {})
        })
      }
      return out
    },

    /**
     * Avvia la connessione di un connettore (dal click dell'utente). Senza UI
     * il connettore resta 'needs_auth' e l'autorizzazione riparte quando la
     * finestra viene aperta (retryPendingAuth). Il flusso NON blocca la RPC:
     * chi chiama non attende il browser.
     */
    connect(id: string): { started: boolean; status: ConnectorStatus; message?: string } {
      const entry = catalog.find((e) => e.id === id)
      if (!entry) return { started: false, status: 'error', message: uiText(UI.rpcConnectorUnknown, { id }) }
      // il flusso dura fino a 10 minuti (attesa del browser): parte in parallelo
      void this.runConnect(entry)
      return { started: true, status: stateOf(id).status }
    },

    /** Il flusso vero e proprio, separato per essere testabile in linea. */
    async runConnect(entry: CatalogEntry): Promise<{ status: ConnectorStatus; message?: string }> {
      if (entry.clientRegistration === 'static' && !(await deps.store.read(entry.id, 'staticClient'))) {
        const message = uiText(UI.connStaticClient)
        setState(entry.id, { status: 'error', error: message })
        return { status: 'error', message }
      }
      // senza UI non si può aprire il browser: resta needs_auth, la
      // connessione riparte quando l'utente apre l'app
      if (!deps.hasUi() && !(await deps.store.read(entry.id, 'oauth.tokens'))) {
        pendingAuth.set(entry.id, entry)
        setState(entry.id, { status: 'needs_auth', error: uiText(UI.connNeedsAuthOpenWindow) })
        return { status: 'needs_auth', message: uiText(UI.connWindowClosed) }
      }
      try {
        // fase 13 (punto 6): discovery/DCR/PKCE/refresh guidati da auth()
        // dell'SDK dentro il flusso col callback di loopback, che VALIDA
        // l'iss della redirect (RFC 9207) prima di riscattare il codice
        await authorizeWithLoopback(entry.mcpUrl, (redirectUrl, stateFactory) => providerFor(entry, redirectUrl, stateFactory))
        // i token ora sono validi e persistiti: il connettore diventa un
        // server MCP e lo si connette per davvero (lista tool)
        deps.registerServer({ id: entry.id, name: entry.name, url: entry.mcpUrl })
        const tools = await deps.toolsOf(entry.id)
        pendingAuth.delete(entry.id)
        setState(entry.id, { status: 'connected', error: undefined })
        return { status: 'connected', message: uiText(UI.connToolsAvailable, { count: tools.length }) }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // apertura del browser fallita (UI chiusa): autorizzazione rinviata
        if (!deps.hasUi()) {
          pendingAuth.set(entry.id, entry)
          setState(entry.id, { status: 'needs_auth', error: message })
          return { status: 'needs_auth', message }
        }
        setState(entry.id, { status: 'error', error: message })
        return { status: 'error', message }
      }
    },

    /** Riprova le connessioni rimaste in needs_auth per UI chiusa. */
    retryPendingAuth(): void {
      for (const entry of [...pendingAuth.values()]) void this.runConnect(entry)
    },

    /** Disconnette: revoca LOCALE dei token (nessuna chiamata al server). */
    async disconnect(id: string): Promise<void> {
      await deps.store.removeAll(id)
      deps.removeServer(id)
      pendingAuth.delete(id)
      setState(id, { ...emptyState() })
    },

    setDisabledTools(id: string, disabledTools: string[]): void {
      setState(id, { disabledTools })
    },

    setInstructions(id: string, instructions: string): void {
      setState(id, { instructions })
    },

    /** Salva cifrate le credenziali del client OAuth statico (Google). */
    async saveStaticClient(id: string, client_id: string, client_secret: string): Promise<void> {
      await deps.store.write(id, 'staticClient', { client_id, client_secret })
      deps.onChange()
    },

    /**
     * Fase catalogo app (P2/P4): il client OAuth statico di una curata è salvato?
     * Decide se la strada DIRETTA è «pronta senza configurazione» (apps:connect).
     */
    async hasStaticClient(id: string): Promise<boolean> {
      return !!(await deps.store.read(id, 'staticClient'))
    },

    /** Sezione istruzioni per i server connessi (system prompt). */
    instructionsSection(): string {
      const connected = catalog
        .filter((e) => deps.serverExists(e.id) && stateOf(e.id).status === 'connected')
        .map((e) => ({ name: e.name, instructions: stateOf(e.id).instructions }))
      return connectorsInstructionsSection(connected)
    }
  }
}

export type ConnectorsManager = ReturnType<typeof createConnectorsManager>
