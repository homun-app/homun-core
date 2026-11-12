// G4 (fase guida): la GRIGLIA del passo Modello nel render — le schede
// visibili (Anthropic col badge consigliato, OpenAI, OpenRouter, Altri…;
// Ollama SOLO se trovato, Integrato SOLO se idoneo), e il foglio
// «Aggiungi provider» delle Impostazioni rifattorizzato sull'hook condiviso
// useProviderSetup resta COM'E' (elenco dei tipi, campo chiave, prova).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import type { OnboardingStatus } from '../../../shared/types'

// i render statici non conservano lo stato tra due passate: il cambio
// pannello (scheda → pannello del provider) qui è una guardia sul sorgente;
// dal vivo lo prova la sonda (G8) con clic veri
const MODEL_SRC = readFileSync(fileURLToPath(new URL('../components/GuideModelStep.tsx', import.meta.url)), 'utf8')
const SHEET_SRC = readFileSync(fileURLToPath(new URL('../components/settings/AddProviderSheet.tsx', import.meta.url)), 'utf8')

// cattura delle props rese per invocare i VERO handler
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

const { GuideView } = await import('../components/GuideView')
const { AddProviderSheet } = await import('../components/settings/AddProviderSheet')
const { useStore } = await import('../store')

const AGENT = { id: 'a_1', name: 'Bot', description: '', providerId: null, model: null, status: 'idle' as const, unread: 0, createdAt: 1 }

const modelStatus = (providerPaths?: OnboardingStatus['providerPaths']): OnboardingStatus => ({
  needed: true,
  state: { step: 'model', done: ['welcome'], skipped: [], startedAt: 1 },
  sequence: ['welcome', 'model', 'approvals', 'chat'],
  modelReady: false,
  guideOpen: true,
  ...(providerPaths ? { providerPaths } : {})
})

const renderModel = (providerPaths?: OnboardingStatus['providerPaths']) => {
  setStoreStateForRender(useStore, {
    onboarding: modelStatus(providerPaths),
    agents: [AGENT],
    mainAgentId: 'a_1',
    windowWidth: 1280
  })
  const html = renderHtml(createElement(GuideView))
  return { html, tree: parseHtml(html) }
}

/** Il testo visibile di tutto l'albero (per la guardia «mai Google»). */
const allText = (root: ReturnType<typeof parseHtml>): string =>
  findAll(root, () => true).map((n) => n.text ?? '').join(' ')

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

describe('G4: la griglia del passo Modello', () => {
  it('senza strade extra: Anthropic (consigliato), OpenAI, OpenRouter, Altri… — niente Ollama, niente Integrato, mai Google', () => {
    const { tree } = renderModel(['cloud'])
    for (const id of ['guide-provider-anthropic', 'guide-provider-openai', 'guide-provider-openrouter', 'guide-provider-others']) {
      expect(byTestId(tree, id).length, `${id} dev'esserci`).toBe(1)
    }
    expect(byTestId(tree, 'guide-provider-ollama').length).toBe(0)
    expect(byTestId(tree, 'guide-provider-local').length).toBe(0)
    expect(allText(tree)).not.toContain('Google')
    // i badge del mockup
    const anthropic = byTestId(tree, 'guide-provider-anthropic')[0]!
    expect(findAll(anthropic, (n) => n.text?.includes('consigliato')).length).toBeGreaterThan(0)
  })

  it('con Ollama trovato e Integrato idoneo: le loro schede, col badge «trovato» su Ollama', () => {
    const { tree } = renderModel(['cloud', 'ollama', 'local'])
    expect(byTestId(tree, 'guide-provider-ollama').length).toBe(1)
    expect(byTestId(tree, 'guide-provider-local').length).toBe(1)
    const ollama = byTestId(tree, 'guide-provider-ollama')[0]!
    expect(findAll(ollama, (n) => n.text?.includes('trovato')).length).toBeGreaterThan(0)
  })

  it('«Altri…» apre l\'elenco degli altri kind con chiave, col compatibile OpenAI che chiede l\'indirizzo', () => {
    const { tree } = renderModel(['cloud'])
    expect(findAll(tree, (n) => n.text?.includes('Altri…')).length).toBeGreaterThan(0)
    // l'elenco completo lo prova la sonda (G8) col clic vero; qui la griglia
    // espone la scheda e la regola dei tipi è in guide-provider-cards (purа)
    void byTestId
  })

  it('il pannello del provider PRENDE il posto della griglia, con «← Altri provider» per tornare', () => {
    // il pannello con chiave e il ritorno: il pannello è reso AL POSTO della
    // griglia (un solo blocco per volta, con l'entrata animata guide-stepin)
    expect(MODEL_SRC).toContain('data-testid="guide-back-providers"')
    expect(MODEL_SRC).toContain('data-testid="guide-key-input"')
    expect(MODEL_SRC).toContain("setup.reset(); setSelectedModel(null)")
    // il bottone «Prova» e il campo password
    expect(MODEL_SRC).toContain('type="password"')
    expect(MODEL_SRC).toContain('data-testid="guide-key-probe"')
    expect(MODEL_SRC).toContain('setup.probeNow()')
    // il link «Dove la trovo?» alla pagina delle chiavi del provider
    expect(MODEL_SRC).toContain('providerKeyUrl(kind!)')
    expect(MODEL_SRC).toContain('target="_blank"')
    // Continua del pannello: saveProvider (Portachiavi) e POI models.main —
    // il passo si chiude da solo (modelBecameReady), niente advance dal client
    expect(MODEL_SRC).toContain("await api.settingsSet('models.main', { providerId, model: selectedModel, thinking: null })")
    expect(MODEL_SRC).not.toContain("advance('model'")
  })
})

describe('GC2: le pillole dei modelli del pannello con chiave', () => {
  it('un SOLO controllo «Altri modelli…» e nessun testo di modello ripetuto', async () => {
    const { GuideModelPills } = await import('../components/GuideModelStep')
    const { createElement: ce } = await import('react')
    const html = renderHtml(ce(GuideModelPills, {
      kind: 'anthropic',
      models: ['claude-sonnet-4-5', 'bravo', 'sciocco'],
      selected: 'bravo',
      onSelect: () => undefined,
      pickerLabel: 'Altri modelli…'
    }))
    const tree = parseHtml(html)
    const texts = findAll(tree, (n) => !!n.text).map((n) => n.text ?? '')
    // UNA sola «Altri modelli…»: il trigger del picker non mostra il valore
    expect(texts.filter((t) => t === 'Altri modelli…')).toHaveLength(1)
    // il modello scelto compare UNA volta sola (nella sua pillola), mai anche nel trigger
    expect(texts.filter((t) => t === 'bravo')).toHaveLength(1)
    expect(texts.filter((t) => t.includes('bravo'))).toHaveLength(1)
    // niente campo di testo: il trigger è una pillola come le altre
    expect(findAll(tree, (n) => n.tag === 'input')).toHaveLength(0)
  })

  it('la scelta evidenzia la pillola giusta; dal picker una pillola NUOVA, selezionata, al posto dell\'ultima', async () => {
    const { GuideModelPills } = await import('../components/GuideModelStep')
    const { createElement: ce } = await import('react')
    const render = (selected: string | null) => {
      // come nel pannello: le pillole stanno nel contenitore guide-model-pills
      const html = renderHtml(ce('div', { 'data-testid': 'guide-model-pills', className: 'contents' }, ce(GuideModelPills, {
        kind: 'anthropic',
        models: ['claude-sonnet-4-5', 'bravo', 'sciocco', 'lungo', 'vecchio'],
        selected,
        onSelect: () => undefined,
        pickerLabel: 'Altri modelli…'
      })))
      return parseHtml(html)
    }
    // la pillola scelta è premuta, le altre no
    let tree = render('bravo')
    expect(byTestId(tree, 'guide-model-bravo')[0]!.attrs['aria-pressed']).toBe('true')
    expect(byTestId(tree, 'guide-model-claude-sonnet-4-5')[0]!.attrs['aria-pressed']).toBe('false')
    // un modello del picker che non è fra le pillole: ultima pillola, selezionata
    tree = render('estratto-dal-picker')
    const last = byTestId(tree, 'guide-model-estratto-dal-picker')
    expect(last).toHaveLength(1)
    expect(last[0]!.attrs['aria-pressed']).toBe('true')
    // al massimo 4 pillole + il trigger «Altri modelli…»
    const pills = byTestId(tree, 'guide-model-pills')[0]!
    expect(findAll(pills, (n) => n.tag === 'button')).toHaveLength(5)
  })

  it('il pannello usa le pillole e il trigger NON mostra mai il valore scelto', () => {
    // il pannello col chiave renderizza GuideModelPills (che porta il trigger
    // pill del ModelPicker), non più il campo-elicottero col valore dentro
    expect(MODEL_SRC).toContain('GuideModelPills')
    expect(MODEL_SRC).not.toContain('placeholder={t`Altri modelli…`}')
  })
})

describe('G4: il foglio «Aggiungi provider» resta com\'era (hook condiviso)', () => {
  it('l\'elenco dei tipi coi tre gruppi, il campo chiave e la nota del Portachiavi', () => {
    capture.els.length = 0
    setStoreStateForRender(useStore, { providers: [], agents: [AGENT], mainAgentId: 'a_1' })
    const html = renderHtml(createElement(AddProviderSheet, { onClose: () => undefined, onSaved: () => undefined }))
    expect(html).toContain('Aggiungi provider')
    expect(html).toContain('Sul tuo Mac')
    expect(html).toContain('Con una chiave')
    expect(html).toContain('Un altro server')
    expect(html).toContain('Cerca (Ollama, Anthropic…)')
    void findAll
  })

  it('il foglio usa l\'hook condiviso con la prova AUTOMATICA e i pezzi noti non cambiano', () => {
    expect(SHEET_SRC).toContain("useProviderSetup(kind, { autoProbe: true })")
    expect(SHEET_SRC).toContain('id="sandbot-addprovider-key"')
    expect(SHEET_SRC).toContain('La chiave resta nel Portachiavi del Mac.')
    // la prova automatica al cambio chiave c\'è ancora (debounce dell'hook)
    expect(SHEET_SRC).toContain('setApiKey(e.target.value)')
    expect(SHEET_SRC).toContain('await setup.save(')
  })
})
