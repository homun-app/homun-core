// U2 (fase prima-release): la barra di sinistra si apre e si chiude da un
// bottone SEMPRE visibile accanto ai semafori — PanelLeftClose da larga,
// PanelLeftOpen da stretta, tooltip con ⌘\, disabilitato (con il perché nel
// tooltip) quando la rotaia è forzata dalla finestra. Il bordo trascinabile
// c'è anche in rotaia non forzata, e «Allarga la barra» esce dal menu
// account: ora il bottone ha un posto suo.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender } from './render-helper'
import { parsePo } from './po-helper'

type El = { type: unknown; props: Record<string, unknown> }
const capture = vi.hoisted(() => ({ els: [] as El[] }))
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

const { Sidebar, SidebarToggleButton } = await import('../components/Sidebar')
const { useStore } = await import('../store')
const { layoutFor } = await import('../layout')

const SIDEBAR = fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url))

const agent = { id: 'bot-1', name: 'Trello', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1 }

const layoutOf = (over: Partial<Parameters<typeof layoutFor>[0]> = {}) =>
  layoutFor({ windowWidth: 1280, sidebarCollapsedByUser: false, sidebarWidthPref: 264, panelOpen: false, panelTab: null, ...over })

/** il bottone del toggle catturato dall'ultimo render, per pezzo di tooltip */
function toggleButton(label: string): El {
  const btn = capture.els.find(
    (e) => e.type === 'button' && e.props['data-testid'] === 'sidebar-toggle' && String(e.props['aria-label'] ?? '').startsWith(label)
  )
  if (!btn) throw new Error(`bottone sidebar-toggle «${label}…» non trovato`)
  return btn
}

describe('U2: il bottone della barra, sempre visibile accanto ai semafori', () => {
  it('da LARGA: PanelLeftClose, «Chiudi la barra (⌘\)», aria-expanded vero — il clic stringe', () => {
    setStoreStateForRender(useStore, { windowWidth: 1280, sidebarCollapsed: false, sidebarWidth: 264, agents: [agent] })
    const html = renderHtml(createElement(SidebarToggleButton, { layout: layoutOf() }))
    expect(html).toContain('Chiudi la barra (⌘\\)')
    expect(html).toContain('aria-expanded="true"')
    // il clic cambia la preferenza: la barra diventa stretta
    ;(toggleButton('Chiudi la barra').props.onClick as () => void)()
    expect(useStore.getState().sidebarCollapsed).toBe(true)
  })

  it('da STRETTA (non forzata): PanelLeftOpen, «Apri la barra (⌘\)» — il clic allarga', () => {
    setStoreStateForRender(useStore, { windowWidth: 1280, sidebarCollapsed: true, sidebarWidth: 264, agents: [agent] })
    renderHtml(createElement(SidebarToggleButton, { layout: layoutOf({ sidebarCollapsedByUser: true }) }))
    const btn = toggleButton('Apri la barra')
    expect(btn.props['aria-expanded']).toBe(false)
    ;(btn.props.onClick as () => void)()
    expect(useStore.getState().sidebarCollapsed).toBe(false)
  })

  it('rotaia FORZATA (finestra sotto AUTO_RAIL_BELOW): visibile ma disabilitato, col perché nel tooltip', () => {
    setStoreStateForRender(useStore, { windowWidth: 900, sidebarCollapsed: false, sidebarWidth: 264, agents: [agent] })
    const html = renderHtml(createElement(SidebarToggleButton, { layout: layoutOf({ windowWidth: 900 }) }))
    expect(html).toContain('Allarga la finestra per aprire la barra')
    const btn = toggleButton('Allarga la finestra')
    expect(btn.props.disabled).toBe(true)
  })

  it('il bordo trascinabile c\'è ANCHE in rotaia non forzata, e NON in rotaia forzata', () => {
    setStoreStateForRender(useStore, { windowWidth: 1280, sidebarCollapsed: true, sidebarWidth: 264, agents: [agent], groups: [] })
    const rail = renderHtml(createElement(Sidebar, { layout: layoutOf({ sidebarCollapsedByUser: true }) }))
    expect(rail).toContain('cursor-col-resize')
    setStoreStateForRender(useStore, { windowWidth: 900, sidebarCollapsed: false, sidebarWidth: 264, agents: [agent], groups: [] })
    const forced = renderHtml(createElement(Sidebar, { layout: layoutOf({ windowWidth: 900 }) }))
    expect(forced).not.toContain('cursor-col-resize')
  })
})

describe('U2: «Allarga la barra» esce dal menu account (ha il suo bottone)', () => {
  it('la voce non c\'è più nel sorgente né nei cataloghi it/en', () => {
    const src = readFileSync(SIDEBAR, 'utf8')
    expect(src).not.toContain('Allarga la barra')
    for (const locale of ['it', 'en'] as const) {
      expect(parsePo(locale).has('Allarga la barra'), `${locale}`).toBe(false)
    }
  })
})
