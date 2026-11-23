// Fase design (DS2): I PEZZI DEL GUSCIO della pagina — la riga in cima a ogni
// colonna (ColumnHead), l'invaso di ogni pagina a tutta area (PageShell con la
// sua colonna, PageColumn), la testata (PageHeader), la sezione (Section).
//
// Resi DAVVERO (react-dom/server, senza DOM: l'HTML è parseato in un albero)
// come ui-flat.test.ts; dove conta il CSS si guarda il CSS VERO di styles.css
// compilato da Tailwind (compileRenderer), perché che una classe generi la
// sua regola lo dice solo l'output, non il sorgente.
//
// I tre contratti che questi test tengono in piedi:
//   1. IL CORPO CHE SCORRE È LARGO QUANTO L'AREA. In PluginShell la colonna
//      centrata stava attorno a tutto, barra di scorrimento compresa: la barra
//      restava attaccata alla colonna, non al bordo della finestra. Qui la
//      radice È la colonna (absolute inset-0, flex flex-col) e il corpo che
//      scorre è suo figlio diretto; solo DENTRO il corpo il contenuto è
//      centrato alla larghezza scelta (data-page-gutter > data-page-content).
//   2. IL MARGINE DIPENDE DALL'AREA, non dalla finestra: sotto i 900 px di
//      area è 24 invece di 32. Con una media query sulla finestra, a una
//      finestra di 900 px l'area (meno la barra di sinistra) sarebbe molto
//      più stretta e il margine resterebbe quello largo. La radice è un
//      contenitore (@container) e il gutter usa la variante @max-[900px]:.
//   3. LO SCHEMA «min-h-0 flex-1» (PP1): testata e barra degli strumenti
//      shrink-0, il corpo min-h-0 flex-1 overflow-y-auto. Senza, la colonna
//      cresce col contenuto e il corpo non scorre mai.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { Puzzle } from 'lucide-react'
import { renderHtml, parseHtml, textOf, findAll, findByText, hasAncestor, type HtmlNode } from './render-helper'
import { isClassList, stringsOf } from './design-scan'
import { compileRenderer, squashed } from './tailwind-compile'

// le props degli elementi resi, catturate dal runtime JSX: è così che si
// invoca il VERO handler di un bottone (qui quello di «indietro»)
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

// i pezzi si importano DENTRO i test (come plugin-shell.test.ts): finché un
// pezzo non c'è fallisce il test che lo chiede, non l'intero file
const pieces = async () => ({
  ...(await import('../components/ui/column-head')),
  ...(await import('../components/ui/page-shell')),
  ...(await import('../components/ui/page-header')),
  ...(await import('../components/ui/section'))
})

/** Le classi di un nodo, come le scrive React (separate da spazi). */
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((c) => c !== '')
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!
const byTestid = (root: HtmlNode, id: string): HtmlNode => first(root, (n) => n.attrs['data-testid'] === id)
const slot = (root: HtmlNode, name: string): HtmlNode => first(root, (n) => n.attrs['data-page-shell'] === name)
const isGutter = (n: HtmlNode): boolean => 'data-page-gutter' in n.attrs
const isContent = (n: HtmlNode): boolean => 'data-page-content' in n.attrs
const isColHead = (n: HtmlNode): boolean => 'data-col-head' in n.attrs

/** Il nodo porta TUTTE queste classi; se mancano, il messaggio dice quali e dove. */
function expectHasAll(node: HtmlNode, list: string[]): void {
  const missing = list.filter((c) => !has(node, c))
  expect(missing, `a <${node.tag} class="${node.attrs.class ?? ''}"> mancano:`).toEqual([])
}

beforeEach(() => { capture.els.length = 0 })

describe('DS2: PageShell — l’invaso di ogni pagina a tutta area', () => {
  const render = async (props: Record<string, unknown>): Promise<HtmlNode> => {
    const { PageShell } = await pieces()
    return parseHtml(renderHtml(createElement(PageShell, props as never)))
  }
  /** Un guscio con tutti gli slot pieni. */
  const full = (): Record<string, unknown> => ({
    width: 'page',
    testId: 'pagina',
    header: createElement('h2', { 'data-testid': 'testata' }, 'Titolo'),
    description: 'La descrizione della pagina',
    toolbar: createElement('input', { 'data-testid': 'ricerca' }),
    children: createElement('p', { 'data-testid': 'corpo' }, 'contenuto'),
    scrollTestId: 'scorre'
  })

  it('la radice: inchiodata all’area (absolute inset-0), colonna flex, sopra la chat (z-20), no-drag, un contenitore per le query — col testid', async () => {
    const root = await render({ width: 'page', testId: 'plugin-page', children: 'corpo' })
    const page = byTestid(root, 'plugin-page')
    expect(page.attrs['data-page-shell']).toBe('root')
    // no-drag: la pagina copre la fascia di trascinamento della chat sotto di lei
    // @container: il margine del gutter si misura sull'AREA
    expectHasAll(page, ['no-drag', '@container', 'absolute', 'inset-0', 'z-20', 'flex', 'flex-col', 'bg-background'])
    expect(has(page, 'z-30')).toBe(false)
  })

  it('z=30: la scheda sta sopra la pagina (z-30) e non porta z-20', async () => {
    const root = await render({ width: 'page', z: 30, testId: 'scheda', children: 'corpo' })
    const page = byTestid(root, 'scheda')
    expectHasAll(page, ['z-30'])
    expect(has(page, 'z-20')).toBe(false)
  })

  it('gli slot nell’ordine — testata · descrizione · barra degli strumenti · corpo che scorre — e il corpo è figlio DIRETTO della radice (nessuna colonna in mezzo: la barra di scorrimento sta sul bordo dell’area)', async () => {
    const root = await render(full())
    const page = byTestid(root, 'pagina')
    expect(page.children.map((c) => c.attrs['data-page-shell'])).toEqual(['header', 'description', 'toolbar', 'scroll'])
    // testata, descrizione e barra degli strumenti restano FERME (non si accartocciano) e riservano 6 px per lato
    for (const name of ['header', 'description', 'toolbar']) {
      expectHasAll(slot(root, name), ['shrink-0', 'px-1.5'])
      expect(slot(root, name).parent).toBe(page)
    }
    // il corpo che scorre: lo schema di PP1 — prende lo spazio che resta, il di più scorre
    const scroller = byTestid(root, 'scorre')
    expect(scroller.attrs['data-page-shell']).toBe('scroll')
    expectHasAll(scroller, ['scroll-thin', 'min-h-0', 'flex-1', 'overflow-y-auto', 'overflow-x-hidden'])
    // la barra di scroll-thin occupa 6 px: il corpo la riserva su TUTTI E DUE i lati (simmetrico: il contenuto resta al centro dell'area)
    expect(has(scroller, '[scrollbar-gutter:stable_both-edges]')).toBe(true)
    const css = await compileRenderer(['[scrollbar-gutter:stable_both-edges]', 'px-1.5'])
    // compilato: la proprietà arbitraria genera la sua regola (la classe nel selettore è scappata)
    expect(squashed(css)).toContain('scrollbar-gutter\\:stable_both-edges')
    expect(squashed(css)).toContain('scrollbar-gutter: stable both-edges;')
    expect(squashed(css)).toContain('.px-1\\.5 { padding-inline: calc(var(--spacing) * 1.5); }')
    expect(scroller.parent).toBe(page)
    expect(textOf(byTestid(root, 'corpo'))).toBe('contenuto')
    expect(textOf(byTestid(root, 'testata'))).toBe('Titolo')
  })

  it('la testata è resa TAL QUALE nello slot: nessuna colonna intorno (il suo ColumnHead deve essere largo quanto l’area)', async () => {
    const root = await render({ width: 'page', header: createElement('h2', { 'data-testid': 'testata' }, 'Titolo'), children: 'corpo' })
    const head = byTestid(root, 'testata')
    expect(head.tag).toBe('h2')
    expect(head.parent).toBe(slot(root, 'header'))
    expect(slot(root, 'header').parent).toBe(slot(root, 'root'))
    expect(hasAncestor(head, isGutter)).toBe(false)
  })

  it('la descrizione sta sotto la riga dei 52, alla larghezza del contenuto: text-small grigio, a 12 px dal contenuto', async () => {
    const root = await render(full())
    const desc = slot(root, 'description')
    // lo slot > gutter > contenuto: la descrizione è larga quanto il contenuto, non quanto l'area
    expect(desc.children.map(isGutter)).toEqual([true])
    const content = desc.children[0]!.children[0]!
    expect(isContent(content)).toBe(true)
    expectHasAll(content, ['text-small', 'text-muted-foreground', 'pb-3'])
    expect(textOf(content)).toBe('La descrizione della pagina')
  })

  it('la descrizione tiene la DIMENSIONE e il COLORE, tutte e due: ci vuole cn() che conosca le dimensioni di DS1 (quello di fabbrica scambiava text-small per un colore e, accanto a text-muted-foreground, lo toglieva)', async () => {
    const { PageShell, PageHeader } = await pieces()
    const viaGuscio = parseHtml(renderHtml(createElement(PageShell, { width: 'page', description: 'descrizione', children: 'corpo' })))
    const viaTestata = parseHtml(renderHtml(createElement(PageHeader, { title: 'Titolo', description: 'descrizione' })))
    for (const root of [viaGuscio, viaTestata]) {
      const marked = findAll(root, (n) => classes(n).some((c) => c === 'text-small' || c === 'text-muted-foreground'))
      // un elemento solo, con tutte e due: 13 px E grigio
      expect(marked.map(classes)).toEqual([['mx-auto', 'w-full', 'pb-3', 'text-small', 'text-muted-foreground']])
    }
  })

  it('la barra degli strumenti: ferma, alla larghezza del contenuto, in una riga alta 40 (min-h-10)', async () => {
    const root = await render(full())
    const bar = slot(root, 'toolbar')
    expect(bar.children.map(isGutter)).toEqual([true])
    const row = byTestid(root, 'ricerca').parent!
    expect(row.parent).toBe(bar.children[0]!.children[0]!)
    expect(isContent(row.parent!)).toBe(true)
    expectHasAll(row, ['flex', 'min-h-10', 'items-center', 'gap-3'])
  })

  it('senza testata, descrizione e barra gli slot non nascono: resta solo il corpo che scorre (e niente attributi vuoti)', async () => {
    const root = await render({ width: 'page', children: 'corpo' })
    const page = slot(root, 'root')
    expect(page.children.map((c) => c.attrs['data-page-shell'])).toEqual(['scroll'])
    expect(page.attrs['data-testid']).toBeUndefined()
    expect(page.children[0]!.attrs['data-testid']).toBeUndefined()
    // dentro il corpo: una colonna sola, col contenuto
    const [gutter] = page.children[0]!.children
    expect(isGutter(gutter!)).toBe(true)
    expect(textOf(gutter!)).toBe('corpo')
  })
})

describe('DS2: PageColumn — il gutter col margine, dentro il contenuto centrato', () => {
  it.each((['reading', 'page', 'wide'] as const).map((width) => [width, width] as const))('larghezza %s: il contenuto è mx-auto w-full, largo al più var(--w-%s)', async (width) => {
    const { PageColumn } = await pieces()
    const root = parseHtml(renderHtml(createElement(PageColumn, { width, children: 'testo', testId: 'colonna' })))
    // il gutter: largo quanto il suo contenitore, col margine della pagina (24 sotto i 900 px di area)
    const gutter = byTestid(root, 'colonna')
    expect(isGutter(gutter)).toBe(true)
    expectHasAll(gutter, ['w-full', 'min-w-0', 'px-page-margin', '@max-[900px]:px-page-margin-narrow'])
    expect(gutter.children).toHaveLength(1)
    // il contenuto: centrato (mx-auto) e largo al più quanto la larghezza scelta
    const content = gutter.children[0]!
    expect(isContent(content)).toBe(true)
    expectHasAll(content, ['mx-auto', 'w-full'])
    expect(content.attrs.style).toBe(`max-width:var(--w-${width})`)
    expect(textOf(content)).toBe('testo')
  })

  it('la larghezza viaggia nel contesto del guscio: dentro PageShell a reading OGNI colonna è da lettura; fuori dal guscio (o senza riceverla) vale page', async () => {
    const { PageShell, PageColumn } = await pieces()
    const alone = parseHtml(renderHtml(createElement(PageColumn, null, 'testo')))
    expect(first(alone, isContent).attrs.style).toBe('max-width:var(--w-page)')
    const root = parseHtml(renderHtml(createElement(PageShell, {
      width: 'reading',
      description: 'descrizione',
      toolbar: 'barra',
      // una colonna dentro il contenuto, che la larghezza non la riceve: legge il contesto
      children: createElement(PageColumn, null, 'interna')
    })))
    const styles = findAll(root, isContent).map((n) => n.attrs.style)
    expect(styles).toHaveLength(4)
    for (const style of styles) expect(style).toBe('max-width:var(--w-reading)')
  })

  it('la larghezza ricevuta vince sul contesto', async () => {
    const { PageShell, PageColumn } = await pieces()
    const root = parseHtml(renderHtml(createElement(PageShell, {
      width: 'page',
      children: createElement(PageColumn, { width: 'wide', children: 'tabella' })
    })))
    expect(findAll(root, isContent).map((n) => n.attrs.style)).toEqual(['max-width:var(--w-page)', 'max-width:var(--w-wide)'])
  })

  it('contentClassName va sull’elemento del contenuto del corpo: è lì che chi elenca le sezioni decide il ritmo (flex flex-col gap-section)', async () => {
    const { PageShell } = await pieces()
    const root = parseHtml(renderHtml(createElement(PageShell, { width: 'page', contentClassName: 'flex flex-col gap-section pb-6', children: 'corpo' })))
    const scroller = slot(root, 'scroll')
    const gutter = scroller.children[0]!
    const content = gutter.children[0]!
    expectHasAll(content, ['mx-auto', 'w-full', 'flex', 'flex-col', 'gap-section', 'pb-6'])
    // e SOLO lì: né il gutter né il corpo che scorre
    for (const node of [gutter, scroller]) expect(classes(node).some((c) => c.startsWith('gap-'))).toBe(false)
  })
})

describe('DS2: PageHeader — indietro · icona · titolo · azioni, sotto la descrizione', () => {
  const renderHeader = async (props: Record<string, unknown>): Promise<HtmlNode> => {
    const { PageHeader } = await pieces()
    return parseHtml(renderHtml(createElement(PageHeader, props as never)))
  }
  /** La riga dentro la testata: ColumnHead > gutter > contenuto > riga. */
  const rowOf = (root: HtmlNode): { col: HtmlNode; row: HtmlNode } => {
    const col = first(root, isColHead)
    return { col, row: col.children[0]!.children[0]!.children[0]! }
  }

  it('la riga dei 52 — fascia di trascinamento, larga quanto l’area — con dentro la colonna e la riga: indietro · icona · titolo · spazio · azioni', async () => {
    const root = await renderHeader({
      title: 'Plugin',
      testId: 'testata',
      back: { onClick: () => undefined, label: 'Torna alla chat' },
      icon: createElement(Puzzle),
      actions: createElement('button', { 'data-testid': 'azione' }, 'Aggiungi')
    })
    const head = byTestid(root, 'testata')
    expect(head.tag).toBe('div')
    const { col, row } = rowOf(head)
    expect(isColHead(col)).toBe(true)
    expectHasAll(col, ['drag-region', 'flex', 'h-col-head', 'shrink-0', 'items-center'])
    // la colonna è figlia UNICA della riga dei 52, e la riempie (altrimenti le azioni restano appiccicate al titolo)
    expect(col.children.map(isGutter)).toEqual([true])
    expectHasAll(col.children[0]!, ['w-full', 'min-w-0', 'px-page-margin'])
    expect(isContent(row.parent!)).toBe(true)
    expectHasAll(row, ['flex', 'min-w-0', 'flex-1', 'items-center', 'gap-3'])
    expect(row.children.map((c) => c.tag)).toEqual(['button', 'span', 'h1', 'span', 'div'])
    expect(textOf(row.children[2]!)).toBe('Plugin')
    expect(textOf(row.children[4]!)).toBe('Aggiungi')
  })

  it('indietro: bottone tondo da 32 (size-control-sm), no-drag, ChevronLeft a 16, aria-label e type=button — e il clic VERO chiama onClick', async () => {
    const onClick = vi.fn()
    const root = await renderHeader({ title: 'Plugin', back: { onClick, label: 'Torna ai plugin' } })
    const button = first(root, (n) => n.tag === 'button')
    expect(button.attrs.type).toBe('button')
    expect(button.attrs['aria-label']).toBe('Torna ai plugin')
    // no-drag: sta nella fascia di trascinamento; shrink-0: quando il titolo tronca non si schiaccia in un ovale
    expectHasAll(button, ['no-drag', 'grid', 'size-control-sm', 'shrink-0', 'place-items-center', 'rounded-full', 'text-muted-foreground', 'transition', 'hover:bg-muted', 'hover:text-foreground'])
    const svg = button.children[0]!
    expect(svg.tag).toBe('svg')
    expect(has(svg, 'size-4')).toBe(true)
    expect(svg.attrs.class).toContain('lucide-chevron-left')
    // il VERO handler, preso dal runtime JSX mentre la testata si rendeva
    const captured = capture.els.find((e) => e.type === 'button' && e.props['aria-label'] === 'Torna ai plugin')
    expect(captured, 'il bottone reso').toBeDefined()
    ;(captured!.props.onClick as () => void)()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('il titolo: h1 in font-display, 600, text-page, che tronca; se è una stringa porta anche title (il nome intero al passaggio), se è un nodo no', async () => {
    const asString = await renderHeader({ title: 'Server MCP' })
    const h1 = first(asString, (n) => n.tag === 'h1')
    expectHasAll(h1, ['min-w-0', 'truncate', 'font-display', 'font-semibold', 'text-page'])
    expect(h1.attrs.title).toBe('Server MCP')
    expect(textOf(h1)).toBe('Server MCP')
    const asNode = await renderHeader({ title: createElement('span', null, 'Server MCP') })
    expect(first(asNode, (n) => n.tag === 'h1').attrs.title).toBeUndefined()
  })

  it('l’icona è 20 px e grigia (size-5): la misura la dà la testata, non chi la passa', async () => {
    const root = await renderHeader({ title: 'Plugin', icon: createElement(Puzzle) })
    const { row } = rowOf(root)
    const icon = row.children[0]!
    expectHasAll(icon, ['size-5', 'shrink-0', 'text-muted-foreground'])
    expect(first(icon, (n) => n.tag === 'svg')).toBeTruthy()
  })

  it('il logo è 40 px (size-10) e prende il posto dell’icona: se ci sono tutti e due vince il logo (le testate di scheda)', async () => {
    const { PageHeader } = await pieces()
    const root = parseHtml(renderHtml(createElement(PageHeader, {
      title: 'Notion',
      icon: createElement(Puzzle),
      logo: createElement('img', { src: 'notion.svg', alt: '' })
    })))
    const { row } = rowOf(root)
    expect(row.children.map((c) => c.tag)).toEqual(['span', 'h1'])
    expectHasAll(row.children[0]!, ['size-10', 'shrink-0'])
    expect(has(row.children[0]!, 'size-5')).toBe(false)
    expect(first(row.children[0]!, (n) => n.tag === 'svg')).toBeUndefined()
  })

  it('le azioni a destra: dopo il titolo viene lo spazio che resta, poi le azioni (flex shrink-0 items-center gap-2), che non si schiacciano', async () => {
    const root = await renderHeader({ title: 'Plugin', actions: createElement('button', { 'data-testid': 'azione' }, 'Aggiungi') })
    const { row } = rowOf(root)
    expect(row.children.map((c) => c.tag)).toEqual(['h1', 'span', 'div'])
    expectHasAll(row.children[1]!, ['flex-1'])
    expectHasAll(row.children[2]!, ['flex', 'shrink-0', 'items-center', 'gap-2'])
    expect(byTestid(row.children[2]!, 'azione')).toBeTruthy()
  })

  it('solo il titolo: nella riga c’è l’h1 e nient’altro (nessun nodo vuoto), sotto la riga non c’è nulla', async () => {
    const root = await renderHeader({ title: 'Plugin' })
    const head = root.children[0]!
    expect(head.children.map((n) => (isColHead(n) ? 'col-head' : n.tag))).toEqual(['col-head'])
    const { row } = rowOf(head)
    expect(row.children.map((c) => c.tag)).toEqual(['h1'])
    expect(findAll(root, (n) => n.tag === 'button')).toHaveLength(0)
  })

  it('la descrizione sta SOTTO la riga dei 52, mai dentro: text-small grigio, alla larghezza del contenuto', async () => {
    const root = await renderHeader({ title: 'Plugin', description: 'Tutto quello che Homun può usare' })
    const head = root.children[0]!
    const { col } = rowOf(head)
    // dentro la riga dei 52 c’è SOLO il titolo
    expect(textOf(col)).toBe('Plugin')
    expect(hasAncestor(findByText(root, 'Tutto quello che Homun può usare')!, (n) => n === col)).toBe(false)
    // la descrizione è la colonna che segue la riga: mai dentro la riga dei 52
    expect(head.children.map((n) => (isColHead(n) ? 'col-head' : (isGutter(n) ? 'gutter' : n.tag)))).toEqual(['col-head', 'gutter'])
    expect(head.children[0]).toBe(col)
    const content = head.children[1]!.children[0]!
    expect(isContent(content)).toBe(true)
    expectHasAll(content, ['text-small', 'text-muted-foreground', 'pb-3'])
    expect(textOf(content)).toBe('Tutto quello che Homun può usare')
  })

  it('il nome della testata viene dal guscio (lo legge la sonda): headName="pannello" dentro PageShell; da sola è «pagina»', async () => {
    const { PageShell, PageHeader } = await pieces()
    const alone = await renderHeader({ title: 'Plugin' })
    expect(first(alone, isColHead).attrs['data-col-head']).toBe('pagina')
    const root = parseHtml(renderHtml(createElement(PageShell, {
      width: 'page',
      headName: 'pannello',
      header: createElement(PageHeader, { title: 'Attività', back: { onClick: () => undefined, label: 'Indietro' } }),
      children: 'corpo'
    })))
    const col = first(root, isColHead)
    expect(col.attrs['data-col-head']).toBe('pannello')
    // la testata sta nello slot della testata, a stare sopra tutto il resto
    expect(hasAncestor(col, (n) => n.attrs['data-page-shell'] === 'header')).toBe(true)
    // e dentro il guscio la sua colonna è larga quanto il guscio (page: 880)
    expect(first(col, isContent).attrs.style).toBe('max-width:var(--w-page)')
  })
})

describe('DS2: ColumnHead — la riga in cima a ogni colonna', () => {
  it('alta 52 (h-col-head), fascia di trascinamento (drag-region), ferma (shrink-0), col nome per la sonda; le classi in più sono AGGIUNTE in coda (quelle proprie non si sovrascrivono)', async () => {
    const { ColumnHead } = await pieces()
    const root = parseHtml(renderHtml(createElement(ColumnHead, { name: 'chat', className: 'justify-between' }, 'contenuto')))
    const head = root.children[0]!
    expect(head.tag).toBe('div')
    expect(head.attrs['data-col-head']).toBe('chat')
    expect(classes(head)).toEqual(['drag-region', 'flex', 'h-col-head', 'shrink-0', 'items-center', 'justify-between'])
    expect(textOf(head)).toBe('contenuto')
  })

  it('senza figli e senza classi in più la riga c’è lo stesso (la fascia di trascinamento serve anche vuota)', async () => {
    const { ColumnHead } = await pieces()
    const root = parseHtml(renderHtml(createElement(ColumnHead, { name: 'barra' })))
    expect(root.children).toHaveLength(1)
    expect(root.children[0]!.children).toHaveLength(0)
    expect(classes(root.children[0]!)).toEqual(['drag-region', 'flex', 'h-col-head', 'shrink-0', 'items-center'])
  })
})

describe('DS2: Section — titolo · azione a destra · contenuto, con le distanze dei token', () => {
  const renderSection = async (props: Record<string, unknown>): Promise<HtmlNode> => {
    const { Section } = await pieces()
    return parseHtml(renderHtml(createElement(Section, props as never)))
  }

  it('di default: titolo text-caption grigio a 500, l’azione a destra, il contenuto sotto a 12 px (gap-section-head)', async () => {
    const root = await renderSection({
      title: 'Collegati',
      action: createElement('button', { 'data-testid': 'azione' }, 'Collega'),
      children: createElement('p', null, 'contenuto'),
      testId: 'sezione'
    })
    const section = byTestid(root, 'sezione')
    expect(section.tag).toBe('section')
    expectHasAll(section, ['flex', 'flex-col', 'gap-section-head'])
    expect(section.children).toHaveLength(2)
    const [head, body] = section.children as [HtmlNode, HtmlNode]
    // la riga di testa: titolo, poi l'azione spinta a destra
    expect(head.children.map((c) => c.tag)).toEqual(['h2', 'div'])
    expectHasAll(head.children[0]!, ['text-caption', 'font-medium', 'text-muted-foreground'])
    expect(textOf(head.children[0]!)).toBe('Collegati')
    expect(has(head.children[0]!, 'text-foreground')).toBe(false)
    const action = byTestid(root, 'azione').parent!
    expect(action).toBe(head.children[1])
    expectHasAll(action, ['ml-auto', 'flex', 'shrink-0', 'items-center', 'gap-2'])
    // il contenuto
    expect(textOf(body)).toBe('contenuto')
  })

  it('tre misure del titolo: caption e body grigie a 500; title in primo piano a 600 (e non in font-display: quello è solo del titolo di pagina)', async () => {
    const { Section } = await pieces()
    const titleOf = async (size: 'caption' | 'body' | 'title'): Promise<HtmlNode> => {
      const root = parseHtml(renderHtml(createElement(Section, { title: 'Uso e costi', size, children: 'corpo' })))
      return first(root, (n) => n.tag === 'h2')
    }
    for (const size of ['caption', 'body'] as const) {
      const h = await titleOf(size)
      expectHasAll(h, [`text-${size}`, 'font-medium', 'text-muted-foreground'])
      expect(has(h, 'text-foreground')).toBe(false)
    }
    const big = await titleOf('title')
    expectHasAll(big, ['text-title', 'font-semibold', 'text-foreground'])
    expect(has(big, 'text-muted-foreground')).toBe(false)
    expect(has(big, 'font-display')).toBe(false)
  })

  it('i blocchi dentro la sezione stanno a 16 px (gap-block); la sezione NON ha margini suoi: la distanza fra sezioni la decide chi le elenca (gap-section)', async () => {
    const root = await renderSection({
      title: 'Strumenti',
      children: [createElement('div', { key: 'a' }, 'uno'), createElement('div', { key: 'b' }, 'due')]
    })
    const section = root.children[0]!
    // sulla radice solo il ritmo interno: nessun margine, nessun padding
    expect(classes(section)).toEqual(['flex', 'flex-col', 'gap-section-head'])
    const body = section.children[1]!
    expect(classes(body)).toEqual(['flex', 'flex-col', 'gap-block'])
    expect(body.children.map(textOf)).toEqual(['uno', 'due'])
  })

  it('senza titolo e senza azione non c’è la riga di testa: solo il contenuto; className e testId vanno sulla radice', async () => {
    const root = await renderSection({ children: 'solo contenuto', className: 'rounded-surface bg-card p-4', testId: 'sezione' })
    const section = byTestid(root, 'sezione')
    expect(section.children).toHaveLength(1)
    expect(textOf(section)).toBe('solo contenuto')
    expectHasAll(section, ['rounded-surface', 'bg-card', 'p-4', 'gap-section-head'])
  })
})

describe('DS2: il CSS compilato (il CSS vero di styles.css, compilato da Tailwind)', () => {
  it('il margine dipende dall’AREA: @container dichiara il contenitore e @max-[900px]: compila in una container query «width < 900px», DOPO la regola larga', async () => {
    const css = squashed(await compileRenderer(['@container', 'px-page-margin', '@max-[900px]:px-page-margin-narrow']))
    expect(css).toContain('.\\@container { container-type: inline-size; }')
    expect(css).toContain('.px-page-margin { padding-inline: var(--spacing-page-margin); }')
    // la sintassi ESATTA della variante: un blocco @container con la condizione in forma di intervallo
    expect(css).toContain('@container (width < 900px) { .\\@max-\\[900px\\]\\:px-page-margin-narrow { padding-inline: var(--spacing-page-margin-narrow); } }')
    // stessa specificità: vince la regola che viene dopo, e deve essere quella stretta
    expect(css.indexOf('@container (width < 900px)')).toBeGreaterThan(css.indexOf('.px-page-margin {'))
    // i valori: 32, e 24 sotto i 900 px
    expect(css).toContain('--spacing-page-margin: 32px;')
    expect(css).toContain('--spacing-page-margin-narrow: 24px;')
  })

  it('le tre larghezze escono SEMPRE nel CSS: la colonna le legge con var(…) in uno stile in linea, senza chiedere nessuna utility', async () => {
    const css = await compileRenderer([])
    for (const [name, px] of [['reading', 720], ['page', 880], ['wide', 1120]]) expect(css).toContain(`--w-${name}: ${px}px;`)
  })

  it('le misure dei pezzi, compilate: la riga in cima 52 (col-head), indietro 32 (control-sm), la barra degli strumenti 40 (min-h-10), dal titolo di sezione al contenuto 12, fra blocchi 16, fra sezioni 32', async () => {
    const css = await compileRenderer(['h-col-head', 'size-control-sm', 'min-h-10', 'gap-section-head', 'gap-block', 'gap-section'])
    const rule = (cls: string, decl: string): void => expect(css).toMatch(new RegExp(`\\.${cls}\\s*\\{[^}]*${decl}`))
    rule('h-col-head', 'height:\\s*var\\(--spacing-col-head\\)')
    rule('size-control-sm', 'width:\\s*var\\(--spacing-control-sm\\)[^}]*height:\\s*var\\(--spacing-control-sm\\)')
    // min-h-10: 10 × la scala di Tailwind (4 px) = 40
    rule('min-h-10', 'min-height:\\s*calc\\(var\\(--spacing\\) \\* 10\\)')
    rule('gap-section-head', 'gap:\\s*var\\(--spacing-section-head\\)')
    rule('gap-block', 'gap:\\s*var\\(--spacing-block\\)')
    rule('gap-section', 'gap:\\s*var\\(--spacing-section\\)')
    for (const [name, px] of [['col-head', 52], ['control-sm', 32], ['section-head', 12], ['block', 16], ['section', 32]]) {
      expect(css).toContain(`--spacing-${name}: ${px}px;`)
    }
    // drag-region e no-drag sono le due fasce (stanno in styles.css, fuori dalle utility)
    expect(css).toMatch(/\.drag-region\s*\{[^}]*-webkit-app-region:\s*drag/)
    expect(css).toMatch(/\.no-drag\s*\{[^}]*-webkit-app-region:\s*no-drag/)
  })

  it('ogni classe scritta nei quattro pezzi genera la sua regola: una classe sbagliata tace, e non si vede finché non si guarda la pagina', async () => {
    const tokens = new Set<string>()
    for (const file of ['column-head', 'page-shell', 'page-header', 'section']) {
      const source = readFileSync(new URL(`../components/ui/${file}.tsx`, import.meta.url), 'utf8')
      // le liste di classi lette dall'AST (la stessa lettura della guardia): i commenti non contano
      for (const value of stringsOf(source)) {
        if (!isClassList(value)) continue
        for (const token of value.split(/\s+/)) if (token !== '') tokens.add(token)
      }
    }
    expect(tokens.size).toBeGreaterThan(40)
    const css = await compileRenderer([...tokens])
    // ogni regola apre su una riga sua col selettore in cima, e ogni segno è
    // scappato ([&>svg]:size-5 → \[\&\>svg\]\:size-5)
    const escaped = (token: string): string => token.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
    const righe = css.split('\n').map((l) => l.trim())
    const silent = [...tokens].filter((token) => {
      const inizio = `.${escaped(token)}`
      // dopo il nome non deve seguire una lettera o un trattino: sarebbe un nome più lungo (h-control non prova h-control-sm)
      return !righe.some((l) => l.startsWith(inizio) && !/[\w-]/.test(l.charAt(inizio.length)))
    })
    expect(silent, 'classi che non producono nessuna regola').toEqual([])
  })
})
