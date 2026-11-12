// G6 (fase guida): il passo «Pronto» (SOLO UI: la sequenza del daemon non
// cambia) — «Tutto pronto.», tre righe di riepilogo (bot, modello o «da
// scegliere», permessi), «Apri la chat» che fa l'avanzare di approvals; e
// l'arrivo: la mascotte vola dalla scena al pannello del bot (FLIP Web
// Animations ~450 ms), con prefers-reduced-motion o senza bersaglio niente.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { stubApiMethod } from './render-helper-install'
import { useStore } from '../store'
import type { OnboardingStatus } from '../../../shared/types'

const GUIDE_SRC = readFileSync(fileURLToPath(new URL('../components/GuideView.tsx', import.meta.url)), 'utf8')
const ARRIVAL_SRC = readFileSync(fileURLToPath(new URL('../lib/guide-arrival.ts', import.meta.url)), 'utf8')
const APP_SRC = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')

const AGENT = { id: 'a_1', name: 'Nanna', description: '', providerId: null, model: null, status: 'idle' as const, unread: 0, createdAt: 1, avatar: { family: 'jelly', color: 'c3' } }

const readyStatus = (): OnboardingStatus => ({
  needed: true,
  state: { step: 'approvals', done: ['welcome', 'model'], skipped: [], startedAt: 777 },
  sequence: ['welcome', 'model', 'approvals', 'chat'],
  modelReady: false,
  guideOpen: true
})

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

describe('G6: il passo «Pronto» (solo UI, la sequenza del daemon non cambia)', () => {
  it('«Tutto pronto.» con le tre righe: il bot (nome, faccia, colore), il modello «da scegliere», i permessi', async () => {
    stubApiMethod('settingsGet', (...args: unknown[]) => Promise.resolve(args[1]))
    const { GuideView } = await import('../components/GuideView')
    setStoreStateForRender(useStore, {
      onboarding: readyStatus(),
      agents: [AGENT],
      mainAgentId: 'a_1',
      windowWidth: 1280,
      guideReadyAt: 777
    })
    const html = renderHtml(createElement(GuideView))
    const tree = parseHtml(html)
    expect(html).toContain('Tutto pronto.')
    expect(byTestId(tree, 'guide-step-ready').length).toBe(1)
    const bot = byTestId(tree, 'guide-summary-bot')[0]!
    expect(findAll(bot, () => true).map((n) => n.text ?? '').join(' ')).toContain('Nanna')
    const model = byTestId(tree, 'guide-summary-model')[0]!
    expect(findAll(model, () => true).map((n) => n.text ?? '').join(' ')).toContain('da scegliere')
    const perms = byTestId(tree, 'guide-summary-permissions')[0]!
    expect(findAll(perms, () => true).map((n) => n.text ?? '').join(' ')).toContain('Chiedimi prima')
    // il bottone della navigazione si chiama «Apri la chat»
    expect(html).toContain('Apri la chat')
  })

  it('il passo Pronto NON è un passo del daemon: «Apri la chat» fa l\'avanzare di approvals', () => {
    // GuideView: la Continua di Pronto chiama advance('approvals', 'done') — è
    // QUELLO che porta a 'chat' (niente passo nuovo nella sequenza del daemon)
    expect(GUIDE_SRC).toContain("stashMascotFlight()")
    expect(GUIDE_SRC).toContain("void advance('approvals', 'done')")
    // il passo Pronto si raggiunge SOLO via guideReadyAt (chiave startedAt):
    // un «Rifai da capo» (startedAt nuovo) lo azzera da solo
    expect(GUIDE_SRC).toContain('guideReadyAt === state.startedAt')
  })
})

describe('G6: l\'arrivo — la mascotte VOLA dalla scena al pannello del bot', () => {
  it('il volo è un FLIP via Web Animations di ~450 ms, dal fantasma fisso al bersaglio', () => {
    expect(ARRIVAL_SRC).toContain('const FLIGHT_MS = 450')
    expect(ARRIVAL_SRC).toContain('.animate(')
    expect(ARRIVAL_SRC).toContain("document.querySelector('[data-testid=\"bot-settings-trigger\"] .bot')")
  })

  it('prefers-reduced-motion o bersaglio mancante → niente volo (semplice dissolvenza)', () => {
    expect(ARRIVAL_SRC).toContain("(prefers-reduced-motion: reduce)")
    expect(ARRIVAL_SRC).toContain('return')
  })

  it('la guida misura la mascotte PRIMA di avanzare; App la fa volare al passaggio guida → shell', () => {
    expect(GUIDE_SRC).toContain('stashMascotFlight()')
    expect(APP_SRC).toContain("import { flyStashedMascotTo } from './lib/guide-arrival'")
    expect(APP_SRC).toContain('flyStashedMascotTo()')
    expect(APP_SRC).toContain("=== 'guide'")
  })
})
