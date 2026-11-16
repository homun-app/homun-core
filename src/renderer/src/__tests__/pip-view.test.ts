// U3 (fase prima-release): la barra della PiP è SEMPRE visibile (niente
// comandi sotto l'hover, che su macOS un'area di trascinamento non riceve
// mai): in alto mascotte+nome a sinistra, «Riporta in Homun» e «Chiudi» a
// destra. Solo la barra trascina la finestra; i bottoni sono no-drag e lo
// schermo sotto è no-drag e senza input. «Riporta in Homun» è UN gesto.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender } from './render-helper'
import { callsOf } from './render-helper-install'

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

const { PipView } = await import('../components/PipView')
const { useStore } = await import('../store')

const SRC = readFileSync(fileURLToPath(new URL('../components/PipView.tsx', import.meta.url)), 'utf8')

const agent = { id: 'bot-7', name: 'Nori', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1 }

function renderPip(): string {
  capture.els.length = 0
  setStoreStateForRender(useStore, { agents: [agent], activeId: 'bot-7' })
  return renderHtml(createElement(PipView, { agentId: 'bot-7' }))
}

const buttonBy = (pred: (e: El) => boolean): El => {
  const btn = capture.els.find((e) => e.type === 'button' && pred(e))
  if (!btn) throw new Error('bottone non trovato')
  return btn
}

describe('U3: la barra della PiP è SEMPRE visibile, solo lei trascina', () => {
  it('nel rendering statico la barra c\'è SENZA hover: «Riporta in Homun», «Chiudi» e il nome del bot', () => {
    const html = renderPip()
    expect(html).toContain('Riporta in Homun')
    expect(html).toContain('Chiudi')
    expect(html).toContain('Nori')
    // niente comandi nascosti sotto l'hover
    expect(SRC).not.toContain('group-hover')
    expect(SRC).not.toContain('opacity-0')
  })

  it('solo la barra è area di trascinamento: la radice NON è drag, i bottoni sono no-drag', () => {
    renderPip()
    // la radice non ha più il drag (il canvas sotto deve poter vivere no-drag)
    const root = capture.els.find((e) => e.props['data-testid'] === 'pip-view')!
    expect(String((root.props.style as Record<string, unknown>)?.WebkitAppRegion ?? '')).not.toBe('drag')
    // la barra sì
    const bar = capture.els.find(
      (e) => String(e.props['data-testid'] ?? '') === 'pip-bar' && (e.props.style as Record<string, unknown>)?.WebkitAppRegion === 'drag'
    )
    expect(bar, 'la barra è l\'unica area drag').toBeTruthy()
    // i bottoni no-drag
    const back = buttonBy((e) => e.props['data-testid'] === 'pip-bring-back')
    expect((back.props.style as Record<string, unknown>)?.WebkitAppRegion).toBe('no-drag')
  })

  it('«Riporta in Homun» chiama pipFocusMain del bot (UN gesto: il main chiude la PiP e porta Homun davanti)', () => {
    renderPip()
    const back = buttonBy((e) => e.props['data-testid'] === 'pip-bring-back')
    ;(back.props.onClick as () => void)()
    expect(callsOf('pipFocusMain').map((c) => c.args)).toEqual([['bot-7']])
  })

  it('«Chiudi» chiama pipClose', () => {
    renderPip()
    const close = buttonBy((e) => e.props['data-testid'] === 'pip-close')
    ;(close.props.onClick as () => void)()
    expect(callsOf('pipClose').map((c) => c.args)).toEqual([[]])
  })
})
