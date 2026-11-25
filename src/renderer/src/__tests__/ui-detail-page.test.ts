// C2 (fase linguaggio): il rendering di DetailPage — il modello della scheda.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement as ce } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { DetailPage } from '../components/ui/detail-page'

const html = renderHtml(ce(DetailPage, {
  titolo: 'Mattermost', testId: 'scheda-prova',
  indietro: { onClick: () => undefined, label: 'Torna ai plugin' },
  children: 'le sezioni'
} as never))

describe('C2: DetailPage — la scheda di una cosa', () => {
  it('sta SOPRA la pagina (z-30), alla stessa larghezza wide, con «indietro» in testata', () => {
    const tree = parseHtml(html)
    const guscio = findAll(tree, (n) => n.attrs['data-page-shell'] === 'root')[0]!
    expect(guscio.attrs.class).toContain('z-30')
    const contenuto = findAll(guscio, (n) => n.attrs['data-page-content'] !== undefined).at(-1)!
    expect(contenuto.attrs.style).toBe('max-width:var(--w-wide)')
    const indietro = findAll(tree, (n) => n.attrs['aria-label'] === 'Torna ai plugin')[0]!
    expect(indietro).toBeTruthy()
  })

  it('il corpo scorre sotto la testata: la scheda non scorre per intero', () => {
    const tree = parseHtml(html)
    expect(findAll(tree, (n) => n.attrs['data-page-shell'] === 'scroll').length).toBe(1)
  })
})
