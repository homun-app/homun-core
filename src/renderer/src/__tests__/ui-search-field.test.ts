// C1 (fase linguaggio): il rendering di SearchField — l'unica ricerca dell'app.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { SearchField } from '../components/ui/search-field'

const campoOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(SearchField, { value: '', onChange: () => undefined, ...props } as never)))
  return findAll(tree, (n) => n.tag === 'input')[0]!
}
const etichettaOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(SearchField, { value: '', onChange: () => undefined, ...props } as never)))
  return findAll(tree, (n) => n.tag === 'label')[0]!
}

describe('C1: SearchField — l\'unica ricerca', () => {
  it('36 px (h-control), fondo tenue, raggio dei controlli, la lente dentro', () => {
    const c = (etichettaOf({}).attrs.class ?? '').split(/\s+/)
    for (const k of ['h-control', 'bg-muted', 'rounded-control', 'w-72']) expect(c).toContain(k)
    const tree = parseHtml(renderHtml(createElement(SearchField, { value: '', onChange: () => undefined } as never)))
    expect(findAll(tree, (n) => n.tag === 'svg').length).toBe(1)
  })

  it('il campo è type=search col valore controllato, il segnaposto e il nome accessibile', () => {
    const campo = campoOf({ value: 'mate', placeholder: 'Cerca tra plugin e skill', ariaLabel: 'Cerca tra plugin e skill' })
    expect(campo.attrs.type).toBe('search')
    expect(campo.attrs.value).toBe('mate')
    expect(campo.attrs.placeholder).toBe('Cerca tra plugin e skill')
    expect(campo.attrs['aria-label']).toBe('Cerca tra plugin e skill')
  })

  it('il testid va sul CAMPO (è lui che le sonde cercano)', () => {
    expect(campoOf({ testId: 'plugin-search' }).attrs['data-testid']).toBe('plugin-search')
  })
})
