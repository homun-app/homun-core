// K3 (fase conversione-chat): il rendering di Code — IL CODICE della chat in
// monospazio: la riga che scorre (il comando da approvare), il blocco che va
// a capo (il testo per il modello, i dettagli tecnici), il pezzo in una frase.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, textOf, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { Code } from '../components/ui/code'

const ce = (type: unknown, props: Record<string, unknown> | null, figli?: ReactNode): React.ReactElement =>
  createElement(type as never, (props ?? {}) as never, figli)
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((t) => t !== '')
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const render = (props: Record<string, unknown>): HtmlNode => parseHtml(renderHtml(ce(Code, props, 'rm -rf vecchi'))).children[0]!

describe('K3: Code — il codice della chat', () => {
  it('la riga che scorre (il default): un <code> a blocco, su una riga sola, che scorre in orizzontale — raggio di controllo, respiro 12, monospazio in didascalia', () => {
    const n = render({})
    expect(n.tag).toBe('code')
    for (const k of ['block', 'overflow-x-auto', 'whitespace-nowrap', 'rounded-control', 'p-3', 'font-mono', 'text-small']) expect(has(n, k), k).toBe(true)
    expect(textOf(n)).toBe('rm -rf vecchi')
  })

  it('il fondo è chiuso: su fondo card, dentro una card (la cosa da approvare si distingue dal fondo ambra) · su fondo tenue, col testo grigio (il default)', () => {
    const suCard = render({ tone: 'card' })
    expect(has(suCard, 'bg-card')).toBe(true)
    expect(classes(suCard).some((c) => c === 'bg-muted' || c === 'text-muted-foreground')).toBe(false)
    const tenue = render({})
    for (const k of ['bg-muted', 'text-muted-foreground']) expect(has(tenue, k), k).toBe(true)
    expect(has(tenue, 'bg-card')).toBe(false)
  })

  it('il blocco che va a capo (aCapo): un <pre> che va a capo e scorre dentro se stesso, sullo stesso fondo', () => {
    const n = render({ aCapo: true })
    expect(n.tag).toBe('pre')
    for (const k of ['scroll-thin', 'overflow-auto', 'whitespace-pre-wrap', 'wrap-anywhere', 'rounded-control', 'p-3', 'font-mono', 'text-small']) expect(has(n, k), k).toBe(true)
    expect(has(n, 'whitespace-nowrap')).toBe(false)
    expect(has(render({ aCapo: true, tone: 'card' }), 'bg-card')).toBe(true)
  })

  it('inline: il pezzo dentro una frase — un <code> monospazio in didascalia, niente riquadro; grigio col tono muted, del colore del testo con card', () => {
    const n = render({ inline: true })
    expect(n.tag).toBe('code')
    expect(classes(n)).toEqual(['font-mono', 'text-small', 'text-muted-foreground'])
    expect(classes(render({ inline: true, tone: 'card' }))).toEqual(['font-mono', 'text-small'])
  })

  it('className del chiamante si aggiunge (quanto è alto al più, la distanza da ciò che sta sopra); il testid passa, e senza non c\'è attributo vuoto', () => {
    const n = render({ aCapo: true, className: 'mt-1.5 max-h-40', testId: 'blocco-codice' })
    for (const k of ['mt-1.5', 'max-h-40', 'overflow-auto']) expect(has(n, k), k).toBe(true)
    expect(n.attrs['data-testid']).toBe('blocco-codice')
    expect('data-testid' in render({}).attrs).toBe(false)
  })

  it('nessuna classe morta: ogni classe che Code può mettere nell\'HTML ha la sua regola nel CSS compilato', async () => {
    const tutte = new Set<string>()
    for (const p of [{}, { tone: 'card' }, { aCapo: true }, { aCapo: true, tone: 'card' }, { inline: true }, { inline: true, tone: 'card' }]) for (const c of classes(render(p))) tutte.add(c)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte])).toEqual([])
  })
})
