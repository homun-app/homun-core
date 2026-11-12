// G5 (fase guida): il passo «Permessi» — le due schede grandi del mockup
// coi testi VERI (la scrittura dei setting resta quella di OA3). «Fai
// quello che ti chiedo» senza modello resta spenta con la riga che dice
// perché; «Continua» è spento finché non si sceglie.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { useStore } from '../store'
import type { OnboardingStatus } from '../../../shared/types'

const AGENT = { id: 'a_1', name: 'Bot', description: '', providerId: null, model: null, status: 'idle' as const, unread: 0, createdAt: 1 }

const approvalsStatus = (modelReady: boolean): OnboardingStatus => ({
  needed: true,
  state: { step: 'approvals', done: ['welcome', 'model'], skipped: [], startedAt: 1 },
  sequence: ['welcome', 'model', 'approvals', 'chat'],
  modelReady,
  guideOpen: true
})

const renderApprovals = async (modelReady: boolean) => {
  setStoreStateForRender(useStore, { onboarding: approvalsStatus(modelReady), agents: [AGENT], mainAgentId: 'a_1', windowWidth: 1280 })
  const html = renderHtml(createElement((await import('../components/GuideView')).GuideView))
  return { html, tree: parseHtml(html) }
}

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

describe('G5: il passo «Permessi» — titolo, riga e le due schede del mockup', () => {
  it('titolo «Quanto posso fare da solo?» e riga «Lo cambi quando vuoi da Impostazioni › Approvazioni»', async () => {
    const { tree } = await renderApprovals(true)
    const panel = byTestId(tree, 'guide-step-approvals')[0]!
    const text = findAll(panel, () => true).map((n) => n.text ?? '').join(' ')
    expect(text).toContain('Quanto posso fare da solo?')
    expect(text).toContain('Lo cambi quando vuoi da Impostazioni › Approvazioni')
  })

  it('«Chiedimi prima»: descrizione e le due righe Da solo / Ti chiedo del mockup', async () => {
    const { tree } = await renderApprovals(true)
    const card = byTestId(tree, 'guide-approvals-ask')[0]!
    const text = findAll(card, () => true).map((n) => n.text ?? '').join(' ')
    expect(text).toContain('Chiedimi prima')
    expect(text).toContain('Leggo e cerco da solo. Prima di cambiare qualcosa, ti chiedo.')
    expect(text).toContain('Da solo')
    expect(text).toContain('leggere la posta, cercare sul web, preparare bozze')
    expect(text).toContain('Ti chiedo')
    expect(text).toContain('inviare, scrivere, cancellare, pagare')
  })

  it('«Fai quello che ti chiedo»: descrizione e righe del mockup; col modello è attiva', async () => {
    const { tree } = await renderApprovals(true)
    const card = byTestId(tree, 'guide-approvals-auto')[0]!
    const text = findAll(card, () => true).map((n) => n.text ?? '').join(' ')
    expect(text).toContain('Fai quello che ti chiedo')
    expect(text).toContain('Faccio da solo ciò che serve alla tua richiesta.')
    expect(text).toContain('tutto quello che serve a ciò che mi hai chiesto')
    expect(text).toContain('soldi, messaggi a persone nuove, cancellazioni, cose fuori richiesta')
    expect(card.attrs['disabled']).toBeUndefined()
  })

  it('senza modello «Fai quello che ti chiedo» è DISATTIVATA con «Serve un modello: torna indietro e collegane uno»', async () => {
    const { tree } = await renderApprovals(false)
    const card = byTestId(tree, 'guide-approvals-auto')[0]!
    expect(card.attrs['disabled']).toBeDefined()
    const text = findAll(card, () => true).map((n) => n.text ?? '').join(' ')
    expect(text).toContain('Serve un modello: torna indietro e collegane uno')
    // «Chiedimi prima» resta sempre attiva
    expect(byTestId(tree, 'guide-approvals-ask')[0]!.attrs['disabled']).toBeUndefined()
  })

  it('«Continua» è SPENTO finché non si sceglie; niente «Salta per ora» su questo passo', async () => {
    const { tree } = await renderApprovals(true)
    expect(byTestId(tree, 'guide-continue')[0]!.attrs['disabled']).toBeDefined()
    expect(byTestId(tree, 'guide-skip').length).toBe(0)
  })
})
