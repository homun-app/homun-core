// C1 (fase linguaggio): il rendering di ListGroup — il gruppo di righe a
// filo, senza riquadri.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf } from './render-helper'
import { ListGroup } from '../components/ui/list-group'
import { ListRow } from '../components/ui/list-row'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(ListGroup, { testId: 'gruppo-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'gruppo-prova')[0]!
}

describe('C1: ListGroup — titolo di sezione + righe a filo, NIENTE riquadri', () => {
  it('il titolo è un\'etichetta text-caption grigia peso 500; l\'azione sta a destra', () => {
    const root = rootOf({ titolo: 'Bot che lo usano', azione: createElement('button', null, 'Mostra tutto') })
    const h3 = findAll(root, (n) => n.tag === 'h3')[0]!
    expect(textOf(h3)).toBe('Bot che lo usano')
    for (const c of ['text-caption', 'font-medium', 'text-muted-foreground']) expect(h3.attrs.class).toContain(c)
    expect(textOf(root)).toContain('Mostra tutto')
  })

  it('le righe sono DIVISE DA UN FILETTO: divide-y, mai uno spazio né un riquadro', () => {
    const root = rootOf({ children: [createElement(ListRow, { key: 'a', titolo: 'una' }), createElement(ListRow, { key: 'b', titolo: 'due' })] })
    const contenitore = findAll(root, (n) => (n.attrs.class ?? '').includes('divide-y'))[0]!
    expect(contenitore.attrs.class).toContain('divide-border/50')
    // nessun fondo né riquadro attorno alle righe: la scheda griglia è VUOTA
    const classi = findAll(root, () => true).flatMap((n) => (n.attrs.class ?? '').split(/\s+/))
    expect(classi.filter((c) => c === 'bg-muted/60' || c === 'rounded-surface')).toEqual([])
  })

  it('dal titolo alle righe: gap-section-head (12); senza titolo il gruppo sono solo le righe', () => {
    expect((rootOf({ titolo: 'x', children: 'r' }).attrs.class ?? '')).toContain('gap-section-head')
    const senza = rootOf({ children: 'r' })
    expect(findAll(senza, (n) => n.tag === 'h3')).toHaveLength(0)
  })
})
