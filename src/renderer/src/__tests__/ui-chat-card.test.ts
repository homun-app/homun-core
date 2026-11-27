// K2 (fase conversione-chat): il rendering di ChatCard — IL GUSCIO DI OGNI
// CARD IN CHAT. La superficie, l'85% della colonna, la testata (il segno,
// il titolo, ciò che lo completa) e la riga delle azioni stanno qui una volta
// sola: le card portano solo il corpo.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { Plug } from 'lucide-react'
import { renderHtml, parseHtml, findAll, textOf, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { ChatCard } from '../components/ui/chat-card'
import { Tag } from '../components/ui/tag'

/** Il createElement tollerante dei figli come terzo argomento (come gli altri test di ui/). */
const ce = (type: unknown, props: Record<string, unknown> | null, figli?: ReactNode): React.ReactElement =>
  createElement(type as never, (props ?? {}) as never, figli)

/** `children` nelle prop diventa il terzo argomento di createElement (altrimenti lo copre). */
const render = (props: Record<string, unknown>): HtmlNode => {
  const { children, ...rest } = props
  return parseHtml(renderHtml(createElement(ChatCard, { testId: 'card-prova', ...rest } as never, ...(children === undefined ? [] : [children as ReactNode]))))
}
const root = (props: Record<string, unknown>): HtmlNode => findAll(render(props), (n) => n.attrs['data-testid'] === 'card-prova')[0]!
const cls = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter(Boolean)
/** La colonna dei blocchi È la radice del guscio (flex-col gap-2). */
const colonna = root

describe('K2: ChatCard — il guscio di ogni card in chat', () => {
  it('la forma della card in chat: raggio di superficie, respiro 16, larga al massimo l’85% della colonna, il lungo va a capo DENTRO; fondo tenue, senza bordo né ombra', () => {
    const c = cls(root({ children: 'x' }))
    for (const k of ['max-w-[85%]', 'min-w-0', 'rounded-surface', 'p-4', 'wrap-anywhere', 'bg-muted']) expect(c).toContain(k)
    expect(c.filter((x) => x.startsWith('border') || x.startsWith('shadow'))).toEqual([])
  })

  it('il testid sta sulla radice', () => {
    expect(root({ children: 'x' }).tag).toBe('div')
  })

  it('i toni sono chiusi: attesa (ambra) ed errore (rosso) cambiano solo il fondo', () => {
    expect(cls(root({ children: 'x', tone: 'waiting' }))).toContain('bg-waiting/10')
    expect(cls(root({ children: 'x', tone: 'error' }))).toContain('bg-destructive/10')
    for (const tone of ['waiting', 'error']) expect(cls(root({ children: 'x', tone }))).not.toContain('bg-muted')
  })

  it('il corpo è UNA colonna: i blocchi a 8 px l’uno dall’altro, e la card si riempie in larghezza', () => {
    for (const k of ['flex', 'min-w-0', 'flex-col', 'gap-2']) expect(cls(colonna({ children: 'x' })), k).toContain(k)
  })

  it('la testata: il file del logo ai 32, il titolo in peso medio, ciò che completa il titolo per ultimo', () => {
    const testa = colonna({ logo: '/loghi/notion.svg', titolo: 'Collega Notion', nota: ce(Tag, null, 'token scaduto') }).children[0]!
    const [segno, titolo, nota] = testa.children
    expect(segno!.tag).toBe('img')
    expect(segno!.attrs.src).toBe('/loghi/notion.svg')
    for (const k of ['size-8', 'shrink-0', 'rounded-control', 'object-cover']) expect(cls(segno!)).toContain(k)
    for (const k of ['text-body', 'font-medium']) expect(cls(titolo!.children[0]!)).toContain(k)
    expect(textOf(nota!)).toBe('token scaduto')
    for (const k of ['flex', 'items-center', 'gap-2', 'flex-wrap']) expect(cls(testa), k).toContain(k)
    expect(cls(nota!)[0]).toBe('shrink-0')
  })

  it('il segno è UNO: il file vince sull’iniziale, l’iniziale sull’icona', () => {
    const segno = (props: Record<string, unknown>): HtmlNode => colonna({ titolo: 'x', ...props }).children[0]!.children[0]!
    expect(segno({ logo: '/loghi/a.svg', nome: 'Asana', icona: Plug }).tag).toBe('img')
    const iniziale = segno({ nome: 'Asana', icona: Plug })
    expect(iniziale.tag).toBe('span')
    expect(textOf(iniziale)).toBe('A')
    expect(cls(iniziale)).toContain('size-8')
    const icona = segno({ icona: Plug })
    expect(icona.tag).toBe('span')
    for (const k of ['size-8', 'grid', 'place-items-center', 'text-muted-foreground']) expect(cls(icona), k).toContain(k)
    expect(findAll(icona, (n) => n.tag === 'svg')[0]).toBeTruthy()
  })

  it('sotto il titolo la riga grigia, che si tronca; senza titolo non nasce', () => {
    const titolo = colonna({ titolo: 'Gmail', sottotitolo: 'Server MCP · sul Mac' }).children[0]!.children[0]!
    expect(titolo.children.map((n) => textOf(n))).toEqual(['Gmail', 'Server MCP · sul Mac'])
    const sotto = titolo.children[1]!
    for (const k of ['text-small', 'text-muted-foreground', 'truncate']) expect(cls(sotto), k).toContain(k)
    expect(colonna({ titolo: 'Gmail' }).children[0]!.children[0]!.children).toHaveLength(1)
  })

  it('senza titolo né segno la riga di testa non nasce; il corpo è il primo figlio', () => {
    const col = colonna({ children: '✓ Collegata' })
    expect(textOf(col)).toBe('✓ Collegata')
    // nessun elemento prima: il testo è il primo figlio
    expect(col.children).toHaveLength(0)
  })

  it('l’ordine è quello della card: avviso · testata · corpo · azioni — le azioni in fondo, a 16 dal corpo, in fila', () => {
    const col = colonna({
      avviso: ce('p', { 'data-mark': 'avviso' }),
      titolo: 'x',
      nota: ce('span', { 'data-mark': 'nota' }),
      azioni: ce('p', { 'data-mark': 'azioni' }),
      children: ce('p', { 'data-mark': 'corpo' })
    })
    expect(findAll(col, (n) => n.attrs['data-mark'] !== undefined).map((n) => n.attrs['data-mark'])).toEqual(['avviso', 'nota', 'corpo', 'azioni'])
    const azioni = col.children[col.children.length - 1]!
    for (const k of ['mt-2', 'flex', 'flex-wrap', 'items-center', 'gap-2']) expect(cls(azioni), k).toContain(k)
  })

  it('senza avviso e senza azioni nessun nodo vuoto: la colonna ha tanti figli quanti ne ha dati chi chiama', () => {
    expect(colonna({ titolo: 'x', children: ce('p', null, 'corpo') }).children).toHaveLength(2)
  })

  it('nessuna classe morta: ogni classe che ChatCard può mettere nell’HTML ha la sua regola nel CSS compilato', async () => {
    const tutte = new Set<string>()
    for (const tone of [undefined, 'waiting', 'error']) {
      for (const logo of [undefined, '/loghi/a.svg']) {
        for (const nome of [undefined, 'Asana']) {
          for (const icona of [undefined, Plug]) {
            const r = root({ tone, logo, nome, icona, titolo: 'x', sottotitolo: 's', nota: 'n', avviso: 'a', azioni: 'b', children: 'c' })
            // le classi di lucide (lucide, lucide-plug) sono dell'svg, non del catalogo
            for (const n of findAll(r, () => true)) for (const c of cls(n)) if (!c.startsWith('lucide')) tutte.add(c)
          }
        }
      }
    }
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte])).toEqual([])
  })
})

describe('K3 (fase conversione-chat): ChatCard — la superficie da sola, il titolo grande, l\'incavo, il secondario sulla card', () => {
  const tutto = (n: HtmlNode): string[] => [n, ...findAll(n, () => true)].flatMap(cls)

  it('il titolo GRANDE (titoloGrande) è la frase che si legge prima di decidere: text-title, peso 600, e va a capo da sé (RW4); senza, il titolo resta la riga in peso medio', () => {
    const grande = findAll(root({ titolo: 'Vuole eseguire un comando', titoloGrande: true }), (n) => n.tag === 'p')[0]!
    for (const k of ['text-title', 'font-semibold', 'wrap-anywhere']) expect(cls(grande), k).toContain(k)
    expect(cls(grande)).not.toContain('font-medium')
    const riga = findAll(root({ titolo: 'Slack' }), (n) => n.tag === 'p')[0]!
    for (const k of ['text-body', 'font-medium']) expect(cls(riga), k).toContain(k)
    for (const k of ['text-title', 'font-semibold', 'wrap-anywhere']) expect(cls(riga), k).not.toContain(k)
  })

  it('ChatSurface è la superficie da sola: le stesse classi della radice di ChatCard (l\'85% della colonna, raggio di superficie, respiro 16, il testo che va a capo DENTRO, il fondo del tono) senza colonna, testata né ritmo', async () => {
    const { ChatSurface } = await import('../components/ui/chat-card')
    const albero = parseHtml(renderHtml(ce(ChatSurface, { testId: 'superficie-prova', tone: 'waiting' }, 'corpo')))
    const n = findAll(albero, (x) => x.attrs['data-testid'] === 'superficie-prova')[0]!
    for (const k of ['max-w-[85%]', 'min-w-0', 'rounded-surface', 'p-4', 'wrap-anywhere', 'bg-waiting/10']) expect(cls(n), k).toContain(k)
    for (const k of ['flex', 'flex-col', 'gap-2', 'bg-muted']) expect(cls(n), k).not.toContain(k)
    expect(textOf(n)).toBe('corpo')
    // ed è DAVVERO la stessa superficie: la radice di ChatCard col suo tono ha tutte le classi della superficie
    for (const k of cls(n)) expect(cls(root({ tone: 'waiting' })), k).toContain(k)
    expect(cls(root({}))).toContain('bg-muted')
    expect('data-testid' in findAll(parseHtml(renderHtml(ce(ChatSurface, {}, 'corpo'))), (x) => x.tag === 'div')[0]!.attrs).toBe(false)
  })

  it('CardBlock è l\'incavo dentro la card: raggio di controllo, fondo card, respiro 12 — e nient\'altro (il ritmo lo decide chi lo riempie)', async () => {
    const { CardBlock } = await import('../components/ui/chat-card')
    const n = findAll(parseHtml(renderHtml(ce(CardBlock, { testId: 'blocco-prova' }, 'riga'))), (x) => x.attrs['data-testid'] === 'blocco-prova')[0]!
    expect(cls(n)).toEqual(['rounded-control', 'bg-card', 'p-3'])
    expect(textOf(n)).toBe('riga')
    // className del chiamante si aggiunge
    expect(cls(findAll(parseHtml(renderHtml(ce(CardBlock, { className: 'mt-3 flex flex-col gap-1.5' }, 'x'))), (x) => x.tag === 'div')[0]!)).toEqual(['rounded-control', 'bg-card', 'p-3', 'mt-3', 'flex', 'flex-col', 'gap-1.5'])
  })

  it('SU_CARD (dal catalogo, con Button) è il secondario DENTRO una card in chat: fondo card, un passo più chiaro — si aggiunge a variant="secondary" senza togliergli il resto', async () => {
    const { SU_CARD, Button } = await import('../components/ui/button')
    expect(SU_CARD).toBe('bg-card hover:bg-card/80')
    const n = findAll(parseHtml(renderHtml(ce(Button, { variant: 'secondary', className: SU_CARD }, 'Rifiuta'))), (x) => x.tag === 'button')[0]!
    for (const k of ['bg-card', 'hover:bg-card/80', 'h-control', 'rounded-control', 'text-foreground', 'font-medium']) expect(cls(n), k).toContain(k)
    expect(cls(n)).not.toContain('bg-muted')
  })

  it('nessuna classe morta: nemmeno quelle del titolo grande, della superficie, dell\'incavo e del secondario sulla card', async () => {
    const { ChatSurface, CardBlock } = await import('../components/ui/chat-card')
    const { SU_CARD, Button } = await import('../components/ui/button')
    const tutte = new Set<string>([
      ...tutto(root({ titolo: 'x', titoloGrande: true })),
      ...tutto(parseHtml(renderHtml(ce(ChatSurface, { tone: 'error' }, 'x')))),
      ...tutto(parseHtml(renderHtml(ce(CardBlock, {}, 'x')))),
      ...cls(findAll(parseHtml(renderHtml(ce(Button, { variant: 'secondary', className: SU_CARD }, 'x'))), (x) => x.tag === 'button')[0]!)
    ])
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte])).toEqual([])
  })
})
