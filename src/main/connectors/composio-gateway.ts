// Fase Composio OAuth (C5): collegare le APP dentro il server Composio
// collegato con il login (C1). COMPOSIO_MANAGE_CONNECTIONS crea i link di
// autorizzazione (redirect_url): qui sta tutto il flusso —
// - DAL BOT: quando il modello chiama `add`, Homun NON passa il link nel
//   testo libero (lo toglie dal risultato al modello) e mostra una CARD DI
//   COLLEGAMENTO come offer_connector («Collega Gmail tramite Composio»).
//   Il clic è dell'utente: apre il link nel browser di sistema (lo stesso
//   controllo canOpenExternally di host.openExternal). Dopo il clic Homun
//   chiama da solo COMPOSIO_WAIT_FOR_CONNECTIONS per quel toolkit (timeout
//   5 minuti, annullabile) e aggiorna la card a «Collegata» o «Non riuscito»;
// - DALLA FINESTRA APP: il dettaglio di Composio elenca «App collegate
//   tramite Composio» e ha il campo «Collega un'app» (lista dei toolkit
//   comuni + ricerca libera dello slug); Collega → MANAGE_CONNECTIONS add →
//   stesso flusso (il clic nella finestra È dell'utente: il link si apre
//   subito e la finestra mostra l'attesa). Rimuovi → remove con account_id.
//
// L'ELENCO delle app collegate (C5 punto 3): MANAGE_CONNECTIONS `list`
// lavora per toolkit; Homun tiene in memoria e su disco i toolkit che
// l'utente ha collegato DA HOMUN e fa `list` su quelli all'apertura del
// dettaglio. Il formato esatto della risposta va letto dal risultato VERO
// (lo verifichiamo con l'account vero): qui il parsing è TOLLERANTE (cerca
// redirect_url, id e stati nei campi del JSON, vedi parseConnectionsResult)
// e quando lo stato non si deduce la riga dice «Gestisci su Composio».
//
// CA1 (fase composio-account): PIÙ ACCOUNT PER APP. Composio supporta più
// account per toolkit (add sempre con link nuovo e limite di account, rename
// e remove per account_id, il campo `account` di ogni voce del blocco): lo
// stato locale passa da «un account per app, sempre l'ultimo» a un ELENCO —
// `{ [slug]: { name, accounts: […] } }` con migrazione pura del formato
// vecchio (composio-accounts.ts) — e la verità resta `list`, che rilegge
// TUTTI gli account (id, alias, email, stato, is_default) e sostituisce
// l'elenco. L'alias predefinito è la parte locale dell'email, appena nota;
// altrimenti «account 2», «account 3»; normalizzati minuscoli, senza spazi
// e unici nel toolkit.
//
// Le dipendenze sono INIETTABILI (callMcp, openExternal, settings): i test
// girano senza daemon. Nessuna chiamata a Composio fuori dai flussi di qui.
import { randomUUID } from 'node:crypto'
import type { SandbotEvent } from '../../shared/types'
// K3 (ritocchi): il nome umano del toolkit, mai lo slug grezzo nella UI
import { composioToolkitName } from '../../shared/composio-names'
import {
  manageConnectionsAgentResult, manageConnectionsEntries, parseConnectionsResult, connectionsAccountsOf, accountLimitReachedIn
} from './tool-batch'
// B3 (fase b20-bug): la risposta di `add` dice che il login di questo toolkit Composio non lo gestisce
import { noManagedAuthIn } from './app-connect-start'
// CA1: lo stato multi-account e le sue funzioni pure (migrazione, alias)
import {
  assignDefaultAliases, gatewayAppStatusOf, normalizeAlias, normalizeGatewayApps, uniqueAlias,
  type GatewayAccount, type GatewayAppStored, type GatewayAppsStored, type GatewayAccountStatus
} from './composio-accounts'

/**
 * Il nome completo degli strumenti del server Composio nella pipeline. È il
 * DEFAULT (slug del server «composio»): da K6 dei ritocchi il runtime
 * inietta `serverTools` che ricava il prefisso dal nome VERO del server con
 * `catalogId === 'composio'` (mcp__<slug del nome>__…), così il gateway non
 * si rompe se il server ha un altro nome.
 */
export const COMPOSIO_SERVER_TOOLS = {
  manageConnections: 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS',
  waitForConnections: 'mcp__composio__COMPOSIO_WAIT_FOR_CONNECTIONS'
} as const

/** L'attesa del login: 5 minuti, annullabile (C5 punto 1). */
export const COMPOSIO_GATEWAY_WAIT_MS = 5 * 60_000
/** Ogni quanti secondi la UI rilegge lo stato mentre aspetta (il suo timer). */
const S_SETTING_APPS = 'composioGateway.apps'

export type ComposioGatewayAppStatus = GatewayAccountStatus

export interface ComposioGatewayAccountRpc {
  accountId: string | null
  alias?: string
  email?: string
  status: ComposioGatewayAppStatus
  isDefault?: boolean
}

export interface ComposioGatewayAppRpc {
  slug: string
  name: string
  status: ComposioGatewayAppStatus
  /** CA1: il primo degli account (is_default, altrimenti il primo attivo) —
   *  per compatibilità con chi leggeva la riga a un account solo */
  accountId: string | null
  /** V8: l'email dell'account da mostrare nel dettaglio (mai l'id tecnico) */
  email?: string
  /** CA1: TUTTI gli account dell'app, l'elenco che la finestra App mostra */
  accounts: ComposioGatewayAccountRpc[]
}

export interface ComposioGatewayStatusRpc {
  /** il server Composio è collegato (login C1 riuscito) */
  active: boolean
  connected: ComposioGatewayAppRpc[]
  /** il collegamento in attesa del login nel browser (Annulla = cancel) */
  pending: { slug: string; name: string; since: number; failed?: boolean } | null
}

export interface ComposioGatewayDeps {
  /** esegue uno strumento del server Composio (mcp.callTool, iniettabile). */
  callMcp(tool: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<string>
  /** il server Composio è attivo (connettore collegato, non needs_auth). */
  gatewayActive(): boolean
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  /** Apre il browser di sistema (HostBridge: stesso controllo canOpenExternally). */
  openExternal(url: string): Promise<void>
  hasUi(): boolean
  emit(e: SandbotEvent): void
  now?(): number
  /**
   * Fase catalogo app (P4): quanto aspettare fra i TENTATIVI di una chiamata
   * MCP che trova la connessione ancora aperta male (default 600 ms; i test
   * la azzerano).
   */
  retryDelayMs?(): number
  /**
   * K6 (ritocchi): i nomi completi degli strumenti del server Composio,
   * ricavati dal nome VERO del server con catalogId 'composio' (il default
   * resta lo slug storico «composio»: vedi COMPOSIO_SERVER_TOOLS).
   */
  serverTools?(): { manageConnections: string; waitForConnections: string }
  /**
   * CA4 (fase composio-account): chiude e RIAPRE il client MCP del server
   * Composio (la stessa riconnessione che RW3 usa per le letture del bot) —
   * su «Connection closed» la connessione chiusa non si riusa.
   */
  reopenMcp?(): void | Promise<void>
  /**
   * CA4: la riga di log di ogni riconnessione (default console.error: nel
   * daemon finisce in daemon.log) — MAI token né link negli argomenti.
   */
  logLine?(line: string): void
  /**
   * Fase mcp-setup (M5.3): un'app è appena diventata ACTIVE (transizione, non
   * il refresh di una già attiva) — il daemon può avvisare i bot con
   * un'offerta pendente per la curata DIRETTA dello stesso marchio.
   */
  onAppActive?(slug: string, name: string): void
}

/** Le opzioni di connectApp: il nome umano e, da CA1, il SECONDO account. */
export interface ConnectAppOptions {
  /** il nome umano del toolkit (hint della finestra App) */
  name?: string
  /** CA1: aggiunge un ALTRO account anche se ce n'è già uno attivo */
  another?: boolean
  /** CA1: l'alias dell'account nuovo (normalizzato: minuscolo, senza spazi) */
  alias?: string
  /**
   * B3 (fase b20-bug): la scadenza dell'AVVIO (epoch ms). Oltre, il link NON
   * si apre più nel browser: chi ha chiamato ha già risposto «nessuna
   * risposta» e una pagina di login che si apre minuti dopo confonderebbe
   * (l'esito è `reason: 'timeout'`). Si controlla prima di aprire il link e
   * fra un tentativo di `add` e l'altro.
   */
  notAfter?: number
}

/**
 * B3: perché connectApp NON è partito. `error` resta il testo di sempre
 * (gli altri chiamanti non cambiano); `reason` lo dice in codice a chi deve
 * spiegare la cosa all'utente (apps:connect): Composio non gestisce il login
 * di questo toolkit, il browser non si è aperto, il tempo dell'avvio è scaduto.
 */
export type ConnectAppFailReason = 'not-connectable' | 'browser' | 'timeout'

export type ComposioGatewayManager = ReturnType<typeof createComposioGatewayManager>

/** Un link di autorizzazione in attesa del clic dell'utente (la card lo chiama per chiave). */
interface PendingLink {
  key: string
  slug: string
  name: string
  url: string
  at: number
}

export function createComposioGatewayManager(deps: ComposioGatewayDeps) {
  const now = (): number => deps.now?.() ?? Date.now()
  /** i link creati da `add`, in attesa del clic dell'utente sulla card */
  const pendingLinks = new Map<string, PendingLink>()
  /** l'attesa del login in corso (annullabile) */
  let waiting: { slug: string; name: string; since: number; cancelled: boolean; failed?: boolean } | null = null
  /**
   * K2 (ritocchi): l'attesa IN CORSO per slug — card in chat e finestra App
   * possono avviare il collegamento dello stesso toolkit insieme: si RIUSA
   * l'attesa già partita (una sola chiamata WAIT_FOR_CONNECTIONS), non se ne
   * crea una seconda che, finita male per conto suo, lascerebbe un
   * «Non riuscito» accanto a un collegamento riuscito.
   */
  let inFlight: { slug: string; promise: Promise<'connected' | 'failed' | 'cancelled'> } | null = null
  /**
   * V8 (prova vera): il session_id del workflow — il server lo manda nella
   * risposta (data.session.id) e chiede di ripassarlo nelle chiamate
   * successive. Il gateway lo tiene e lo ripassa nelle SUE chiamate; il
   * modello lo gestisce da sé (i risultati gli passano invariati).
   */
  let sessionId: string | null = null

  // CA1: lo stato è NORMALIZZATO in lettura (migrazione pura e idempotente
  // del formato vecchio a un account) e si riscrive già normalizzato
  const apps = (): GatewayAppsStored => normalizeGatewayApps(deps.getSetting<unknown>(S_SETTING_APPS, {}))
  const setApps = (next: GatewayAppsStored): void => {
    deps.setSetting(S_SETTING_APPS, next)
    deps.emit({ type: 'connectors' })
  }
  const setApp = (slug: string, patch: GatewayAppStored): void => {
    const key = slug.toLowerCase()
    const wasActive = apps()[key]?.accounts.some((a) => a.status === 'ACTIVE') ?? false
    const next = { ...apps(), [key]: patch }
    setApps(next)
    const isActive = patch.accounts.some((a) => a.status === 'ACTIVE')
    // K2 (ritocchi): un toolkit diventato ACTIVE azzera la SUA attesa — il
    // riquadro «Non riuscito» non può restare accanto alla riga «Collegata»
    // anche se l'ACTIVE l'ha portato un'altra via (refreshAccounts, la card)
    if (isActive && waiting?.slug === key) waiting = null
    // fase mcp-setup (M5.3): SOLO la transizione a ACTIVE (il refresh di una
    // già attiva non ri-notifica — e le offerte soddisfatte non si ripetono)
    if (isActive && !wasActive) deps.onAppActive?.(key, patch.name)
  }
  const appOf = (slug: string): GatewayAppStored | undefined => apps()[slug.toLowerCase()]
  /** K6 (ritocchi): i nomi degli strumenti del server Composio (di default lo slug storico). */
  const serverTools = (): { manageConnections: string; waitForConnections: string } =>
    deps.serverTools?.() ?? COMPOSIO_SERVER_TOOLS

  /** Gli slug collegati localmente (per il classificatore C2 e le ricerche). */
  const connectedSlugs = (): string[] => Object.keys(apps())

  // ---- l'esecuzione di MANAGE_CONNECTIONS e il parsing tollerante ----

  /** V8: gli argomenti con il session_id del workflow, quando il server lo ha dato. */
  const withSession = (args: Record<string, unknown>): Record<string, unknown> =>
    sessionId ? { ...args, session_id: sessionId } : args

  /** CA4: l'errore di trasporto che si cura RIAPRENDO il client MCP. */
  const isConnectionClosed = (e: unknown): boolean =>
    /connection closed/i.test(e instanceof Error ? e.message : String(e))

  /** CA4: l'add/remove partito quando la connessione è caduta (NON si ripete). */
  class ConnectionDroppedError extends Error {
    constructor() {
      super('MCP connection closed while the request may have already been sent')
    }
  }

  /** CA4: la riga di log di una riapertura (server/strumento, MAI token né link). */
  const logReopen = (tool: string): void => {
    ;(deps.logLine ?? console.error)(`[sandbotd] composio gateway: mcp connection closed on ${tool}; client reopened`)
  }

  /**
   * CA4: la chiamata con la RIAPERTURA del client MCP — su «Connection
   * closed» il client si chiude, si riapre una volta e la chiamata si
   * ripete. Per le chiamate con EFFETTI che non si ripetono (add e remove:
   * la richiesta può essere già avvenuta) la ripetizione NON c'è: si
   * riapre, si segna la caduta e il chiamante decide rileggendo `list`.
   */
  async function callMcpReopen(
    tool: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
    effects = false
  ): Promise<string> {
    try {
      return await deps.callMcp(tool, args, opts)
    } catch (e) {
      if (!isConnectionClosed(e)) throw e
      logReopen(tool.split('__').slice(2).join('__') || tool)
      await deps.reopenMcp?.()
      if (effects) throw new ConnectionDroppedError()
      return await deps.callMcp(tool, args, opts)
    }
  }

  /**
   * Chiama COMPOSIO_MANAGE_CONNECTIONS e torna il risultato con i link
   * trovati (parseConnectionsResult: la forma VERA di V8 per prima, poi il
   * walk tollerante; il session_id si tiene per le chiamate successive).
   * CA4: add/remove non si ripetono dopo che la richiesta è partita — la
   * caduta di connessione si segnala al chiamante (che rilegge `list`).
   */
  async function runManageConnections(args: Record<string, unknown>): Promise<{ output: string; links: Array<{ url: string; toolkit?: string }> }> {
    const entries = manageConnectionsEntries(args)
    const effects = entries.some((e) => e.action === 'add' || e.action === 'remove')
    const output = await callMcpReopen(serverTools().manageConnections, withSession(args), undefined, effects)
    const parsed = parseConnectionsResult(output)
    if (parsed.sessionId) sessionId = parsed.sessionId
    return { output, links: parsed.redirectUrls }
  }

  /** Lo stato di un account di `list` → lo stato locale (V8 + CA1). */
  const accountStatusOf = (listStatus: string | undefined): GatewayAccountStatus => {
    const s = String(listStatus ?? '').toLowerCase()
    if (s === 'active') return 'ACTIVE'
    if (s === 'failed') return 'FAILED'
    return 'RECONNECT'
  }

  /**
   * CA1: TUTTI gli account di un toolkit dal `list` (id, alias, email,
   * stato, is_default), con gli alias predefiniti assegnati a chi non li ha
   * (la parte locale dell'email, altrimenti «account N», unici nel toolkit).
   * Il parsing tollerante può trovare lo STESSO account due volte (la forma
   * vera per prima, poi il walk): si deduplica per id, e i resti senza id
   * contano solo quando non c'è nessun account con id.
   * Ritenta un paio di volte: la connessione MCP appena aperta può rispondere
   * «Connection closed» (P4).
   */
  async function readAccounts(slug: string, cancelled: () => boolean): Promise<GatewayAccount[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { output } = await runManageConnections({ toolkits: [{ name: slug, action: 'list' }] })
        const parsed = parseConnectionsResult(output)
        const seen = new Set<string>()
        const accounts: GatewayAccount[] = []
        for (const a of connectionsAccountsOf(parsed, slug)) {
          // contano solo gli account con ID: il walk tollerante produce anche
          // «account» dal solo record del toolkit (status senza id) — rumore
          if (!a.id) continue
          if (seen.has(a.id)) continue
          seen.add(a.id)
          accounts.push({
            accountId: a.id,
            status: accountStatusOf(a.status),
            connectedAt: now(),
            ...(a.alias ? { alias: a.alias } : {}),
            ...(a.email ? { email: a.email } : {}),
            ...(a.isDefault ? { isDefault: true } : {})
          })
        }
        return assignDefaultAliases(accounts)
      } catch (e) {
        if (cancelled() || attempt >= 2) throw e
        await new Promise((r) => setTimeout(r, deps.retryDelayMs?.() ?? 600))
      }
    }
  }

  /**
   * V8 (compatibilità): lo stato VERITÀ di un toolkit lo dice `list` — la
   * forma a un account di prima, ricavata dagli account completi (per chi
   * chiede «è attivo? qual è l'account?»).
   */
  async function listToolkit(slug: string, cancelled: () => boolean): Promise<{ active: boolean; accountId: string | null; email?: string }> {
    const accounts = await readAccounts(slug, cancelled)
    const chosen = accounts.find((a) => a.status === 'ACTIVE') ?? accounts[0]
    return {
      active: accounts.some((a) => a.status === 'ACTIVE'),
      accountId: chosen?.accountId ?? null,
      ...(chosen?.email ? { email: chosen.email } : {})
    }
  }

  /**
   * Il risultato di una chiamata `add` DEL MODELLO (C5 punto 1): i link NON
   * passano nel testo libero — restano qui, la card li apre al clic. Torna
   * l'output PULITO per il modello e le card da creare in chat.
   */
  function handleAgentManageResult(
    args: Record<string, unknown>,
    output: string
  ): { output: string; cards: Array<{ key: string; slug: string; name: string }> } {
    const entries = manageConnectionsEntries(args).filter((e) => e.named && e.action === 'add')
    const parsed = parseConnectionsResult(output)
    const cards: Array<{ key: string; slug: string; name: string }> = []
    for (const link of parsed.redirectUrls) {
      const slug = (link.toolkit ?? entries[0]?.name ?? '').toLowerCase()
      if (!slug) continue
      const key = randomUUID()
      // K3 (ritocchi): il nome della card è UMANO («Collega Slack tramite
      // Composio»), mai lo slug del server
      const name = composioToolkitName(slug)
      pendingLinks.set(key, { key, slug, name, url: link.url, at: now() })
      cards.push({ key, slug, name })
    }
    // voci `add` senza link trovato: niente card, il modello lo sa dal testo
    return { output: manageConnectionsAgentResult(output, parsed.redirectUrls), cards }
  }

  // ---- l'attesa del login (WAIT_FOR_CONNECTIONS, 5 minuti, annullabile) ----

  /**
   * Chiama COMPOSIO_WAIT_FOR_CONNECTIONS per un toolkit e aggiorna lo stato
   * locale («Collegata» o «Non riuscito»). Il timeout del turno non c'entra:
   * è l'attesa del login dell'utente, annullabile dalla UI.
   *
   * V8 (prova vera): il formato vero di WAIT non lo conosciamo ancora, quindi
   * l'esito NON si deduce dalla sua risposta — dopo l'attesa il gateway chiama
   * SEMPRE `list` per quel toolkit e prende stato e account da lì. Se `list`
   * non dice active, il collegamento NON è riuscito.
   * CA1: il `list` rilegge TUTTI gli account; l'esito negativo segna i non
   * attivi come FAILED (l'esito definitivo di sempre, non «da ricollegare»).
   * V12: nemmeno un errore di WAIT basta per «Non riuscito» — prima si
   * verifica con `list`: finché ci sono tentativi o verifica in corso la riga
   * resta «Completa il login…», l'esito definitivo conta soltanto.
   *
   * K2 (ritocchi): se per quel toolkit c'è GIÀ un'attesa in corso, la si
   * riusa — una sola chiamata WAIT_FOR_CONNECTIONS anche se card in chat e
   * finestra App partono insieme.
   */
  function waitForApp(slugRaw: string, name: string): Promise<'connected' | 'failed' | 'cancelled'> {
    const slug = slugRaw.toLowerCase()
    if (inFlight?.slug === slug) return inFlight.promise
    const promise = runWait(slug, name)
    void promise.catch(() => undefined) // mai un unhandled rejection nel daemon
    return promise
  }

  async function runWait(slug: string, name: string): Promise<'connected' | 'failed' | 'cancelled'> {
    const state = { slug, name, since: now(), cancelled: false }
    const promise = (async () => {
      let outcome: 'connected' | 'failed' | 'cancelled'
      waiting = state
      deps.emit({ type: 'connectors' })
      /** CA1: chiude il collegamento con l'esito della verifica `list` (TUTTI gli account). */
      const finishByList = async (): Promise<'connected' | 'failed'> => {
        const accounts = await readAccounts(slug, () => state.cancelled)
        if (accounts.some((a) => a.status === 'ACTIVE')) {
          setApp(slug, { name, accounts })
          return 'connected'
        }
        // l'esito definitivo negativo: i non attivi sono FAILED (V8), non «da
        // ricollegare»; senza account resta la riga FALLITA di sempre
        setApp(slug, {
          name,
          accounts: accounts.length
            ? accounts.map((a) => (a.status === 'ACTIVE' ? a : { ...a, status: 'FAILED' as const }))
            : [{ accountId: null, status: 'FAILED', connectedAt: now() }]
        })
        return 'failed'
      }
      try {
        // P4 (catalogo app): la PRIMA chiamata dopo il login di Composio può
        // trovare la connessione MCP ancora aperta male («Connection closed»)
        // — si ritenta un paio di volte prima di arrendersi.
        // CA4: ogni tentativo passa dalla RIAPERTURA del client (la stessa
        // riconnessione delle letture del bot), non dalla stessa connessione chiusa
        for (let attempt = 0; ; attempt++) {
          try {
            await callMcpReopen(
              serverTools().waitForConnections,
              withSession({ toolkits: [slug], mode: 'any' }),
              { timeoutMs: COMPOSIO_GATEWAY_WAIT_MS }
            )
            break
          } catch (e) {
            if (state.cancelled || attempt >= 2) throw e
            await new Promise((r) => setTimeout(r, deps.retryDelayMs?.() ?? 600))
          }
        }
        outcome = state.cancelled ? 'cancelled' : await finishByList()
      } catch {
        // V12: WAIT finita male (errore di connessione, timeout) NON è ancora
        // un fallimento definitivo: il login può essere riuscito lo stesso e
        // `list` lo dice (così un collegamento riuscito non passa mai per
        // «Non riuscito», nemmeno un istante)
        if (state.cancelled) {
          outcome = 'cancelled'
        } else {
          try {
            outcome = await finishByList()
          } catch {
            setApp(slug, { name, accounts: [{ accountId: null, status: 'FAILED', connectedAt: now() }] })
            outcome = 'failed'
          }
        }
      }
      // l'attesa visibile finisce con l'esito; il flag failed resta per la
      // card finché non parte un collegamento nuovo (o lo stesso toolkit
      // diventa ACTIVE, K2: setApp lo azzera)
      if (waiting === state) waiting = outcome === 'failed' ? { ...state, failed: true } : null
      deps.emit({ type: 'connectors' })
      return outcome
    })()
    inFlight = { slug, promise }
    try {
      return await promise
    } finally {
      if (inFlight?.promise === promise) inFlight = null
    }
  }

  /** L'account «principale» di un'app: l'is_default, altrimenti il primo attivo. */
  const mainAccountOf = (app: GatewayAppStored): GatewayAccount | undefined =>
    app.accounts.find((a) => a.isDefault) ?? app.accounts.find((a) => a.status === 'ACTIVE') ?? app.accounts[0]

  return {
    /** Gli slug collegati (per il classificatore del blocco, C2). */
    connectedSlugs,

    /**
     * CA3: gli account ATTIVI di un toolkit, per la riga del prompt e per la
     * scelta dell'account nel loop (vuoto se l'app non è del gateway).
     */
    activeAccountsOf(slugRaw: string): Array<{ accountId: string | null; alias?: string; email?: string }> {
      return assignDefaultAliases(appOf(slugRaw)?.accounts ?? [])
        .filter((a) => a.status === 'ACTIVE')
        .map((a) => ({ accountId: a.accountId, ...(a.alias ? { alias: a.alias } : {}), ...(a.email ? { email: a.email } : {}) }))
    },

    /** Lo stato per la UI (C5 punto 3) — mai i link, mai i token. */
    status(): ComposioGatewayStatusRpc {
      const rows: ComposioGatewayAppRpc[] = Object.entries(apps()).map(([slug, a]) => {
        // CA1: gli alias predefiniti valgono anche per i dati appena migrati
        // (il formato vecchio non aveva alias ma poteva avere l'email)
        const withAliases = assignDefaultAliases(a.accounts)
        const main = mainAccountOf({ ...a, accounts: withAliases })
        return {
          slug,
          // K3 (ritocchi): un nome salvato UGUALE allo slug (dati delle sonde
          // vecchie) si sostituisce col nome umano alla lettura
          name: a.name === slug ? composioToolkitName(slug) : a.name,
          status: gatewayAppStatusOf(a),
          accountId: main?.accountId ?? null,
          ...(main?.email ? { email: main.email } : {}),
          // CA1: l'elenco di TUTTI gli account per la finestra App
          accounts: withAliases.map((acc) => ({
            accountId: acc.accountId,
            ...(acc.alias ? { alias: acc.alias } : {}),
            ...(acc.email ? { email: acc.email } : {}),
            status: acc.status,
            ...(acc.isDefault ? { isDefault: true } : {})
          }))
        }
      })
      rows.sort((a, b) => a.name.localeCompare(b.name))
      return {
        active: deps.gatewayActive(),
        connected: rows,
        pending: waiting ? { slug: waiting.slug, name: waiting.name, since: waiting.since, ...(waiting.failed ? { failed: true } : {}) } : null
      }
    },

    /** Il flusso DAL BOT (C5 punto 1): il risultato `add` del modello → card. */
    handleAgentManageResult,

    /**
     * Il clic su «Collega» della card in chat: apre il link nel browser di
     * sistema e aspetta il login (WAIT_FOR_CONNECTIONS, 5 min, annullabile).
     */
    async cardConnect(key: string): Promise<{ ok: boolean; error?: string }> {
      const link = pendingLinks.get(key)
      if (!link) return { ok: false, error: 'link no longer valid' }
      pendingLinks.delete(key)
      try {
        await deps.openExternal(link.url)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      void waitForApp(link.slug, link.name)
      return { ok: true }
    },

    /**
     * Il flusso DALLA FINESTRA APP (C5 punto 2): Collega → add per lo slug →
     * il link si apre subito (il clic nella finestra è dell'utente) → attesa.
     * Fase catalogo app (P4): subito dopo il LOGIN di Composio la prima
     * chiamata può trovare la connessione MCP ancora aperta male («Connection
     * closed»): l'add si ritenta un paio di volte prima di arrendersi.
     * V8 (prova vera): PRIMA dell'add si chiama `list` per quel toolkit — se
     * c'è GIÀ un account attivo, niente add (mai account doppi sullo stesso
     * utente): la riga diventa «Collegata» e la risposta lo dice.
     * CA1: con `another: true` il controllo si SALTA (il secondo account si
     * vuole davvero) e l'add porta l'ALIAS normalizzato e univoco; se il
     * server dice che si è al massimo di account, la risposta lo dice in
     * parole povere (`error: 'account-limit'` + quanti se ne hanno).
     * B3 (fase b20-bug): l'esito dice anche PERCHÉ (`reason`): un toolkit il
     * cui login Composio non gestisce (`not-connectable`), il browser che non
     * si apre (`browser`), l'avvio scaduto (`notAfter` → `timeout`). Prima
     * «nessun link» era un errore come un altro e finiva in una promessa
     * orfana: la riga restava «Completa il login…» per sempre.
     */
    async connectApp(slugRaw: string, opts: ConnectAppOptions = {}): Promise<{ ok: boolean; already?: boolean; error?: string; reason?: ConnectAppFailReason; accountCount?: number }> {
      const slug = slugRaw.toLowerCase()
      if (!deps.gatewayActive()) return { ok: false, error: 'not-active' }
      // B3: l'avvio scaduto non apre più niente nel browser
      const expired = (): boolean => opts.notAfter !== undefined && now() > opts.notAfter
      const timedOut = (): { ok: false; error: string; reason: 'timeout' } => ({ ok: false, error: 'connection start timed out', reason: 'timeout' })
      const name = composioToolkitName(opts.name ?? slug)
      let existing: GatewayAccount[] = []
      try {
        existing = await readAccounts(slug, () => false)
        if (!opts.another && existing.some((a) => a.status === 'ACTIVE')) {
          setApp(slug, { name, accounts: existing })
          return { ok: true, already: true }
        }
      } catch { /* list non risponde: si prova l'add come oggi */ }
      if (expired()) return timedOut()
      // CA1: l'alias richiesto, normalizzato e univoco fra gli account che ci
      // sono già (il suffisso -2, -3… se serve)
      const alias = typeof opts.alias === 'string' && normalizeAlias(opts.alias)
        ? uniqueAlias(normalizeAlias(opts.alias), new Set(existing.flatMap((a) => (a.alias ? [a.alias] : []))))
        : undefined
      let link: string | undefined
      let lastError = ''
      for (let attempt = 0; attempt < 3 && !link; attempt++) {
        try {
          const { output, links } = await runManageConnections({
            toolkits: [{ name: slug, action: 'add', ...(alias ? { alias } : {}) }]
          })
          link = links[0]?.url
          if (!link) {
            // CA1: il server può rispondere che si è al MASSIMO di account —
            // la UI lo dice in parole semplici, niente errore grezzo
            if (accountLimitReachedIn(output)) {
              return { ok: false, error: 'account-limit', accountCount: existing.length || 5 }
            }
            // B3: Composio non gestisce il login di questo toolkit (serve la
            // configurazione di accesso): lo si dice in codice, è un motivo
            // che si spiega — non «nessun link» come un errore qualunque
            if (noManagedAuthIn(output)) {
              return { ok: false, error: 'no Composio-managed auth config for this toolkit', reason: 'not-connectable' }
            }
            return { ok: false, error: 'no authorization link in the response' }
          }
        } catch (e) {
          if (e instanceof ConnectionDroppedError) {
            // CA4: l'add NON si ripete (la richiesta può essere già partita):
            // si rilegge `list` e si decide da lì
            try {
              const after = await readAccounts(slug, () => false)
              if (after.some((a) => a.status === 'ACTIVE')) {
                setApp(slug, { name, accounts: after })
                return { ok: true, already: true }
              }
            } catch { /* il list non risponde: l'esito resta incerto */ }
            return { ok: false, error: 'connection closed while adding the account; open the app again to see its accounts' }
          }
          lastError = e instanceof Error ? e.message : String(e)
          // B3: scaduto il tempo dell'avvio non si ritenta
          if (expired()) return timedOut()
          if (attempt < 2) await new Promise((r) => setTimeout(r, deps.retryDelayMs?.() ?? 600))
        }
      }
      if (!link) return { ok: false, error: lastError || 'connection error' }
      if (expired()) return timedOut()
      try {
        await deps.openExternal(link)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), reason: 'browser' }
      }
      // K3 (ritocchi): il nome dell'attesa è umano anche senza hint
      void waitForApp(slug, name)
      return { ok: true }
    },

    /**
     * CA1 punto 3: rinomina un ACCOUNT (rename con account_id + alias
     * normalizzato e univoco), poi `list` rilegge l'elenco.
     */
    async renameAccount(slugRaw: string, accountId: string, aliasInput?: string): Promise<{ ok: boolean; error?: string }> {
      const slug = slugRaw.toLowerCase()
      const app = appOf(slug)
      if (!app) return { ok: false, error: 'app not connected from Homun' }
      const base = normalizeAlias(String(aliasInput ?? ''))
      if (!base) return { ok: false, error: 'alias required' }
      const taken = new Set(app.accounts.filter((a) => a.accountId !== accountId).flatMap((a) => (a.alias ? [a.alias] : [])))
      const alias = uniqueAlias(base, taken)
      try {
        await runManageConnections({ toolkits: [{ name: slug, action: 'rename', account_id: accountId, alias }] })
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      try {
        const accounts = await readAccounts(slug, () => false)
        setApp(slug, { ...app, accounts })
      } catch {
        // il rename è partito: l'elenco si rileggerà al prossimo refresh
      }
      return { ok: true }
    },

    /**
     * CA1 punto 3: toglie un ACCOUNT (remove con account_id); togliere
     * l'ultimo toglie l'app. L'esito lo decide il `list` di dopo.
     */
    async removeAccount(slugRaw: string, accountId: string): Promise<{ ok: boolean; error?: string }> {
      const slug = slugRaw.toLowerCase()
      const app = appOf(slug)
      if (!app) return { ok: false, error: 'app not connected from Homun' }
      try {
        await runManageConnections({ toolkits: [{ name: slug, action: 'remove', account_id: accountId }] })
      } catch (e) {
        // CA4: il remove NON si ripete dopo che la richiesta è partita —
        // decide il `list` di sotto (l'account può essere già tolto)
        if (!(e instanceof ConnectionDroppedError)) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      }
      try {
        const accounts = await readAccounts(slug, () => false)
        if (accounts.length === 0) {
          const next = { ...apps() }
          delete next[slug]
          setApps(next)
        } else {
          setApp(slug, { ...app, accounts })
        }
      } catch {
        // il remove è partito ma il list non risponde: si toglie l'account
        // anche in locale (era la richiesta dell'utente), l'elenco tornerà
        const rest = app.accounts.filter((a) => a.accountId !== accountId)
        if (rest.length === 0) {
          const next = { ...apps() }
          delete next[slug]
          setApps(next)
        } else {
          setApp(slug, { ...app, accounts: rest })
        }
      }
      return { ok: true }
    },

    /** Rimuovi (C5 punto 2): remove con account_id per OGNI account, conferma chiesta dalla UI. */
    async removeApp(slugRaw: string): Promise<{ ok: boolean; error?: string }> {
      const slug = slugRaw.toLowerCase()
      const app = appOf(slug)
      if (!app) return { ok: false, error: 'app not connected from Homun' }
      try {
        for (const account of app.accounts) {
          if (account.accountId) {
            await runManageConnections({
              toolkits: [{ name: slug, action: 'remove', account_id: account.accountId }]
            })
          }
        }
      } catch (e) {
        // CA4: un remove caduto non si ripete — la riga locale va via comunque
        // e il `list` al prossimo refresh dice la verità del server
        if (!(e instanceof ConnectionDroppedError)) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      } finally {
        const next = { ...apps() }
        delete next[slug]
        setApps(next)
      }
      return { ok: true }
    },

    /** Annulla l'attesa del login (il bottone Annulla della UI; K2: anche «Chiudi» di un attesa non riuscita). */
    cancelWait(): void {
      if (waiting) {
        waiting.cancelled = true
        waiting = null
        // K2: l'attesa annullata non si riusa — un collegamento ripartito
        // subito dopo deve chiamare di nuovo WAIT_FOR_CONNECTIONS
        inFlight = null
        deps.emit({ type: 'connectors' })
      }
    },

    /**
     * C5 punto 3 + CA1: `list` sui toolkit collegati da Homun — rilegge TUTTI
     * gli account di ogni toolkit (id, alias, email, stato, is_default) e
     * SOSTITUISCE l'elenco; lo stato non deducibile lascia la riga com'è (la
     * UI mostra «Gestisci su Composio» quando serve). K2 (ritocchi): passa da
     * setApp, così un ACTIVE del toolkit azzera la sua attesa «Non riuscito».
     */
    async refreshAccounts(): Promise<void> {
      if (!deps.gatewayActive()) return
      for (const slug of Object.keys(apps())) {
        const stored = appOf(slug)
        if (!stored) continue
        try {
          const accounts = await readAccounts(slug, () => false)
          if (accounts.length === 0) continue
          // il connectedAt degli account che si conoscono già non si azzera
          const merged = accounts.map((a) => ({
            ...a,
            connectedAt: stored.accounts.find((old) => old.accountId !== null && old.accountId === a.accountId)?.connectedAt ?? a.connectedAt
          }))
          if (merged.some((a) => a.status === 'ACTIVE')) {
            setApp(slug, { ...stored, accounts: merged })
          } else {
            // V8: stati che non sono active → da ricollegare (o FALLITA del
            // server: la riga dice «Ricollega», non resta «Collegata» fissa)
            setApp(slug, { ...stored, accounts: merged })
          }
        } catch {
          // senza rete o server giù: la riga resta com'è, mai un'eccezione alla UI
        }
      }
    },

    /** Lo stato per il modello/loop: il link di una card è ancora apribile? */
    hasPendingLink(key: string): boolean {
      return pendingLinks.has(key)
    }
  }
}

// ---- i punti d'ingresso per il loop (niente import inversi) ----

let active: ComposioGatewayManager | null = null

/** Il daemon registra QUI il manager (runtime.ts); null = server Composio non attivo. */
export function setActiveComposioGateway(manager: ComposioGatewayManager | null): void {
  active = manager
}

/** C5: il gestore attivo (null se il server Composio non è collegato). */
export function composioGateway(): ComposioGatewayManager | null {
  return active
}
