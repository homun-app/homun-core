// RV1 (fase beta.2), punto 4 — la riga «Versione e aggiornamenti» quando
// l'app va spostata in Applicazioni: compare il MOTIVO («Per gli
// aggiornamenti sposta Homun in Applicazioni») col bottone che RIPROPONE lo
// spostamento; «Controlla aggiornamenti» non c'è (non può funzionare lì) e
// comunque non fallisce in silenzio: il controllo dal main risponde
// needsMove. Render vero con react-dom/server (niente DOM nel repo).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, dialogPassThroughMock, accessibleName, textOf } from './render-helper'
import { callsOf } from './render-helper-install'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

// la cattura delle props degli elementi resi: per «cliccare» senza DOM si
// invoca il VERO handler del bottone trovato (mock del runtime JSX, che i
// componenti del repo usano per la trasformazione automatica)
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

// dopo l'installazione di window.sandbot (primo import) i componenti veri
const { Settings } = await import('../components/Settings')
const { useStore } = await import('../store')

function renderSettings(): { html: string; tree: ReturnType<typeof parseHtml> } {
  capture.els.length = 0
  const html = renderHtml(createElement(Settings))
  return { html, tree: parseHtml(html) }
}

const buttonsNamed = (tree: ReturnType<typeof parseHtml>, name: string) =>
  findAll(tree, (n) => n.tag === 'button' && accessibleName(n) === name)

describe('RV1: la riga «Versione e aggiornamenti» quando serve lo spostamento', () => {
  it('needsMove → il motivo col bottone «Sposta in Applicazioni»; «Controlla aggiornamenti» non c’è', () => {
    setStoreStateForRender(useStore, {
      settingsOpen: true,
      updaterStatus: { current: '0.3.1001-beta.2', canUpdate: true, needsMove: true, channel: 'stable' }
    })
    const { tree } = renderSettings()
    expect(textOf(findAll(tree, (n) => n.attrs['data-testid'] === 'settings-update-row')[0]!)).toContain(
      'Per gli aggiornamenti sposta Homun in Applicazioni'
    )
    expect(buttonsNamed(tree, 'Sposta in Applicazioni')).toHaveLength(1)
    expect(buttonsNamed(tree, 'Controlla aggiornamenti')).toHaveLength(0)
  })

  it('il bottone RIPROPONE lo spostamento (la stessa richiesta del main)', () => {
    setStoreStateForRender(useStore, {
      settingsOpen: true,
      updaterStatus: { current: '0.3.1001-beta.2', canUpdate: true, needsMove: true, channel: 'stable' }
    })
    const { html } = renderSettings()
    void html
    const move = capture.els.find(
      (e) => e.type === 'button' && (e.props as { 'data-testid'?: string })['data-testid'] === 'move-to-applications'
    )
    expect(move, 'il bottone dello spostamento dev\'esserci').toBeTruthy()
    ;(move!.props.onClick as () => void)()
    expect(callsOf('moveToApplications')).toHaveLength(1)
  })

  it('senza needsMove la riga resta quella di sempre («Controlla aggiornamenti»)', () => {
    setStoreStateForRender(useStore, {
      settingsOpen: true,
      updaterStatus: { current: '0.3.1001', canUpdate: true, needsMove: false, channel: 'stable' }
    })
    const { tree } = renderSettings()
    expect(buttonsNamed(tree, 'Controlla aggiornamenti')).toHaveLength(1)
    expect(buttonsNamed(tree, 'Sposta in Applicazioni')).toHaveLength(0)
  })
})
