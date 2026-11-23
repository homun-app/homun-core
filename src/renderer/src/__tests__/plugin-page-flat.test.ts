// PP4 (fase plugin-pulita): la lista della pagina Plugin — meno muro. Un solo
// segnale di stato per riga: quando tutto va nessuna parola (niente «attivo»
// verde) e l'interruttore senza etichetta accanto; quando qualcosa non va la
// parola con la sua azione (Vedi perché · Ricollega · Completa · Riaccendi),
// al posto dell'interruttore se l'azione è quella giusta; spento
// dall'utente: «spento» e l'interruttore spento. «Tutti i bot» sparisce dalla
// riga: i bot si nominano solo quando l'accesso è ristretto («Solo X»). La
// riga grigia resta una sola. Le righe sono a filo (FlatRow), il logo da 32px,
// i segmenti in testa sono UnderlineTabs, «Aggiungi» resta l'unico pieno,
// i titoli di sezione 13px grigi e lo spazio tra le sezioni più largo.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { stubApiMethod } from './render-helper-install'
import type { McpServerInfo } from '../../../shared/types'
import type { YourPluginRow } from '../lib/plugins-view'

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
vi.mock('../components/ui/dialog', () => ({}) as never)

const PANEL_SRC = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
const APPS_SRC = readFileSync(fileURLToPath(new URL('../components/AppsWindow.tsx', import.meta.url)), 'utf8')

const { PluginPanel, YourRow } = await import('../components/PluginPanel')
const { useStore } = await import('../store')

const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)
const byId = (root: HtmlNode, id: string) => findAll(root, (n) => n.attrs['data-testid'] === id)
const el = (id: string) => capture.els.find((e) => e.props['data-testid'] === id)

/** Una riga di «I tuoi» fatta a mano, con lo stato e i bot voluti. */
const row = (state: YourPluginRow['state'], bots: YourPluginRow['bots'] = { all: true, names: [], extra: 0 }, over: Partial<YourPluginRow> = {}): YourPluginRow => ({
  key: `server:srv-${state}`, kind: 'server', name: `plugin-${state}`, logo: null,
  gray: { type: 'server', strada: 'mac' }, state, verified: false, bots,
  open: { kind: 'server', serverId: `srv-${state}` }, ...over
})
const renderRow = (r: YourPluginRow, onOpen = vi.fn(), onToggleActive = vi.fn()): { root: HtmlNode; onOpen: typeof onOpen; onToggleActive: typeof onToggleActive } => {
  capture.els.length = 0
  const root = parseHtml(renderHtml(createElement(YourRow, { row: r, lang: 'it', onOpen, onToggleActive } as never)))
  return { root, onOpen, onToggleActive }
}
const rowOf = (root: HtmlNode, r: YourPluginRow) => byId(root, `plugin-row-${r.key}`)[0]!

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
  stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
  stubApiMethod('skillsCatalog', () => [])
  stubApiMethod('pluginsUsage', () => [])
  stubApiMethod('mcpList', () => [])
  stubApiMethod('getPermissions', () => ({ default: 'needs_approval', rules: [] }))
  stubApiMethod('mcpSave', () => [])
  setStoreStateForRender(useStore, {
    pluginOpen: true, pluginAt: null,
    connectors: [], composio: null, composioGateway: null,
    agents: [
      { id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 },
      { id: 'a-2', name: 'Ricerche', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
    ]
  })
})

describe('PP4: la riga — un solo segnale di stato', () => {
  it('quando tutto va: nessuna parola di stato, l\'interruttore senza etichetta accanto (l\'aria-label sì), e niente «Tutti i bot»', () => {
    const { root } = renderRow(row('active'))
    // (la piastrella di ripiego porta l'iniziale del nome: la P di «plugin-active»)
    const text = textOf(rowOf(root, row('active')))
    expect(text).toBe('Pplugin-activeServer MCP · sul Mac')
    const toggle = el('plugin-active-server:srv-active')!
    expect(toggle).toBeTruthy()
    expect(toggle.props['aria-label']).toBe('Attivo')
    expect(toggle.props['aria-checked']).toBe(true)
    expect(byId(root, 'plugin-state-server:srv-active')).toHaveLength(0)
  })

  it('la riga grigia resta una sola: «tipo · strada» (con il suo testid)', () => {
    const { root } = renderRow(row('active'))
    const gray = byId(root, 'plugin-gray-server:srv-active')[0]
    expect(gray).toBeTruthy()
    expect(textOf(gray!)).toBe('Server MCP · sul Mac')
  })

  it('non parte: la parola in rosso con «Vedi perché», e l\'interruttore resta (spegnere è un\'altra cosa)', () => {
    const { root, onOpen } = renderRow(row('broken'))
    const state = byId(root, 'plugin-state-server:srv-broken')[0]!
    expect(has(state, 'text-destructive')).toBe(true)
    expect(textOf(state)).toBe('non parteVedi perché')
    expect(el('plugin-active-server:srv-broken')).toBeTruthy()
    ;(el('plugin-action-server:srv-broken')!.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined })
    expect(onOpen).toHaveBeenCalledWith(row('broken'))
  })

  it('spento dall\'utente: «spento» in grigio e l\'interruttore spento', () => {
    const { root } = renderRow(row('off-user'))
    const state = byId(root, 'plugin-state-server:srv-off-user')[0]!
    expect(textOf(state)).toBe('spento')
    expect(has(state, 'text-muted-foreground')).toBe(true)
    expect(has(state, 'text-destructive')).toBe(false)
    expect(el('plugin-active-server:srv-off-user')!.props['aria-checked']).toBe(false)
  })

  it('spento da Homun (non rispondeva): la parola neutra e «Riaccendi» AL POSTO dell\'interruttore — che accende', () => {
    const { root, onToggleActive } = renderRow(row('off-homun'))
    expect(textOf(byId(root, 'plugin-state-server:srv-off-homun')[0]!)).toBe('spento da Homun: non rispondevaRiaccendi')
    expect(byId(root, 'plugin-active-server:srv-off-homun')).toHaveLength(0)
    ;(el('plugin-action-server:srv-off-homun')!.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined })
    expect(onToggleActive).toHaveBeenCalledWith(row('off-homun'), true)
  })

  it('accesso scaduto: «Ricollega» al posto dell\'interruttore, e apre la scheda su «Account e bot»', () => {
    const { root, onOpen } = renderRow(row('expired'))
    expect(textOf(byId(root, 'plugin-state-server:srv-expired')[0]!)).toBe('accesso scadutoRicollega')
    expect(byId(root, 'plugin-active-server:srv-expired')).toHaveLength(0)
    ;(el('plugin-action-server:srv-expired')!.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined })
    expect(onOpen).toHaveBeenCalledWith(row('expired'), 'accounts')
  })

  it('da completare: «Completa» al posto dell\'interruttore, e apre la scheda su «Account e bot»', () => {
    const { root, onOpen } = renderRow(row('setup'))
    expect(textOf(byId(root, 'plugin-state-server:srv-setup')[0]!)).toBe('da completareCompleta')
    expect(byId(root, 'plugin-active-server:srv-setup')).toHaveLength(0)
    ;(el('plugin-action-server:srv-setup')!.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined })
    expect(onOpen).toHaveBeenCalledWith(row('setup'), 'accounts')
  })

  it('i bot si nominano solo quando l\'accesso è ristretto: «Solo Ricerche», «Solo Ricerche +1», «nessun bot»', () => {
    const solo = renderRow(row('active', { all: false, names: ['Ricerche'], extra: 0 }))
    expect(textOf(rowOf(solo.root, row('active', { all: false, names: ['Ricerche'], extra: 0 })))).toBe('Pplugin-activeServer MCP · sul MacSolo Ricerche')
    const piu = renderRow(row('active', { all: false, names: ['Ricerche'], extra: 1 }))
    expect(textOf(rowOf(piu.root, row('active', { all: false, names: ['Ricerche'], extra: 1 })))).toContain('Solo Ricerche +1')
    const nessuno = renderRow(row('active', { all: false, names: [], extra: 0 }))
    expect(textOf(rowOf(nessuno.root, row('active', { all: false, names: [], extra: 0 })))).toContain('nessun bot')
  })
})

describe('PP4: la lista — righe a filo, un solo pieno, segmenti come testo', () => {
  it('la riga è un FlatRow a filo (nessun fondo, nessun riquadro) con il logo da 32px', () => {
    const { root } = renderRow(row('active'))
    const r = rowOf(root, row('active'))
    expect(has(r, 'py-3')).toBe(true)
    // nessun fondo né riquadro: l'unico bg- è l'hover tenue della riga cliccabile
    const tokens = (r.attrs.class ?? '').split(/\s+/)
    expect(tokens.filter((c) => c.startsWith('bg-') || c.startsWith('rounded-'))).toEqual([])
    expect(tokens).toContain('hover:bg-muted/50')
    expect(PANEL_SRC).toMatch(/<FlatRow[\s\S]*?testId=\{`plugin-row-\$\{row\.key\}`\}/)
    // il logo: nel sorgente 32px (size-8), non più 40 (size-10)
    const rowSrc = PANEL_SRC.slice(PANEL_SRC.indexOf('export function YourRow('))
    expect(rowSrc).toContain('size-8 shrink-0 rounded-[9px]')
    expect(rowSrc).not.toContain('size-10 shrink-0 rounded-[11px]')
    expect(rowSrc).toContain('className="size-8 text-sm"')
  })

  it('«I tuoi» è un FlatList: le righe separate da un filetto, senza spazio tra loro', () => {
    const srv: McpServerInfo = { id: 'srv-1', name: 'uno', transport: 'stdio', command: 'node', enabled: true }
    const root = parseHtml(renderHtml(createElement(PluginPanel, { initial: { installed: { servers: [srv, { ...srv, id: 'srv-2', name: 'due' }], plugins: [] } } } as never)))
    const yours = byId(root, 'plugin-yours')[0]!
    expect(findAll(yours, (n) => has(n, 'divide-y')).length).toBeGreaterThanOrEqual(1)
  })

  it('i segmenti in testa sono UnderlineTabs (tablist, tab, aria-selected): la pagina non usa più FilterPill', () => {
    const root = parseHtml(renderHtml(createElement(PluginPanel, {})))
    const segments = byId(root, 'plugin-segments')[0]!
    const list = findAll(segments, (n) => n.attrs.role === 'tablist')[0]!
    expect(list).toBeTruthy()
    const tabs = findAll(list, (n) => n.attrs.role === 'tab')
    expect(tabs.map((x) => textOf(x))).toEqual(['Tutto', 'Connettori', 'Skill', 'Collegati · 0'])
    expect(tabs.map((x) => x.attrs['aria-selected'])).toEqual(['true', 'false', 'false', 'false'])
    expect(PANEL_SRC).not.toMatch(/<FilterPill\b/)
    // niente pillola nera nei segmenti
    for (const x of tabs) expect(x.attrs.class ?? '').not.toContain('bg-foreground')
  })

  it('«Aggiungi» resta l\'UNICO pieno della pagina: nel corpo della lista nessun bg-foreground', () => {
    const root = parseHtml(renderHtml(createElement(PluginPanel, {})))
    const full = findAll(root, (n) => has(n, 'bg-foreground') && !has(n, 'bg-foreground/20'))
    expect(full.map((n) => n.attrs['data-testid'] ?? n.tag)).toEqual(['plugin-add'])
  })

  it('i titoli di sezione sono 13px grigi, non più 15px medium; tra le sezioni 32px', () => {
    const root = parseHtml(renderHtml(createElement(PluginPanel, {})))
    const yours = byId(root, 'plugin-yours')[0]!
    const h2 = findAll(yours, (n) => n.tag === 'h2')[0]!
    expect(has(h2, 'text-[13px]')).toBe(true)
    expect(has(h2, 'text-muted-foreground')).toBe(true)
    expect(has(h2, 'font-medium')).toBe(false)
    expect(has(yours, 'mt-8')).toBe(true)
    expect(PANEL_SRC).not.toMatch(/<h2 className="text-\[15px\] font-medium">/)
  })

  it('anche la riga del catalogo (AppRow) è a filo, col logo da 32, e non dice «Connessa» quando è tutto a posto', async () => {
    const { AppRow } = await import('../components/AppsWindow')
    const base = { app: { id: 'notion', name: 'Notion', logo: null, via: 'direct' as const, directId: 'notion' }, tagline: 'Semplifica il lavoro', connected: 'connected' as const }
    const html = renderHtml(createElement(AppRow, { row: base, flow: null, onConnect: () => undefined, onCancel: () => undefined, onConflictResolve: () => undefined, onOpen: () => undefined } as never))
    const root = parseHtml(html)
    const r = byId(root, 'app-row-notion')[0]!
    expect(has(r, 'py-3')).toBe(true)
    expect(r.attrs.class ?? '').not.toMatch(/rounded-\[/)
    // (la piastrella di ripiego porta l'iniziale: la N di Notion)
    expect(textOf(r)).toBe('NNotionSemplifica il lavoro')
    expect(APPS_SRC.slice(APPS_SRC.indexOf('export function AppRow(')).includes('size-8 text-sm')).toBe(true)
  })
})
