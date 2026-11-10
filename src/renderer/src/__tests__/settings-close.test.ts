// RV2 (fase beta.2): nelle Impostazioni una SOLA ✕, che resta FERMA. Nella
// scheda «App e skill» se ne vedevano DUE sovrapposte (quella delle
// Impostazioni, absolute DENTRO il contenitore che scorre, e quella della
// testata di AppsView non embedded) e scorrendo la ✕ se ne andava col
// contenuto. Qui si rende davvero ogni scheda e si conta quel che conta:
// esattamente UN bottone con nome accessibile «Chiudi», che non è
// discendente del contenitore che scorre (vive fuori: resta visibile a
// qualunque scorrimento, in tutte le schede).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, hasAncestor, dialogPassThroughMock, accessibleName } from './render-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const { Settings } = await import('../components/Settings')
const { useStore } = await import('../store')

/** La scheda aperta PRIMO render: come l'effetto di consumo di settingsTab, ma senza il flash iniziale. */
const TABS = ['generale', 'modelli', 'app', 'approvazioni', 'vault', 'routine', 'uso'] as const

function renderTab(tab: string) {
  setStoreStateForRender(useStore, { settingsOpen: true, settingsTab: tab })
  const html = renderHtml(createElement(Settings))
  return { html, tree: parseHtml(html) }
}

describe('RV2: una sola ✕, ferma, in OGNI scheda delle Impostazioni', () => {
  for (const tab of TABS) {
    it(`scheda «${tab}»: esattamente UN bottone «Chiudi»`, () => {
      const { tree } = renderTab(tab)
      const closes = findAll(tree, (n) => n.tag === 'button' && accessibleName(n) === 'Chiudi')
      expect(closes.map((c) => c.tag)).toHaveLength(1)
    })
  }

  it('la ✕ NON è discendente del contenitore che scorre (resta ferma a qualunque scorrimento)', () => {
    const { tree } = renderTab('generale')
    const close = findAll(tree, (n) => n.tag === 'button' && accessibleName(n) === 'Chiudi')[0]!
    const insideScroller = hasAncestor(close, (n) => (n.attrs['class'] ?? '').includes('overflow-y-auto'))
    expect(insideScroller).toBe(false)
  })

  it('il contenuto scorre ancora (il contenitore con overflow-y-auto c’è, con la pagina dentro)', () => {
    const { tree } = renderTab('generale')
    const scroller = findAll(tree, (n) => (n.attrs['class'] ?? '').includes('overflow-y-auto') && (n.attrs['class'] ?? '').includes('scroll-thin'))
    expect(scroller.length).toBeGreaterThanOrEqual(1)
  })
})
