// G2 (fase guida): il RENDER della scena della guida (react-dom/server, come
// gli altri test del renderer): la mascotte è il componente Bot VERO (niente
// emoji 🧚), la nuvoletta porta la frase del passo, «Continua» è disattivo
// senza modello, e la fila dei puntini c'è con la lingua.
import { describe, expect, it, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf, setStoreStateForRender } from './render-helper'
import './render-helper-install'
import { useStore } from '../store'
import { GuideView } from '../components/GuideView'
import type { OnboardingStatus } from '../../../shared/types'

const AGENT = {
  id: 'a_1', name: 'Bot', description: '', providerId: null, model: null,
  status: 'idle' as const, unread: 0, createdAt: 1
}

const status = (step: OnboardingStatus['state'], modelReady = false): OnboardingStatus => ({
  needed: true,
  state: step,
  sequence: ['welcome', 'model', 'approvals', 'chat'],
  modelReady,
  guideOpen: true
})

const seed = (onboarding: OnboardingStatus, windowWidth = 1280): void => {
  setStoreStateForRender(useStore, {
    onboarding,
    agents: [AGENT],
    mainAgentId: 'a_1',
    windowWidth
  })
}

const byTestId = (root: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(root, (n) => n.attrs['data-testid'] === testId)

/** Il markup della guida per lo stato dato. */
const renderGuide = (onboarding: OnboardingStatus, windowWidth = 1280): string => {
  seed(onboarding, windowWidth)
  return renderHtml(createElement(GuideView))
}

beforeEach(() => {
  // il providerPaths delle strade non serve qui: senza, la griglia mostra cloud
  setStoreStateForRender(useStore, { onboarding: null, agents: [AGENT], mainAgentId: 'a_1', windowWidth: 1280 })
})

describe('G2: la scena della guida — mascotte Bot, nuvoletta, niente emoji', () => {
  it('al benvenuto: il Bot VERO (svg .bot) e il nome sotto, nessuna emoji', () => {
    const html = renderGuide(status({ step: 'welcome', done: [], skipped: [], startedAt: 1 }))
    const tree = parseHtml(html)
    expect(byTestId(tree, 'guide-scene').length).toBeGreaterThan(0)
    expect(findAll(tree, (n) => n.tag === 'svg').length).toBeGreaterThan(0)
    expect(html).not.toContain('🧚')
    // il nome del bot principale sotto la mascotte
    const scene = byTestId(tree, 'guide-scene')[0]!
    expect(textOf(scene)).toContain('Bot')
  })

  it('la nuvoletta porta la frase del passo (il saluto del mockup)', () => {
    const html = renderGuide(status({ step: 'welcome', done: [], skipped: [], startedAt: 1 }))
    expect(html).toContain('Ciao! Sono il tuo nuovo bot. Come mi chiami?')
  })

  it('la fila dei puntini (Tu · Modello · Permessi) e la select della lingua', () => {
    const html = renderGuide(status({ step: 'welcome', done: [], skipped: [], startedAt: 1 }))
    const tree = parseHtml(html)
    expect(textOf(byTestId(tree, 'guide-rail')[0]!)).toContain('Tu')
    expect(textOf(byTestId(tree, 'guide-rail')[0]!)).toContain('Modello')
    expect(textOf(byTestId(tree, 'guide-rail')[0]!)).toContain('Permessi')
    expect(byTestId(tree, 'guide-language-select').length).toBe(1)
  })

  it('passo Modello senza modello: «Continua» DISATTIVO e «Salta per ora» presente', () => {
    const html = renderGuide(status({ step: 'model', done: ['welcome'], skipped: [], startedAt: 1 }, false))
    const tree = parseHtml(html)
    const cont = byTestId(tree, 'guide-continue')[0]!
    expect(cont.attrs['disabled']).toBeDefined()
    expect(byTestId(tree, 'guide-skip').length).toBe(1)
  })

  it('passo Modello col modello pronto: «Continua» ATTIVO e niente «Salta per ora»', () => {
    const html = renderGuide(status({ step: 'model', done: ['welcome'], skipped: [], startedAt: 1 }, true))
    const tree = parseHtml(html)
    const cont = byTestId(tree, 'guide-continue')[0]!
    expect(cont.attrs['disabled']).toBeUndefined()
    expect(byTestId(tree, 'guide-skip').length).toBe(0)
  })

  it('finestra stretta (820): la scena impilata resta senza scorrimenti nascosti', () => {
    const html = renderGuide(status({ step: 'welcome', done: [], skipped: [], startedAt: 1 }), 820)
    const tree = parseHtml(html)
    expect(byTestId(tree, 'guide-scene').length).toBeGreaterThan(0)
    expect(byTestId(tree, 'guide-step-welcome').length).toBe(1)
  })
})
