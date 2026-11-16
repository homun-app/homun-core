// SV5 (fase schermo-vivo) — la scheda Computer SA della PiP: «Stacca» accanto
// ai comandi di oggi apre la finestra PiP e scollega la vista grande (che
// dice «Lo schermo è in una finestra a parte»), «Riporta qui» la chiude e la
// vista torna; prendere il controllo chiude la PiP. Render statico del
// componente VERO (BotScreen con novnc FINTO) + handler catturati dal runtime
// JSX + guardie sul sorgente per i legami che il render statico non esercita.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'
import { callsOf } from './render-helper-install'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
// il canvas di noVNC non serve: qui si prova la SCHEDA, non il collegamento
vi.mock('@novnc/novnc', () => ({ default: class FakeRfb {} }))

// le props degli elementi resi si catturano mockando il runtime JSX
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

const { BotScreen } = await import('../components/BotScreen')
const { useStore } = await import('../store')

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

function renderScreen(pipAgentId: string | null): ReturnType<typeof parseHtml> {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    agents: [agent()],
    activeId: 'bot-1',
    computerPanel: { open: false, tab: 'screen', mode: 'view' },
    pipAgentId
  })
  const html = renderHtml(createElement(BotScreen, { agentId: 'bot-1', inPanel: true }))
  return parseHtml(html)
}

describe('SV5: la scheda Computer sa della PiP', () => {
  beforeEach(() => {
    setStoreStateForRender(useStore, { pipAgentId: null })
  })

  it('«Stacca» c\'è accanto ai comandi e chiama pipOpen del bot GIUSTO', () => {
    const tree = renderScreen(null)
    const btn = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-screen-detach')[0]
    expect(btn).toBeTruthy()
    expect(textOf(btn)).toBe('Stacca')
    // il VERO handler del bottone, catturato dal runtime JSX
    const el = capture.els.filter((e) => (e.props as Record<string, unknown>)['data-testid'] === 'bot-screen-detach')[0]!
    ;(el.props.onClick as () => void)()
    expect(callsOf('pipOpen').map((c) => c.args)).toEqual([['bot-1']])
  })

  it('con la PiP aperta la vista grande dice «Lo schermo è in una finestra a parte» con «Riporta qui»', () => {
    const tree = renderScreen('bot-1')
    const all = findAll(tree, (n) => typeof n.text === 'string' && n.text.includes('Lo schermo è in una finestra a parte'))
    expect(all.length).toBeGreaterThan(0)
    const btn = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-screen-restore')[0]
    expect(btn).toBeTruthy()
    expect(textOf(btn)).toBe('Riporta qui')
    const el = capture.els.filter((e) => (e.props as Record<string, unknown>)['data-testid'] === 'bot-screen-restore')[0]!
    ;(el.props.onClick as () => void)()
    expect(callsOf('pipClose').length).toBe(1)
  })

  it('la PiP di UN ALTRO bot non stacca la vista grande di questo', () => {
    const tree = renderScreen('bot-2')
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'bot-screen-restore')[0]).toBeFalsy()
  })

  it('prendere il CONTROLLO chiude la PiP: la vista della PiP si chiude da sé quando il suo schermo è controllato', () => {
    // il legame sta nell'effetto di PipView (il render statico non lo esercita):
    // a OGNI stato screen del suo bot, control=true → pipClose
    const src = readFileSync(fileURLToPath(new URL('../components/PipView.tsx', import.meta.url)), 'utf8')
    expect(src).toMatch(/control[\s\S]{0,120}pipClose/)
  })

  it('la vista grande si riapre in VISTA quando la PiP si chiude, ma NON ruba il posto al controllo', () => {
    // il legame sta nell'effetto di BotScreen: la riapertura vale solo in view
    const src = readFileSync(fileURLToPath(new URL('../components/BotScreen.tsx', import.meta.url)), 'utf8')
    expect(src).toMatch(/modeRef\.current === 'view'[\s\S]{0,200}open\('view'\)/)
    // e open non parte se lo schermo di QUESTO bot è in una PiP
    expect(src).toMatch(/pipOpen[\s\S]{0,80}agentId/)
  })
})
