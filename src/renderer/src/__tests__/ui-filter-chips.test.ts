// C1 (fase linguaggio): il rendering delle tre pillole di filtro. Il menu
// vive in un portale (mock passante nei test statici, come gli altri).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'
/** Il createElement tollerante dei figli come terzo argomento (come fanno gli altri test coi componenti di ui/). */
const ce = (type: unknown, props: Record<string, unknown>, figli?: ReactNode) => createElement(type as never, props as never, figli)
import { FilterChipsScelta, FilterChipsMenu, FilterChipsInterruttore } from '../components/ui/filter-chips'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ui/dropdown-menu', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  const pass = (tag: string) => ({ children, className, ...rest }: { children?: unknown; className?: string } & Record<string, unknown>) =>
    createElement('div', { 'data-mock': tag, className, ...rest }, children as never)
  return { ...m, DropdownMenu: pass('dropdown-menu'), DropdownMenuContent: pass('dropdown-menu-content'), DropdownMenuTrigger: pass('dropdown-menu-trigger'), DropdownMenuItem: pass('dropdown-menu-item') }
})

describe('C1: FilterChips — le tre pillole di filtro', () => {
  it('scelta: piena quando è ACCESA, secondaria quando no, col conteggio e aria-pressed', () => {
    const accesa = parseHtml(renderHtml(ce(FilterChipsScelta, { active: true, count: 12, onSelect: () => undefined }, 'Tutte')))
    const bottone = findAll(accesa, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!
    expect(bottone.attrs.class).toContain('rounded-full')
    expect(bottone.attrs['aria-pressed']).toBe('true')
    expect(textOf(bottone)).toContain('· 12')
    const spenta = parseHtml(renderHtml(ce(FilterChipsScelta, { active: false, onSelect: () => undefined }, 'Pagamenti')))
    expect(textAll(spenta)).toContain('Pagamenti')
  })

  it('menu: la pillola mostra «Filtro: valore ▾» e le voci stanno nel menu (portale)', () => {
    const html = renderHtml(ce(FilterChipsMenu, {
      label: 'Bot', value: 'tutti',
      options: [{ value: 'tutti', label: 'tutti' }, { value: 'competitoor', label: 'Competitoor' }],
      onSelect: () => undefined
    }))
    expect(html).toContain('Bot: tutti')
    const tree = parseHtml(html)
    expect(findAll(tree, (n) => (n.attrs['data-mock'] ?? '') === 'dropdown-menu-item').length).toBe(2)
  })

  it('interruttore: aria-pressed, e il testo è la sola etichetta («Archiviati»)', () => {
    const tree = parseHtml(renderHtml(ce(FilterChipsInterruttore, { active: true, onToggle: () => undefined }, 'Archiviati')))
    const bottone = findAll(tree, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!
    expect(bottone.attrs['aria-pressed']).toBe('true')
    expect(textOf(bottone)).toBe('Archiviati')
  })

  // fase linguaggio-ritocchi (R3): il conteggio accanto all'etichetta, come la
  // pillola di scelta — «Da sistemare · 13» in Plugin › Collegati
  it('interruttore col conteggio: «Da sistemare · 13», spenta resta secondaria e aria-pressed false', () => {
    const conConteggio = parseHtml(renderHtml(ce(FilterChipsInterruttore, { active: false, count: 13, onToggle: () => undefined }, 'Da sistemare')))
    const bottone = findAll(conConteggio, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!
    expect(textOf(bottone)).toBe('Da sistemare · 13')
    expect(bottone.attrs['aria-pressed']).toBe('false')
    // senza il conteggio il testo resta la sola etichetta
    const senza = parseHtml(renderHtml(ce(FilterChipsInterruttore, { active: false, onToggle: () => undefined }, 'Da sistemare')))
    expect(textOf(findAll(senza, (n) => (n.attrs['data-slot'] ?? '') === 'button')[0]!)).toBe('Da sistemare')
  })
})

const textAll = (root: ReturnType<typeof parseHtml>): string => findAll(root, () => true).map((n) => textOf(n)).join('')
