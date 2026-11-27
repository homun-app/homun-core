// K2 (fase conversione-chat): il rendering di Tag — l'etichetta piccola di
// stato accanto a un titolo.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { Tag } from '../components/ui/tag'

const ce = (type: unknown, props: Record<string, unknown> | null, figli?: ReactNode): React.ReactElement =>
  createElement(type as never, (props ?? {}) as never, figli)
const render = (props: Record<string, unknown>): HtmlNode => {
  const tree = parseHtml(renderHtml(ce(Tag, props, 'token scaduto')))
  return findAll(tree, (n) => n.attrs['data-slot'] === 'tag')[0]!
}
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((t) => t !== '')

describe('K2: Tag — l’etichetta di stato', () => {
  it('uno span segnato data-slot, testo didascalia sul raggio dei controlli, che si legge e basta (non è un bottone)', () => {
    const n = render({})
    expect(n.tag).toBe('span')
    expect(n.attrs['data-slot']).toBe('tag')
    expect(textOf(n)).toBe('token scaduto')
    for (const k of ['inline-flex', 'shrink-0', 'items-center', 'rounded-control', 'px-1.5', 'py-0.5', 'text-caption']) expect(classes(n), k).toContain(k)
  })

  it('il tono è chiuso: neutro (il default) · attesa · errore · riuscito — fondo tenue e colore del testo, e nessun fondo pieno', () => {
    const FIRME: Record<string, string[]> = {
      muted: ['bg-muted', 'text-muted-foreground'],
      waiting: ['bg-waiting/15', 'text-waiting'],
      error: ['bg-destructive/15', 'text-destructive'],
      ok: ['bg-chart-2/15', 'text-chart-2']
    }
    for (const [tone, firma] of Object.entries(FIRME)) {
      const c = classes(render({ tone }))
      for (const f of firma) expect(c, tone).toContain(f)
      for (const other of Object.values(FIRME).flat()) if (!firma.includes(other)) expect(c, `${tone} non ha ${other}`).not.toContain(other)
    }
    for (const f of FIRME.muted!) expect(classes(render({}))).toContain(f)
  })

  it('il testid passa attraverso; senza, nessun attributo vuoto', () => {
    expect(render({ testId: 'tag-prova' }).attrs['data-testid']).toBe('tag-prova')
    expect('data-testid' in render({}).attrs).toBe(false)
  })

  it('nessuna classe morta', async () => {
    const tutte = new Set<string>()
    for (const tone of ['muted', 'waiting', 'error', 'ok']) for (const c of classes(render({ tone }))) tutte.add(c)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte])).toEqual([])
  })
})
