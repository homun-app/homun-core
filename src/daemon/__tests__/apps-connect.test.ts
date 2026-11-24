// Fase catalogo app (P4): «Connetti» in un passo — apps:connect decide la
// strada dalla riga dell'elenco e, se Composio non è ancora «entrato», parte
// il login con l'INTENZIONE tenuta nel daemon: appena il connettore risulta
// connesso prosegue da solo con connectApp per lo slug giusto. L'intenzione
// scade (10 minuti), è UNA sola (il secondo clic la sostituisce), e con la
// chiave di progetto attiva risponde conflict (C6). Dipendenze TUTTE finte.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../test-tmp'
import { join } from 'node:path'

vi.mock('../../main/agent/tools', () => ({
  toolDefs: [],
  executeTool: async () => { throw new Error('non chiamato in questi test') }
}))

const { setDataDir, db } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { ConnectorsManager } from '../../main/connectors'
import type { ComposioManager } from '../../main/connectors/composio'
import type { ComposioGatewayManager } from '../../main/connectors/composio-gateway'
import type { CatalogEntry } from '../../main/connectors'

const fakeWorker = { poke: () => undefined, drain: async () => undefined, start: () => undefined, stop: () => undefined } as unknown as JobWorker

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-appsconnect-'))
  setDataDir(dir)
  db()
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Un connettore finto del catalogo, come lo legge apps:connect. */
const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name: id, logo: '·', mcpUrl: 'https://example.com', clientRegistration: 'dynamic',
  docsUrl: 'https://docs.example.com', notes: { it: 'n', en: 'n' }, ...extra
}) as CatalogEntry

interface FakeState {
  staticClients: Set<string>
  runConnect: ((entry: CatalogEntry) => Promise<{ status: string }>) | null
  runConnectCalls: CatalogEntry[]
  disconnectCalls: string[]
  composioStatus: { active: boolean }
  gateway: {
    active: boolean
    pending: { slug: string; name: string; since: number; failed?: boolean } | null
    connectAppCalls: Array<{ slug: string; name?: string }>
    cancelWaitCalls: number
  }
}

/** I manager finti: si guida tutto da `state`, come faceva connector-notify. */
const fakeManagers = (state: FakeState) => {
  const connectors = {
    catalog: [
      entry('composio', { gateway: true }),
      entry('gmail', { clientRegistration: 'static' }),
      entry('linear')
    ],
    stateOf: (id: string) => ({ status: state.gateway.active && id === 'composio' ? 'connected' : 'not_connected', disabledTools: [], instructions: '' }),
    hasStaticClient: async (id: string) => state.staticClients.has(id),
    runConnect: async (e: CatalogEntry) => {
      state.runConnectCalls.push(e)
      return state.runConnect ? state.runConnect(e) : { status: 'connected' }
    },
    disconnect: async (id: string) => { state.disconnectCalls.push(id) }
  } as unknown as ConnectorsManager
  const composio = { status: async () => state.composioStatus } as unknown as ComposioManager
  const gateway = {
    status: () => ({ active: state.gateway.active, connected: [], pending: state.gateway.pending }),
    connectApp: async (slug: string, opts?: { name?: string }) => {
      state.gateway.connectAppCalls.push({ slug, name: opts?.name })
      return { ok: true }
    },
    cancelWait: () => { state.gateway.cancelWaitCalls++ }
  } as unknown as ComposioGatewayManager
  return { connectors, composio, gateway }
}

const apiOf = (state: FakeState, emit?: (e: { type: string }) => void) => {
  const { connectors, composio, gateway } = fakeManagers(state)
  return buildApiMethods(emit ?? (() => undefined), fakeWorker, connectors, undefined, { composio, composioGateway: gateway })
}

const appsConnect = (api: ReturnType<typeof buildApiMethods>, appId: string) =>
  (api['apps:connect'] as (p: unknown[]) => Promise<{ started: boolean; phase?: string; conflict?: string; reason?: string }>)([appId])
const appsCancel = (api: ReturnType<typeof buildApiMethods>, appId: string) =>
  (api['apps:cancel-connect'] as (p: unknown[]) => Promise<{ ok: boolean }>)([appId])

describe('P4 — apps:connect, la strada la decide la riga', () => {
  it('gmail (static senza client) passa da Composio; linear (dynamic) resta diretta', async () => {
    const state: FakeState = {
      staticClients: new Set(), runConnect: null, runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const api = apiOf(state)
    const gmail = await appsConnect(api, 'gmail')
    expect(gmail).toEqual({ started: true, phase: 'login' }) // non entrato → login di Composio
    const linear = await appsConnect(api, 'linear')
    expect(linear).toEqual({ started: true, phase: 'direct' })
    expect(state.runConnectCalls.map((e) => e.id)).toContain('linear')
  })

  it('con il client OAuth salvato, gmail diventa DIRETTA', async () => {
    const state: FakeState = {
      staticClients: new Set(['gmail']), runConnect: null, runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const api = apiOf(state)
    expect(await appsConnect(api, 'gmail')).toEqual({ started: true, phase: 'direct' })
    expect(state.runConnectCalls.map((e) => e.id)).toEqual(['gmail'])
  })

  it('app sconosciuta: started false con reason, senza far nulla', async () => {
    const state: FakeState = {
      staticClients: new Set(), runConnect: null, runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const api = apiOf(state)
    expect(await appsConnect(api, 'non-esiste')).toEqual({ started: false, reason: 'unknown-app' })
    expect(state.runConnectCalls).toHaveLength(0)
  })
})

describe('P4 — l\'intenzione sta nel daemon e prosegue da sola', () => {
  /**
   * Il login finto: risolve «connected» solo quando si molla il lucchetto.
   * Dopo il rilascio il login resta LENTO (LOGIN_DELAY_MS): è il caso che
   * questi test proteggono — su una macchina carica il lavoro vero che
   * segue il lucchetto (notifyConnectorConnected, connectApp) arriva quando
   * arriva, e una pausa fissa nel test non lo può sapere.
   */
  const LOGIN_DELAY_MS = 50
  const loginGate = (delayMs = LOGIN_DELAY_MS) => {
    let release!: () => void
    const done = new Promise<void>((r) => { release = r })
    const promise = done.then(async () => {
      await new Promise((r) => setTimeout(r, delayMs))
      return { status: 'connected' }
    })
    return { release, promise }
  }

  /**
   * L'emit che registra gli eventi arrivati DOPO il rilascio del login e si
   * scioglie al primo `connectors` di quel gruppo: quando l'app NON parte,
   * runComposioLoginWithIntent finisce proprio lì (è il contratto con cui
   * la UI si aggiorna) — è il segnale di «finito» dei controlli al negativo.
   */
  const emitRecorder = () => {
    const events: string[] = []
    let released = false
    let atEnd!: () => void
    const endOfLogin = new Promise<void>((r) => { atEnd = r })
    return {
      events,
      endOfLogin,
      markReleased: () => { released = true },
      emit: (e: { type: string }) => {
        if (!released) return
        events.push(e.type)
        if (e.type === 'connectors') atEnd()
      }
    }
  }

  it('non entrato → login → appena connesso parte connectApp per lo slug GIUSTO', async () => {
    const gate = loginGate()
    const state: FakeState = {
      staticClients: new Set(), runConnect: async (e) => (e.id === 'composio' ? gate.promise : { status: 'connected' }),
      runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const api = apiOf(state)
    expect(await appsConnect(api, 'gmail')).toEqual({ started: true, phase: 'login' })
    expect(state.runConnectCalls.map((e) => e.id)).toEqual(['composio'])
    // il login è fermo sul lucchetto: connectApp NON può essere partito.
    // Questo controllo non può dare falsi rossi — basta far scorrere le
    // macrotask, niente millisecondi
    await new Promise(setImmediate)
    expect(state.gateway.connectAppCalls).toHaveLength(0)
    gate.release()
    // «aspetto che succeda»: waitFor con tetto largo, veloce quando la
    // macchina è libera e che regge il login lento quando è carica
    await vi.waitFor(() => expect(state.gateway.connectAppCalls).toEqual([{ slug: 'gmail', name: 'Gmail' }]), { timeout: 2000, interval: 5 })
  })

  it('già entrato: connectApp subito, senza passare dal login', async () => {
    const state: FakeState = {
      staticClients: new Set(), runConnect: null, runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: true, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const api = apiOf(state)
    expect(await appsConnect(api, 'gmail')).toEqual({ started: true, phase: 'app' })
    expect(state.gateway.connectAppCalls).toEqual([{ slug: 'gmail', name: 'Gmail' }])
    expect(state.runConnectCalls).toHaveLength(0)
  })

  it('un secondo clic SOSTITUISCE l\'intenzione (un solo flusso di login)', async () => {
    const gate = loginGate()
    const state: FakeState = {
      staticClients: new Set(), runConnect: async (e) => (e.id === 'composio' ? gate.promise : { status: 'connected' }),
      runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const api = apiOf(state)
    await appsConnect(api, 'gmail')
    await appsConnect(api, 'slack') // il secondo clic vince
    gate.release()
    // prima si aspetta che il flusso sia arrivato (waitFor su connectApp)…
    await vi.waitFor(() => expect(state.gateway.connectAppCalls).toEqual([{ slug: 'slack', name: 'Slack' }]), { timeout: 2000, interval: 5 })
    // …e SOLO dopo il controllo «un solo flusso di Composio»
    expect(state.runConnectCalls.filter((e) => e.id === 'composio')).toHaveLength(1) // UN flusso solo
  })

  it('l\'intenzione scade dopo 10 minuti: il login riesce ma l\'app non parte', async () => {
    const gate = loginGate()
    const state: FakeState = {
      staticClients: new Set(), runConnect: async (e) => (e.id === 'composio' ? gate.promise : { status: 'connected' }),
      runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const rec = emitRecorder()
    const api = apiOf(state, rec.emit)
    // Date.now finto con spyOn (scelto contro l'assegnazione a mano): il
    // mockRestore in finally rimette a posto il metodo anche cadendo prima,
    // e resta nei registri di vitest finché non è restaurato.
    const now = vi.spyOn(Date, 'now')
    let fakeNow = Date.now()
    now.mockImplementation(() => fakeNow)
    try {
      await appsConnect(api, 'gmail')
      fakeNow += 10 * 60_000 + 1 // scaduta
      rec.markReleased()
      gate.release()
      // Il prodotto legge Date.now SOLO DOPO che il login lento ha risolto:
      // il finto deve valere fino alla decisione. La fine del flusso è
      // l'evento `connectors` di fine login, atteso con la promise sciolta
      // dall'emit — niente waitFor qui, così il tempo torna vero PRIMA di
      // qualunque attesa col tetto (il mockRestore qui sotto).
      await rec.endOfLogin
    } finally {
      now.mockRestore()
    }
    expect(state.gateway.connectAppCalls).toHaveLength(0)
  })

  it('con la chiave di progetto attiva risponde conflict (le due strade non insieme)', async () => {
    const state: FakeState = {
      staticClients: new Set(), runConnect: null, runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: true }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const api = apiOf(state)
    expect(await appsConnect(api, 'gmail')).toEqual({ started: false, conflict: 'composio-key' })
    expect(state.runConnectCalls).toHaveLength(0)
    expect(state.gateway.connectAppCalls).toHaveLength(0)
  })

  it('Annulla durante l\'attesa dell\'app ferma il wait; durante il login ferma anche quello', async () => {
    // fase app: il pending del gateway riguarda la riga
    const stateApp: FakeState = {
      staticClients: new Set(), runConnect: null, runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: true, pending: { slug: 'gmail', name: 'Gmail', since: 1 }, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const apiApp = apiOf(stateApp)
    await appsCancel(apiApp, 'gmail')
    expect(stateApp.gateway.cancelWaitCalls).toBe(1)

    // fase login: l'intenzione va via e il connettore si disconnette
    const gate = loginGate()
    const stateLogin: FakeState = {
      staticClients: new Set(), runConnect: async (e) => (e.id === 'composio' ? gate.promise : { status: 'connected' }),
      runConnectCalls: [], disconnectCalls: [],
      composioStatus: { active: false }, gateway: { active: false, pending: null, connectAppCalls: [], cancelWaitCalls: 0 }
    }
    const rec = emitRecorder()
    const apiLogin = apiOf(stateLogin, rec.emit)
    await appsConnect(apiLogin, 'gmail')
    await appsCancel(apiLogin, 'gmail')
    expect(stateLogin.disconnectCalls).toEqual(['composio'])
    rec.markReleased()
    gate.release() // il login infine riesce lo stesso: niente app
    // prima il segnale di «finito» (l'evento connectors di fine login, con
    // waitFor), POI il controllo che l'app NON sia partita
    await vi.waitFor(() => expect(rec.events).toContain('connectors'), { timeout: 2000, interval: 5 })
    expect(stateLogin.gateway.connectAppCalls).toHaveLength(0)
  })
})
