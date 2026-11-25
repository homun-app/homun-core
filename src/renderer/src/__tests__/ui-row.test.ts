// C1 (fase linguaggio): il rendering di Row — la riga dell'impaginazione,
// con distanze e allineamento come varianti chiuse.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Row } from '../components/ui/row'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Row, { testId: 'row-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'row-prova')[0]!
}
const cls = (props: Record<string, unknown>) => (rootOf(props).attrs.class ?? '').split(/\s+/)

describe('C1: Row — la riga, con distanze e allineamento delle token', () => {
  it('è una riga flex, larga quanto il contenitore e restringibile', () => {
    const c = cls({ children: 'x' })
    for (const k of ['flex', 'min-w-0', 'items-center']) expect(c).toContain(k)
  })

  it('la distanza è una variante chiusa: item (12, il default), tight (8), block (16), section (32), none', () => {
    expect(cls({ children: 'x' })).toContain('gap-3')
    expect(cls({ children: 'x', gap: 'tight' })).toContain('gap-2')
    expect(cls({ children: 'x', gap: 'block' })).toContain('gap-block')
    expect(cls({ children: 'x', gap: 'section' })).toContain('gap-section')
    expect(cls({ children: 'x', gap: 'none' })).not.toContain('gap-3')
  })

  it('l\'allineamento è una variante chiusa; wrap manda i figli a capo', () => {
    expect(cls({ children: 'x', align: 'start' })).toContain('items-start')
    expect(cls({ children: 'x', align: 'baseline' })).toContain('items-baseline')
    expect(cls({ children: 'x', wrap: true })).toContain('flex-wrap')
    expect(cls({ children: 'x' })).not.toContain('flex-wrap')
  })
})
