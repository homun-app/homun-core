// C1 (fase linguaggio): il rendering di Grid — la griglia del catalogo.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Grid } from '../components/ui/grid'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Grid, { testId: 'grid-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'grid-prova')[0]!
}
const cls = (props: Record<string, unknown>) => (rootOf(props).attrs.class ?? '').split(/\s+/)

describe('C1: Grid — la griglia, colonne e distanze chiuse', () => {
  it('è una griglia con colonne uguali e distanza di default block (16)', () => {
    const c = cls({ children: 'x' })
    for (const k of ['grid', 'grid-cols-2', 'gap-block', 'min-w-0']) expect(c).toContain(k)
  })

  it('le colonne sono una variante chiusa: 2, 3, 4, 6', () => {
    expect(cls({ children: 'x', cols: 3 })).toContain('grid-cols-3')
    expect(cls({ children: 'x', cols: 4 })).toContain('grid-cols-4')
    expect(cls({ children: 'x', cols: 6 })).toContain('grid-cols-6')
  })

  it('la distanza è quella dei token', () => {
    expect(cls({ children: 'x', gap: 'tight' })).toContain('gap-2')
    expect(cls({ children: 'x', gap: 'section' })).toContain('gap-section')
  })
})
