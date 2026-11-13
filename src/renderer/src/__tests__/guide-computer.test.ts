// OB2 (fase onboarding-b): il passo «Computer» nella guida — il pannello
// (titolo, la riga del mockup, il bottone del consenso con le quattro cose
// IN PAROLE e i GB calcolati), la lista d'avanzamento condivisa (righe col
// loro stato, il bottone «Apri l'installazione» sull'attesa), la
// navigazione (Continua spento sull'attesa dell'Installer, attivo a ready
// o mentre download/immagine corrono in background; «Salta per ora»
// sempre) e il riepilogo di Pronto con la riga Computer. Render statico
// del componente VERO (render-helper) + guardie sul sorgente per i clic.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { useStore } from '../store'
import type { BoxSetupState, OnboardingStatus } from '../../../shared/types'

const GUIDE_SRC = readFileSync(fileURLToPath(new URL('../components/GuideView.tsx', import.meta.url)), 'utf8')

const { GuideView } = await import('../components/GuideView')

const AGENT = { id: 'a_1', name: 'Bot', description: '', providerId: null, model: null, status: 'idle' as const, unread: 0, createdAt: 1 }

const SEQ_COMPUTER = ['welcome', 'model', 'computer', 'approvals', 'chat'] as const

const computerStatus = (): OnboardingStatus => ({
  needed: true,
  state: { step: 'computer', done: ['welcome', 'model'], skipped: [], startedAt: 777 },
  sequence: [...SEQ_COMPUTER],
  modelReady: false,
  guideOpen: true
})

const setupState = (patch: Partial<BoxSetupState>): BoxSetupState => ({
  phase: 'idle', bytes: null, total: null, buildPhase: null, error: null, startedAt: null,
  neededBytes: 3_400_000_000, ...patch
})

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

const textOf = (n: ReturnType<typeof parseHtml>): string =>
  findAll(n, () => true).map((x) => x.text ?? '').join(' ')

const renderComputer = (boxSetup: BoxSetupState | null): { html: string; tree: ReturnType<typeof parseHtml> } => {
  setStoreStateForRender(useStore, {
    onboarding: computerStatus(),
    boxSetup,
    agents: [AGENT],
    mainAgentId: 'a_1',
    windowWidth: 1280
  })
  const html = renderHtml(createElement(GuideView))
  return { html, tree: parseHtml(html) }
}

describe('OB2: il pannello del passo Computer', () => {
  it('titolo, la riga del mockup e il bottone del consenso con le QUATTRO cose in parole', () => {
    const { html, tree } = renderComputer(setupState({}))
    expect(html).toContain('Il computer del bot')
    expect(html).toContain('Un computer tutto suo, dentro il tuo Mac: lavora lì senza toccare i tuoi file, e tu decidi cosa può vedere.')
    expect(byTestId(tree, 'guide-computer-prepare').length).toBe(1)
    const consent = textOf(byTestId(tree, 'guide-computer-consent')[0]!)
    expect(consent).toContain('container')
    expect(consent).toContain('170 MB')
    expect(consent).toContain('password del Mac')
    expect(consent).toContain('kernel Linux consigliato')
    // i GB CALCOLATI dalla stima (3,4 GB → 4 per eccesso), mai inventati
    expect(consent).toContain('4 GB')
  })

  it('la nuvoletta e l\'umore: «Mi preparo un computer tutto mio?» e thinking', () => {
    const { html, tree } = renderComputer(setupState({}))
    expect(html).toContain('Mi preparo un computer tutto mio?')
    expect(byTestId(tree, 'guide-scene')[0] && html).toContain('data-mood="thinking"')
  })

  it('l\'avanzamento durante il download: la prima riga in corso con la percentuale', () => {
    const { tree } = renderComputer(setupState({ phase: 'downloading', bytes: 850, total: 1000 }))
    const download = byTestId(tree, 'box-setup-row-download')[0]!
    expect(download.attrs['data-status']).toBe('running')
    expect(textOf(download)).toContain('85%')
    expect(byTestId(tree, 'box-setup-cancel').length).toBe(1)
    // il bottone del consenso NON c\'è più: la preparazione corre
    expect(byTestId(tree, 'guide-computer-prepare').length).toBe(0)
  })

  it('sull\'attesa dell\'Installer la riga diventa il bottone «Apri l\'installazione»', () => {
    const { tree, html } = renderComputer(setupState({ phase: 'awaiting-installer' }))
    expect(byTestId(tree, 'box-setup-open-installer').length).toBe(1)
    expect(html).toContain('Mi serve la tua password del Mac per installare lo strumento di Apple.')
    // niente «Annulla» sull'attesa: serve l'utente
    expect(byTestId(tree, 'box-setup-cancel').length).toBe(0)
  })

  it('l\'errore in parole con «Riprova»', () => {
    const { tree, html } = renderComputer(setupState({
      phase: 'error',
      error: { phase: 'verifying', code: 'sha256', message: 'Il pacchetto scaricato non è quello atteso: l’ho cancellato.' }
    }))
    expect(html).toContain('Qualcosa non è andato: te lo dico qui sotto.')
    expect(html).toContain('Il pacchetto scaricato non è quello atteso')
    expect(byTestId(tree, 'guide-computer-retry').length).toBe(1)
  })

  it('la riga dell\'immagine in corso durante la build', () => {
    const { tree } = renderComputer(setupState({ phase: 'building-image', buildPhase: 'LOAD' }))
    const img = byTestId(tree, 'box-setup-row-image')[0]!
    expect(img.attrs['data-status']).toBe('running')
    expect(textOf(img)).toContain('LOAD')
  })
})

describe('OB2: la navigazione del passo Computer', () => {
  it('«Continua» SPENTO sull\'attesa dell\'Installer; «Salta per ora» c\'è', () => {
    const { tree } = renderComputer(setupState({ phase: 'awaiting-installer' }))
    // React rende disabled="" quando c'è, e LO OMETTE quando non c'è
    expect(byTestId(tree, 'guide-continue')[0]!.attrs.disabled).toBe('')
    expect(byTestId(tree, 'guide-skip').length).toBe(1)
  })

  it('«Continua» ATTIVO a ready (e la nuvoletta dice «Ho il mio computer!»)', () => {
    const { tree, html } = renderComputer(setupState({ phase: 'ready' }))
    expect(byTestId(tree, 'guide-continue')[0]!.attrs.disabled).toBeUndefined()
    expect(html).toContain('Ho il mio computer!')
    expect(html).toContain('data-mood="happy"')
    expect(byTestId(tree, 'guide-skip').length).toBe(0)
  })

  it('«Continua» ATTIVO mentre il download o l\'immagine corrono in background', () => {
    for (const patch of [{ phase: 'downloading' as const, bytes: 1, total: 2 }, { phase: 'building-image' as const }]) {
      const { tree } = renderComputer(setupState(patch))
      expect(byTestId(tree, 'guide-continue')[0]!.attrs.disabled, patch.phase).toBeUndefined()
    }
  })

  it('«Continua» SPENTO durante la verifica (non è background: l\'utente aspetta)', () => {
    const { tree } = renderComputer(setupState({ phase: 'verifying' }))
    expect(byTestId(tree, 'guide-continue')[0]!.attrs.disabled).toBe('')
  })

  it('i clic veri: Continua a ready avanza il passo computer; Salta lo salta', () => {
    expect(GUIDE_SRC).toContain("void advance('computer', 'done')")
    expect(GUIDE_SRC).toContain("void advance('computer', 'skipped')")
  })

  it('il puntino del Computer nella fila SOLO quando il passo c\'è', () => {
    const { tree } = renderComputer(setupState({}))
    const rail = byTestId(tree, 'guide-rail')[0]!
    expect(textOf(rail)).toContain('Computer')
  })
})

describe('OB2: il riepilogo di «Pronto» con la riga Computer', () => {
  it('«Computer: pronto» quando la preparazione è finita', () => {
    setStoreStateForRender(useStore, {
      onboarding: { ...computerStatus(), state: { step: 'approvals', done: ['welcome', 'model', 'computer'], skipped: [], startedAt: 777 } },
      boxSetup: setupState({ phase: 'ready' }),
      agents: [AGENT],
      mainAgentId: 'a_1',
      windowWidth: 1280,
      guideReadyAt: 777
    })
    const html = renderHtml(createElement(GuideView))
    expect(html).toContain('Tutto pronto.')
    expect(html).toContain('Computer')
    expect(html).toContain('pronto')
  })

  it('«in preparazione» quando si è andati avanti col download in background (guardia sul sorgente)', () => {
    // la riga dice in preparazione quando boxSetupActive e non ready
    expect(GUIDE_SRC).toContain("computerDoneForSummary")
    expect(GUIDE_SRC).toContain("'preparing'")
  })
})
