// C1 (fase linguaggio): il rendering di Stack — la colonna del catalogo, con
// le distanze dei token come varianti chiuse (mai una classe scritta in pagina).
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Stack } from '../components/ui/stack'

/** La radice della Stack nel render (parseHtml può incartare il documento). */
const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Stack, { testId: 'stack-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'stack-prova')[0]!
}

describe('C1: Stack — la colonna, con le distanze dei token', () => {
  it('è una colonna flex: i figli uno sotto l\'altro, larga quanto il contenitore e restringibile', () => {
    const root = rootOf({ children: [createElement('div', null, 'a'), createElement('div', null, 'b')] })
    const cls = (root.attrs.class ?? '').split(/\s+/)
    for (const c of ['flex', 'flex-col', 'min-w-0']) expect(cls).toContain(c)
  })

  it('la distanza è una variante chiusa: block (16, il default), tight (8), section (32), none', () => {
    expect((rootOf({ children: 'x' }).attrs.class ?? '').split(/\s+/)).toContain('gap-block')
    expect((rootOf({ children: 'x', gap: 'tight' }).attrs.class ?? '').split(/\s+/)).toContain('gap-2')
    expect((rootOf({ children: 'x', gap: 'section' }).attrs.class ?? '').split(/\s+/)).toContain('gap-section')
    expect((rootOf({ children: 'x', gap: 'none' }).attrs.class ?? '').split(/\s+/)).not.toContain('gap-block')
  })

  it('il testid va sulla radice della colonna (è la radice che lo porta, non un involucro)', () => {
    const root = rootOf({ children: 'x' })
    expect(root.attrs['data-testid']).toBe('stack-prova')
  })
})
