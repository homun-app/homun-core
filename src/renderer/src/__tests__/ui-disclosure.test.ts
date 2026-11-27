// K3 (fase conversione-chat): il rendering di Disclosure — LA RIGA DI SISTEMA
// CHE SI APRE. È la riga che resta dopo una decisione («Consentito una volta ·
// … · 10:44»), la riga compatta che porta al riquadro del campo e la riga
// <summary> del testo per il modello: prima la scriveva a mano DecidedRow.tsx.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { Check, ScrollText, X } from 'lucide-react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { Disclosure, DisclosureSummary } from '../components/ui/disclosure'

const ce = (type: unknown, props: Record<string, unknown> | null, figli?: ReactNode): React.ReactElement =>
  createElement(type as never, (props ?? {}) as never, figli)
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((t) => t !== '')
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const render = (props: Record<string, unknown>): HtmlNode => parseHtml(renderHtml(ce(Disclosure, props)))
const riga = (props: Record<string, unknown>): HtmlNode => findAll(render(props), (n) => n.tag === 'button')[0]!

describe('K3: Disclosure — la riga di sistema che si apre', () => {
  it('è il bottone del sistema (ghost, 32) largo quanto la colonna, col testo di una riga di sistema (text-small, in peso normale): segno · testo che si tronca · metadato · freccia', () => {
    const n = riga({ segno: ce(Check, { className: 'size-4' }), testo: 'Consentito una volta · rm -rf vecchi', metadato: '10:44', aperto: false, apribile: true, tone: 'ok' })
    expect(n.tag).toBe('button')
    expect(n.attrs['data-slot']).toBe('button')
    expect(n.attrs['aria-expanded']).toBe('false')
    for (const k of ['w-full', 'justify-start', 'font-normal', 'text-small', 'h-control-sm']) expect(has(n, k), k).toBe(true)
    expect(has(n, 'font-medium')).toBe(false)
    expect(has(n, 'text-body')).toBe(false)
    const [segno, testo, meta, freccia] = n.children as [HtmlNode, HtmlNode, HtmlNode, HtmlNode]
    expect(has(segno, 'text-chart-2')).toBe(true)
    expect(segno.children[0]!.tag).toBe('svg')
    for (const k of ['min-w-0', 'flex-1', 'truncate']) expect(has(testo, k), k).toBe(true)
    expect(textOf(testo)).toBe('Consentito una volta · rm -rf vecchi')
    expect(has(meta, 'shrink-0')).toBe(true)
    expect(has(meta, 'text-caption')).toBe(true)
    expect(textOf(meta)).toBe('10:44')
    expect(freccia.attrs['aria-hidden']).toBe('true')
    // chiusa: la freccia verso destra
    expect(classes(freccia.children[0]!).some((c) => c.includes('chevron-right'))).toBe(true)
  })

  it('aperta: aria-expanded true e la freccia gira (giù); il tono del segno è chiuso: normale (nessun colore) · ok (verde) · grigio', () => {
    const aperta = riga({ segno: ce(X, { className: 'size-4' }), testo: 'Rifiutato', aperto: true, apribile: true, tone: 'muted' })
    expect(aperta.attrs['aria-expanded']).toBe('true')
    expect(classes(aperta.children[2]!.children[0]!).some((c) => c.includes('chevron-down'))).toBe(true)
    expect(has(aperta.children[0]!, 'text-muted-foreground')).toBe(true)
    expect(has(aperta.children[0]!, 'text-chart-2')).toBe(false)
    expect(has(riga({ segno: 'x', testo: 't', tone: 'ok' }).children[0]!, 'text-chart-2')).toBe(true)
    // normale: il segno prende il colore del bottone, nessuna classe di colore sua
    expect(classes(riga({ segno: 'x', testo: 't' }).children[0]!)).toEqual([])
  })

  it('la riga che non apre nulla (quella che porta al riquadro del campo): senza metadato, senza freccia e senza aria-expanded; il testid passa, e senza non c\'è attributo vuoto', () => {
    const n = riga({ segno: '↓', testo: 'In attesa della tua scelta · qui sotto', testId: 'approval-compact-row' })
    expect(n.children).toHaveLength(2)
    expect('aria-expanded' in n.attrs).toBe(false)
    expect(n.attrs['data-testid']).toBe('approval-compact-row')
    expect('data-testid' in riga({ testo: 't' }).attrs).toBe(false)
  })

  it('DisclosureSummary: la riga <summary> di un <details> — dentro Notice con l\'icona e la freccia; il triangolo del browser nascosto; il tono va a Notice; il testid passa', () => {
    const n = parseHtml(renderHtml(ce(DisclosureSummary, { icon: ScrollText, tone: 'warning', testId: 'riga-che-si-apre' }, 'Riepilogo turni precedenti'))).children[0]!
    expect(n.tag).toBe('summary')
    expect(n.attrs['data-testid']).toBe('riga-che-si-apre')
    expect(classes(n).some((c) => c.includes('details-marker'))).toBe(true)
    const notice = findAll(n, (x) => 'data-notice' in x.attrs)[0]!
    expect(has(notice, 'text-waiting')).toBe(true)
    expect(textOf(notice)).toBe('Riepilogo turni precedenti')
    expect(findAll(notice, (x) => x.tag === 'svg')).toHaveLength(2)
    expect('data-testid' in parseHtml(renderHtml(ce(DisclosureSummary, { icon: ScrollText }, 'x'))).children[0]!.attrs).toBe(false)
  })

  it('nessuna classe morta: ogni classe che Disclosure e DisclosureSummary possono mettere nell\'HTML ha la sua regola nel CSS compilato', async () => {
    const tutte = new Set<string>()
    for (const n of [riga({ segno: 'x', testo: 't', metadato: '1', aperto: true, apribile: true, tone: 'ok' }), riga({ testo: 't' })]) {
      for (const c of classes(n)) tutte.add(c)
    }
    const somma = parseHtml(renderHtml(ce(DisclosureSummary, { icon: ScrollText }, 'x'))).children[0]!
    // le classi di lucide (lucide, lucide-<nome>) non sono del foglio dell'app
    for (const x of findAll(somma, () => true)) for (const c of classes(x)) tutte.add(c)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte].filter((c) => !c.startsWith('lucide')))).toEqual([])
  })
})
