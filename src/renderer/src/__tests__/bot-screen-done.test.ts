// U9 (fase prima-release): «Ho finito» sempre visibile — in controllo sta
// nella TESTATA al posto di «Prendi il controllo», col colore del bot; il
// piede tiene solo la nota facoltativa, che viaggia con «Ho finito». Il
// canvas non spinge fuori niente (min-h-0: lo scaleViewport adatta) e la
// sezione scorre se proprio non ci sta.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'
import { callsOf } from './render-helper-install'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
vi.mock('@novnc/novnc', () => ({ default: class FakeRfb {} }))

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

const SRC = readFileSync(fileURLToPath(new URL('../components/BotScreen.tsx', import.meta.url)), 'utf8')

const agent = () => ({
  id: 'bot-1', name: 'Trello', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1
})

function renderScreen(mode: 'view' | 'control'): ReturnType<typeof parseHtml> {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    agents: [agent()],
    activeId: 'bot-1',
    computerPanel: { open: false, tab: 'screen', mode },
    pipAgentId: null
  })
  const html = renderHtml(createElement(BotScreen, { agentId: 'bot-1', inPanel: true }))
  return parseHtml(html)
}

const captured = (testId: string) => capture.els.find((e) => e.props['data-testid'] === testId)

describe('U9: in controllo «Ho finito» sta nella testata, al posto di «Prendi il controllo»', () => {
  it("in CONTROLLO: «Ho finito» c'è nella testata (colore del bot) e «Prendi il controllo» no", () => {
    const tree = renderScreen('control')
    const done = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-screen-done')[0]
    expect(done).toBeTruthy()
    expect(textOf(done)).toBe('Ho finito')
    expect(textOf(tree)).not.toContain('Prendi il controllo')
    // il colore del bot (primario)
    const el = captured('bot-screen-done')!
    expect(String((el.props.style as Record<string, unknown>)?.background ?? '')).toContain('var(--bot-')
  })

  it("in VISTA: nessun «Ho finito» in testata, e «Prendi il controllo» resta al suo posto (sorgente: il blocco è gated su view)", () => {
    const tree = renderScreen('view')
    expect(findAll(tree, (n) => n.attrs['data-testid'] === 'bot-screen-done').length).toBe(0)
    // il bottone di oggi vive nel blocco {phase === 'connected' && mode === 'view'} —
    // nel render statico phase è idle: lo si verifica sul sorgente
    const start = SRC.indexOf("phase === 'connected' && mode === 'view'")
    const block = SRC.slice(start, start + 900)
    expect(block).toContain('Prendi il controllo')
  })

  it("il clic su «Ho finito» chiama screenRelease (la nota viaggia con lui)", () => {
    renderScreen('control')
    const el = captured('bot-screen-done')!
    ;(el.props.onClick as () => void)()
    expect(callsOf('screenRelease').map((c) => c.args)).toEqual([['bot-1', undefined]])
  })
})

describe('U9: lo schermo non spinge fuori niente (guarda sul codice)', () => {
  it("il canvas ha min-h-0 (lo scaleViewport adatta l\\'immagine), NON min-h-[320px]", () => {
    expect(SRC).toContain('className="min-h-0 flex-1 bg-black/90"')
    expect(SRC).not.toContain('min-h-[320px] flex-1 bg-black/90')
  })

  it('la sezione nel pannello scorre (overflow-y-auto) se proprio non ci sta', () => {
    expect(SRC).toMatch(/inPanel \? '[^']*overflow-y-auto/)
  })

  it('il piede tiene SOLO la nota: «Ho finito» non è più laggiù', () => {
    // nel footer resta l'input della nota, il bottone no
    const footer = SRC.slice(SRC.indexOf('<footer'), SRC.indexOf('</footer>'))
    expect(footer).toContain('Nota per il bot')
    expect(footer).not.toContain('Ho finito')
    // release() manda la nota: esiste ancora e passa a screenRelease
    expect(SRC).toContain('api.screenRelease(agentId, note.trim() || undefined)')
  })
})
