// C1 (fase linguaggio): il rendering di Card — la superficie unica.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Card } from '../components/ui/card'

const cls = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Card, { testId: 'card-prova', ...props } as never)))
  return (findAll(tree, (n) => n.attrs['data-testid'] === 'card-prova')[0]!.attrs.class ?? '').split(/\s+/)
}

describe('C1: Card — una forma sola, senza ombra', () => {
  it('rounded-surface, bordo del tema, fondo card, NESSUNA ombra', () => {
    const c = cls({ children: 'x' })
    for (const k of ['rounded-surface', 'border', 'border-border', 'bg-card', 'p-4']) expect(c).toContain(k)
    expect(c.filter((x) => x.startsWith('shadow'))).toEqual([])
  })

  it('il respiro è una variante chiusa: block 16 (default) · none', () => {
    expect(cls({ children: 'x', padding: 'none' })).not.toContain('p-4')
  })
})
