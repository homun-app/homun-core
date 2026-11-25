// C1 (fase linguaggio): il rendering di EmptyState.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { Inbox } from 'lucide-react'
import { renderHtml, parseHtml, findAll, textOf } from './render-helper'
import { EmptyState } from '../components/ui/empty-state'
import { Button } from '../components/ui/button'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(EmptyState, { testId: 'vuoto-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'vuoto-prova')[0]!
}

describe('C1: EmptyState — icona, titolo, frase, azione', () => {
  it('centrato e arioso: l\'icona grande grigia sopra, il titolo, la frase grigia che dice cosa fare', () => {
    const root = rootOf({ icon: Inbox, titolo: 'Nessuna skill', frase: 'Creane una, importala, o chiedi a un bot di salvarne una.' })
    const cls = (root.attrs.class ?? '').split(/\s+/)
    expect(cls).toContain('text-center')
    const svg = findAll(root, (n) => n.tag === 'svg')[0]!
    expect(svg.attrs.class).toContain('size-5')
    expect(textOf(root)).toContain('Nessuna skill')
    const frase = findAll(root, (n) => textOf(n).includes('Creane una'))[0]!
    expect(frase.attrs.class).toContain('text-muted-foreground')
  })

  it('l\'azione facoltativa sta sotto la frase', () => {
    const root = rootOf({ icon: Inbox, titolo: 'Vuoto', azione: createElement(Button, null, 'Creane una') })
    const bottone = findAll(root, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!
    expect(textOf(bottone)).toBe('Creane una')
  })
})
