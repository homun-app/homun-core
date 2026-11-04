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
// Le dipendenze sono INIETTABILI (callMcp, openExternal, settings): i test
// girano senza daemon. Nessuna chiamata a Composio fuori dai flussi di qui.
import { randomUUID } from 'node:crypto'
import type { SandbotEvent } from '../../shared/types'
// K3 (ritocchi): il nome umano del toolkit, mai lo slug grezzo nella UI
import { composioToolkitName } from '../../shared/composio-names'
import {
  manageConnectionsAgentResult, manageConnectionsEntries, parseConnectionsResult, connectionsAccountsOf
} from './tool-batch'

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

export type ComposioGatewayAppStatus = 'ACTIVE' | 'RECONNECT' | 'FAILED'

interface StoredGatewayApp {
  name: string
  accountId: string | null
  status: ComposioGatewayAppStatus
  connectedAt: number
  /** V8: l'email dell'account quando `list` la dà (user_info.email) */
  email?: string
}

/** Lo stato locale delle app collegate tramite il server Composio. */
type GatewayAppsSetting = Record<string, StoredGatewayApp>

export interface ComposioGatewayAppRpc {
  slug: string
  name: string
  status: ComposioGatewayAppStatus
  accountId: string | null
  /** V8: l'email dell'account da mostrare nel dettaglio (mai l'id tecnico) */
  email?: string
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
   * Fase mcp-setup (M5.3): un'app è appena diventata ACTIVE (transizione, non
   * il refresh di una già attiva) — il daemon può avvisare i bot con
   * un'offerta pendente per la curata DIRETTA dello stesso marchio.
   */
  onAppActive?(slug: string, name: string): void
}

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

  const apps = (): GatewayAppsSetting => deps.getSetting<GatewayAppsSetting>(S_SETTING_APPS, {})
  const setApps = (next: GatewayAppsSetting): void => {
    deps.setSetting(S_SETTING_APPS, next)
    deps.emit({ type: 'connectors' })
  }
  const setApp = (slug: string, patch: StoredGatewayApp): void => {
    const key = slug.toLowerCase()
    const wasActive = apps()[key]?.status === 'ACTIVE'
    setApps({ ...apps(), [key]: patch })
    // K2 (ritocchi): un toolkit diventato ACTIVE azzera la SUA attesa — il
    // riquadro «Non riuscito» non può restare accanto alla riga «Collegata»
    // anche se l'ACTIVE l'ha portato un'altra via (refreshAccounts, la card)
    if (patch.status === 'ACTIVE' && waiting?.slug === key) waiting = null
    // fase mcp-setup (M5.3): SOLO la transizione a ACTIVE (il refresh di una
    // già attiva non ri-notifica — e le offerte soddisfatte non si ripetono)
    if (patch.status === 'ACTIVE' && !wasActive) deps.onAppActive?.(key, patch.name)
  }
  const appOf = (slug: string): StoredGatewayApp | undefined => apps()[slug.toLowerCase()]
  /** K6 (ritocchi): i nomi degli strumenti del server Composio (di default lo slug storico). */
  const serverTools = (): { manageConnections: string; waitForConnections: string } =>
    deps.serverTools?.() ?? COMPOSIO_SERVER_TOOLS

  /** Gli slug collegati localmente (per il classificatore C2 e le ricerche). */
  const connectedSlugs = (): string[] => Object.keys(apps())

  // ---- l'esecuzione di MANAGE_CONNECTIONS e il parsing tollerante ----

  /** V8: gli argomenti con il session_id del workflow, quando il server lo ha dato. */
  const withSession = (args: Record<string, unknown>): Record<string, unknown> =>
    sessionId ? { ...args, session_id: sessionId } : args

  /**
   * Chiama COMPOSIO_MANAGE_CONNECTIONS e torna il risultato con i link
   * trovati (parseConnectionsResult: la forma VERA di V8 per prima, poi il
   * walk tollerante; il session_id si tiene per le chiamate successive).
   */
  async function runManageConnections(args: Record<string, unknown>): Promise<{ output: string; links: Array<{ url: string; toolkit?: string }> }> {
    const output = await deps.callMcp(serverTools().manageConnections, withSession(args))
    const parsed = parseConnectionsResult(output)
    if (parsed.sessionId) sessionId = parsed.sessionId
    return { output, links: parsed.redirectUrls }
  }

  /**
   * V8: lo stato VERITÀ di un toolkit lo dice `list` — l'account da tenere è
   * l'is_default, altrimenti il primo attivo. Ritenta un paio di volte: la
   * connessione MCP appena aperta può rispondere «Connection closed» (P4).
   */
  async function listToolkit(slug: string, cancelled: () => boolean): Promise<{ active: boolean; accountId: string | null; email?: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { output } = await runManageConnections({ toolkits: [{ name: slug, action: 'list' }] })
        const parsed = parseConnectionsResult(output)
        const accounts = connectionsAccountsOf(parsed, slug)
        const chosen = accounts[0]
        return {
          active: accounts.some((a) => String(a.status ?? '').toLowerCase() === 'active'),
          accountId: chosen?.id ?? null,
          ...(chosen?.email ? { email: chosen.email } : {})
        }
      } catch (e) {
        if (cancelled() || attempt >= 2) throw e
        await new Promise((r) => setTimeout(r, deps.retryDelayMs?.() ?? 600))
      }
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
   * SEMPRE `list` per quel toolkit e prende stato e account da lì (l'account
   * is_default, altrimenti il primo attivo). Se `list` non dice active, il
   * collegamento NON è riuscito.
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
      /** V8: chiude il collegamento con l'esito della verifica `list`. */
      const finishByList = async (): Promise<'connected' | 'failed'> => {
        const v = await listToolkit(slug, () => state.cancelled)
        if (v.active) {
          setApp(slug, { name, accountId: v.accountId, status: 'ACTIVE', connectedAt: now(), ...(v.email ? { email: v.email } : {}) })
          return 'connected'
        }
        setApp(slug, { name, accountId: null, status: 'FAILED', connectedAt: now() })
        return 'failed'
      }
      try {
        // P4 (catalogo app): la PRIMA chiamata dopo il login di Composio può
        // trovare la connessione MCP ancora aperta male («Connection closed»)
        // — si ritenta un paio di volte prima di arrendersi
        for (let attempt = 0; ; attempt++) {
          try {
            await deps.callMcp(
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
            setApp(slug, { name, accountId: null, status: 'FAILED', connectedAt: now() })
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

  return {
    /** Gli slug collegati (per il classificatore del blocco, C2). */
    connectedSlugs,

    /** Lo stato per la UI (C5 punto 3) — mai i link, mai i token. */
    status(): ComposioGatewayStatusRpc {
      const rows: ComposioGatewayAppRpc[] = Object.entries(apps()).map(([slug, a]) => ({
        slug,
        // K3 (ritocchi): un nome salvato UGUALE allo slug (dati delle sonde
        // vecchie) si sostituisce col nome umano alla lettura
        name: a.name === slug ? composioToolkitName(slug) : a.name,
        status: a.status,
        accountId: a.accountId,
        ...(a.email ? { email: a.email } : {})
      }))
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
     * utente): la riga diventa «Collegata» e la risposta lo dice. Il modello
     * resta libero di chiedere un SECONDO account (la sua chiamata add passa
     * dalla card, come oggi).
     */
    async connectApp(slugRaw: string, nameHint?: string): Promise<{ ok: boolean; already?: boolean; error?: string }> {
      const slug = slugRaw.toLowerCase()
      if (!deps.gatewayActive()) return { ok: false, error: 'not-active' }
      try {
        const v = await listToolkit(slug, () => false)
        if (v.active) {
          setApp(slug, {
            name: composioToolkitName(nameHint ?? slug),
            accountId: v.accountId,
            status: 'ACTIVE',
            connectedAt: now(),
            ...(v.email ? { email: v.email } : {})
          })
          return { ok: true, already: true }
        }
      } catch { /* list non risponde: si prova l'add come oggi */ }
      let link: string | undefined
      let lastError = ''
      for (let attempt = 0; attempt < 3 && !link; attempt++) {
        try {
          const { links } = await runManageConnections({
            toolkits: [{ name: slug, action: 'add' }]
          })
          link = links[0]?.url
          if (!link) return { ok: false, error: 'no authorization link in the response' }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e)
          if (attempt < 2) await new Promise((r) => setTimeout(r, deps.retryDelayMs?.() ?? 600))
        }
      }
      if (!link) return { ok: false, error: lastError || 'connection error' }
      try {
        await deps.openExternal(link)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      // K3 (ritocchi): il nome dell'attesa è umano anche senza hint
      void waitForApp(slug, composioToolkitName(nameHint ?? slug))
      return { ok: true }
    },

    /** Rimuovi (C5 punto 2): remove con account_id, conferma chiesta dalla UI. */
    async removeApp(slugRaw: string): Promise<{ ok: boolean; error?: string }> {
      const slug = slugRaw.toLowerCase()
      const app = appOf(slug)
      if (!app) return { ok: false, error: 'app not connected from Homun' }
      try {
        if (app.accountId) {
          await runManageConnections({
            toolkits: [{ name: slug, action: 'remove', account_id: app.accountId }]
          })
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
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
     * C5 punto 3: `list` sui toolkit collegati da Homun — V8: si legge la
     * forma VERA (data.results.<toolkit>, l'account is_default con l'email);
     * lo stato non deducibile lascia la riga com'è (la UI mostra «Gestisci su
     * Composio» quando serve). K2 (ritocchi): passa da setApp, così un ACTIVE
     * del toolkit azzera la sua attesa «Non riuscito».
     */
    async refreshAccounts(): Promise<void> {
      if (!deps.gatewayActive()) return
      for (const slug of Object.keys(apps())) {
        const stored = appOf(slug)
        if (!stored) continue
        try {
          const v = await listToolkit(slug, () => false)
          if (v.active) {
            setApp(slug, { ...stored, status: 'ACTIVE', accountId: v.accountId ?? stored.accountId, ...(v.email ? { email: v.email } : {}) })
          } else {
            // V8: stati che non sono active → da ricollegare (o FALLITA del
            // server: la riga dice «Ricollega», non resta «Collegata» fissa)
            setApp(slug, { ...stored, status: 'RECONNECT' })
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
