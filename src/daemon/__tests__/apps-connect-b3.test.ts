// B3 (fase b20-bug): «Connetti» su Spotify (via Composio) non apriva il
// collegamento e la riga restava bloccata. La causa è QUI: apps:connect
// rispondeva «partito» (started true, phase app) PRIMA di sapere com'era
// andata la chiamata a Composio — l'esito di connectApp finiva in una
// promessa orfana — e i flussi che continuano in background (il login di
// Composio, il connettore diretto) non dicevano a nessuno quando finivano
// male. Ogni esito deve arrivare alla riga: o il collegamento è avviato
// (il login è aperto nel browser), o c'è un motivo in parole; e se Composio
// non risponde, entro un tempo massimo. Dipendenze TUTTE finte.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../test-tmp'

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async () => { throw new Error('non chiamato in questi test') }
}))

const { setDataDir, setSetting, db } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { ConnectorsManager } from '../../main/connectors'
import type { ComposioManager } from '../../main/connectors/composio'
import type { ComposioGatewayManager } from '../../main/connectors/composio-gateway'
import type { CatalogEntry } from '../../main/connectors'
import type { AppsConnectResult, ComposioGatewayStatusInfo } from '../../shared/types'

const fakeWorker = { poke: () => undefined, drain: async () => undefined, start: () => undefined, stop: () => undefined } as unknown as JobWorker

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-appsconnect-b3-'))
  setDataDir(dir)
  db()
  // i testi del catalogo UI nella lingua dell'interfaccia (qui l'italiano)
  setSetting('ui.activeLanguage', 'it')
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Un connettore finto del catalogo, come lo legge apps:connect. */
const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name: id, logo: '·', mcpUrl: 'https://example.com', clientRegistration: 'dynamic',
  docsUrl: 'https://docs.example.com', notes: { it: 'n', en: 'n' }, ...extra
}) as CatalogEntry

type ConnectAppResult = Awaited<ReturnType<ComposioGatewayManager['connectApp']>>
type RunConnectResult = { status: string; message?: string }

interface FakeState {
  /** Composio già «entrato» (login fatto): la strada è connectApp subito */
  gatewayActive: boolean
  pending: ComposioGatewayStatusInfo['pending']
  connectApp: (slug: string, opts?: { name?: string }) => Promise<ConnectAppResult>
  connectAppCalls: Array<{ slug: string; name?: string }>
  cancelWaitCalls: number
  runConnect: (e: CatalogEntry) => Promise<RunConnectResult>
  runConnectCalls: CatalogEntry[]
  disconnectCalls: string[]
  composioKeyActive: boolean
}

const newState = (over: Partial<FakeState> = {}): FakeState => ({
  gatewayActive: false, pending: null,
  connectApp: async () => ({ ok: true }), connectAppCalls: [], cancelWaitCalls: 0,
  runConnect: async () => ({ status: 'connected' }), runConnectCalls: [], disconnectCalls: [],
  composioKeyActive: false,
  ...over
})

/** I manager finti: si guida tutto da `state`. */
const apiOf = (state: FakeState, opts: { appConnectTimeoutMs?: number } = {}) => {
  const connectors = {
    catalog: [
      entry('composio', { gateway: true }),
      entry('gmail', { clientRegistration: 'static' }),
      entry('linear')
    ],
    stateOf: (id: string) => ({ status: state.gatewayActive && id === 'composio' ? 'connected' : 'not_connected', disabledTools: [], instructions: '' }),
    hasStaticClient: async () => false,
    runConnect: async (e: CatalogEntry) => {
      state.runConnectCalls.push(e)
      return state.runConnect(e)
    },
    disconnect: async (id: string) => { state.disconnectCalls.push(id) }
  } as unknown as ConnectorsManager
  const composio = { status: async () => ({ active: state.composioKeyActive }) } as unknown as ComposioManager
  const gateway = {
    status: () => ({ active: state.gatewayActive, connected: [], pending: state.pending }),
    connectApp: (slug: string, o?: { name?: string }) => {
      state.connectAppCalls.push({ slug, name: o?.name })
      return state.connectApp(slug, o)
    },
    cancelWait: () => { state.cancelWaitCalls++ }
  } as unknown as ComposioGatewayManager
  return buildApiMethods(() => undefined, fakeWorker, connectors, undefined, { composio, composioGateway: gateway, ...opts })
}

type Api = ReturnType<typeof apiOf>
const appsConnect = (api: Api, appId: string) =>
  (api['apps:connect'] as (p: unknown[]) => Promise<AppsConnectResult>)([appId])
const appsCancel = (api: Api, appId: string) =>
  (api['apps:cancel-connect'] as (p: unknown[]) => Promise<{ ok: boolean }>)([appId])
/** Lo stato del gateway come lo rilegge la riga durante i flussi (il suo polling). */
const gatewayStatus = (api: Api) =>
  (api['composio-gateway:status'] as () => ComposioGatewayStatusInfo)()

/**
 * Il login finto: risolve solo quando si molla il lucchetto. Il gateway
 * diventa attivo insieme alla risposta «connected» (come nel daemon vero).
 */
const loginGate = (state: FakeState, result: () => RunConnectResult) => {
  let release!: () => void
  const done = new Promise<void>((r) => { release = r })
  state.runConnect = async (e) => {
    if (e.id !== 'composio') return { status: 'connected' }
    await done
    const r = result()
    state.gatewayActive = r.status === 'connected'
    return r
  }
  return { release }
}

describe('B3 — Composio già entrato: l\'esito dell\'avvio arriva alla riga', () => {
  it('connectApp fallisce → started FALSE col motivo (prima: «partito», e la riga restava «Completa il login…» per sempre)', async () => {
    const state = newState({
      gatewayActive: true,
      connectApp: async () => ({ ok: false, error: 'no authorization link in the response' })
    })
    const r = await appsConnect(apiOf(state), 'gmail')
    expect(r.started).toBe(false)
    expect(r.reason).toBe('connect-failed')
    // in parole, col nome dell'app, nella lingua dell'interfaccia
    expect(r.error).toContain('Gmail')
    expect(r.detail).toContain('no authorization link')
  })

  it('un\'app che Composio non può collegare (manca la configurazione di accesso) → reason «not-connectable» con un motivo chiaro', async () => {
    const state = newState({
      gatewayActive: true,
      connectApp: async () => ({ ok: false, error: 'no Composio-managed auth config for this toolkit', reason: 'not-connectable' })
    })
    const r = await appsConnect(apiOf(state), 'gmail')
    expect(r).toMatchObject({ started: false, phase: 'app', reason: 'not-connectable' })
    expect(r.error).toContain('configurazione')
    // il motivo è noto: niente dettaglio grezzo da aggiungere
    expect(r.detail).toBeUndefined()
  })

  it('connectApp NON risponde → entro il tempo massimo apps:connect risponde «timeout» (mai una riga in attesa per sempre)', async () => {
    let rejectLate!: (e: Error) => void
    const state = newState({
      gatewayActive: true,
      connectApp: () => new Promise<ConnectAppResult>((_res, rej) => { rejectLate = rej })
    })
    const r = await appsConnect(apiOf(state, { appConnectTimeoutMs: 40 }), 'gmail')
    expect(r).toMatchObject({ started: false, reason: 'timeout' })
    expect(r.error).toContain('Gmail')
    // la risposta tardiva di Composio (qui: un errore) resta catturata: nessuna rejection dispersa
    rejectLate(new Error('late failure'))
    await new Promise(setImmediate)
  })

  it('connectApp lancia → started false con il motivo (nessuna rejection verso la UI)', async () => {
    const state = newState({ gatewayActive: true, connectApp: async () => { throw new Error('boom') } })
    const r = await appsConnect(apiOf(state), 'gmail')
    expect(r).toMatchObject({ started: false, reason: 'connect-failed' })
    expect(r.detail).toContain('boom')
  })

  it('una prova nuova della stessa riga toglie l\'esito della prova vecchia (il «Riprova» che riesce)', async () => {
    const state = newState({ gatewayActive: true, connectApp: async () => ({ ok: false, error: 'connection error' }) })
    const api = apiOf(state)
    expect((await appsConnect(api, 'gmail')).started).toBe(false)
    expect(gatewayStatus(api).appConnect).toMatchObject({ appId: 'gmail' })
    // Riprova: Composio stavolta risponde → il login è aperto nel browser e la riga aspetta
    state.connectApp = async () => ({ ok: true })
    expect(await appsConnect(api, 'gmail')).toEqual({ started: true, phase: 'app' })
    expect(gatewayStatus(api).appConnect).toBeNull()
  })
})

describe('B3 — i flussi che continuano in background pubblicano il loro esito', () => {
  it('il login di Composio finisce male → l\'esito arriva alla riga che aspettava (composio-gateway:status)', async () => {
    const state = newState()
    loginGate(state, () => ({ status: 'error', message: 'Authorization failed' })).release()
    const api = apiOf(state)
    expect(await appsConnect(api, 'gmail')).toMatchObject({ started: true, phase: 'login' })
    await vi.waitFor(() => expect(gatewayStatus(api).appConnect).toMatchObject({ appId: 'gmail', reason: 'connect-failed' }), { timeout: 2000, interval: 5 })
    expect(gatewayStatus(api).appConnect!.error).toContain('Composio')
  })

  it('il login riesce ma l\'app non parte (connectApp fallisce) → esito pubblicato, con la ragione vera', async () => {
    const state = newState({ connectApp: async () => ({ ok: false, error: 'x', reason: 'not-connectable' }) })
    loginGate(state, () => ({ status: 'connected' })).release()
    const api = apiOf(state)
    await appsConnect(api, 'gmail')
    await vi.waitFor(() => expect(gatewayStatus(api).appConnect).toMatchObject({ appId: 'gmail', reason: 'not-connectable' }), { timeout: 2000, interval: 5 })
  })

  it('l\'intenzione scade (login lentissimo): lo si dice, la riga non resta in attesa', async () => {
    const state = newState()
    const gate = loginGate(state, () => ({ status: 'connected' }))
    const api = apiOf(state)
    // Date.now finto con spyOn (come apps-connect.test.ts): il mockRestore in finally rimette a posto il metodo
    const now = vi.spyOn(Date, 'now')
    let fakeNow = Date.now()
    now.mockImplementation(() => fakeNow)
    try {
      await appsConnect(api, 'gmail')
      fakeNow += 10 * 60_000 + 1 // scaduta
      gate.release()
      await vi.waitFor(() => expect(gatewayStatus(api).appConnect).toMatchObject({ appId: 'gmail', reason: 'connect-failed' }), { timeout: 2000, interval: 5 })
    } finally {
      now.mockRestore()
    }
    expect(state.connectAppCalls).toHaveLength(0)
    expect(gatewayStatus(api).appConnect!.error).toContain('Gmail')
  })

  it('il connettore DIRETTO finisce male → esito pubblicato con il motivo del flusso', async () => {
    const state = newState({ runConnect: async () => ({ status: 'error', message: 'Authorization failed' }) })
    const api = apiOf(state)
    expect(await appsConnect(api, 'linear')).toEqual({ started: true, phase: 'direct' })
    await vi.waitFor(() => expect(gatewayStatus(api).appConnect).toMatchObject({ appId: 'linear', reason: 'connect-failed' }), { timeout: 2000, interval: 5 })
    expect(gatewayStatus(api).appConnect!.error).toBe('Authorization failed')
  })

  it('il connettore DIRETTO riesce → nessun esito d\'errore', async () => {
    const state = newState()
    const api = apiOf(state)
    await appsConnect(api, 'linear')
    await new Promise(setImmediate)
    expect(gatewayStatus(api).appConnect).toBeNull()
  })

  it('«Annulla» durante il login: l\'errore tardivo del login NON arriva alla riga (la prova annullata non parla più)', async () => {
    const state = newState()
    const gate = loginGate(state, () => ({ status: 'error', message: 'Authorization failed' }))
    const api = apiOf(state)
    await appsConnect(api, 'gmail')
    await appsCancel(api, 'gmail')
    gate.release()
    await vi.waitFor(() => expect(state.runConnectCalls.map((e) => e.id)).toContain('composio'), { timeout: 2000, interval: 5 })
    await new Promise(setImmediate)
    expect(gatewayStatus(api).appConnect).toBeNull()
  })

  it('un secondo clic su un\'ALTRA riga dice quale sostituisce (la sua riga torna a «Connetti»)', async () => {
    const state = newState()
    const gate = loginGate(state, () => ({ status: 'connected' }))
    const api = apiOf(state)
    await appsConnect(api, 'gmail')
    const second = await appsConnect(api, 'slack')
    expect(second.replaces).toBe('gmail')
    gate.release()
    await vi.waitFor(() => expect(state.connectAppCalls).toEqual([{ slug: 'slack', name: 'Slack' }]), { timeout: 2000, interval: 5 })
    // e alla fine l'esito è quello dell'app NUOVA (o nessuno): mai di Gmail, che non ha più nessuna prova in corso
    expect(gatewayStatus(api).appConnect?.appId).not.toBe('gmail')
  })
})

describe('B3 — senza Composio, e con la chiave di progetto', () => {
  it('nessun gateway (Composio non disponibile nel daemon) → started false col motivo, non un login che non parte', async () => {
    const connectors = {
      catalog: [entry('composio', { gateway: true }), entry('gmail', { clientRegistration: 'static' })],
      stateOf: () => ({ status: 'not_connected', disabledTools: [], instructions: '' }),
      hasStaticClient: async () => false,
      runConnect: async () => ({ status: 'connected' })
    } as unknown as ConnectorsManager
    const api = buildApiMethods(() => undefined, fakeWorker, connectors, undefined, {})
    const r = await (api['apps:connect'] as (p: unknown[]) => Promise<AppsConnectResult>)(['gmail'])
    expect(r.started).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
