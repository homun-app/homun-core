// G3 (fase guida): il passo «Tu» — nome e faccia del bot principale. Il nome
// si normalizza in UNA funzione pura (guideNameOf); il pannello ha il campo
// nome (max 40, segnaposto «Bot»), le 5 famiglie come piastrelle col Bot
// piccolo (62 px) nel colore scelto, i 7 colori come tondi; ogni scelta è
// immediata sulla scena (anteprima) e «Continua» salva con agents:update.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { guideNameOf, GUIDE_NAME_MAX } from '../lib/guide-identity'
import { BOT_FAMILIES, BOT_COLORS } from '../../../shared/avatar'
import type { OnboardingStatus } from '../../../shared/types'

// il comportamento guidato dai clic (anteprima immediata, salvataggio) qui
// come guardia sul sorgente di GuideView: i render statici non conservano lo
// stato tra due passate, e dal vivo lo prova la sonda (G8)
const GUIDE_SRC = readFileSync(fileURLToPath(new URL('../components/GuideView.tsx', import.meta.url)), 'utf8')

const { GuideView } = await import('../components/GuideView')
const { useStore } = await import('../store')

const AGENT = {
  id: 'a_1', name: 'Bot', description: '', providerId: null, model: null,
  status: 'idle' as const, unread: 0, createdAt: 1
}

const welcomeStatus = (): OnboardingStatus => ({
  needed: true,
  state: { step: 'welcome', done: [], skipped: [], startedAt: 1 },
  sequence: ['welcome', 'model', 'approvals', 'chat'],
  modelReady: false,
  guideOpen: true
})

const renderWelcome = (): { html: string; tree: ReturnType<typeof parseHtml> } => {
  setStoreStateForRender(useStore, { onboarding: welcomeStatus(), agents: [AGENT], mainAgentId: 'a_1', windowWidth: 1280 })
  const html = renderHtml(createElement(GuideView))
  return { html, tree: parseHtml(html) }
}

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

describe('G3 guideNameOf (pura): il nome del bot principale si normalizza in un punto', () => {
  it('spazi ai bordi tolti, e vuoto → «Bot»', () => {
    expect(guideNameOf('  Nanna  ')).toBe('Nanna')
    expect(guideNameOf('   ')).toBe('Bot')
    expect(guideNameOf('')).toBe('Bot')
  })

  it(`tetto di ${GUIDE_NAME_MAX} caratteri`, () => {
    expect(GUIDE_NAME_MAX).toBe(40)
    expect(guideNameOf('a'.repeat(80))).toBe('a'.repeat(40))
    expect(guideNameOf('  ' + 'b'.repeat(45) + ' ')).toBe('b'.repeat(40))
  })
})

describe('G3: il pannello del passo «Tu»', () => {
  it('titolo e riga di spiegazione del mockup', () => {
    const { tree } = renderWelcome()
    const panel = byTestId(tree, 'guide-step-welcome')[0]!
    const text = findAll(panel, () => true).map((n) => n.text ?? '').join(' ')
    expect(text).toContain('Diamo una faccia al tuo bot')
    expect(text).toContain('punto di contatto in Homun')
  })

  it('il campo nome: segnaposto «Bot», tetto 40, parte vuoto col nome di default', () => {
    const { tree } = renderWelcome()
    const input = byTestId(tree, 'guide-name-input')[0]!
    expect(input.tag).toBe('input')
    expect(input.attrs['placeholder']).toBe('Bot')
    expect(input.attrs['maxLength']).toBe('40')
    expect(input.attrs['value'] ?? '').toBe('')
  })

  it('le 5 facce: bottoni veri con aria-pressed, ognuna col suo Bot da 62 px nel colore scelto', () => {
    const { tree, html } = renderWelcome()
    for (const f of BOT_FAMILIES) {
      const btn = byTestId(tree, `guide-family-${f}`)[0]
      expect(btn, `la piastrella ${f} dev'esserci`).toBeTruthy()
      expect(btn!.tag).toBe('button')
      expect(btn!.attrs['aria-pressed']).toBe(f === 'h-creature' ? 'true' : 'false')
    }
    // ogni piastrella contiene un Bot (svg) da 62 px
    expect(html.match(/width:62px/g)?.length ?? 0).toBe(BOT_FAMILIES.length)
    expect(html).toContain('Creatura')
    expect(html).toContain('Robottino')
    expect(html).toContain('Gelatina')
    expect(html).toContain('Pixel')
  })

  it('i 7 colori: tondi da 34 px, aria-label col nome, il selezionato col doppio anello', () => {
    const { tree, html } = renderWelcome()
    for (const c of BOT_COLORS) {
      const btn = byTestId(tree, `guide-color-${c}`)[0]
      expect(btn, `il tondo ${c} dev'esserci`).toBeTruthy()
      expect(btn!.attrs['aria-pressed']).toBe(c === 'c1' ? 'true' : 'false')
      expect(btn!.attrs['aria-label']).toBeTruthy()
    }
    expect(html).toContain('var(--bot-c1)')
    // il doppio anello del selezionato (c1 di default)
    expect(html).toContain('shadow-[0_0_0_3px_var(--background),0_0_0_5px_var(--foreground)]')
  })

  it('anteprima IMMEDIATA: la scena del passo Tu disegna la BOZZA (famiglia, colore, nome digitato)', () => {
    expect(GUIDE_SRC).toContain("const onTuStep = daemonStep === 'welcome' || backTo === 'welcome'")
    expect(GUIDE_SRC).toContain('const avatar = onTuStep ? (draftAvatar ?? savedAvatar) : savedAvatar')
    // ogni scelta di faccia/colore aggiorna la bozza E fa il lampo felice (~1 s)
    expect(GUIDE_SRC).toContain('onPickFamily={(family) => { setDraftAvatar({ family, color: avatar.color }); happyFlash() }}')
    expect(GUIDE_SRC).toContain('onPickColor={(color) => { setDraftAvatar({ family: avatar.family, color }); happyFlash() }}')
    expect(GUIDE_SRC).toContain('setTimeout(() => setFlashHappy(false), 1_100)')
  })

  it('clic su un colore: il tondo scelto guida la scena (guardia: i colori passano da BOT_COLORS)', () => {
    const { html } = renderWelcome()
    for (const c of BOT_COLORS) expect(html).toContain(`var(--bot-${c})`)
  })

  it('«Continua» salva con agents:update: nome normalizzato (guideNameOf) e avatar scelto', () => {
    expect(GUIDE_SRC).toContain('api.updateAgent(mainAgentId, { name: guideNameOf(draftName), avatar: { family: avatar.family, color: avatar.color } })')
  })

  it('Invio nel campo nome conferma (onConfirm: la stessa strada di «Continua»)', () => {
    expect(GUIDE_SRC).toContain("if (e.key === 'Enter') { e.preventDefault(); onConfirm() }")
  })
})
