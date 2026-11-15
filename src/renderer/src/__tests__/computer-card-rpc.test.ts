// CCK1 (fase computer-card-correzioni): la RISPOSTA della RPC box:runtime
// ENTRA nello store — la STESSA azione dell'evento `box`. È il caso dell'app
// installata: il daemon nasce all'avvio, porta unknown → running con la
// finestra ancora chiusa e l'evento va perso; la finestra si apre (o si
// ricarica) col box GIÀ acceso e NESSUN evento arriva più (l'evento parte
// SOLO al cambio) — se la risposta della RPC si butta via, la card dice
// «Spento» per sempre: il bug di partenza della fase computer-card, provato
// ROSSO dalla sonda (Page.reload e finestra nuova → «Spento»). E l'ORDINE:
// una risposta della RPC più VECCHIA di un evento già arrivato NON lo
// sovrascrive — vince il `since` più recente. Render statico del componente
// VERO col store: nel render statico gli effetti non girano, quindi il test
// chiama quello che chiama l'effetto (l'api è la STESSA finta) e il collegamento
// effetto → azione è la guardia sul sorgente (come engine-section-computer).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'
import { stubApiMethod, callsOf } from './render-helper-install'
import type { SandbotEvent, BoxRuntime } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))

const { RightPanel } = await import('../components/RightPanel')
const { useStore } = await import('../store')

const LAYOUT = { sidebar: 'full', sidebarWidth: 264, panel: 'docked', panelWidth: 340 } as const

const agent = () => ({
  id: 'bot-1',
  name: 'Trello',
  description: '',
  providerId: null,
  model: null,
  status: 'offline',
  unread: 0,
  createdAt: 1
})

/** Il pannello destro col bot attivo (la card «Computer» sta nella scheda Attività). */
function renderPanel(over: Record<string, unknown> = {}) {
  setStoreStateForRender(useStore, {
    rightPanel: true,
    openGroupId: null,
    activeId: 'bot-1',
    agents: [agent()],
    providers: [{ id: 'p1', name: 'Anthropic', kind: 'anthropic', enabled: true }],
    mainModel: null,
    entries: [],
    ...over
  })
  const html = renderHtml(createElement(RightPanel, { layout: LAYOUT }))
  return { html, tree: parseHtml(html) }
}

/** Il testo dello stato della card «Computer» (bot-computer-status), o null. */
const cardStatusOf = (tree: ReturnType<typeof parseHtml>): string | null => {
  const el = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-computer-status')[0] ?? null
  return el ? textOf(el) : null
}

describe('CCK1: la risposta della RPC box:runtime ENTRA nello store', () => {
  beforeEach(() => {
    useStore.setState({ boxRuntime: null, boxInUse: false })
    stubApiMethod('boxRuntime', () => ({ state: 'running', since: 10_000 } satisfies BoxRuntime))
    stubApiMethod('settingsGet', (key: unknown, fallback: unknown) => (key === 'sandbox.mode' ? 'box' : fallback))
  })

  it('il box è running PRIMA che il componente nasca, NESSUN evento box → la card dice «In attesa» (non «Spento»)', async () => {
    // come fa la card all'apertura (l'effetto): la RPC rilegge e la RISPOSTA
    // entra nello store, la modalità si legge — poi il componente nasca
    await useStore.getState().readBoxRuntime()
    await useStore.getState().readBoxInUse()
    expect(useStore.getState().boxRuntime).toEqual({ state: 'running', since: 10_000 })
    expect(useStore.getState().boxInUse).toBe(true)
    // il render statico legge lo stato INIZIALE (getServerSnapshot): si passa
    // quello appena letto, come farebbe la finestra vera dopo l'effetto
    const { tree } = renderPanel({ boxRuntime: useStore.getState().boxRuntime, boxInUse: useStore.getState().boxInUse })
    expect(cardStatusOf(tree)).toBe('In attesa')
  })

  it('l\'effetto della card chiama le letture (guardia sul sorgente: nel render statico l\'effetto non gira)', () => {
    const SRC = readFileSync(fileURLToPath(new URL('../components/RightPanel.tsx', import.meta.url)), 'utf8')
    expect(SRC).toContain('readBoxRuntime()')
    expect(SRC).toContain('readBoxInUse()')
    expect(SRC).not.toContain('void api.boxRuntime()')
  })
})

describe('CCK1: l\'ORDINE — vince il `since` più recente, attraverso la STESSA azione dell\'evento `box`', () => {
  beforeEach(async () => {
    useStore.setState({ boxRuntime: null, boxInUse: false })
    stubApiMethod('listAgents', () => [])
    stubApiMethod('listProviders', () => [])
    stubApiMethod('getPermissions', () => ({}))
    stubApiMethod('settingsGet', (...args: unknown[]) => args[1])
    await useStore.getState().init()
  })

  it('evento running@9000, poi la risposta RPC PIÙ VECCHIA stopped@4000 → resta running', async () => {
    const onEvent = callsOf('onEvent')[0]!.args[0] as (e: SandbotEvent) => void
    onEvent({ type: 'box', runtime: { state: 'running', since: 9_000 } })
    expect(useStore.getState().boxRuntime).toEqual({ state: 'running', since: 9_000 })
    stubApiMethod('boxRuntime', () => ({ state: 'stopped', since: 4_000 } satisfies BoxRuntime))
    await useStore.getState().readBoxRuntime()
    expect(useStore.getState().boxRuntime).toEqual({ state: 'running', since: 9_000 })
  })

  it('evento stopped@1000, poi la risposta RPC PIÙ RECENTE running@9000 → running (la lettura fresca vince)', async () => {
    const onEvent = callsOf('onEvent')[0]!.args[0] as (e: SandbotEvent) => void
    onEvent({ type: 'box', runtime: { state: 'stopped', since: 1_000 } })
    stubApiMethod('boxRuntime', () => ({ state: 'running', since: 9_000 } satisfies BoxRuntime))
    await useStore.getState().readBoxRuntime()
    expect(useStore.getState().boxRuntime).toEqual({ state: 'running', since: 9_000 })
  })
})
