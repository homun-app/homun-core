// PP4 (fase plugin-pulita): i due pezzi riusabili di components/ui che la
// pagina Plugin e la sua scheda usano per smettere di essere «un muro» — e
// che la 0.3.2 userà nel resto dell'app. FlatList / FlatRow: righe A FILO,
// nessun fondo, un filetto tra l'una e l'altra, respiro verticale (~12px),
// hover tenue SOLO sulle righe cliccabili; slot leading · title · subtitle ·
// trailing. UnderlineTabs: schede come testo, l'attiva in primo piano con la
// sottolineatura di 2px, niente pillola nera; tastiera con le frecce e i ruoli
// tablist / tab / aria-selected. Solo token di Tailwind già usati
// (border, muted, muted-foreground, foreground): chiaro e scuro.
//
// Fase design (DS2): gli stessi due pezzi ai TOKEN di DS1 (niente più misure
// scritte a mano: py-row-pad, gap-row-gap, min-h-row / min-h-row-text,
// text-body / text-small) e le schede su UNA RIGA SOLA: se non ci stanno
// scorrono in orizzontale, senza barra, con una sfumatura ai lati che dice
// che c'è altro. Quale lato si vede lo decide tabEdges, PURA (si prova senza
// DOM); l'anello del fuoco e il gradiente si controllano nel CSS compilato
// (tailwind-compile: che una utility esista lo dice solo l'output).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { compileRenderer } from './tailwind-compile'

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

const { FlatList, FlatRow } = await import('../components/ui/flat-list')
const { UnderlineTabs, tabEdges, tabReveal, tabVeil } = await import('../components/ui/underline-tabs')

const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)
/** Le classi di un nodo, come token (senza l'ordine: in una lista di classi non significa nulla). */
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter(Boolean).sort()
/** Nel CSS compilato, le dichiarazioni { … } della regola il cui selettore inizia con `selector`. */
const ruleOf = (css: string, selector: string): string => {
  const at = css.indexOf(selector)
  expect(at, `la regola «${selector}» nel CSS compilato`).toBeGreaterThan(-1)
  return css.slice(css.indexOf('{', at), css.indexOf('}', at))
}
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!

beforeEach(() => { capture.els.length = 0 })

describe('PP4: FlatList / FlatRow — righe a filo', () => {
  it('la lista: un filetto tra le righe (divide-y divide-border/50), nessun fondo, il testid e le classi sue', () => {
    const root = parseHtml(renderHtml(createElement(FlatList, {
      testId: 'lista', className: 'mt-2',
      children: [createElement(FlatRow, { title: 'una' } as never), createElement(FlatRow, { title: 'due' } as never)]
    })))
    const list = first(root, (n) => n.attrs['data-testid'] === 'lista')
    expect(has(list, 'divide-y')).toBe(true)
    expect(has(list, 'divide-border/50')).toBe(true)
    expect(has(list, 'mt-2')).toBe(true)
    expect((list.attrs.class ?? '')).not.toMatch(/\bbg-/)
    expect(list.children).toHaveLength(2)
    expect(list.children.map((c) => textOf(c))).toEqual(['una', 'due'])
  })

  it('la riga: leading · title · subtitle · trailing nei loro slot, respiro verticale di 12px, niente fondo', () => {
    const root = parseHtml(renderHtml(createElement(FlatRow, {
      leading: createElement('img', { src: 'x.svg', alt: '' }),
      title: 'Notion',
      subtitle: 'Connettore · MCP diretto di Notion',
      trailing: createElement('span', { 'data-testid': 'coda' }, 'azione')
    })))
    // (React antepone un <link rel="preload"> all'immagine: la riga è il div)
    const row = first(root, (n) => n.tag === 'div')
    // il respiro verticale è quello della riga di DS1 (py-row-pad = 12)
    expect(has(row, 'py-row-pad')).toBe(true)
    expect(has(row, 'flex')).toBe(true)
    expect(has(row, 'items-center')).toBe(true)
    expect((row.attrs.class ?? '')).not.toMatch(/\bbg-|rounded/)
    // i slot nell'ordine: il leading, poi nome e riga grigia (che troncano), poi la coda
    expect(row.children.map((c) => c.tag)).toEqual(['span', 'span', 'span'])
    expect(row.children[0]!.children[0]!.tag).toBe('img')
    const body = row.children[1]!
    expect(textOf(body.children[0]!)).toBe('Notion')
    expect(textOf(body.children[1]!)).toBe('Connettore · MCP diretto di Notion')
    for (const line of body.children) expect(has(line, 'truncate')).toBe(true)
    expect(has(body.children[1]!, 'text-muted-foreground')).toBe(true)
    expect(first(root, (n) => n.attrs['data-testid'] === 'coda')).toBeTruthy()
  })

  it('senza subtitle e senza leading non si creano nodi vuoti; la riga sola non è cliccabile (né hover, né ruolo)', () => {
    const root = parseHtml(renderHtml(createElement(FlatRow, { title: 'sola' })))
    const row = first(root, (n) => n.tag === 'div')
    expect(row.children).toHaveLength(1)
    expect(row.attrs.role).toBeUndefined()
    expect(row.attrs.tabindex).toBeUndefined()
    expect((row.attrs.class ?? '')).not.toMatch(/hover:|cursor-pointer/)
  })

  it('la riga cliccabile: ruolo bottone, focusabile, hover tenue, il clic e Invio/spazio chiamano onClick', () => {
    const onClick = vi.fn()
    const root = parseHtml(renderHtml(createElement(FlatRow, { title: 'clic', subtitle: 'sotto', clickable: true, onClick, testId: 'riga' })))
    const row = first(root, (n) => n.attrs['data-testid'] === 'riga')
    expect(row.attrs.role).toBe('button')
    expect(row.attrs.tabindex).toBe('0')
    expect(has(row, 'cursor-pointer')).toBe(true)
    expect(has(row, 'hover:bg-muted/50')).toBe(true)
    const captured = capture.els.find((e) => e.props['data-testid'] === 'riga')!
    ;(captured.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined })
    // Invio e spazio: il clic — e lo spazio non fa scorrere la pagina (preventDefault)
    const preventDefault = vi.fn()
    for (const key of ['Enter', ' ', 'a']) (captured.props.onKeyDown as (e: unknown) => void)({ key, preventDefault })
    // il clic, Invio e spazio: tre; «a» non fa nulla
    expect(onClick).toHaveBeenCalledTimes(3)
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })
})

describe('PP4: UnderlineTabs — schede come testo', () => {
  const TABS: Array<[string, ReactNode]> = [['overview', 'Panoramica'], ['permissions', 'Autorizzazioni'], ['accounts', 'Account e bot']]
  const render = (value: string, onChange: (id: string) => void): HtmlNode => parseHtml(renderHtml(createElement(UnderlineTabs, { tabs: TABS, value, onChange, testId: 'schede' } as never)))
  const tabsOf = (root: HtmlNode): HtmlNode[] => findAll(root, (n) => n.attrs.role === 'tab')

  it('un tablist di tab: l\'attiva ha aria-selected, primo piano e la sottolineatura di 2px; le altre sono grigie; nessuna pillola nera', () => {
    const root = render('permissions', () => undefined)
    const list = first(root, (n) => n.attrs.role === 'tablist')
    expect(list.attrs['data-testid']).toBe('schede')
    const tabs = tabsOf(root)
    expect(tabs.map((t) => textOf(t))).toEqual(['Panoramica', 'Autorizzazioni', 'Account e bot'])
    expect(tabs.map((t) => t.attrs['aria-selected'])).toEqual(['false', 'true', 'false'])
    expect(has(tabs[1]!, 'border-b-2')).toBe(true)
    expect(has(tabs[1]!, 'border-foreground')).toBe(true)
    expect(has(tabs[1]!, 'text-foreground')).toBe(true)
    for (const other of [tabs[0]!, tabs[2]!]) {
      expect(has(other, 'text-muted-foreground')).toBe(true)
      expect(has(other, 'border-transparent')).toBe(true)
    }
    for (const t of tabs) expect(t.attrs.class ?? '').not.toMatch(/bg-foreground|rounded-full/)
    // tabindex a scacchi: solo l'attiva entra nel giro di Tab
    expect(tabs.map((t) => t.attrs.tabindex)).toEqual(['-1', '0', '-1'])
  })

  it("il clic su una scheda la sceglie", () => {
    const onChange = vi.fn()
    render('overview', onChange)
    const third = capture.els.filter((e) => e.props.role === 'tab')[2]!
    ;(third.props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('accounts')
  })

  it('freccia destra: dalla prima all\'ultima e poi da capo; freccia sinistra: indietro e poi da capo; il fuoco segue la scheda scelta', () => {
    const onChange = vi.fn()
    render('permissions', onChange)
    const buttons = [{ focus: vi.fn() }, { focus: vi.fn() }, { focus: vi.fn() }]
    const key = (i: number, k: string): void => {
      const tab = capture.els.filter((e) => e.props.role === 'tab')[i]!
      ;(tab.props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault: vi.fn(), currentTarget: { parentElement: { querySelectorAll: () => buttons } } })
    }
    key(1, 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('accounts')
    expect(buttons[2]!.focus).toHaveBeenCalledTimes(1)
    key(2, 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('overview')
    expect(buttons[0]!.focus).toHaveBeenCalledTimes(1)
    key(0, 'ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('accounts')
    key(1, 'ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('overview')
    expect(onChange).toHaveBeenCalledTimes(4)
    // un altro tasto non fa nulla
    key(1, 'a')
    expect(onChange).toHaveBeenCalledTimes(4)
  })
})

describe('DS2: FlatRow ai token di DS1 (fase design)', () => {
  const rowOf = (props: Record<string, unknown>): HtmlNode => first(parseHtml(renderHtml(createElement(FlatRow, props as never))), (n) => n.tag === 'div')

  it('il respiro è quello della riga (py-row-pad: 12) e fra icona e testo la distanza dei token (gap-row-gap: 12): niente più misure scritte a mano', () => {
    const row = rowOf({ title: 'sola' })
    for (const cls of ['flex', 'w-full', 'items-center', 'gap-row-gap', 'py-row-pad']) expect(has(row, cls), cls).toBe(true)
    for (const vietato of ['py-3', 'gap-3']) expect(has(row, vietato), vietato).toBe(false)
  })

  it('con il leading (icona o logo) la riga è alta almeno 52 (min-h-row); senza, 40 (min-h-row-text)', () => {
    const con = rowOf({ title: 'a', leading: createElement('img', { src: 'x.svg', alt: '' }) })
    expect(has(con, 'min-h-row')).toBe(true)
    expect(has(con, 'min-h-row-text')).toBe(false)
    // anche con il sottotitolo, senza leading, resta la riga «solo testo»
    const senza = rowOf({ title: 'a', subtitle: 'b' })
    expect(has(senza, 'min-h-row-text')).toBe(true)
    expect(has(senza, 'min-h-row')).toBe(false)
  })

  it('il leading sta nello slot da 32 (grid size-8, centrato): icone da 16 e loghi da 32 hanno la stessa casa, e il testo parte sempre dallo stesso punto', () => {
    const row = rowOf({ title: 'a', leading: createElement('img', { src: 'x.svg', alt: '' }) })
    const slot = row.children[0]!
    for (const cls of ['grid', 'size-8', 'shrink-0', 'place-items-center']) expect(has(slot, cls), cls).toBe(true)
    expect(slot.children.map((c) => c.tag)).toEqual(['img'])
    // senza leading nessun nodo vuoto
    expect(rowOf({ title: 'a' }).children).toHaveLength(1)
  })

  it('titolo text-body in peso medio e sottotitolo text-small grigio, tutti e due troncati; niente text-[…]', () => {
    const row = rowOf({ title: 'Notion', subtitle: 'tramite Composio' })
    const [titolo, sotto] = row.children[0]!.children as [HtmlNode, HtmlNode]
    // la taglia DEVE restare accanto al colore: sul cn di questa base (18d09f22) twMerge scambia text-small
    // per un colore e lo toglierebbe (626750e2 lo corregge). Il test vale con entrambi i cn.
    for (const cls of ['block', 'truncate', 'text-body', 'font-medium']) expect(has(titolo, cls), cls).toBe(true)
    for (const cls of ['mt-0.5', 'block', 'truncate', 'text-small', 'text-muted-foreground']) expect(has(sotto, cls), cls).toBe(true)
    for (const nodo of [titolo, sotto]) expect((nodo.attrs.class ?? '').split(/\s+/).some((c) => /^text-\[/.test(c))).toBe(false)
  })
})

describe('DS2: UnderlineTabs — una riga sola, che scorre (fase design)', () => {
  const TABS: Array<[string, ReactNode]> = [['overview', 'Panoramica'], ['permissions', 'Autorizzazioni'], ['accounts', 'Account e bot']]
  const render = (props: Record<string, unknown> = {}): HtmlNode => parseHtml(renderHtml(createElement(UnderlineTabs, { tabs: TABS, value: 'overview', onChange: () => undefined, testId: 'schede', ...props } as never)))
  const tablist = (root: HtmlNode): HtmlNode => first(root, (n) => n.attrs.role === 'tablist')

  it('la tablist non va mai a capo: flex-nowrap, e se le schede non ci stanno scorre in orizzontale — senza barra visibile', () => {
    const list = tablist(render())
    for (const cls of ['flex-nowrap', 'overflow-x-auto', '[scrollbar-width:none]']) expect(has(list, cls), cls).toBe(true)
    expect(classes(list)).not.toContain('flex-wrap')
    expect(list.attrs['data-testid']).toBe('schede')
  })

  it('le schede non si restringono e non vanno a capo, in text-body; l’anello del fuoco è esplicito e verso l’interno (la riga che scorre ritaglia ciò che sporge)', () => {
    const list = tablist(render())
    for (const tab of list.children) {
      expect(tab.tag).toBe('button')
      for (const cls of ['shrink-0', 'whitespace-nowrap', 'text-body', 'focus-visible:outline-2', 'focus-visible:-outline-offset-2', 'focus-visible:outline-ring']) expect(has(tab, cls), cls).toBe(true)
      // solo da tastiera: mai la variante che scatta anche al clic (la regola di B5)
      expect(classes(tab).some((c) => /^focus:(ring|outline)/.test(c))).toBe(false)
      expect(classes(tab).some((c) => /^text-\[/.test(c))).toBe(false)
    }
  })

  it('il className del chiamante va sull’INVOLUCRO: «flex-wrap» (lo passano ancora due chiamanti della pagina Plugin) non arriva mai alla tablist', () => {
    const root = render({ className: 'flex-wrap mt-2' })
    const list = tablist(root)
    expect(classes(list)).not.toContain('flex-wrap')
    expect(has(list, 'flex-nowrap')).toBe(true)
    // la radice è l'involucro: le classi del chiamante stanno lì, su un contenitore che NON è flex — non possono far andare a capo nulla
    const wrapper = root.children[0]!
    expect(wrapper).toBe(list.parent)
    expect(has(wrapper, 'flex-wrap')).toBe(true)
    expect(has(wrapper, 'mt-2')).toBe(true)
    expect(has(wrapper, 'relative')).toBe(true)
    expect(wrapper.attrs.role).toBeUndefined()
    expect(classes(wrapper)).not.toContain('flex')
  })

  it('il filetto di base è dell’involucro e la tablist lo copre di un pixel (-mb-px): la sottolineatura di 2px resta intera dentro la riga che ritaglia', () => {
    const root = render()
    const wrapper = root.children[0]!
    expect(has(wrapper, 'border-b')).toBe(true)
    expect(has(wrapper, 'border-border/50')).toBe(true)
    const list = tablist(root)
    expect(has(list, '-mb-px')).toBe(true)
    expect(has(list, 'border-b')).toBe(false)
    // le schede non hanno più il margine negativo: il loro bordo sta dentro la tablist, dove niente lo ritaglia
    for (const tab of list.children) expect(has(tab, '-mb-px')).toBe(false)
  })

  it('tabEdges (pura): a riposo nessun velo; all’inizio di una riga che non ci sta solo il destro; in mezzo tutti e due; in fondo solo il sinistro', () => {
    expect(tabEdges({ scrollLeft: 0, scrollWidth: 500, clientWidth: 500 })).toEqual({ left: false, right: false })
    expect(tabEdges({ scrollLeft: 0, scrollWidth: 900, clientWidth: 500 })).toEqual({ left: false, right: true })
    expect(tabEdges({ scrollLeft: 200, scrollWidth: 900, clientWidth: 500 })).toEqual({ left: true, right: true })
    expect(tabEdges({ scrollLeft: 400, scrollWidth: 900, clientWidth: 500 })).toEqual({ left: true, right: false })
    // una riga che non è stata misurata (nascosta) non chiede veli
    expect(tabEdges({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0 })).toEqual({ left: false, right: false })
  })

  it('tabEdges: un pixel di tolleranza — le frazioni di pixel non tengono acceso un velo su una riga già al bordo', () => {
    expect(tabEdges({ scrollLeft: 0.75, scrollWidth: 900, clientWidth: 500 })).toEqual({ left: false, right: true })
    expect(tabEdges({ scrollLeft: 399.25, scrollWidth: 900, clientWidth: 500 })).toEqual({ left: true, right: false })
    // oltre il pixel il velo torna
    expect(tabEdges({ scrollLeft: 1.25, scrollWidth: 900, clientWidth: 500 }).left).toBe(true)
    expect(tabEdges({ scrollLeft: 398.75, scrollWidth: 900, clientWidth: 500 }).right).toBe(true)
  })

  it('i veli (pura la loro composizione): quando servono sono larghi 24, non prendono il clic, nascosti agli aid, e sfumano DAL fondo della pagina al trasparente — ciascuno verso l’interno', () => {
    const destra = tabVeil('right', true)
    expect(destra.hidden).toBe(false)
    expect(destra['aria-hidden']).toBe('true')
    const veliDi = (side: 'left' | 'right'): string[] => tabVeil(side, true).className.split(/\s+/).sort()
    // il velo di destra: dal fondo della pagina (al bordo) al trasparente (verso l’interno)
    expect(veliDi('right')).toEqual(['-bottom-px', 'absolute', 'bg-[linear-gradient(to_left,var(--color-background),transparent)]', 'pointer-events-none', 'right-0', 'top-0', 'w-6'])
    expect(veliDi('left')).toEqual(['-bottom-px', 'absolute', 'bg-[linear-gradient(to_right,var(--color-background),transparent)]', 'left-0', 'pointer-events-none', 'top-0', 'w-6'])
    // quando non servono sono nascosti
    expect(tabVeil('left', false).hidden).toBe(true)
    expect(tabVeil('right', false).hidden).toBe(true)
  })

  it('nel render statico i due veli ci sono già, spenti, ACCANTO alla tablist (dentro scorrerebbero col contenuto): la misura si fa dopo, dal vivo', () => {
    const root = render()
    const wrapper = root.children[0]!
    expect(wrapper.children.map((c) => c.tag)).toEqual(['div', 'span', 'span'])
    const veils = wrapper.children.slice(1)
    for (const v of veils) {
      expect(v.attrs['aria-hidden']).toBe('true')
      expect(v.attrs.hidden).toBe('')
      expect(has(v, 'pointer-events-none')).toBe(true)
      expect(v.children).toHaveLength(0)
    }
    expect(tablist(root).children.every((c) => c.tag === 'button')).toBe(true)
  })

  it('tabReveal (pura): la scheda attiva entra in vista del minimo («nearest») e si ferma FUORI dal velo — quando oltre il bordo c’è ancora roba, il velo c’è e copre 24 px', () => {
    // vista: 500 px di una riga lunga 900 (si scorre fino a 400)
    const vista = { scrollWidth: 900, clientWidth: 500 }
    // già tutta in vista, fuori dai veli: non si muove
    expect(tabReveal({ start: 100, end: 200 }, { ...vista, scrollLeft: 0 })).toBe(0)
    expect(tabReveal({ start: 300, end: 400 }, { ...vista, scrollLeft: 200 })).toBe(200)
    // nascosta a destra, con altre schede oltre: il suo fondo arriva a 24 px dal bordo destro
    expect(tabReveal({ start: 450, end: 560 }, { ...vista, scrollLeft: 0 })).toBe(84)
    // nascosta a destra ma è l’ULTIMA: niente velo a destra, va fino in fondo
    expect(tabReveal({ start: 450, end: 560 }, { scrollWidth: 560, clientWidth: 500, scrollLeft: 0 })).toBe(60)
    // sotto il velo destro senza sapere di esserci: esce dal velo
    expect(tabReveal({ start: 460, end: 499 }, { ...vista, scrollLeft: 0 })).toBe(23)
    // nascosta a sinistra: la sua testa arriva a 24 px dal bordo sinistro (a sinistra il velo c’è, si è scorso)
    expect(tabReveal({ start: 50, end: 150 }, { ...vista, scrollLeft: 300 })).toBe(26)
    // e se 24 px non ci sono, si ferma all’inizio: lì il velo non c’è
    expect(tabReveal({ start: 10, end: 150 }, { ...vista, scrollLeft: 300 })).toBe(0)
    // mai oltre i limiti della riga
    expect(tabReveal({ start: 300, end: 900 }, { ...vista, scrollLeft: 0 })).toBe(400)
    // una riga non misurata non si muove
    expect(tabReveal({ start: 50, end: 150 }, { scrollWidth: 0, clientWidth: 0, scrollLeft: 300 })).toBe(300)
  })

  it('compilate da Tailwind: la riga scorre senza barra (scrollbar-width: none), i veli sfumano dal fondo della pagina, l’anello delle schede sta dentro il bordo e solo da tastiera', async () => {
    const root = render()
    const list = tablist(root)
    // una classe per candidato (compile non divide le liste: lo fa lo scanner del plugin Vite)
    const css = await compileRenderer([...classes(list), ...classes(list.children[0]!), ...tabVeil('left', true).className.split(/\s+/)])
    // nel CSS le parentesi quadre e i due punti del nome sono preceduti da una barra rovesciata
    expect(css).toMatch(/\.\\\[scrollbar-width\\:none\\\]\s*\{\s*scrollbar-width:\s*none;/)
    expect(css).toMatch(/linear-gradient\(to right,var\(--color-background\),transparent\)/)
    // la variabile del tema esce davvero nel CSS: senza, il velo sarebbe invisibile
    expect(css).toMatch(/--color-background:\s*var\(--background\);/)
    // l'anello: dentro il bordo (offset negativo), nel colore dell'app — e SOLO da tastiera: nella variante c'è la negazione del puntatore di B5
    const suTastiera = ":focus-visible:not(:where([data-focus-from='pointer'] :not("
    expect(ruleOf(css, '.focus-visible\\:outline-2' + suTastiera)).toMatch(/outline-style:\s*var\(--tw-outline-style\);/)
    expect(ruleOf(css, '.focus-visible\\:outline-2' + suTastiera)).toMatch(/outline-width:\s*2px;/)
    expect(ruleOf(css, '.focus-visible\\:-outline-offset-2' + suTastiera)).toMatch(/outline-offset:\s*calc\(2px \* -1\);/)
    expect(ruleOf(css, '.focus-visible\\:outline-ring' + suTastiera)).toMatch(/outline-color:\s*var\(--ring\);/)
  })
})

describe('DS4: UnderlineTabs — il testid di ogni scheda (le sonde cercano approvals-tab-<id> e simili)', () => {
  it('con tabTestId ogni scheda porta il suo data-testid; senza, nessuna', () => {
    const render = (tabTestId?: (id: string) => string) => parseHtml(renderHtml(createElement(UnderlineTabs as never, {
      tabs: [['a', 'Alfa'], ['b', 'Beta']] as never, value: 'a', onChange: () => undefined, label: 'Schede', tabTestId
    } as never)))
    const ids = (root: HtmlNode) => findAll(root, (n) => n.attrs.role === 'tab').map((n) => n.attrs['data-testid'])
    expect(ids(render((id) => `scheda-${id}`))).toEqual(['scheda-a', 'scheda-b'])
    expect(ids(render())).toEqual([undefined, undefined])
  })
})
