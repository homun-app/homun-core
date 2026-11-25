// C1 (fase linguaggio): il rendering di Segmented — la scelta di
// un'impostazione, alta 36.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf } from './render-helper'
import { Segmented } from '../components/ui/segmented'

const OPS = [
  { value: 'sistema', label: 'Sistema' },
  { value: 'chiaro', label: 'Chiaro' },
  { value: 'scuro', label: 'Scuro' }
] as const

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Segmented, { options: OPS, onChange: () => undefined, ...props } as never)))
  return findAll(tree, (n) => n.attrs.role === 'radiogroup')[0]!
}

describe('C1: Segmented — la scelta di un\'impostazione, a 36', () => {
  it('è un radiogroup col nome accessibile; le voci sono radio con aria-checked', () => {
    const root = rootOf({ value: 'chiaro', label: 'Tema' })
    expect(root.attrs.role).toBe('radiogroup')
    expect(root.attrs['aria-label']).toBe('Tema')
    const voci = findAll(root, (n) => n.attrs.role === 'radio')
    expect(voci.map((v) => textOf(v))).toEqual(['Sistema', 'Chiaro', 'Scuro'])
    expect(voci.map((v) => v.attrs['aria-checked'])).toEqual(['false', 'true', 'false'])
  })

  it('ALTO 36 (h-control): è la scelta di un\'impostazione, non un filtro', () => {
    expect((rootOf({ value: null }).attrs.class ?? '').split(/\s+/)).toContain('h-control')
  })

  it('la voce attiva è piena (primo piano), le altre grigie; fill divide la larghezza', () => {
    const root = rootOf({ value: 'scuro' })
    const voci = findAll(root, (n) => n.attrs.role === 'radio')
    expect(voci[2]!.attrs.class).toContain('bg-foreground')
    expect(voci[0]!.attrs.class).toContain('text-muted-foreground')
    const pieno = rootOf({ value: null, fill: true })
    expect((pieno.attrs.class ?? '').split(/\s+/)).toContain('w-full')
  })
})
