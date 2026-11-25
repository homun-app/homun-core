// C1 (fase linguaggio): il rendering di Textarea.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Textarea } from '../components/ui/textarea'

const cls = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Textarea, props as never)))
  return (findAll(tree, (n) => n.tag === 'textarea')[0]!.attrs.class ?? '').split(/\s+/)
}

describe('C1: Textarea — l\'area di testo, gemella dell\'Input', () => {
  it('porta le classi del campo (FIELD_CLASS): bordo, raggio dei controlli, testo del corpo', () => {
    const c = cls({ min: undefined })
    for (const k of ['rounded-control', 'border-input', 'text-body', 'outline-none']) expect(c).toContain(k)
    expect(c).not.toContain('h-control') // l'altezza NON è fissa: cresce col testo
  })

  it('l\'altezza minima è una variante chiusa: sm 64 (default) · md 96 · lg 160', () => {
    expect(cls({})).toContain('min-h-16')
    expect(cls({ min: 'md' })).toContain('min-h-24')
    expect(cls({ min: 'lg' })).toContain('min-h-40')
  })

  it('si può ridimensionare in verticale (resize-y), mai in orizzontale', () => {
    expect(cls({})).toContain('resize-y')
    expect(cls({})).not.toContain('resize')
    expect(cls({}).filter((c) => c === 'resize-x' || c === 'resize')).toEqual([])
  })
})
