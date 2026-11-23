// B3 (fase b20-bug): il FLUSSO del «Connetti» in un passo, PURO (senza
// React) — l'hook useConnectFlows lo crea una volta e ne legge le righe. Il
// clic aspetta la risposta di apps:connect con un TEMPO MASSIMO
// (APP_CONNECT_MAX_MS, orologio e timer finti): la risposta dice se il
// collegamento è partito oppure perché no; nessuna risposta entro il tempo
// massimo → la riga si sblocca con un avviso e «Riprova». I flussi che
// continuano in background (login di Composio, connettore diretto) portano
// sulla riga l'esito che il daemon pubblica. In ogni test stanno anche le
// guardie dei comportamenti di prima che NON devono cambiare.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { APP_CONNECT_MAX_MS } from '../../../shared/app-connect'
import {
  createAppConnectFlows, appFlowView, appConnectPublishedFailure,
  type AppConnectAttempt, type AppFlowEnv, type AppConnectFlowsDeps
} from '../lib/app-connect-flow'
import { i18n } from '../lib/i18n'
import { messages as itMessages } from '../locales/it/messages.mjs'

i18n.load('it', itMessages as never)
i18n.activate('it')

afterEach(() => { vi.useRealTimers() })

const row = { app: { id: 'spotify', name: 'Spotify', composioSlug: 'spotify' }, tagline: null, connected: null }
const rowOf = (id: string, name = id) => ({ app: { id, name, composioSlug: id }, tagline: null, connected: null })

/** L'ambiente della riga: ciò che i connettori e il gateway dicono sul momento. */
const env = (over: Partial<AppFlowEnv> = {}): AppFlowEnv =>
  ({ connected: null, composioSlug: 'spotify', gatewayConnected: true, pending: null, published: null, ...over })

interface Harness {
  flows: ReturnType<typeof createAppConnectFlows>
  appsConnect: ReturnType<typeof vi.fn>
  appsCancelConnect: ReturnType<typeof vi.fn>
  changed: ReturnType<typeof vi.fn>
  refreshed: ReturnType<typeof vi.fn>
}

/** Il flusso con le API finte e l'orologio dei timer sostituibili. */
const make = (over: Partial<AppConnectFlowsDeps> = {}, timers: { clear?: AppConnectFlowsDeps['clearTimer'] } = {}): Harness => {
  const appsConnect = vi.fn(async (_id: string): Promise<never> => ({ started: true, phase: 'app' }) as never)
  const appsCancelConnect = vi.fn(async (_id: string) => ({ ok: true }))
  const changed = vi.fn()
  const refreshed = vi.fn()
  let clock = 1_000
  const flows = createAppConnectFlows({
    appsConnect: (id) => appsConnect(id), appsCancelConnect: (id) => appsCancelConnect(id),
    changed, refreshed, now: () => clock,
    ...(timers.clear ? { clearTimer: timers.clear } : {}),
    ...over
  })
  return { flows, appsConnect, appsCancelConnect, changed, refreshed }
}

/** Una apps:connect che risponde solo quando lo dice il test. */
const deferred = (): { promise: Promise<unknown>; answer: (r: unknown) => void } => {
  let answer!: (r: unknown) => void
  const promise = new Promise((res) => { answer = res })
  return { promise, answer }
}

describe('B3 — l\'errore di apps:connect sblocca la riga e mostra il motivo', () => {
  it('apps:connect risponde «non partito» con un motivo → la riga non è più in attesa e mostra quel motivo (col dettaglio)', async () => {
    const h = make()
    h.appsConnect.mockResolvedValue({ started: false, phase: 'app', reason: 'connect-failed', error: 'Composio non ha aperto il login di Spotify.', detail: 'MCP error -32000: Connection closed' })
    await h.flows.connect(row)
    expect(h.flows.viewOf('spotify', env())).toEqual({
      kind: 'failed',
      failure: { reason: 'connect-failed', text: 'Composio non ha aperto il login di Spotify.', detail: 'MCP error -32000: Connection closed' }
    })
    expect(h.flows.hasPending()).toBe(false)
    expect(h.refreshed).toHaveBeenCalled()
  })

  it('apps:connect rifiuta (RPC in errore) → la riga si sblocca col testo dell\'errore (prima: restava «Connetti» muta)', async () => {
    const h = make()
    h.appsConnect.mockRejectedValue(new Error('connettori non disponibili'))
    await h.flows.connect(row)
    expect(h.flows.viewOf('spotify', env())).toEqual({ kind: 'failed', failure: { reason: 'connect-failed', text: 'connettori non disponibili' } })
    // un errore senza testo non lascia la riga muta
    h.appsConnect.mockRejectedValue('')
    await h.flows.connect(row)
    expect(h.flows.viewOf('spotify', env()).failure!.text.length).toBeGreaterThan(3)
  })

  it('apps:connect risponde senza motivo (app sconosciuta) → una frase sua; il conflitto con la chiave di progetto resta la proposta di prima', async () => {
    const h = make()
    h.appsConnect.mockResolvedValue({ started: false, reason: 'unknown-app' })
    await h.flows.connect(row)
    const view = h.flows.viewOf('spotify', env())
    expect(view.kind).toBe('failed')
    expect(view.failure!.text.length).toBeGreaterThan(3)
    expect(view.failure!.reason).toBe('connect-failed')
    // com'era: la chiave di progetto attiva si propone di essere disattivata (nessun errore)
    h.appsConnect.mockResolvedValue({ started: false, conflict: 'composio-key' })
    await h.flows.connect(row)
    expect(h.flows.viewOf('spotify', env())).toEqual({ kind: 'conflict', failure: null })
  })

  it('«Riprova» dopo l\'errore fa una richiesta nuova: la risposta «partito, fase app» mette la riga in attesa del login', async () => {
    const h = make()
    h.appsConnect.mockResolvedValueOnce({ started: false, reason: 'connect-failed', error: 'nope' })
    await h.flows.connect(row)
    expect(h.flows.viewOf('spotify', env()).kind).toBe('failed')
    await h.flows.connect(row)
    expect(h.appsConnect).toHaveBeenCalledTimes(2)
    expect(h.flows.viewOf('spotify', env())).toEqual({ kind: 'app', failure: null })
    expect(h.flows.hasPending()).toBe(true)
  })
})

describe('B3 — il tempo massimo sblocca la riga', () => {
  it('prima della risposta la riga è «in avvio»; un secondo clic non raddoppia la richiesta', async () => {
    vi.useFakeTimers()
    const d = deferred()
    const h = make()
    h.appsConnect.mockImplementation(() => d.promise as never)
    void h.flows.connect(row)
    expect(h.flows.viewOf('spotify', env())).toEqual({ kind: 'starting', failure: null })
    expect(h.flows.hasPending()).toBe(true)
    void h.flows.connect(row)
    expect(h.appsConnect).toHaveBeenCalledTimes(1)
    d.answer({ started: true, phase: 'app' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.flows.viewOf('spotify', env()).kind).toBe('app')
  })

  it('nessuna risposta entro APP_CONNECT_MAX_MS → la riga si sblocca con l\'avviso (tempo massimo con ripiego)', async () => {
    vi.useFakeTimers()
    const h = make({ appsConnect: () => new Promise(() => undefined) })
    void h.flows.connect(row)
    await vi.advanceTimersByTimeAsync(APP_CONNECT_MAX_MS - 1)
    expect(h.flows.viewOf('spotify', env()).kind, 'un ms prima del tempo massimo è ancora in avvio').toBe('starting')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.flows.viewOf('spotify', env())).toEqual({
      kind: 'failed', failure: { reason: 'timeout', text: 'Nessuna risposta entro 25 secondi: riprova.' }
    })
    expect(h.flows.hasPending()).toBe(false)
    expect(h.changed).toHaveBeenCalled()
  })

  it('il tempo massimo è una costante esportata e un test (o una sonda) può accorciarla (maxMs)', async () => {
    vi.useFakeTimers()
    expect(APP_CONNECT_MAX_MS).toBe(25_000)
    const h = make({ appsConnect: () => new Promise(() => undefined), maxMs: 300 })
    void h.flows.connect(row)
    await vi.advanceTimersByTimeAsync(299)
    expect(h.flows.viewOf('spotify', env()).kind).toBe('starting')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.flows.viewOf('spotify', env()).failure!.reason).toBe('timeout')
  })

  it('la risposta in tempo disarma il tempo massimo; una risposta TARDIVA porta il motivo vero (o l\'attesa, se il collegamento è partito davvero)', async () => {
    vi.useFakeTimers()
    const h = make()
    await h.flows.connect(row)
    await vi.advanceTimersByTimeAsync(APP_CONNECT_MAX_MS * 3)
    expect(h.flows.viewOf('spotify', env()).kind, 'la riga resta in attesa del login, che dura minuti').toBe('app')

    const slow = deferred()
    h.appsConnect.mockImplementation(() => slow.promise as never)
    const waiting = h.flows.connect(row)
    await vi.advanceTimersByTimeAsync(APP_CONNECT_MAX_MS)
    await waiting // connect si scioglie al tempo massimo: non resta appeso
    expect(h.flows.viewOf('spotify', env()).failure!.reason).toBe('timeout')
    slow.answer({ started: false, reason: 'not-connectable', error: 'Composio non gestisce il login di Spotify.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.flows.viewOf('spotify', env()).failure).toEqual({ reason: 'not-connectable', text: 'Composio non gestisce il login di Spotify.' })

    const lateStart = deferred()
    h.appsConnect.mockImplementation(() => lateStart.promise as never)
    const waiting2 = h.flows.connect(row)
    await vi.advanceTimersByTimeAsync(APP_CONNECT_MAX_MS)
    await waiting2
    lateStart.answer({ started: true, phase: 'app' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.flows.viewOf('spotify', env()).kind).toBe('app')
  })

  it('una risposta tardiva di una prova VECCHIA non tocca la riga: l\'Annulla libera subito (anche se il daemon non risponde) e chiama apps:cancel-connect', async () => {
    vi.useFakeTimers()
    const old = deferred()
    const h = make()
    h.appsConnect.mockImplementationOnce(() => old.promise as never)
    void h.flows.connect(row)
    await vi.advanceTimersByTimeAsync(APP_CONNECT_MAX_MS)
    await h.flows.cancel(row)
    expect(h.flows.viewOf('spotify', env())).toEqual({ kind: null, failure: null })
    expect(h.appsCancelConnect).toHaveBeenCalledWith('spotify')
    old.answer({ started: true, phase: 'app' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.flows.viewOf('spotify', env())).toEqual({ kind: null, failure: null })

    // Annulla durante l\'attesa del login; un daemon che rifiuta lascia comunque la riga libera
    const rejecting = make({ appsCancelConnect: async () => { throw new Error('già fermo') } })
    await rejecting.flows.connect(row)
    await rejecting.flows.cancel(row)
    expect(rejecting.flows.viewOf('spotify', env())).toEqual({ kind: null, failure: null })
    expect(rejecting.refreshed).toHaveBeenCalled()
  })

  it('allo smontaggio i timer si fermano (nessun aggiornamento dopo)', async () => {
    vi.useFakeTimers()
    const clear = vi.fn((id: unknown) => clearTimeout(id as never))
    const h = make({ appsConnect: () => new Promise(() => undefined) }, { clear })
    void h.flows.connect(row)
    h.flows.dispose()
    expect(clear).toHaveBeenCalledTimes(1)
    h.changed.mockClear()
    await vi.advanceTimersByTimeAsync(APP_CONNECT_MAX_MS)
    expect(h.changed).not.toHaveBeenCalled()
  })
})

describe('B3 — l\'attesa nel browser e i flussi in background (login di Composio, connettore diretto)', () => {
  it('il login di Composio finisce male → l\'esito pubblicato dal daemon sblocca la riga che aspettava, col motivo', async () => {
    const h = make()
    h.appsConnect.mockResolvedValue({ started: true, phase: 'login' })
    await h.flows.connect(row)
    // com'era, finché nessun esito arriva: «Accedi…» finché il gateway non è collegato, poi l\'attesa dell'app
    // (senza esito pubblicato — null, o un vecchio daemon che non lo manda — resta in attesa: l\'utente ha «Annulla»)
    expect(h.flows.viewOf('spotify', env({ gatewayConnected: false, published: null })).kind).toBe('login')
    expect(h.flows.viewOf('spotify', env({ gatewayConnected: false, published: undefined })).kind).toBe('login')
    expect(h.flows.viewOf('spotify', env({ gatewayConnected: true })).kind).toBe('app')
    const published = { appId: 'spotify', at: 2_000, reason: 'connect-failed' as const, error: 'Accesso a Composio non riuscito: Spotify non è stata collegata.', detail: 'Authorization failed' }
    expect(h.flows.viewOf('spotify', env({ gatewayConnected: false, published })).failure).toEqual({
      reason: 'connect-failed', text: 'Accesso a Composio non riuscito: Spotify non è stata collegata.', detail: 'Authorization failed'
    })
    // anche se intanto il gateway risulta collegato (login poi riuscito): l'esito di QUESTA prova conta
    expect(h.flows.viewOf('spotify', env({ gatewayConnected: true, published })).kind).toBe('failed')
  })

  it('un\'app che Composio NON può collegare lo dice PRIMA del clic successivo: il motivo resta sulla riga anche dopo che si è lasciata la pagina (finché dura il daemon)', () => {
    // nessuna prova in corso su questa riga: il daemon ricorda l'esito dell'ultima prova
    const remembered = { appId: 'spotify', at: 500, reason: 'not-connectable' as const, error: 'Composio non gestisce il login di Spotify: manca la sua configurazione di accesso sul tuo account Composio.' }
    expect(appFlowView('spotify', null, env({ published: remembered }))).toEqual({
      kind: 'failed', failure: { reason: 'not-connectable', text: remembered.error }
    })
    // gli esiti PASSEGGERI (nessuna risposta, errore di rete) non si ricordano: domani non valgono più
    const transient = { appId: 'spotify', at: 500, reason: 'timeout' as const, error: 'vecchio' }
    expect(appFlowView('spotify', null, env({ published: transient }))).toEqual({ kind: null, failure: null })
    // e se l'app è collegata (per esempio dalla chat) la riga non dice niente
    expect(appFlowView('spotify', null, env({ published: remembered, connected: 'connected' }))).toEqual({ kind: null, failure: null })
    expect(appFlowView('slack', null, env({ published: remembered }))).toEqual({ kind: null, failure: null })
  })

  it('un esito pubblicato VECCHIO (di prima del clic) o di un\'ALTRA riga non tocca questa prova', () => {
    const attempt: AppConnectAttempt = { token: 1, phase: 'app', startedAt: 1_000, failure: null }
    const stale = { appId: 'spotify', at: 999, reason: 'not-connectable' as const, error: 'vecchio' }
    expect(appFlowView('spotify', attempt, env({ published: stale }))).toEqual({ kind: 'app', failure: null })
    expect(appConnectPublishedFailure('spotify', 1_000, stale)).toBeNull()
    expect(appConnectPublishedFailure('spotify', 999, { ...stale, at: 1_000 })).toEqual({ ...stale, at: 1_000 })
    const other = { appId: 'slack', at: 2_000, reason: 'connect-failed' as const, error: 'x' }
    const inLogin: AppConnectAttempt = { token: 1, phase: 'login', startedAt: 1_000, failure: null }
    expect(appFlowView('spotify', inLogin, env({ gatewayConnected: false, published: other })).kind).toBe('login')
    expect(appConnectPublishedFailure('spotify', 1_000, other)).toBeNull()
    expect(appConnectPublishedFailure('spotify', 1_000, null)).toBeNull()
  })

  it('il clic che sostituisce l\'intenzione (replaces) libera la riga sostituita: torna a «Connetti», senza errore', async () => {
    const h = make()
    h.appsConnect.mockResolvedValueOnce({ started: true, phase: 'login' })
    await h.flows.connect(rowOf('gmail', 'Gmail')) // login di Composio in corso per Gmail
    expect(h.flows.viewOf('gmail', env({ composioSlug: 'gmail', gatewayConnected: false })).kind).toBe('login')
    h.appsConnect.mockResolvedValue({ started: true, phase: 'login', replaces: 'gmail' })
    await h.flows.connect(row) // secondo clic: Spotify
    expect(h.flows.viewOf('gmail', env({ composioSlug: 'gmail', gatewayConnected: false }))).toEqual({ kind: null, failure: null })
    expect(h.flows.viewOf('spotify', env({ gatewayConnected: false })).kind).toBe('login')
  })

  it('l\'attesa del login finita male (pending.failed del gateway) → «Non riuscito» col motivo; la riga collegata chiude il flusso e ferma il polling', async () => {
    const h = make()
    await h.flows.connect(row)
    const view = h.flows.viewOf('spotify', env({ pending: { slug: 'spotify', failed: true } }))
    expect(view.kind).toBe('failed')
    expect(view.failure!.reason).toBe('connect-failed')
    expect(view.failure!.text).toContain('login nel browser')
    // collegata: il flusso si chiude da solo (e con lei il polling)
    expect(h.flows.viewOf('spotify', env({ connected: 'connected' }))).toEqual({ kind: null, failure: null })
    expect(h.flows.dropClosed('spotify', 'slack')).toBe(1)
    expect(h.flows.hasPending()).toBe(false)
  })
})
