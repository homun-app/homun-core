// Fase design (DS2): LA TABELLA UNICA (DataTable) — quella che useranno
// «Collegati», «Uso e costi», «Attività». Le regole della spec, parola per
// parola: intestazioni text-caption GRIGIE in tono normale (niente
// maiuscoletto), celle text-body, seconde righe text-small, righe da 52 px,
// filetti tra le righe (e sotto le intestazioni), NIENTE A CAPO nei valori
// brevi (troncati col testo intero nel title), scorrimento orizzontale DENTRO
// la tabella se la finestra è stretta. Come gli altri test dei pezzi: il
// componente VERO reso con react-dom/server (senza DOM), l'HTML letto con
// parseHtml, e i VERO handler invocati dalle props catturate col mock del
// runtime JSX.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

const { DataTable, Cell, CellStack } = await import('../components/ui/data-table')
type DataTableColumn<T> = import('../components/ui/data-table').DataTableColumn<T>

interface Riga { id: string; nome: string; sede: string; costo: string }
const RIGHE: readonly Riga[] = [
  { id: 'n', nome: 'Notion', sede: 'Milano', costo: '12,00' },
  { id: 's', nome: 'Slack', sede: 'Roma', costo: '3,50' }
]
/** Quattro colonne, una per caso: di default · larga fissa · che cresce · allineata a destra. */
const COLONNE: ReadonlyArray<DataTableColumn<Riga>> = [
  { id: 'nome', header: 'Nome', cell: (r) => r.nome },
  { id: 'sede', header: 'Sede', width: 100, cell: (r) => r.sede },
  { id: 'note', header: 'Note', grow: true, cell: (r) => createElement(CellStack, { primary: r.nome, secondary: r.sede }) },
  { id: 'costo', header: 'Costo', width: 200, align: 'right', cell: (r) => r.costo }
]

const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter(Boolean)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!
const tag = (root: HtmlNode, name: string): HtmlNode[] => findAll(root, (n) => n.tag === name)
/** Le righe del corpo (quelle dentro <tbody>). */
const righe = (root: HtmlNode): HtmlNode[] => findAll(root, (n) => n.tag === 'tr' && n.parent?.tag === 'tbody')
const render = (props: Record<string, unknown> = {}): HtmlNode => parseHtml(renderHtml(createElement(DataTable, {
  columns: COLONNE, rows: RIGHE, rowKey: (r: Riga) => r.id, ...props
} as never)))
const cell = (children: ReactNode, props: Record<string, unknown> = {}): HtmlNode => {
  const root = parseHtml(renderHtml(createElement('td', null, createElement(Cell, { children, ...props } as never))))
  return first(root, (n) => n.tag === 'td').children[0]!
}
/** Lo slot da 32 del leading: un quadrato griglia al quale si affidano icone e loghi. */
const SLOT = ['grid', 'size-8', 'shrink-0', 'place-items-center']

beforeEach(() => { capture.els.length = 0 })

describe('DS2: DataTable — la struttura', () => {
  it('il contenitore scorre in orizzontale DENTRO la tabella (overflow-x-auto, barra sottile) e porta il testid', () => {
    const root = render({ testId: 'collegati' })
    const box = first(root, (n) => n.attrs['data-testid'] === 'collegati')
    expect(has(box, 'overflow-x-auto')).toBe(true)
    expect(has(box, 'scroll-thin')).toBe(true)
    expect(box.children.map((c) => c.tag)).toEqual(['table'])
  })

  it('senza testId il contenitore non ha l’attributo', () => {
    expect(first(render(), (n) => has(n, 'overflow-x-auto')).attrs['data-testid']).toBeUndefined()
  })

  it('una <col> per colonna: larga come la sua larghezza fissa (128 se non la dice), niente larghezza per quella che cresce', () => {
    const cols = tag(render(), 'col')
    expect(cols).toHaveLength(4)
    expect(cols.map((c) => c.attrs.style)).toEqual(['width:128px', 'width:100px', undefined, 'width:200px'])
    // una intestazione e una cella per colonna, in ogni riga
    expect(tag(render(), 'th')).toHaveLength(4)
    expect(tag(render(), 'td')).toHaveLength(8)
    for (const r of righe(render())) expect(r.children.filter((c) => c.tag === 'td')).toHaveLength(4)
  })

  it('la tabella è larga quanto il contenitore e ALMENO la somma delle colonne fisse (+ 160 per ognuna che cresce): sotto, scorre il contenitore', () => {
    // 128 (default) + 100 + 160 (grow) + 200
    const table = tag(render(), 'table')[0]!
    expect(table.attrs.style).toBe('min-width:588px')
    for (const cls of ['w-full', 'table-fixed', 'border-collapse', 'text-left']) expect(has(table, cls), cls).toBe(true)
    expect(tag(render({ rows: [], columns: [{ id: 'a', header: 'a', cell: () => 'a' }, { id: 'b', header: 'b', cell: () => 'b', grow: true }, { id: 'c', header: 'c', cell: () => 'c', grow: true }] }), 'table')[0]!.attrs.style).toBe('min-width:448px')
  })

  it('il filetto sotto le intestazioni; tra le righe un filetto in alto, e ognuna è alta 52 (h-row)', () => {
    const root = render()
    const head = tag(root, 'tr')[0]!
    expect(head.parent?.tag).toBe('thead')
    expect(has(head, 'border-b')).toBe(true)
    expect(has(head, 'border-border/50')).toBe(true)
    for (const r of righe(root)) {
      expect(has(r, 'h-row')).toBe(true)
      expect(has(r, 'border-t')).toBe(true)
      expect(has(r, 'border-border/50')).toBe(true)
    }
  })

  it('le intestazioni: text-caption grigie, in tono normale (font-normal), che non vanno mai a capo — niente maiuscoletto, niente maiuscole', () => {
    for (const th of tag(render(), 'th')) {
      expect(th.attrs.scope).toBe('col')
      for (const cls of ['text-caption', 'text-muted-foreground', 'font-normal', 'whitespace-nowrap', 'py-2', 'pr-4', 'align-middle']) expect(has(th, cls), cls).toBe(true)
      for (const vietato of [/^uppercase$/, /^tracking-/, /^font-(medium|semibold|bold)$/, /^text-\[/, /^leading-/]) expect(classes(th).some((c) => vietato.test(c)), String(vietato)).toBe(false)
    }
    expect(tag(render(), 'th').map((t) => textOf(t))).toEqual(['Nome', 'Sede', 'Note', 'Costo'])
  })

  it('le celle: il respiro della riga (py-row-pad), aria a destra (pr-4), allineate al centro verticale, senza filetti propri', () => {
    for (const td of tag(render(), 'td')) {
      for (const cls of ['py-row-pad', 'pr-4', 'align-middle']) expect(has(td, cls), cls).toBe(true)
      expect(classes(td).some((c) => c.startsWith('border'))).toBe(false)
    }
    expect(tag(render(), 'td').map((t) => textOf(t))).toEqual(['Notion', 'Milano', 'NotionMilano', '12,00', 'Slack', 'Roma', 'SlackRoma', '3,50'])
  })

  it('una colonna allineata a destra lo è in intestazione E nelle celle (una colonna di costi non si legge con il titolo staccato dai numeri)', () => {
    const root = render()
    expect(has(tag(root, 'th')[3]!, 'text-right')).toBe(true)
    expect(has(tag(root, 'th')[3]!, 'text-left')).toBe(false)
    for (const r of righe(root)) {
      expect(has(r.children[3]!, 'text-right')).toBe(true)
      // le altre restano come la tabella (text-left sta sul <table>) e non si portano dietro un allineamento loro
      expect(classes(r.children[0]!).some((c) => /^text-(left|right)$/.test(c))).toBe(false)
    }
  })
})

describe('DS2: DataTable — le righe', () => {
  it('ogni riga del corpo ha il testid di rowTestId (la riga delle intestazioni no)', () => {
    const root = render({ rowTestId: (r: Riga) => `riga-${r.id}` })
    expect(righe(root).map((r) => r.attrs['data-testid'])).toEqual(['riga-n', 'riga-s'])
    // anche negli elementi VERI di React, nello stesso ordine: prima la riga delle intestazioni (senza testid)
    expect(capture.els.filter((e) => e.type === 'tr').map((e) => e.props['data-testid'])).toEqual([undefined, 'riga-n', 'riga-s'])
    expect(righe(render()).every((r) => r.attrs['data-testid'] === undefined)).toBe(true)
  })

  it('la riga che si apre: cursore, hover tenue, tabIndex 0; il clic chiama onRowClick con LA riga', () => {
    const onRowClick = vi.fn()
    const root = render({ onRowClick, rowTestId: (r: Riga) => `riga-${r.id}` })
    const row = first(root, (n) => n.attrs['data-testid'] === 'riga-s')
    expect(row.attrs.tabindex).toBe('0')
    expect(has(row, 'cursor-pointer')).toBe(true)
    expect(has(row, 'transition')).toBe(true)
    expect(has(row, 'hover:bg-muted/50')).toBe(true)
    // l'anello del fuoco, esplicito e verso l'interno: il contenitore scorre e ritaglia ciò che sporge dalla riga
    for (const cls of ['focus-visible:outline-2', 'focus-visible:-outline-offset-2', 'focus-visible:outline-ring']) expect(has(row, cls), cls).toBe(true)
    const captured = capture.els.find((e) => e.type === 'tr' && e.props['data-testid'] === 'riga-s')!
    ;(captured.props.onClick as () => void)()
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith(RIGHE[1])
  })

  it('Invio e Spazio fanno il clic (e lo spazio non fa scorrere la pagina: preventDefault); gli altri tasti non fanno nulla', () => {
    const onRowClick = vi.fn()
    render({ onRowClick })
    // la PRIMA riga del corpo (il primo tr è quello delle intestazioni, che non ha tasti)
    const captured = capture.els.filter((e) => e.type === 'tr' && e.props.onKeyDown !== undefined)[0]!
    expect(captured).toBeTruthy()
    const preventDefault = vi.fn()
    for (const key of ['Enter', ' ', 'a', 'ArrowDown', 'Tab']) (captured.props.onKeyDown as (e: unknown) => void)({ key, preventDefault })
    expect(onRowClick).toHaveBeenCalledTimes(2)
    expect(onRowClick).toHaveBeenCalledWith(RIGHE[0])
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it('senza onRowClick la riga non è un bottone: niente tabIndex, niente hover, niente handler', () => {
    const root = render()
    for (const r of righe(root)) {
      expect(r.attrs.tabindex).toBeUndefined()
      expect(r.attrs.role).toBeUndefined()
      expect(classes(r).some((c) => /^hover:|^cursor-pointer$|^focus-visible:/.test(c))).toBe(false)
    }
    for (const e of capture.els.filter((e) => e.type === 'tr')) {
      expect(e.props.onClick).toBeUndefined()
      expect(e.props.onKeyDown).toBeUndefined()
    }
  })

  it('senza righe: al posto della tabella c’è empty; senza empty restano le intestazioni (la tabella non sparisce)', () => {
    const vuoto = render({ rows: [], empty: createElement('p', { 'data-testid': 'vuoto' }, 'Nessun collegamento') })
    expect(tag(vuoto, 'table')).toHaveLength(0)
    expect(tag(vuoto, 'th')).toHaveLength(0)
    expect(textOf(first(vuoto, (n) => n.attrs['data-testid'] === 'vuoto'))).toBe('Nessun collegamento')
    const soloTeste = render({ rows: [] })
    expect(tag(soloTeste, 'th')).toHaveLength(4)
    expect(righe(soloTeste)).toHaveLength(0)
  })
})

describe('DS2: DataTable — le celle', () => {
  it('Cell: UNA riga, troncata, col testo intero nel title quando il contenuto è una stringa', () => {
    const c = cell('Server MCP del team Marketing, ambiente di prova')
    expect(c.tag).toBe('span')
    expect(has(c, 'block')).toBe(true)
    expect(has(c, 'truncate')).toBe(true)
    expect(c.attrs.title).toBe('Server MCP del team Marketing, ambiente di prova')
    expect(textOf(c)).toBe('Server MCP del team Marketing, ambiente di prova')
    // il testo è suo (nessun nodo dentro: una riga sola)
    expect(c.children).toHaveLength(0)
  })

  it('Cell secondaria: text-small grigia, troncata anche lei', () => {
    const c = cell('tramite Composio', { secondary: true })
    expect(has(c, 'truncate')).toBe(true)
    expect(has(c, 'text-small')).toBe(true)
    expect(has(c, 'text-muted-foreground')).toBe(true)
    expect(c.attrs.title).toBe('tramite Composio')
  })

  it('Cell senza title quando il contenuto non è una stringa (un nodo non ha un «titolo intero» da mostrare)', () => {
    const c = cell(createElement('span', null, 'un nodo'))
    expect(c.attrs.title).toBeUndefined()
    expect(has(c, 'truncate')).toBe(true)
  })

  it('Cell con il leading: logo o icona nello slot da 32, sulla stessa riga del testo, con 12 px in mezzo; il testo tronca (min-w-0 flex-1)', () => {
    const c = cell('Notion', { leading: createElement('img', { src: 'notion.svg', alt: '' }) })
    expect(has(c, 'flex')).toBe(true)
    expect(has(c, 'items-center')).toBe(true)
    expect(has(c, 'gap-row-gap')).toBe(true)
    expect(c.children.map((x) => x.tag)).toEqual(['span', 'span'])
    for (const cls of SLOT) expect(has(c.children[0]!, cls), cls).toBe(true)
    expect(c.children[0]!.children[0]!.tag).toBe('img')
    const testo = c.children[1]!
    for (const cls of ['block', 'truncate', 'min-w-0', 'flex-1']) expect(has(testo, cls), cls).toBe(true)
    expect(testo.attrs.title).toBe('Notion')
    // senza leading non c'è lo slot: il testo è la cella stessa
    expect(cell('sola').tag).toBe('span')
    expect(cell('sola').children.map((x) => x.tag)).toEqual([])
  })

  it('CellStack: DUE righe volute — il titolo text-body (peso medium, come i titoli di riga) e la seconda text-small grigia — tutte e due troncate, col title se sono stringhe', () => {
    const root = parseHtml(renderHtml(createElement('td', null, createElement(CellStack, { primary: 'Notion', secondary: '2 account' }))))
    const stack = first(root, (n) => n.tag === 'td').children[0]!
    expect(stack.children.map((x) => textOf(x))).toEqual(['Notion', '2 account'])
    const [titolo, seconda] = stack.children as [HtmlNode, HtmlNode]
    for (const line of stack.children) expect(has(line, 'truncate'), 'tronca').toBe(true)
    for (const cls of ['text-body', 'font-medium']) expect(has(titolo, cls), cls).toBe(true)
    expect(titolo.attrs.title).toBe('Notion')
    for (const cls of ['text-small', 'text-muted-foreground']) expect(has(seconda, cls), cls).toBe(true)
    expect(has(seconda, 'text-body')).toBe(false)
    expect(seconda.attrs.title).toBe('2 account')
  })

  it('CellStack senza seconda riga ne crea una vuota; con il leading le due righe stanno in min-w-0 flex-1 accanto allo slot da 32', () => {
    const sola = parseHtml(renderHtml(createElement('td', null, createElement(CellStack, { primary: 'solo titolo' }))))
    expect(first(sola, (n) => n.tag === 'td').children[0]!.children).toHaveLength(1)
    const root = parseHtml(renderHtml(createElement('td', null, createElement(CellStack, { primary: 'Slack', secondary: '3 bot', leading: createElement('img', { src: 'slack.svg', alt: '' }) }))))
    const stack = first(root, (n) => n.tag === 'td').children[0]!
    expect(has(stack, 'flex')).toBe(true)
    expect(has(stack, 'gap-row-gap')).toBe(true)
    expect(stack.children.map((x) => x.tag)).toEqual(['span', 'span'])
    for (const cls of SLOT) expect(has(stack.children[0]!, cls), cls).toBe(true)
    const linee = stack.children[1]!
    for (const cls of ['min-w-0', 'flex-1']) expect(has(linee, cls), cls).toBe(true)
    expect(linee.children.map((x) => textOf(x))).toEqual(['Slack', '3 bot'])
  })
})
