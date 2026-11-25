// PP4 (fase plugin-pulita): la lista della pagina Plugin — meno muro. Un solo
// segnale di stato per riga: quando tutto va nessuna parola (niente «attivo»
// verde) e l'interruttore senza etichetta accanto; quando qualcosa non va la
// parola con la sua azione (Vedi perché · Ricollega · Completa · Riaccendi),
// al posto dell'interruttore se l'azione è quella giusta; spento
// dall'utente: «spento» e l'interruttore spento. «Tutti i bot» sparisce dalla
// riga: i bot si nominano solo quando l'accesso è ristretto («Solo X»). La
// riga grigia resta una sola. Le righe sono a filo (FlatRow), il logo da 32px,
// i segmenti in testa sono UnderlineTabs, «Aggiungi» resta l'unico pieno,
// i titoli di sezione sono grigi e lo spazio tra le sezioni è quello di sistema.
//
// Fase design (DS4): la pagina passa al sistema — in fondo, «la pagina è nel
// guscio di sistema»: PageShell (il corpo che scorre largo quanto l'area) con
// la testata di PageHeader (la riga dei 52), la barra degli strumenti in una
// riga sola, le schede che non vanno mai a capo, il menu «Aggiungi» coi token
// e le icone lucide al posto dei glifi.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, hasAncestor, type HtmlNode } from './render-helper'
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
// C0 (fase linguaggio): AppsWindow è smontato — i pezzi si leggono uniti
const APPS_SRC = ['connect-flows', 'app-row', 'app-logo']
  .map((n) => readFileSync(fileURLToPath(new URL(`../components/plugin/${n}.tsx`, import.meta.url)), 'utf8'))
  .join('\n\n')

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
    expect(textOf(state)).toBe('non parte · Vedi perché')
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
    expect(textOf(byId(root, 'plugin-state-server:srv-off-homun')[0]!)).toBe('spento da Homun: non rispondeva · Riaccendi')
    expect(byId(root, 'plugin-active-server:srv-off-homun')).toHaveLength(0)
    ;(el('plugin-action-server:srv-off-homun')!.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined })
    expect(onToggleActive).toHaveBeenCalledWith(row('off-homun'), true)
  })

  it('accesso scaduto: «Ricollega» al posto dell\'interruttore, e apre la scheda su «Account e bot»', () => {
    const { root, onOpen } = renderRow(row('expired'))
    expect(textOf(byId(root, 'plugin-state-server:srv-expired')[0]!)).toBe('accesso scaduto · Ricollega')
    expect(byId(root, 'plugin-active-server:srv-expired')).toHaveLength(0)
    ;(el('plugin-action-server:srv-expired')!.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined })
    expect(onOpen).toHaveBeenCalledWith(row('expired'), 'accounts')
  })

  it('da completare: «Completa» al posto dell\'interruttore, e apre la scheda su «Account e bot»', () => {
    const { root, onOpen } = renderRow(row('setup'))
    expect(textOf(byId(root, 'plugin-state-server:srv-setup')[0]!)).toBe('da completare · Completa')
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
    // fase design (DS2): il respiro della riga è il token di DS1 (py-row-pad, 12px) — prima era scritto a mano (py-3)
    expect(has(r, 'py-row-pad')).toBe(true)
    // nessun fondo né riquadro: l'unico bg- è l'hover tenue della riga cliccabile
    const tokens = (r.attrs.class ?? '').split(/\s+/)
    expect(tokens.filter((c) => c.startsWith('bg-') || c.startsWith('rounded-'))).toEqual([])
    expect(tokens).toContain('hover:bg-muted/50')
    expect(PANEL_SRC).toMatch(/<FlatRow[\s\S]*?testId=\{`plugin-row-\$\{row\.key\}`\}/)
    // il logo: 32px (size-8), nella casa da 32 di FlatRow. Fase design (DS4):
    // il raggio non si scrive più in questa riga (era un rounded-[9px] a
    // mano): sta in lib/app-logos, con quello di ogni altro logo
    expect(has(r.children[0]!, 'size-8')).toBe(true)
    const rowSrc = PANEL_SRC.slice(PANEL_SRC.indexOf('export function YourRow('))
    expect(rowSrc).toContain('<RowLogo row={row} name={shown} className="size-8 text-body" />')
    expect(rowSrc).not.toMatch(/rounded-\[\d+px\]/)
    expect(rowSrc).not.toContain('size-10')
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

  // fase design (DS4): il titolo di sezione è la sezione di sistema (Section):
  // un'etichetta grigia a 500 — text-caption, ché 13 px non è una taglia di DS1
  // — e lo scarto fra le sezioni lo decide la pagina UNA volta (gap-section
  // sulla colonna del contenuto): prima ogni sezione portava il suo mt-8
  it('i titoli di sezione sono etichette grigie a 500 (Section, text-caption), non titoli; le sezioni stanno a 32px per decise una volta sola', () => {
    const root = parseHtml(renderHtml(createElement(PluginPanel, {})))
    const yours = byId(root, 'plugin-yours')[0]!
    expect(yours.tag).toBe('section')
    const h2 = findAll(yours, (n) => n.tag === 'h2')[0]!
    expect(has(h2, 'text-caption')).toBe(true)
    expect(has(h2, 'text-muted-foreground')).toBe(true)
    expect(has(h2, 'font-medium')).toBe(true)
    expect(has(h2, 'font-display')).toBe(false)
    // la sezione non ha margini suoi: lo scarto sta sulla colonna che la contiene
    expect((yours.attrs.class ?? '')).not.toMatch(/(^|\s)-?mt-/)
    const columns = findAll(root, (n) => 'data-page-content' in n.attrs && has(n, 'gap-section'))
    expect(columns).toHaveLength(1)
    expect(columns[0]!.children).toContain(yours)
    expect(PANEL_SRC).not.toMatch(/<h2 className="text-\[15px\] font-medium">/)
  })

  it('anche la riga del catalogo (AppRow) è a filo, col logo da 32, e non dice «Connessa» quando è tutto a posto', async () => {
    const { AppRow } = await import('../components/plugin/app-row')
    const base = { app: { id: 'notion', name: 'Notion', logo: null, via: 'direct' as const, directId: 'notion' }, tagline: 'Semplifica il lavoro', connected: 'connected' as const }
    const html = renderHtml(createElement(AppRow, { row: base, flow: null, onConnect: () => undefined, onCancel: () => undefined, onConflictResolve: () => undefined, onOpen: () => undefined } as never))
    const root = parseHtml(html)
    const r = byId(root, 'app-row-notion')[0]!
    // fase design (DS2): come tutte le FlatRow, il respiro dei token (py-row-pad)
    expect(has(r, 'py-row-pad')).toBe(true)
    expect(r.attrs.class ?? '').not.toMatch(/rounded-\[/)
    // (la piastrella di ripiego porta l'iniziale: la N di Notion)
    expect(textOf(r)).toBe('NNotionSemplifica il lavoro')
    // fase design (DS4): l'iniziale della piastrella è testo di riga (text-body, prima text-sm)
    expect(APPS_SRC.slice(APPS_SRC.indexOf('export function AppRow(')).includes('size-8 text-body')).toBe(true)
  })
})

describe('DS4 (fase design): la pagina è nel guscio di sistema', () => {
  const renderPage = (initial: Record<string, unknown> = {}): HtmlNode => parseHtml(renderHtml(createElement(PluginPanel, { initial } as never)))
  /** Lo slot del guscio (header, description, toolbar, scroll) e la colonna del contenuto che sta dentro. */
  const slot = (root: HtmlNode, name: string): HtmlNode => findAll(root, (n) => n.attrs['data-page-shell'] === name)[0]!

  it('la testata: la riga dei 52 (la fascia di trascinamento, uguale in ogni colonna) con indietro «Torna alla chat», Puzzle a 20, il titolo di pagina e «Aggiungi» — un Button pieno a pillola, alto 32, no-drag', () => {
    const root = renderPage()
    const page = byId(root, 'plugin-page')[0]!
    // la riga dei 52 sta nello slot della testata, DENTRO la pagina: il contratto lo tiene PageShell, qui si guarda che la pagina lo usi
    const heads = findAll(page, (n) => n.attrs['data-col-head'] !== undefined)
    expect(heads).toHaveLength(1)
    expect(hasAncestor(heads[0]!, (n) => n.attrs['data-page-shell'] === 'header')).toBe(true)
    for (const cls of ['h-col-head', 'drag-region']) expect(has(heads[0]!, cls)).toBe(true)
    const back = findAll(heads[0]!, (n) => n.tag === 'button')[0]!
    expect(back.attrs['aria-label']).toBe('Torna alla chat')
    expect(has(back, 'size-control-sm')).toBe(true)
    expect(has(back, 'no-drag')).toBe(true)
    const title = findAll(heads[0]!, (n) => n.tag === 'h1')[0]!
    expect(has(title, 'text-page')).toBe(true)
    expect(has(title, 'font-display')).toBe(true)
    expect(textOf(title)).toBe('Plugin')
    // l'icona di pagina: 20 px (la misura la dà la testata; indietro, accanto, resta a 16)
    const icon = findAll(heads[0]!, (n) => n.tag === 'svg').find((n) => has(n, 'size-5'))
    expect(icon).toBeTruthy()
    expect(icon!.attrs.class).toContain('lucide-puzzle')
    const add = byId(root, 'plugin-add')[0]!
    expect(add.attrs['data-slot']).toBe('button')
    expect(textOf(add)).toBe('Aggiungi')
    for (const cls of ['bg-foreground', 'rounded-full', 'h-control-sm']) expect(has(add, cls)).toBe(true)
    // l'azione principale è UNA: nel corpo non c'è altro pieno
    expect(findAll(page, (n) => has(n, 'bg-foreground') && !has(n, 'bg-foreground/20')).map((n) => n.attrs['data-testid'])).toEqual(['plugin-add'])
    // la fascia trascina la finestra: l'azione — e il menu che ne scende — sono no-drag
    expect(hasAncestor(add, (n) => has(n, 'no-drag'))).toBe(true)
    expect(hasAncestor(byId(root, 'plugin-add-menu')[0]!, (n) => has(n, 'no-drag'))).toBe(true)
  })

  it('il menu «Aggiungi», scritto a mano, coi token: raggio delle superfici, p-1, voci text-body, le seconde righe text-small grigie, i filetti', () => {
    const root = renderPage()
    const menu = byId(root, 'plugin-add-menu')[0]!
    for (const cls of ['rounded-surface', 'p-1', 'bg-card']) expect(has(menu, cls)).toBe(true)
    const items = findAll(menu, (n) => n.tag === 'button')
    expect(items.length).toBe(6)
    for (const item of items) {
      expect(has(item, 'text-body')).toBe(true)
      expect(has(item, 'rounded-control')).toBe(true)
    }
    const text = textOf(menu)
    for (const voce of ['Importa da altre app', 'Server MCP personalizzato', 'Importa skill', 'Crea una skill', 'Crea con il bot', 'Aggiungi un marketplace']) expect(text).toContain(voce)
    // le due voci con la seconda riga: grigia, text-small
    const second = findAll(menu, (n) => has(n, 'text-small'))
    expect(second.map((n) => textOf(n))).toEqual(['Cursor, Codex, ZCode…', 'Cursor, Codex, ZCode, Claude Code…'])
    for (const s of second) expect(has(s, 'text-muted-foreground')).toBe(true)
    // i due filetti fra i tre gruppi
    expect(findAll(menu, (n) => has(n, 'h-px')).length).toBe(2)
  })

  it('la descrizione sta sotto la riga dei 52, alla larghezza del contenuto: text-small grigio (non più una riga della barra)', () => {
    const root = renderPage()
    const desc = slot(root, 'description')
    expect(desc).toBeTruthy()
    const content = desc.children[0]!.children[0]!
    for (const cls of ['text-small', 'text-muted-foreground']) expect(has(content, cls)).toBe(true)
    expect(textOf(content)).toMatch(/^Connettori, server MCP e skill/)
    // e non sta nella riga dei 52
    expect(hasAncestor(content, (n) => n.attrs['data-col-head'] !== undefined)).toBe(false)
  })

  it('la barra degli strumenti è UNA riga alta 40 con i segmenti e la ricerca: il campo è un campo (36, raggio dei controlli), non una pillola', () => {
    const root = renderPage()
    const toolbar = slot(root, 'toolbar')
    const column = toolbar.children[0]!.children[0]!
    expect(column.children).toHaveLength(1)
    const row = column.children[0]!
    for (const cls of ['flex', 'min-h-10', 'items-center']) expect(has(row, cls)).toBe(true)
    expect(byId(row, 'plugin-segments')).toHaveLength(1)
    const search = byId(row, 'plugin-search')[0]!
    expect(search.attrs.placeholder).toBe('Cerca tra plugin e skill')
    for (const cls of ['h-control', 'rounded-control']) expect(has(search.parent!, cls)).toBe(true)
    expect(has(search.parent!, 'rounded-full')).toBe(false)
    expect(has(search, 'text-body')).toBe(true)
  })

  it('le schede non vanno mai a capo: nessuna delle schede della pagina chiede flex-wrap, e le tablist rese sono flex-nowrap', () => {
    const calls = PANEL_SRC.match(/<UnderlineTabs[\s\S]*?\/>/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(4)
    for (const call of calls) expect(call).not.toContain('flex-wrap')
    const root = renderPage({ seg: 'skills' })
    const lists = findAll(root, (n) => n.attrs.role === 'tablist')
    expect(lists.length).toBeGreaterThanOrEqual(2)
    for (const list of lists) {
      expect(has(list, 'flex-nowrap')).toBe(true)
      expect((list.attrs.class ?? '')).not.toContain('flex-wrap')
    }
  })

  it('nessun glifo al posto di un\'icona: la voce del catalogo e il filtro per bot portano icone lucide da 16 (prima ✦ e ✕ nel testo)', async () => {
    const { useStore } = await import('../store')
    setStoreStateForRender(useStore, { skillsFilterAgent: 'a-1' })
    const skillCatalog = [
      { id: 'riassunti', source: { repo: 'anthropics/skills', commit: 'a'.repeat(40), path: '' }, license: 'MIT', category: 'writing', description: { it: 'Riassume', en: 'Summarizes' }, files: { exclude: [] }, reviewed: true }
    ]
    const root = renderPage({ seg: 'skills', skillCatalog })
    const segment = byId(root, 'plugin-skills')[0]!
    // il filtro per bot: una pillola col nome e la X di lucide
    const filter = findAll(segment, (n) => n.tag === 'button' && textOf(n) === 'Competitoor')[0]!
    expect(filter).toBeTruthy()
    expect(has(filter.children[0]!, 'size-4')).toBe(true)
    expect(filter.children[0]!.attrs.class).toContain('lucide-x')
    // la voce del catalogo: la piastrella da 32 con l'icona
    const entry = findAll(byId(root, 'plugin-skills-catalog')[0]!, (n) => textOf(n) === 'Riassunti')[0]!
    expect(entry).toBeTruthy()
    const tile = findAll(entry.parent!.parent!, (n) => has(n, 'rounded-control') && has(n, 'size-8'))[0]!
    expect(tile).toBeTruthy()
    expect(has(tile.children[0]!, 'size-4')).toBe(true)
    expect(tile.children[0]!.attrs.class).toContain('lucide-sparkles')
    // nel codice della pagina non restano i due glifi (i commenti li citano: raccontano cosa c'era)
    expect(PANEL_SRC.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')).not.toMatch(/[✦✕]/)
  })

  it('il logo di ripiego è l\'iniziale: niente emoji al posto di un logo (DS1: nell\'interfaccia solo icone)', async () => {
    const { AppLogo } = await import('../components/plugin/app-logo')
    const html = renderHtml(createElement(AppLogo, { logo: '🧩', name: 'Zed' }))
    expect(textOf(parseHtml(html))).toBe('Z')
    expect(html).not.toContain('🧩')
    // e il raggio del logo non è scritto nel pezzo: viene da lib/app-logos
    expect(APPS_SRC).toContain('${LOGO_CLASS} ${className}')
    expect(APPS_SRC).toContain('${LOGO_TILE_CLASS} ${className}')
  })
})

describe('DS4 (fase design): gli account di un\'app Composio sono righe a filo, come il resto della scheda', () => {
  it('un account per riga — l\'alias, l\'email in grigio, «Da ricollegare» per chi non è attivo — con «Rinomina» e «Togli» come testo; sotto, la riga che aggiunge un account', async () => {
    const { GatewayAccountsSection } = await import('../components/plugin/gateway-accounts')
    const app = {
      slug: 'gmail', name: 'Gmail', status: 'ACTIVE', accountId: 'a1',
      accounts: [
        { accountId: 'a1', alias: 'fabio', email: 'fabio@studio.example', status: 'ACTIVE' },
        { accountId: 'a2', alias: 'lavoro', status: 'RECONNECT' }
      ]
    } as never
    const root = parseHtml(renderHtml(createElement(GatewayAccountsSection, { app, appName: 'Gmail', onChanged: () => undefined } as never)))
    const section = byId(root, 'app-accounts')[0]!
    // a filo: un elenco (filetti), niente riquadri tenui intorno agli account
    expect(findAll(section, (n) => has(n, 'divide-y'))).toHaveLength(1)
    expect(findAll(section, (n) => has(n, 'bg-muted/60'))).toHaveLength(0)
    const first = byId(root, 'app-account-a1')[0]!.children[0]!
    // riga di solo testo (40): con alias ed email è più alta, ma il minimo è quello di sistema
    expect(has(first, 'min-h-row-text')).toBe(true)
    expect(has(first, 'py-row-pad')).toBe(true)
    expect(textOf(first)).toContain('fabio@studio.example')
    expect(textOf(first)).not.toContain('Da ricollegare')
    expect(textOf(byId(root, 'app-account-a2')[0]!.children[0]!)).toContain('Da ricollegare')
    // le azioni della riga sono testo: Button ghost, nessun pieno nella sezione
    const actions = findAll(first, (n) => n.tag === 'button')
    expect(actions.map((a) => textOf(a))).toEqual(['Rinomina', 'Togli'])
    for (const a of actions) {
      expect(a.attrs['data-slot']).toBe('button')
      expect(has(a, 'bg-foreground')).toBe(false)
    }
    expect(has(actions[1]!, 'text-destructive')).toBe(true)
    // la riga che aggiunge: un bottone alto 40 (riga di solo testo), con l'icona al posto del «+» scritto nel testo
    const add = byId(root, 'app-add-account')[0]!
    expect(add.tag).toBe('button')
    expect(has(add, 'min-h-row-text')).toBe(true)
    expect(textOf(add)).toBe('Aggiungi un altro account')
    expect(add.children[0]!.children[0]!.attrs.class).toContain('lucide-plus')
    expect(has(add.children[0]!.children[0]!, 'size-4')).toBe(true)
  })
})
