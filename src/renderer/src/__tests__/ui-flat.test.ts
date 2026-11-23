// PP4 (fase plugin-pulita): i due pezzi riusabili di components/ui che la
// pagina Plugin e la sua scheda usano per smettere di essere «un muro» — e
// che la 0.3.2 userà nel resto dell'app. FlatList / FlatRow: righe A FILO,
// nessun fondo, un filetto tra l'una e l'altra, respiro verticale (~12px),
// hover tenue SOLO sulle righe cliccabili; slot leading · title · subtitle ·
// trailing. UnderlineTabs: schede come testo, l'attiva in primo piano con la
// sottolineatura di 2px, niente pillola nera; tastiera con le frecce e i ruoli
// tablist / tab / aria-selected. Solo token di Tailwind già usati
// (border, muted, muted-foreground, foreground): chiaro e scuro.
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

const { FlatList, FlatRow } = await import('../components/ui/flat-list')
const { UnderlineTabs } = await import('../components/ui/underline-tabs')

const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)
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
    expect(has(row, 'py-3')).toBe(true)
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
