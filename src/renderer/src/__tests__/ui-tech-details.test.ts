// K3 (fase conversione-chat): il rendering di TechDetails — I DETTAGLI
// TECNICI, chiusi: la riga che si apre e, sotto, il blocco di codice. Il
// testo tecnico resta com'è (mai tradotto): all'utente la card dice l'esito in
// parole, il nome tecnico lo guarda chi lo vuole.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { TechDetails } from '../components/ui/tech-details'

const ce = (type: unknown, props: Record<string, unknown> | null, figli?: ReactNode): React.ReactElement =>
  createElement(type as never, (props ?? {}) as never, figli)
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((t) => t !== '')
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const render = (props: Record<string, unknown>): HtmlNode => parseHtml(renderHtml(ce(TechDetails, { testo: 'not installable here: type pypi', ...props }))).children[0]!

describe('K3: TechDetails — i dettagli tecnici, chiusi', () => {
  it('un <details> chiuso (senza open): la riga che si apre dice «Dettagli tecnici», grigio in didascalia; sotto il blocco di codice che va a capo (Code), col testo tecnico COM\'È', () => {
    const n = render({})
    expect(n.tag).toBe('details')
    expect('open' in n.attrs).toBe(false)
    const [summary, blocco] = n.children as [HtmlNode, HtmlNode]
    expect(summary.tag).toBe('summary')
    expect(textOf(summary)).toBe('Dettagli tecnici')
    for (const k of ['cursor-pointer', 'select-none', 'text-small', 'text-muted-foreground']) expect(has(summary, k), k).toBe(true)
    expect(blocco.tag).toBe('pre')
    for (const k of ['mt-1.5', 'max-h-40', 'whitespace-pre-wrap', 'bg-muted', 'font-mono', 'text-small']) expect(has(blocco, k), k).toBe(true)
    expect(textOf(blocco)).toBe('not installable here: type pypi')
  })

  it('l\'etichetta si può cambiare; il testid passa, e senza non c\'è attributo vuoto', () => {
    expect(textOf(render({ etichetta: 'Il motivo grezzo' }).children[0]!)).toBe('Il motivo grezzo')
    expect(render({ testId: 'approval-tech-details' }).attrs['data-testid']).toBe('approval-tech-details')
    // aperto: l'attributo open (booleano); chiuso (il default), niente attributo
    expect('open' in render({ aperto: true }).attrs).toBe(true)
    expect('open' in render({}).attrs).toBe(false)
    expect('data-testid' in render({}).attrs).toBe(false)
  })

  it('nessuna classe morta', async () => {
    const tutte = new Set<string>()
    for (const x of findAll(render({ className: 'mt-2' }), () => true)) for (const c of classes(x)) tutte.add(c)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte])).toEqual([])
  })
})
