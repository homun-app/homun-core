// RV4 (fase beta.2), punto 1: il modello del bot sta nel pannello destro —
// è il PROFILO del bot e il modello è una sua proprietà. Sotto il nome e
// SOPRA le schede Attività · Libreria, una riga compatta col modello RISOLTO
// (resolveAgentModel): il suo, «Come gli altri · <principale>», o «Nessun
// modello» in colore d'avviso. Al clic si apre lo STESSO selettore del
// foglio «Impostazioni del bot» (un foglio piccolo, nessun secondo
// selettore). Render vero del pannello: dati nello store, clic sull'handler catturato.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
// il grafo del pannello porta il Computer (novnc/xterm toccano document
// all'import): quella scheda non c'entra con la riga del modello
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

const { RightPanel } = await import('../components/RightPanel')
const { useStore } = await import('../store')

const LAYOUT = { sidebar: 'full', sidebarWidth: 264, panel: 'docked', panelWidth: 340 } as const

const agent = (over: Partial<ConstructorParameters<typeof Object>[0]> = {}) => ({
  id: 'bot-1',
  name: 'Trello',
  description: '',
  providerId: null,
  model: null,
  status: 'offline',
  unread: 0,
  createdAt: 1,
  ...over
})

/** Il pannello destro col bot attivo e i provider/main dati dal caso. */
function renderPanel(over: Record<string, unknown>) {
  capture.els.length = 0
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

const modelRowOf = (tree: ReturnType<typeof parseHtml>) =>
  findAll(tree, (n) => n.attrs['data-testid'] === 'bot-model-row')[0] ?? null

describe('RV4: la riga del modello nel pannello destro del bot', () => {
  it('modello PROPRIO (provider attivo): «Modello: <provider> · <modello> ›»', () => {
    const { tree } = renderPanel({
      agents: [agent({ providerId: 'p1', model: 'claude-4-5' })]
    })
    const row = modelRowOf(tree)
    expect(row, 'la riga del modello dev’esserci').toBeTruthy()
    expect(textOf(row!)).toContain('Modello:')
    expect(textOf(row!)).toContain('Anthropic · claude-4-5 ›')
  })

  it('modello seguito («Come gli altri»): mostra il principale', () => {
    const { tree } = renderPanel({
      agents: [agent()],
      mainModel: { providerId: 'p1', model: 'main-model-1' }
    })
    const row = modelRowOf(tree)!
    expect(textOf(row)).toContain('Come gli altri · main-model-1 ›')
  })

  it('NESSUN modello: «Nessun modello» in colore d’avviso', () => {
    const { tree } = renderPanel({ agents: [agent()], mainModel: null })
    const row = modelRowOf(tree)!
    expect(textOf(row)).toContain('Nessun modello')
    expect((row.attrs['class'] ?? '') + (row.children[0]?.attrs['class'] ?? '')).toContain('text-waiting')
  })

  it('sta sotto il NOME e SOPRA le schede Attività · Libreria', () => {
    const { html } = renderPanel({ agents: [agent()] })
    const atName = html.indexOf('>Trello<')
    const atRow = html.indexOf('bot-model-row')
    const atTabs = html.indexOf('role="tablist"')
    expect(atName).toBeGreaterThanOrEqual(0)
    expect(atRow).toBeGreaterThan(atName)
    expect(atTabs).toBeGreaterThan(atRow)
  })

  it('al clic si apre lo STESSO selettore del foglio Impostazioni del bot (non un secondo)', () => {
    renderPanel({ agents: [agent()] })
    const row = capture.els.find((e) => (e.props as { 'data-testid'?: string })['data-testid'] === 'bot-model-row')
    expect(row).toBeTruthy()
    ;(row!.props.onClick as () => void)()
    const s = useStore.getState()
    expect(s.botModelOpen).toBe(true)
    expect(s.rightPanel).toBe(true)
  })

  it('il foglio piccolo riporta lo STESSO ModelSelect del foglio Impostazioni (aria «Modello del bot»)', () => {
    renderPanel({ agents: [agent({ providerId: 'p1', model: 'claude-4-5' })] })
    // il clic del test precedente ha acceso lo stato VIVO; per il RENDER serve
    // anche nello stato iniziale (il server di React legge getInitialState)
    setStoreStateForRender(useStore, { botModelOpen: true, rightPanel: true })
    capture.els.length = 0
    renderHtml(createElement(RightPanel, { layout: LAYOUT }))
    // store già botModelOpen: il foglio col ModelSelect (ruolo combobox, nome «Modello del bot»)
    const select = capture.els.find((e) => (e.props as { 'aria-label'?: string })['aria-label'] === 'Modello del bot')
    expect(select, 'il selettore del modello del bot dev’esserci nel foglio').toBeTruthy()
  })
})
