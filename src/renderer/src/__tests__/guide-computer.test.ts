// OB2 (fase onboarding-b): il passo «Computer» nella guida — il pannello
// (titolo, la riga del mockup, il bottone del consenso con le quattro cose
// IN PAROLE e i GB calcolati), la lista d'avanzamento condivisa (righe col
// loro stato, il bottone «Apri l'installazione» sull'attesa), la
// navigazione (OBD1: Continua attivo SOLO a ready — durante download e
// immagine è disabilitato; «Salta per ora» sempre, finché non è ready) e
// il riepilogo di Pronto con la riga Computer. Render statico
// del componente VERO (render-helper) + guardie sul sorgente per i clic.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { useStore } from '../store'
import type { BoxSetupState, OnboardingStatus } from '../../../shared/types'
import type { BoxSetupRowId } from '../../../shared/types'
import { BOX_SETUP_ROW_IDS } from '../../../shared/box-setup-plan'

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
  phase: 'idle', bytes: null, total: null, buildPhase: null, error: null, startedAt: null, skipped: [],
  neededBytes: 3_400_000_000, ...patch
})

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

const textOf = (n: ReturnType<typeof parseHtml>): string =>
  findAll(n, () => true).map((x) => x.text ?? '').join(' ')

const renderComputer = (boxSetup: BoxSetupState | null, plan: readonly BoxSetupRowId[] | null = [...BOX_SETUP_ROW_IDS]): { html: string; tree: ReturnType<typeof parseHtml> } => {
  setStoreStateForRender(useStore, {
    onboarding: computerStatus(),
    boxSetup,
    // OBD2: il piano del consenso (RPC box:setup-plan) — di default tutto il
    // percorso, come i test di prima della fase dettagli
    boxSetupPlan: plan === null ? null : [...plan],
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
    // i GB CALCOLATI dalla stima del piano (2,84 GB → 3 per eccesso), mai inventati
    expect(consent).toContain('3 GB')
  })

  // OBD2: il consenso elenca SOLO quello che succederà — le righe sono i
  // passi del PIANO (RPC box:setup-plan, stessa funzione pura della partenza)
  it('OBD2: con il piano di SOLO l\'immagine NESSUNA riga parla di GitHub, Installer, password o kernel — e c\'è «non serve la password del Mac»', () => {
    const { tree } = renderComputer(setupState({}), ['image'])
    const consent = textOf(byTestId(tree, 'guide-computer-consent')[0]!)
    expect(consent).not.toContain('GitHub')
    expect(consent).not.toContain('170 MB')
    expect(consent).not.toContain('ti chiederà la password')
    expect(consent).not.toContain('kernel')
    // la riga in più che dice la verità: niente password stavolta
    expect(consent).toContain('non serve la password del Mac')
    // solo la riga dell'immagine, coi GB del piano (1,5 GB → 2 per eccesso)
    expect(findAll(byTestId(tree, 'guide-computer-consent')[0]!, (n) => n.tag === 'li').length).toBe(2)
    expect(consent).toContain('preparo il computer del bot (circa 2 GB)')
  })

  it('OBD2: con l\'Installer nel piano la riga della password RESTA (e niente «non serve la password»)', () => {
    const { tree } = renderComputer(setupState({}), ['download', 'verify', 'installer', 'service', 'kernel', 'image'])
    const consent = textOf(byTestId(tree, 'guide-computer-consent')[0]!)
    expect(consent).toContain('ti chiederà la password del Mac')
    expect(consent).not.toContain('non serve la password del Mac')
    // e i GB sono della stima intera (2,84 GB → 3)
    expect(consent).toContain('3 GB')
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

  // OBD2: le righe saltate col LORO testo sotto l'etichetta, e il segno
  // neutro — mai il ✓ verde delle fasi fatte
  it('OBD2: le righe saltate col loro testo (segno neutro, non il ✓)', () => {
    const { tree, html } = renderComputer(setupState({
      phase: 'building-image',
      skipped: ['download', 'verify', 'installer', 'service', 'kernel']
    }))
    const texts: Array<[string, string]> = [
      ['download', 'Già installato: niente da scaricare'],
      ['verify', 'Non serve'],
      ['installer', 'Già installato'],
      ['service', 'Era già acceso'],
      ['kernel', 'Era già presente']
    ]
    for (const [id, text] of texts) {
      const row = byTestId(tree, `box-setup-row-${id}`)[0]!
      expect(row.attrs['data-status']).toBe('skipped')
      expect(textOf(row)).toContain(text)
      expect(textOf(row)).not.toContain('✓')
    }
    // la riga dell'immagine corre (non è saltata)
    expect(byTestId(tree, 'box-setup-row-image')[0]!.attrs['data-status']).toBe('running')
    expect(html).toContain('–')
  })
})

describe('OBR4: nell\'errore UN solo bottone — «Riprova»', () => {
  const errorState = (): BoxSetupState => setupState({
    phase: 'error',
    error: { phase: 'verifying', code: 'sha256', message: 'Il pacchetto scaricato non è quello atteso: l’ho cancellato.' }
  })

  it('con error «Prepara il computer» NON c\'è più: resta solo «Riprova», nel riquadro dell\'errore', () => {
    const { tree } = renderComputer(errorState())
    // «Prepara il computer» e «Riprova» facevano la stessa cosa: ne resta uno
    expect(byTestId(tree, 'guide-computer-prepare').length).toBe(0)
    expect(byTestId(tree, 'guide-computer-retry').length).toBe(1)
    const box = byTestId(tree, 'guide-computer-error')[0]!
    expect(findAll(box, (n) => n.attrs['data-testid'] === 'guide-computer-retry').length).toBe(1)
    // nel pannello del passo c'è UN solo bottone (la navigazione della guida è fuori)
    const step = byTestId(tree, 'guide-step-computer')[0]!
    expect(findAll(step, (n) => n.tag === 'button').length).toBe(1)
  })

  it('il consenso resta visibile SOPRA, in testo: le quattro righe di cosa farà, senza bottone', () => {
    const { html, tree } = renderComputer(errorState())
    const consent = byTestId(tree, 'guide-computer-consent')
    expect(consent.length).toBe(1)
    expect(findAll(consent[0]!, (n) => n.tag === 'li').length).toBe(4)
    const text = textOf(consent[0]!)
    expect(text).toContain('170 MB')
    expect(text).toContain('password del Mac')
    expect(text).toContain('kernel Linux consigliato')
    expect(text).toContain('3 GB')
    // nessun bottone dentro (né attorno, nello stesso riquadro) al consenso
    expect(findAll(consent[0]!.parent!, (n) => n.tag === 'button').length).toBe(0)
    // sopra: il consenso viene PRIMA del riquadro dell'errore
    expect(html.indexOf('data-testid="guide-computer-consent"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-testid="guide-computer-consent"')).toBeLessThan(html.indexOf('data-testid="guide-computer-error"'))
  })

  it('fuori dall\'errore il bottone del consenso c\'è come prima (mai partita)', () => {
    const { tree } = renderComputer(setupState({}))
    expect(byTestId(tree, 'guide-computer-prepare').length).toBe(1)
    expect(byTestId(tree, 'guide-computer-consent').length).toBe(1)
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

  // OBD1 (fase onboarding-b-dettagli): «Continua» è attivo SOLO a ready —
  // durante download e immagine il passo NON è finito, e un bottone attivo
  // diceva il contrario. La sola via per andare avanti prima della fine è
  // «Salta per ora» (e la preparazione continua in background).
  it('OBD1: durante il download «Continua» è DISABILITATO (oggi era attivo)', () => {
    const { tree } = renderComputer(setupState({ phase: 'downloading', bytes: 1, total: 2 }))
    expect(byTestId(tree, 'guide-continue')[0]!.attrs.disabled).toBe('')
  })

  it('OBD1: durante la build dell\'immagine «Continua» è DISABILITATO (oggi era attivo)', () => {
    const { tree } = renderComputer(setupState({ phase: 'building-image' }))
    expect(byTestId(tree, 'guide-continue')[0]!.attrs.disabled).toBe('')
  })

  it('OBD1: a fase ready «Continua» è ATTIVO', () => {
    const { tree } = renderComputer(setupState({ phase: 'ready' }))
    expect(byTestId(tree, 'guide-continue')[0]!.attrs.disabled).toBeUndefined()
  })

  it('OBD1: «Salta per ora» c\'è durante la build dell\'immagine (la sola via prima della fine)', () => {
    const { tree } = renderComputer(setupState({ phase: 'building-image' }))
    expect(byTestId(tree, 'guide-skip').length).toBe(1)
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
