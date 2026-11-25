// C1 (fase linguaggio): il rendering di Text — le taglie dei token e il tono
// come varianti chiuse.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Text } from '../components/ui/text'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Text, { testId: 'text-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'text-prova')[0]!
}
const cls = (props: Record<string, unknown>) => (rootOf(props).attrs.class ?? '').split(/\s+/)

describe('C1: Text — le sei taglie dei token, il tono e il peso', () => {
  it('il default è body, tono normale, peso normale', () => {
    const c = cls({ children: 'x' })
    expect(c).toContain('text-body')
    expect(c).not.toContain('text-muted-foreground')
    expect(c).not.toContain('font-medium')
  })

  it('le taglie sono le sei dei token (con la loro interlinea)', () => {
    for (const s of ['page', 'title', 'body', 'small', 'caption', 'reading']) {
      expect(cls({ children: 'x', size: s }), s).toContain(`text-${s}`)
    }
  })

  it('il tono: grigio per le seconde righe, errore nel distruttivo', () => {
    expect(cls({ children: 'x', tone: 'muted' })).toContain('text-muted-foreground')
    expect(cls({ children: 'x', tone: 'destructive' })).toContain('text-destructive')
  })

  it('il peso: i tre del tema; truncate taglia la riga', () => {
    expect(cls({ children: 'x', weight: 'medium' })).toContain('font-medium')
    expect(cls({ children: 'x', weight: 'semibold' })).toContain('font-semibold')
    expect(cls({ children: 'x', truncate: true })).toContain('truncate')
  })

  it('è un <p>: un blocco di testo, non un involucro qualunque', () => {
    expect(rootOf({ children: 'x' }).tag).toBe('p')
  })
})
