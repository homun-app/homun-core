// RV3 (fase beta.2): la lingua si sceglie con UNA select (le pillole vanno
// bene per 2–3 voci, le lingue cresceranno): la STESSA select della
// «Finestra di consegna», con «Sistema» più una voce per lingua
// dell'elenco unico (SUPPORTED_UI_LANGUAGES), scritta col suo ENDONIMO —
// gli endonimi non si traducono: chi ha sbagliato lingua deve riconoscere
// la sua. Scegliere «English» salva ui.language = 'en' (lo store VERO, con
// l'api finta che registra la settingsSet).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, dialogPassThroughMock } from './render-helper'
import { callsOf } from './render-helper-install'
import { SUPPORTED_UI_LANGUAGES } from '../../../shared/ui-language'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
// il catalogo della lingua si carica col plugin vite dal .po (renderer); nei
// test il .po non si importa: si spegne SOLO activateUiLanguage, il resto del
// modulo (i18n, formatDate…) resta vero
vi.mock('../lib/i18n', async (orig) => {
  const m = await orig<typeof import('../lib/i18n')>()
  return { ...m, activateUiLanguage: async () => undefined }
})

// cattura delle props rese: per «cambiare» la select senza DOM si invoca il
// VERO onChange col valore scelto
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

const { Settings } = await import('../components/Settings')
const { useStore } = await import('../store')

function renderGenerale() {
  capture.els.length = 0
  setStoreStateForRender(useStore, { settingsOpen: true, settingsTab: null, uiLanguage: 'system' })
  const html = renderHtml(createElement(Settings))
  return { html, tree: parseHtml(html) }
}

describe('RV3: la lingua è UNA select, con le voci dell’elenco unico', () => {
  it('la select «Lingua» c’è, con «Sistema» più l’endonimo di ogni lingua (non tradotto)', () => {
    const { tree } = renderGenerale()
    const select = findAll(tree, (n) => n.tag === 'select' && n.attrs['aria-label'] === 'Lingua')[0]
    expect(select, 'la select della lingua dev’esserci (non le pillole)').toBeTruthy()
    const options = select!.children.filter((c) => c.tag === 'option')
    expect(options.map((o) => o.attrs['value'])).toEqual(['system', ...SUPPORTED_UI_LANGUAGES.map((l) => l.code)])
    expect(options.map((o) => o.text.trim())).toEqual(['Sistema', ...SUPPORTED_UI_LANGUAGES.map((l) => l.endonym)])
  })

  it('scegliere «English» salva ui.language = \'en\' (e attiva la lingua)', () => {
    renderGenerale()
    const select = capture.els.find((e) => e.type === 'select' && (e.props as { 'aria-label'?: string })['aria-label'] === 'Lingua')
    expect(select, 'la select della lingua dev’esserci').toBeTruthy()
    ;(select!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'en' } })
    expect(callsOf('settingsSet')).toContainEqual({ method: 'settingsSet', args: ['ui.language', 'en'] })
    expect(useStore.getState().uiLanguage).toBe('en')
    expect(useStore.getState().activeLanguage).toBe('en')
  })
})
