// Fase design (DS4, squadra): la timeline della squadra parla come la chat —
// lo stesso markdown di ogni messaggio di bot (BotMarkdown), la stessa colonna
// di lettura, le righe di sistema con Notice. Le @menzioni restano pillole nel
// colore del bot menzionato: PRIMA il testo era nudo e si spezzava a mano;
// ADESSO il testo è markdown, e le menzioni si cercano dentro i pezzi di
// testo dell'albero reso. Qui le due funzioni PURA che lo fanno.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, textOf, findAll } from './render-helper'
import { splitMentions, mapText, withMentions } from '../components/TeamChat'

describe('DS4 squadra: splitMentions (pura) — il testo a pezzi, le @menzioni da sole', () => {
  const nomi = ['Ana Maria', 'Ana', 'Marco']

  it('una menzione è un pezzo a sé, con la @; il testo attorno resta com’è', () => {
    expect(splitMentions('ciao @Ana, ok', nomi)).toEqual(['ciao ', '@Ana', ', ok'])
    expect(splitMentions('@Marco parte e @Ana Maria lo sa', nomi)).toEqual(['@Marco', ' parte e ', '@Ana Maria', ' lo sa'])
  })

  it('vince il nome più lungo: «@Ana Maria» non diventa «@Ana» seguita da « Maria»', () => {
    // i nomi arrivano in qualunque ordine: è splitMentions che li ordina
    expect(splitMentions('per @Ana Maria', ['Ana', 'Ana Maria'])).toEqual(['per ', '@Ana Maria'])
  })

  it('@tutti è una menzione anche se nessun membro si chiama così', () => {
    expect(splitMentions('@tutti avanti', ['Ana'])).toEqual(['@tutti', ' avanti'])
  })

  it('senza membri (o senza menzioni) il testo resta intero in un pezzo solo', () => {
    expect(splitMentions('ciao @Ana', [])).toEqual(['ciao @Ana'])
    expect(splitMentions('niente menzioni', ['Ana'])).toEqual(['niente menzioni'])
  })

  it('i caratteri speciali di un nome non rompono la ricerca (è testo, non un’espressione)', () => {
    expect(splitMentions('chiedi a @A.B o @C+D', ['A.B', 'C+D'])).toEqual(['chiedi a ', '@A.B', ' o ', '@C+D'])
    // «AXB» non è «A.B»: il punto non vale come jolly
    expect(splitMentions('chiedi a @AXB', ['A.B'])).toEqual(['chiedi a @AXB'])
  })

  it('una frase non comincia e non finisce con un pezzo vuoto; FRA due menzioni attaccate il pezzo vuoto resta (lo salta chi rende)', () => {
    expect(splitMentions('@Ana@Marco', ['Ana', 'Marco'])).toEqual(['@Ana', '', '@Marco'])
    expect(splitMentions('@Ana@Marco@tutti', ['Ana', 'Marco'])).toEqual(['@Ana', '', '@Marco', '', '@tutti'])
  })
})

describe('DS4 squadra: mapText e withMentions — le menzioni dentro l’albero reso', () => {
  const grassetto = (s: string): ReactNode => createElement('b', null, s)
  const pill = (s: string): ReactNode => s.split(/(@\w+)/).map((p, i) => (p.startsWith('@') ? createElement('i', { key: i }, p) : p))

  it('mapText: le stringhe passano dalla funzione, i numeri e i vuoti restano, gli array si scorrono', () => {
    expect(mapText('ciao @Ana', grassetto)).toEqual(createElement('b', null, 'ciao @Ana'))
    expect(mapText(7, grassetto)).toBe(7)
    expect(mapText(true, grassetto)).toBe(true)
    expect(mapText(null, grassetto)).toBe(null)
    expect(mapText(undefined, grassetto)).toBe(undefined)
    // un array torna un array, pezzo per pezzo (i non-testo restano com'erano)
    const fuori = mapText(['a @Ana', true, null], grassetto) as ReactNode[]
    expect(Array.isArray(fuori)).toBe(true)
    expect(fuori).toHaveLength(3)
    expect(fuori[0]).toEqual(createElement('b', null, 'a @Ana'))
    expect(fuori[1]).toBe(true)
    expect(fuori[2]).toBe(null)
  })

  it('mapText scende DENTRO gli elementi: i figli-testo diventano menzioni, l’elemento resta lo stesso', () => {
    const albero = createElement('p', { className: 'x' }, 'ciao ', createElement('strong', null, 'a @Ana'), ' e @Marco')
    const fuori = mapText(albero, pill)
    const html = renderHtml(createElement('div', null, fuori as ReactNode))
    // l'ordine lo dice l'HTML (textOf dell'ausilio mette prima i testi diretti e poi gli elementi: non conserva l'intreccio)
    expect(html).toBe('<div><p class="x">ciao <strong>a <i>@Ana</i></strong> e <i>@Marco</i></p></div>')
    const root = parseHtml(html)
    // le due menzioni sono rese come <i>, al loro posto nell'ordine del testo
    expect(findAll(root, (n) => n.tag === 'i').map(textOf)).toEqual(['@Ana', '@Marco'])
    expect(findAll(root, (n) => n.tag === 'strong').map(textOf)).toEqual(['a @Ana'])
  })

  it('withMentions: un componente che rende lo stesso tag con i figli passati da mapText (è ciò che riceve react-markdown)', () => {
    const P = withMentions('p', pill)
    // node è ciò che react-markdown passa a ogni componente: NON arriva sul tag
    const html = renderHtml(createElement(P, { node: { type: 'element' }, className: 'ten', children: ['ciao ', createElement('em', null, '@Ana')] } as never))
    expect(html).toBe('<p class="ten">ciao <em><i>@Ana</i></em></p>')
  })
})
