// Fase design (DS2): Notice — la riga di sistema COMPATTA della chat, il pezzo
// di components/ui con cui la chat (DS4) smette di scrivere a mano una riga per
// ogni avviso: icona · testo grigio text-small · «· N volte» · azione.
// Qui si prova la VISTA — struttura e classi dei token di DS1 — col catalogo
// compilato (il conteggio è il messaggio di Chat: in inglese «· N times») e
// col CSS compilato da styles.css (nessuna classe morta). Raggruppare gli
// avvisi uguali NON sta in questo pezzo (resta in lib/notice-rows.ts,
// notice-rows.test.ts): qui si mostra ciò che arriva.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { i18n, type Messages } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Timer } from 'lucide-react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { messages as enMessages } from '../locales/en/messages.mjs'
import { Notice } from '../components/ui/notice'

const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((t) => t !== '')
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!
const render = (props: Record<string, unknown>): HtmlNode => parseHtml(renderHtml(createElement(Notice, props as never)))
const noticeOf = (root: HtmlNode): HtmlNode => first(root, (n) => 'data-notice' in n.attrs)

describe('DS2: Notice — la riga di sistema compatta della chat', () => {
  it('la riga: un div segnato data-notice, flex, alto almeno 24 px e largo quanto il contenitore; le parti centrate e distanti 12 px; testo text-small grigio', () => {
    const row = noticeOf(render({ children: 'Avvio automatico' }))
    expect(row.tag).toBe('div')
    expect('data-notice' in row.attrs).toBe(true)
    // le parti non si spaziano a mano, riga per riga: c'è UNA distanza (row-gap)
    for (const cls of ['flex', 'min-h-6', 'w-full', 'items-center', 'gap-row-gap', 'text-small', 'text-muted-foreground']) {
      expect(has(row, cls), cls).toBe(true)
    }
  })

  it('il testo: uno span che può restringersi e va a capo (è testo: non tronca); senza icona, conteggio e azione non nascono nodi vuoti', () => {
    const row = noticeOf(render({ children: 'Il modello non risponde. Riprova tra poco.' }))
    expect(row.children).toHaveLength(1)
    const text = row.children[0]!
    expect(text.tag).toBe('span')
    expect(has(text, 'min-w-0')).toBe(true)
    expect(has(text, 'flex-1')).toBe(true)
    expect(classes(text)).not.toContain('truncate')
    expect(classes(text)).not.toContain('whitespace-nowrap')
    expect(textOf(text)).toBe('Il modello non risponde. Riprova tra poco.')
  })

  it("l'icona sta in uno slot da 16 px davanti al testo, e il suo svg è 16 px qualunque taglia porti", () => {
    // lucide rende un svg: la taglia che porta (qui 20) non conta, comanda lo slot
    const row = noticeOf(render({ icon: createElement(Timer, { className: 'size-5' }), children: 'Routine' }))
    const slot = row.children[0]!
    expect(slot.tag).toBe('span')
    for (const cls of ['grid', 'size-4', 'shrink-0', 'place-items-center', '[&>svg]:size-4']) {
      expect(has(slot, cls), cls).toBe(true)
    }
    expect(slot.children.map((c) => c.tag)).toEqual(['svg'])
    expect(row.children).toHaveLength(2)
    expect(textOf(row.children[1]!)).toBe('Routine')
  })

  it('repeat: dopo il testo, attaccato con uno spazio, «· 4 volte»; sta su una riga sola e non si restringe (il testo è quello che cede)', () => {
    const row = noticeOf(render({ children: 'Risposta vuota', repeat: 4 }))
    expect(row.children.map((c) => c.tag)).toEqual(['span', 'span'])
    const mark = row.children[1]!
    expect(has(mark, 'shrink-0')).toBe(true)
    expect(has(mark, 'whitespace-nowrap')).toBe(true)
    expect(mark.text).toBe(' · 4 volte')
    expect(textOf(row)).toBe('Risposta vuota · 4 volte')
  })

  it("una volta sola dice «· 1 volta»; senza repeat nessun «·» (decide chi chiama: un avviso non ripetuto non porta il conteggio)", () => {
    expect(textOf(noticeOf(render({ children: 'Risposta vuota', repeat: 1 })))).toBe('Risposta vuota · 1 volta')
    const row = noticeOf(render({ children: 'Risposta vuota' }))
    expect(row.children).toHaveLength(1)
    expect(textOf(row)).toBe('Risposta vuota')
  })

  it("il conteggio è il messaggio dei cataloghi, lo stesso di Chat (i cataloghi non cambiano): in inglese «· 4 times»", () => {
    // la traduzione inglese arriva SOLO se il msgid è quello dei cataloghi:
    // con un id diverso resterebbe l'italiano della sorgente
    i18n.load('en', enMessages as unknown as Messages)
    i18n.activate('en')
    const en = (repeat: number): string => renderToStaticMarkup(createElement(I18nProvider, { i18n }, createElement(Notice, { children: 'Empty reply', repeat })))
    expect(en(4)).toContain(' · 4 times')
    expect(en(1)).toContain(' · 1 time')
    i18n.activate('it')
  })

  it("l'azione sta a destra, in uno span fermo e centrato, così com'è (col suo testid); senza azione nessun contenitore vuoto", () => {
    const row = noticeOf(render({
      children: 'Il modello non risponde',
      action: createElement('button', { type: 'button', 'data-testid': 'notice-retry' }, 'Riprova')
    }))
    expect(row.children).toHaveLength(2)
    const slot = row.children[1]!
    expect(slot.tag).toBe('span')
    for (const cls of ['flex', 'shrink-0', 'items-center']) {
      expect(has(slot, cls), cls).toBe(true)
    }
    const action = first(row, (n) => n.attrs['data-testid'] === 'notice-retry')
    expect(textOf(action)).toBe('Riprova')
    expect(noticeOf(render({ children: 'a' })).children).toHaveLength(1)
  })

  it('l’ordine delle parti: icona · testo · conteggio · azione', () => {
    const row = noticeOf(render({
      icon: createElement(Timer),
      children: 'Risposta vuota',
      repeat: 3,
      action: createElement('button', { type: 'button' }, 'Riprova')
    }))
    expect(row.children.map((c) => textOf(c).trim())).toEqual(['', 'Risposta vuota', '· 3 volte', 'Riprova'])
  })

  it('i toni cambiano solo il colore: neutral grigio (il default), warning ambra, destructive rosso — e la taglia resta text-small', () => {
    const colori = ['text-muted-foreground', 'text-waiting', 'text-destructive']
    const check = (tone: string | undefined, colore: string): void => {
      const cls = classes(noticeOf(render({ tone, children: 'Avviso' })))
      expect(cls, `${tone ?? 'default'} ha ${colore}`).toContain(colore)
      for (const other of colori) {
        if (other !== colore) expect(cls, `${tone ?? 'default'} non ha ${other}`).not.toContain(other)
      }
      // il colore è un colore, la taglia è una taglia: una non cancella l'altra
      expect(cls).toContain('text-small')
    }
    check('neutral', 'text-muted-foreground')
    check(undefined, 'text-muted-foreground')
    check('warning', 'text-waiting')
    check('destructive', 'text-destructive')
  })

  it("testId → data-testid; senza, l'attributo non c'è (nessun test trova per sbaglio le righe altrui)", () => {
    expect(noticeOf(render({ children: 'a', testId: 'notice-model-empty' })).attrs['data-testid']).toBe('notice-model-empty')
    expect(noticeOf(render({ children: 'a' })).attrs['data-testid']).toBeUndefined()
  })

  it('className del chiamante si aggiunge e vince su ciò che sovrascrive (una distanza, il colore del tono) senza perdere la taglia', () => {
    const cls = classes(noticeOf(render({ children: 'a', className: 'mt-2 gap-2 text-foreground' })))
    expect(cls).toContain('mt-2')
    expect(cls).toContain('gap-2')
    expect(cls).not.toContain('gap-row-gap')
    expect(cls).toContain('text-foreground')
    expect(cls).not.toContain('text-muted-foreground')
    expect(cls).toContain('text-small')
  })

  it('nessuna classe morta: ogni classe che Notice mette nell’HTML ha la sua regola nel CSS compilato da styles.css', async () => {
    // in node un nome sbagliato non si vede: gap-row-gapp starebbe nell'HTML e non farebbe nulla
    const tutte = new Set<string>()
    // la riga e i suoi span: l'icona e l'azione sono del chiamante (le loro classi non sono di Notice)
    for (const tone of ['neutral', 'warning', 'destructive']) {
      const row = noticeOf(render({ icon: createElement(Timer), children: 'Risposta vuota', repeat: 4, tone, action: createElement('button', null, 'Riprova') }))
      for (const n of [row, ...row.children]) for (const cls of classes(n)) tutte.add(cls)
    }
    expect(tutte.size).toBeGreaterThan(15)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, tutte)).toEqual([])
    // il controllo non è vuoto: un nome sbagliato lo vede
    expect(deadClasses(css, [...tutte, 'gap-row-gapp'])).toEqual(['gap-row-gapp'])
  })

  it('K2 (fase conversione-chat): fill — la riga RIEMPITA del suo tono (la fascia in cima a una card): raggio dei controlli, respiro 12/8, il fondo del tono; il testo resta del suo tono', () => {
    const FIRME: Array<[string, string, string]> = [
      ['neutral', 'bg-muted', 'text-muted-foreground'],
      ['warning', 'bg-waiting/15', 'text-waiting'],
      ['destructive', 'bg-destructive/15', 'text-destructive']
    ]
    for (const [tone, fondo, testo] of FIRME) {
      const c = classes(noticeOf(render({ children: 'x', tone, fill: true })))
      for (const k of ['rounded-control', 'px-3', 'py-2', fondo, testo]) expect(c, `${tone}: ${k}`).toContain(k)
    }
    // senza fill niente fondo né respiro: com'era
    const nuda = classes(noticeOf(render({ children: 'x', tone: 'destructive' })))
    for (const k of ['rounded-control', 'px-3', 'py-2']) expect(nuda).not.toContain(k)
    expect(nuda.filter((c) => c.startsWith('bg-'))).toEqual([])
  })
})

describe('K3 (fase conversione-chat): Notice — la taglia e il peso come varianti chiuse', () => {
  it('size body SOSTITUISCE text-small (non si somma) e weight semibold mette il peso 600; tono, altezza e parti non cambiano; il default resta la riga di sistema (small, 400)', () => {
    const base = noticeOf(render({ children: 'testo' }))
    expect(has(base, 'text-small')).toBe(true)
    expect(has(base, 'text-body')).toBe(false)
    expect(classes(base).some((c) => c.startsWith('font-'))).toBe(false)
    const corpo = noticeOf(render({ children: '+2 altrove', size: 'body', weight: 'semibold', tone: 'warning', icon: createElement(Timer, { className: 'size-4' }) }))
    for (const k of ['text-body', 'font-semibold', 'text-waiting', 'min-h-6', 'w-full']) expect(has(corpo, k), k).toBe(true)
    expect(has(corpo, 'text-small')).toBe(false)
    expect(has(corpo, 'font-medium')).toBe(false)
    expect(has(noticeOf(render({ children: 'x', size: 'body', weight: 'medium' })), 'font-medium')).toBe(true)
  })

  it('nessuna classe morta: nemmeno text-body e i pesi dentro Notice', async () => {
    const tutte = new Set<string>()
    for (const p of [{}, { size: 'body' }, { size: 'body', weight: 'medium', fill: true }, { size: 'body', weight: 'semibold', tone: 'warning' }]) for (const c of classes(noticeOf(render({ children: 'x', ...p })))) tutte.add(c)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte])).toEqual([])
  })
})
