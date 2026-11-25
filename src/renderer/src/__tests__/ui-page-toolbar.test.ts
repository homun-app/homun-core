// C1 (fase linguaggio): il rendering di PageToolbar.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { PageToolbar } from '../components/ui/page-toolbar'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(PageToolbar, { testId: 'toolbar-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'toolbar-prova')[0]!
}

describe('C1: PageToolbar — ricerca a sinistra, pillole, vista a destra', () => {
  it('è una riga alta ALMENO 40 (min-h-10), ferma sopra il corpo', () => {
    expect((rootOf({ ricerca: 'q' }).attrs.class ?? '').split(/\s+/)).toContain('min-h-10')
  })

  it('la vista sta a DESTRA (ml-auto): la ricerca e le pillole restano a sinistra', () => {
    const root = rootOf({ ricerca: createElement('input'), vista: createElement('nav') })
    const nav = findAll(root, (n) => n.tag === 'nav')[0]!
    expect((nav.parent!.attrs.class ?? '').split(/\s+/)).toContain('ml-auto')
  })

  it('le pillole stanno fra la ricerca e la vista, in una fila che si spezza sola', () => {
    const root = rootOf({ ricerca: 'q', pillole: createElement('span', null, 'Tutte') })
    const pillole = findAll(root, (n) => (n.attrs.class ?? '').includes('flex-wrap'))[0]!
    expect(pillole).toBeTruthy()
  })
})
