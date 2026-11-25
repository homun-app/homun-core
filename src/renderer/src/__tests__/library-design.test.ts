// Fase design (DS4): la LIBRERIA, il DOCUMENTO APERTO e le schede in chat nel
// sistema — i test di rendering di COM'È FATTA la pagina (senza DOM:
// react-dom/server, i testi veri in italiano, gli handler VERI catturati dal
// runtime JSX, come library-b4). Là si prova che la pagina FA le cose (menu,
// selezione, dialoghi: i testid, i testi e le RPC non cambiano); qui che le
// regole del sistema le scrive davvero:
//   · il guscio — PageShell: il corpo che scorre è figlio diretto della radice
//     (barra di scorrimento sul bordo dell'area) e DENTRO c'è una colonna
//     sola, centrata alla larghezza giusta (page 880 per la Libreria, reading
//     720 per il documento);
//   · la testata — PageHeader sulla riga dei 52, e la colonna dentro LARGA
//     QUANTO LA TESTATA (DS3: prima la riga interna della testata del
//     documento era larga quanto il suo contenuto, e «Esporta» e il «⋯» non
//     arrivavano al bordo destro); i controlli da 32, no-drag;
//   · la barra degli strumenti, le righe della scheda (DOC_CARD: la stessa in
//     Libreria e in chat), FlatList/FlatRow nella lista;
//   · le icone lucide al posto dei glifi «★ ⚠ ↩».
// Le misure VIVE (le altezze, i bordi, il centramento) le prende la sonda di
// misura sull'app vera: qui stanno le classi che le producono — e, nel CSS
// compilato, che ognuna di quelle classi esista davvero.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, hasAncestor, dialogPassThroughMock, type HtmlNode } from './render-helper'
import { callsOf } from './render-helper-install'
import { compileRenderer, deadClasses, squashed } from './tailwind-compile'
import { stringsOf, isClassList } from './design-scan'
import type { LibraryItemInfo, LibraryContentInfo, Agent, TranscriptEntry } from '../../../shared/types'

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
// le finestre (conferma di Elimina, Rinomina) vivono in un Portal: passanti
vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
// il menu si rende PASSANTE: il suo bottone sta nell'HTML statico
vi.mock('../components/ui/dropdown-menu', () => {
  const pass = (tag: string) => ({ children, ...rest }: { children?: unknown } & Record<string, unknown>) =>
    createElement('div', { 'data-mock': tag, ...rest }, children as never)
  return {
    DropdownMenu: pass('dropdown'),
    DropdownMenuTrigger: pass('dropdown-trigger'),
    DropdownMenuContent: pass('dropdown-content'),
    DropdownMenuItem: pass('dropdown-item'),
    DropdownMenuSeparator: pass('dropdown-sep'),
    DropdownMenuSub: pass('dropdown-sub'),
    DropdownMenuSubTrigger: pass('dropdown-sub-trigger'),
    DropdownMenuSubContent: pass('dropdown-sub-content'),
    DropdownMenuRadioGroup: pass('dropdown-radio-group'),
    DropdownMenuRadioItem: pass('dropdown-radio-item')
  }
})

const { LibraryPanel } = await import('../components/LibraryPanel')
const { PageView } = await import('../components/PageView')
const { DocumentCard, SecureInputCard, ContactCard } = await import('../components/LibraryCards')
const { useStore } = await import('../store')

// ---- i modelli ----
const item = (id: string, over: Partial<LibraryItemInfo> = {}): LibraryItemInfo => ({
  id, kind: 'document', title: id, authorAgentId: 'bot', createdAt: 1, updatedAt: 3,
  pinned: false, tainted: false, currentVersion: 1, chartKind: null, fileName: null, fileSize: null, fileMime: null,
  archived: false,
  ...over
})
const DOC = item('lib_1', { title: 'Pastiera napoletana' })
const DOC2 = item('lib_2', { title: 'Ricettario — indice', pinned: true })
const CHART = item('lib_c', { kind: 'chart', title: 'Vendite Q1', chartKind: 'vega-lite' })
const FILE = item('lib_f', { kind: 'file', title: 'Grafico esportato', fileName: 'grafico.png', fileSize: 12 })
const BOT: Agent = { id: 'bot', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 } as Agent

const CONTENT: LibraryContentInfo = {
  kind: 'document', content: '# Pastiera napoletana\n\nGrano, ricotta, cidro.', svg: null,
  fileBase64: null, fileMime: null, versions: [1], authorName: 'Competitoor'
}
/** Un documento da 14 titoli: l'indice mostra i primi 12 e «Mostra tutti (14)». */
const MD_TOC = '# Pastiera napoletana\n\nGrano, ricotta, cidro.\n\n' + Array.from({ length: 14 }, (_, i) => `## Sezione ${i + 1}\n\ntesto ${i + 1}\n`).join('\n')

// ---- i render ----
function render(library = true, props: Record<string, unknown> = {}): { root: HtmlNode; html: string } {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    openLibraryId: library ? '' : null,
    openPageInfo: library ? null : { id: (props.initial as { id?: string } | undefined)?.id ?? 'lib_1', from: 'chat', title: '', version: 0 },
    agents: [BOT], activeId: 'bot'
  })
  const html = renderHtml(createElement(library ? LibraryPanel : PageView, props as never))
  return { root: parseHtml(html), html }
}
/** La Libreria (la lista). */
const renderLibrary = (initial: Record<string, unknown> = {}): { root: HtmlNode; html: string } => render(true, { initial })
/** La vista di UNA voce della Libreria. */
const renderItemView = (id: string): { root: HtmlNode; html: string } => {
  capture.els.length = 0
  setStoreStateForRender(useStore, { openLibraryId: id, openPageInfo: null, agents: [BOT], activeId: 'bot' })
  const html = renderHtml(createElement(LibraryPanel))
  return { root: parseHtml(html), html }
}
/** Il documento aperto, venendo dalla Libreria o dalla chat. */
const renderPage = (initial: Record<string, unknown> = {}, from: 'chat' | 'library' = 'library'): { root: HtmlNode; html: string } => {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    openPageInfo: { id: initial.id ?? 'lib_1', from, title: '', version: 0 }, openLibraryId: null, agents: [BOT], activeId: 'bot'
  })
  const html = renderHtml(createElement(PageView, { initial } as never))
  return { root: parseHtml(html), html }
}
/** Una card della chat (il messaggio del bot sta nel meta della entry). */
const renderCard = (card: ComponentType<{ entry: TranscriptEntry }>, message: unknown): { root: HtmlNode; html: string } => {
  capture.els.length = 0
  setStoreStateForRender(useStore, { openLibraryId: null, openPageInfo: null, agents: [BOT], activeId: 'bot' })
  const entry: TranscriptEntry = { id: 1, agentId: 'bot', kind: 'send-message', role: 'assistant', content: '', meta: { message }, createdAt: 1 }
  const html = renderHtml(createElement(card, { entry }))
  return { root: parseHtml(html), html }
}

// ---- le domande sull'HTML ----
const has = (node: HtmlNode, token: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(token)
/** Il nodo porta TUTTE queste classi (il messaggio dice quale manca). */
const hasAll = (node: HtmlNode, tokens: string[]): void => {
  for (const token of tokens) expect(has(node, token), `«${token}» manca in «${node.attrs.class ?? ''}»`).toBe(true)
}
const byId = (root: HtmlNode, id: string): HtmlNode[] => findAll(root, (n) => n.attrs['data-testid'] === id)
const bySlot = (root: HtmlNode, slot: string): HtmlNode[] => findAll(root, (n) => n.attrs['data-page-shell'] === slot)
const buttonsIn = (node: HtmlNode): HtmlNode[] => findAll(node, (n) => n.tag === 'button')
const svgsIn = (node: HtmlNode): HtmlNode[] => findAll(node, (n) => n.tag === 'svg')
/** La testata della pagina (la riga dei 52 che la sonda riconosce da data-col-head). */
const head = (root: HtmlNode): HtmlNode => findAll(root, (n) => n.attrs['data-col-head'] === 'pagina')[0]!
/** Le colonne del contenuto dentro un contenitore che scorre: UNA per scorrimento (la sonda la trova da data-page-content). */
const columnsOf = (scroller: HtmlNode): HtmlNode[] => findAll(scroller, (n) => 'data-page-content' in n.attrs)
/** Il bottone che apre una voce, dentro la sua scheda o riga. */
const openButtonIn = (node: HtmlNode): HtmlNode => findAll(node, (n) => (n.attrs['data-testid'] ?? '').startsWith('library-open-'))[0]!
const el = (id: string) => capture.els.find((e) => e.props['data-testid'] === id)
const click = async (id: string): Promise<void> => {
  const props = el(id)?.props
  expect(props, `elemento con data-testid="${id}"`).toBeTruthy()
  ;(props!.onClick as (e?: unknown) => unknown)({ preventDefault() {}, stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => { capture.els.length = 0 })

describe('DS4 Libreria: il guscio (PageShell, larghezza «page»)', () => {
  it('la radice è il guscio: il testid resta su di lei, sta sopra la chat (z-20) ed è no-drag', () => {
    const { root } = renderLibrary({ items: [DOC] })
    const shell = byId(root, 'library-panel')[0]!
    expect(shell.attrs['data-page-shell']).toBe('root')
    hasAll(shell, ['no-drag', 'absolute', 'inset-0', 'z-20', 'bg-background'])
    // UNA radice sola con quel testid (lo cerca la sonda per misurare l'area)
    expect(byId(root, 'library-panel')).toHaveLength(1)
  })

  it('il corpo che scorre è figlio diretto della radice (la barra di scorrimento sta sul bordo dell\'area) e DENTRO c\'è una colonna sola, centrata, larga «page»', () => {
    const { root } = renderLibrary({ items: [DOC] })
    const shell = byId(root, 'library-panel')[0]!
    // nell'ordine: testata, barra degli strumenti, corpo (ferme le prime due)
    expect(shell.children.map((c) => c.attrs['data-page-shell'])).toEqual(['header', 'toolbar', 'scroll'])
    const scroll = bySlot(root, 'scroll')[0]!
    expect(scroll.parent).toBe(shell)
    hasAll(scroll, ['flex-1', 'min-h-0', 'overflow-y-auto'])
    const columns = columnsOf(scroll)
    expect(columns).toHaveLength(1)
    // la colonna: centrata (mx-auto), larga al più quanto --w-wide (1120), col ritmo del sistema
    hasAll(columns[0]!, ['mx-auto', 'w-full', 'flex', 'flex-col', 'gap-block'])
    expect(columns[0]!.attrs.style).toContain('max-width:var(--w-wide)')
    // il margine laterale dipende dall'AREA: 32 px, 24 sotto i 900 (sta sul gutter, attorno alla colonna)
    hasAll(columns[0]!.parent!, ['w-full', 'min-w-0', 'px-page-margin', '@max-[900px]:px-page-margin-narrow'])
  })

  it('la vista di una voce (un grafico, un file, lo storico di un documento) è lo stesso guscio, con lo stesso testid alla radice', () => {
    const { root } = renderItemView('lib_c')
    const shell = byId(root, 'library-panel')[0]!
    expect(shell.attrs['data-page-shell']).toBe('root')
    hasAll(shell, ['no-drag', 'absolute', 'inset-0', 'z-20'])
    expect(columnsOf(bySlot(root, 'scroll')[0]!)[0]!.attrs.style).toContain('max-width:var(--w-wide)')
  })
})

describe('DS4 Libreria: la testata', () => {
  it('è la testata di PageHeader sulla riga dei 52 (la fascia che trascina la finestra), e la colonna dentro è LARGA QUANTO LA TESTATA: il titolo a sinistra, le azioni al bordo destro (DS3)', () => {
    const { root } = renderLibrary({ items: [DOC] })
    const h = head(root)
    hasAll(h, ['drag-region', 'h-col-head', 'shrink-0', 'items-center'])
    // la testata sta nello slot «header» del guscio (fra lei e lo slot, la radice di PageHeader)
    expect(h.parent!.parent!.attrs['data-page-shell']).toBe('header')
    const gutter = findAll(h, (n) => 'data-page-gutter' in n.attrs)[0]!
    expect(gutter.parent, 'la colonna è figlia diretta della testata').toBe(h)
    hasAll(gutter, ['w-full', 'min-w-0'])
    const content = gutter.children[0]!
    hasAll(content, ['w-full', 'mx-auto'])
    // la riga dei controlli riempie la colonna: è lei che tiene le azioni attaccate al bordo destro
    hasAll(content.children[0]!, ['flex', 'min-w-0', 'flex-1', 'items-center'])
  })

  it('indietro · icona · «Libreria» · griglia/elenco — e nient\'altro: i filtri non stanno più in testata', () => {
    const { root, html } = renderLibrary({ items: [DOC] })
    const h = head(root)
    expect(buttonsIn(h).map((b) => b.attrs['aria-label'])).toEqual(['Torna alla chat', 'Griglia', 'Elenco'])
    // indietro è il PRIMO bottone della pagina (è lui che la sonda preme per l'anello di fuoco)
    expect(buttonsIn(root)[0]).toBe(buttonsIn(h)[0])
    // l'icona della pagina (quella fuori dai bottoni) è da 20, la misura delle testate;
    // il titolo di pagina in Bricolage Grotesque
    const icons = svgsIn(h).filter((s) => !hasAncestor(s, (n) => n.tag === 'button'))
    expect(icons).toHaveLength(1)
    hasAll(icons[0]!, ['size-5'])
    const h1 = findAll(h, (n) => n.tag === 'h1')
    expect(h1).toHaveLength(1)
    expect(textOf(h1[0]!)).toBe('Libreria')
    hasAll(h1[0]!, ['font-display', 'font-semibold', 'text-page'])
    // in testata nessun campo: la ricerca e i filtri stanno nella barra degli strumenti
    expect(findAll(h, (n) => n.tag === 'select' || n.tag === 'input')).toHaveLength(0)
    // la larghezza non è più una colonna scritta a mano: la dà PageShell
    for (const gone of ['max-w-4xl', 'max-w-3xl', 'max-w-sm']) expect(html).not.toContain(gone)
  })

  it('OGNI bottone della testata è da 32 e porta no-drag (sta nella fascia che trascina la finestra: senza, il clic trascina)', () => {
    for (const initial of [{ items: [DOC] }, { items: [DOC], view: 'list' }]) {
      const { root } = renderLibrary(initial)
      const buttons = buttonsIn(head(root))
      expect(buttons).toHaveLength(3)
      for (const b of buttons) {
        expect(has(b, 'no-drag'), `no-drag su «${b.attrs['aria-label']}»`).toBe(true)
        expect(has(b, 'size-control-sm') || has(b, 'h-control-sm'), `32 px su «${b.attrs['aria-label']}»`).toBe(true)
      }
    }
  })

  it('«indietro» chiude la Libreria (il VERO handler); griglia ed elenco hanno il loro', () => {
    renderLibrary({ items: [DOC] })
    const back = capture.els.find((e) => e.props['aria-label'] === 'Torna alla chat')!
    expect(back.type).toBe('button')
    ;(back.props.onClick as () => void)()
    expect(useStore.getState().openLibraryId).toBeNull()
    for (const label of ['Griglia', 'Elenco']) {
      renderLibrary({ items: [DOC] })
      const toggle = capture.els.find((e) => e.props['aria-label'] === label)!
      expect(toggle.props.onClick, label).toBeTypeOf('function')
    }
  })
})

describe('DS4 Libreria: la barra degli strumenti', () => {
  it('ferma sotto la testata e PRIMA del corpo che scorre: la ricerca (SearchField), i filtri come PILLOLE (menu per bot e tipo) e «Archiviati» l\'interruttore a pillola — C3', () => {
    const { root } = renderLibrary({ items: [DOC] })
    const toolbar = bySlot(root, 'toolbar')[0]!
    expect(toolbar.parent!.attrs['data-page-shell']).toBe('root')
    expect(has(toolbar, 'shrink-0')).toBe(true)
    // la ricerca è l'UNICA dell'app: SearchField, 36 px, fondo tenue
    const search = findAll(toolbar, (n) => n.tag === 'input')[0]!
    expect(search.attrs.placeholder).toBe('Cerca per titolo…')
    hasAll(search.parent!, ['h-control', 'rounded-control', 'bg-muted'])
    // i filtri per bot e tipo sono pillole-MENU («Bot: tutti ▾»): il testid del filtro bot resta
    const menuBot = byId(root, 'library-filter-bot')[0]!
    expect(textOf(menuBot)).toContain('Bot: ')
    const menuTipo = findAll(toolbar, (n) => (n.attrs['data-mock'] ?? '') === 'dropdown-trigger').at(1)!
    expect(textOf(menuTipo)).toContain('Tipo: ')
    // «Archiviati» è la pillola-interruttore del catalogo
    const archived = byId(root, 'library-filter-archived')[0]!
    expect(archived.attrs['data-slot']).toBe('button')
    expect(archived.attrs['aria-pressed']).toBe('false')
    expect(textOf(archived)).toBe('Archiviati')
    hasAll(archived, ['rounded-full', 'h-control-sm'])
    // l'icona della ricerca è da 16, dentro il campo
    hasAll(svgsIn(toolbar)[0]!, ['size-4'])
  })
})

describe('DS4 Libreria: le schede della griglia', () => {
  it('rounded-surface, bordo, bg-card, p-4: dentro, il bottone che apre si ALLUNGA alla scheda (flex-1) — l\'altezza uguale fra sorelle la dà la griglia', () => {
    const { root } = renderLibrary({ items: [DOC, DOC2] })
    const cards = byId(root, 'library-card')
    expect(cards.map((c) => c.attrs['data-id'])).toEqual(['lib_2', 'lib_1'])
    for (const card of cards) {
      hasAll(card, ['relative', 'flex', 'flex-col', 'rounded-surface', 'border', 'bg-card', 'p-4'])
      const open = openButtonIn(card)
      expect(open.tag).toBe('button')
      expect(open.parent, 'il bottone che apre sta dentro la scheda').toBe(card)
      hasAll(open, ['flex', 'flex-1', 'flex-col', 'w-full', 'text-left'])
    }
    // due colonne, tre quando l'AREA passa i 768 px (una query sul contenitore di PageShell)
    hasAll(cards[0]!.parent!, ['grid', 'grid-cols-2', 'gap-4', '@3xl:grid-cols-3'])
  })

  it('le righe della scheda: il titolo in due righe al massimo (text-body, peso medio), la zona dell\'anteprima ALTA QUATTRO RIGHE, i metadati in fondo (text-caption)', () => {
    const { root } = renderLibrary({ items: [DOC2, DOC] })
    const open = byId(root, 'library-open-lib_2')[0]!
    const [titleRow, zone, meta] = open.children
    expect(open.children).toHaveLength(3)
    const title = findAll(titleRow!, (n) => has(n, 'line-clamp-2'))[0]!
    expect(textOf(title)).toBe('Ricettario — indice')
    hasAll(title, ['text-body', 'font-medium'])
    // il titolo intero al passaggio, perché in due righe può troncare
    expect(title.attrs.title).toBe('Ricettario — indice')
    hasAll(zone!, ['h-18'])
    expect(textOf(meta!)).toMatch(/^Pagina · Competitoor · /)
    hasAll(meta!, ['text-caption', 'text-muted-foreground', 'mt-auto'])
  })

  it('la zona dell\'anteprima è QUATTRO righe di text-small (4 × 18 = 72 px), e la griglia passa a tre colonne a 48rem di AREA: le classi, nel CSS compilato', async () => {
    const css = squashed(await compileRenderer(['h-18', '@3xl:grid-cols-3', 'grid-cols-2', 'gap-block', 'size-control-sm']))
    // la radice resta a 16 px: la scala di Tailwind è 4 px, 18 × 4 = 72 = 4 × l'interlinea di text-small
    expect(css).toContain('--spacing: 0.25rem;')
    expect(css).toContain('--text-small--line-height: 18px;')
    expect(css).toMatch(/\.h-18 \{ height: calc\(var\(--spacing\) \* 18\); \}/)
    // la variante @3xl è una container query sull'area: 48rem = 768 px
    expect(css).toContain('@container (width >= 48rem) { .\\@3xl\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }')
    expect(css).toMatch(/\.gap-block \{ gap: var\(--spacing-block\); \}/)
  })

  it('i glifi sono icone lucide: il «★» dei fissati è un\'icona da 16, rossa come prima; nella pagina non resta né «★» né «⚠» né «↩»', () => {
    const { root, html } = renderLibrary({ items: [{ ...DOC2, tainted: true }, DOC] })
    expect(html).not.toMatch(/[★⚠↩]/)
    const open = byId(root, 'library-open-lib_2')[0]!
    const star = svgsIn(open.children[0]!)[0]!
    hasAll(star, ['size-4', 'fill-current', 'text-destructive'])
    expect(textOf(star)).toBe('')
    // la scheda non fissata non ha l'asterisco
    expect(svgsIn(byId(root, 'library-open-lib_1')[0]!.children[0]!)).toHaveLength(0)
  })

  it('il «⋯» della scheda è il bottone tondo da 32 di Button, no-drag, in alto a destra — e senza ombra (dopo un clic del mouse nessun anello)', () => {
    const { root } = renderLibrary({ items: [DOC] })
    const trigger = byId(root, 'library-menu-grid-lib_1')[0]!
    hasAll(trigger, ['h-control-sm', 'w-control-sm', 'rounded-full', 'no-drag'])
    // il contenitore del menu (sopra il bottone e il menu passante dei test) è quello inchiodato all'angolo della scheda
    hasAll(trigger.parent!.parent!.parent!, ['absolute', 'top-2', 'right-2'])
    expect((trigger.attrs.class ?? '').split(/\s+/).filter((c) => /^(shadow|ring)/.test(c))).toEqual([])
  })
})

describe('DS4 Libreria: la lista', () => {
  it('le righe sono FlatList/FlatRow: l\'icona del tipo nello slot da 32, il titolo text-body in peso medio, i metadati text-small, la data a destra text-caption', () => {
    const { root } = renderLibrary({ items: [DOC, CHART, FILE], view: 'list' })
    const rows = byId(root, 'library-row')
    expect(rows.map((r) => r.attrs['data-id'])).toEqual(['lib_1', 'lib_c', 'lib_f'])
    // FlatList: un filetto fra una riga e l'altra
    hasAll(rows[0]!.parent!, ['divide-y', 'divide-border/50'])
    for (const row of rows) {
      const open = openButtonIn(row)
      expect(open.tag).toBe('button')
      // FlatRow: le misure sono quelle di DS1, le scrive il pezzo (non la pagina)
      const flat = open.children[0]!
      hasAll(flat, ['flex', 'w-full', 'items-center', 'gap-row-gap', 'py-row-pad', 'min-h-row'])
      const [slot, text, trailing] = flat.children
      hasAll(slot!, ['size-8'])
      hasAll(svgsIn(slot!)[0]!, ['size-4'])
      hasAll(text!.children[0]!, ['truncate', 'text-body', 'font-medium'])
      hasAll(text!.children[1]!, ['truncate', 'text-small', 'text-muted-foreground'])
      hasAll(trailing!.children[0]!, ['text-caption', 'text-muted-foreground'])
    }
    // i metadati: il tipo (o il nome del file e la sua misura) · il bot — la data sta a destra
    const subtitleOf = (id: string): string => textOf(openButtonIn(byId(root, 'library-row').find((r) => r.attrs['data-id'] === id)!).children[0]!.children[1]!.children[1]!)
    expect(subtitleOf('lib_1')).toBe('Pagina · Competitoor')
    expect(subtitleOf('lib_c')).toBe('Grafico · Competitoor')
    expect(subtitleOf('lib_f')).toBe('grafico.png · 12 byte · Competitoor')
  })

  it('la casella di selezione e il «⋯» stanno FUORI dal bottone che apre; il bottone ha l\'evento del clic (⌘/Ctrl/Maiusc) e il mousedown della selezione', () => {
    const { root } = renderLibrary({ items: [DOC], view: 'list' })
    const row = byId(root, 'library-row')[0]!
    const open = byId(root, 'library-open-lib_1')[0]!
    expect(open.parent).toBe(row)
    expect(byId(root, 'library-select-lib_1')[0]!.parent).toBe(row)
    const menu = byId(root, 'library-menu-list-lib_1')[0]!
    // (un bottone dentro un altro non è HTML valido, e il clic sul menu aprirebbe la voce)
    expect(hasAncestor(menu, (n) => n === open)).toBe(false)
    expect(hasAncestor(menu, (n) => n === row)).toBe(true)
    const props = el('library-open-lib_1')!.props
    expect(props.onClick).toBeTypeOf('function')
    expect(props.onMouseDown).toBeTypeOf('function')
  })

  it('una voce che viene da dati esterni: l\'icona dell\'avviso al posto del «⚠», col testo «esterno» e il suggerimento di prima', () => {
    const { root, html } = renderLibrary({ items: [{ ...DOC, tainted: true, currentVersion: 3 }], view: 'list' })
    expect(html).not.toContain('⚠')
    const badge = findAll(root, (n) => n.attrs.title === 'Proveniente da dati esterni')[0]!
    expect(textOf(badge)).toBe('esterno')
    hasAll(badge, ['text-destructive'])
    hasAll(svgsIn(badge)[0]!, ['size-4'])
  })
})

describe('DS4 Libreria: i dialoghi', () => {
  it('la larghezza è quella del dialogo (niente più max-w-sm scritto a mano), il titolo è text-title, il campo è alto 36 col raggio dei campi, le azioni sono Button', () => {
    const conferma = renderLibrary({ items: [DOC], confirmDeleteId: 'lib_1' }).root
    const dialog = byId(conferma, 'library-delete-confirm')[0]!
    expect(dialog.attrs.class ?? '').not.toMatch(/max-w-/)
    hasAll(findAll(dialog, (n) => n.attrs['data-mock'] === 'dialog-title')[0]!, ['text-title'])
    // Annulla è secondario, Elimina distruttivo (pieno: è l'azione che non si annulla)
    hasAll(byId(conferma, 'library-delete-confirm-cancel')[0]!, ['h-control', 'rounded-control', 'bg-muted'])
    hasAll(byId(conferma, 'library-delete-confirm-ok')[0]!, ['h-control', 'bg-destructive', 'text-destructive-foreground'])

    const rinomina = renderLibrary({ items: [DOC], rename: { id: 'lib_1', title: 'Pastiera della domenica' } }).root
    hasAll(byId(rinomina, 'library-rename-input')[0]!, ['h-control', 'w-full', 'rounded-control', 'text-body'])
    hasAll(byId(rinomina, 'library-rename-cancel')[0]!, ['bg-muted'])
    // Salva è l'azione principale: una pillola
    hasAll(byId(rinomina, 'library-rename-save')[0]!, ['rounded-full', 'bg-foreground'])
  })
})

describe('DS4 Libreria: la vista di una voce', () => {
  it('lo stesso guscio e la stessa testata: indietro è il primo bottone (il ritorno alla lista), l\'icona del tipo, il titolo; non c\'è più un bottone col testo «← Lista»', () => {
    const { root, html } = renderItemView('lib_c')
    const h = head(root)
    const back = buttonsIn(h)[0]!
    expect(back.attrs['aria-label']).toBe('torna alla lista')
    expect(buttonsIn(root)[0]).toBe(back)
    hasAll(back, ['size-control-sm', 'no-drag'])
    // l'icona del tipo (fuori dai bottoni) è da 20
    const icons = svgsIn(h).filter((s) => !hasAncestor(s, (n) => n.tag === 'button'))
    expect(icons).toHaveLength(1)
    hasAll(icons[0]!, ['size-5'])
    const h1 = findAll(h, (n) => n.tag === 'h1')[0]!
    hasAll(h1, ['font-display', 'text-page'])
    expect(textOf(h1)).toBe('lib_c')
    expect(html).not.toContain('←')
  })
})

describe('DS4 il documento aperto: il guscio e la testata', () => {
  it('PageShell alla larghezza «reading», sopra la chat (z-20), col testid sulla radice e UNA colonna centrata da 720: via max-w-[720px] e pt-[76px] scritti a mano', () => {
    const { root, html } = renderPage({ content: CONTENT, item: DOC })
    const shell = byId(root, 'page-view')[0]!
    expect(shell.attrs['data-page-shell']).toBe('root')
    hasAll(shell, ['absolute', 'inset-0', 'z-20', 'no-drag'])
    expect(shell.children.map((c) => c.attrs['data-page-shell'])).toEqual(['header', 'scroll'])
    const columns = columnsOf(bySlot(root, 'scroll')[0]!)
    expect(columns).toHaveLength(1)
    expect(columns[0]!.attrs.style).toContain('max-width:var(--w-reading)')
    hasAll(columns[0]!, ['mx-auto', 'flex', 'flex-col', 'gap-block'])
    for (const gone of ['max-w-[720px]', 'pt-[76px]']) expect(html).not.toContain(gone)
  })

  it('DS3 — la colonna dentro la testata è LARGA QUANTO LA TESTATA (w-full): il titolo parte da sinistra e «Esporta» e il «⋯» arrivano al bordo destro del contenuto', () => {
    const { root } = renderPage({ content: CONTENT, item: DOC })
    const h = head(root)
    hasAll(h, ['drag-region', 'h-col-head'])
    const gutter = findAll(h, (n) => 'data-page-gutter' in n.attrs)[0]!
    expect(gutter.parent, 'la colonna è figlia diretta della testata').toBe(h)
    hasAll(gutter, ['w-full', 'min-w-0'])
    const content = gutter.children[0]!
    hasAll(content, ['w-full'])
    const row = content.children[0]!
    hasAll(row, ['flex', 'min-w-0', 'flex-1', 'items-center'])
    // in fondo alla riga: lo spazio che resta, poi le azioni — che così restano attaccate al bordo destro del contenuto
    const actions = row.children[row.children.length - 1]!
    expect(has(actions, 'shrink-0') && actions.children.length >= 2).toBe(true)
    expect(has(row.children[row.children.length - 2]!, 'flex-1')).toBe(true)
    // e le azioni sono «Esporta» e il «⋯», in quest'ordine
    expect(buttonsIn(actions).map((b) => b.attrs['data-testid'])).toEqual(['page-export', 'library-menu-page-lib_1'])
  })

  it('indietro è il PRIMO bottone (page-close, l\'aria-label di oggi secondo da dove si viene, da 32, no-drag); poi il titolo del documento nella pillola delle sonde; a destra «Esporta» e il «⋯», da 32', () => {
    const casi: Array<[ReturnType<typeof renderPage>, string]> = [
      [renderPage({ content: CONTENT, item: DOC }, 'library'), 'Torna alla libreria'],
      [renderPage({ content: CONTENT, item: DOC }, 'chat'), 'Torna alla chat']
    ]
    for (const [{ root }, label] of casi) {
      const h = head(root)
      const [back, ...rest] = buttonsIn(h)
      expect(back!.attrs['data-testid']).toBe('page-close')
      expect(back!.attrs['aria-label']).toBe(label)
      // il primo bottone della pagina: lo preme la sonda (e una sonda di squadra: page-view button)
      expect(buttonsIn(root)[0]).toBe(back)
      for (const b of buttonsIn(h)) {
        expect(has(b, 'no-drag'), `no-drag su «${b!.attrs['data-testid'] ?? ''}»`).toBe(true)
        expect(has(b, 'size-control-sm') || has(b, 'h-control-sm'), `32 px su «${b!.attrs['data-testid'] ?? ''}»`).toBe(true)
      }
      expect(rest.map((b) => b.attrs['data-testid'])).toEqual(['page-export', 'library-menu-page-lib_1'])
      const pill = byId(root, 'page-title-pill')[0]!
      expect(textOf(pill)).toBe('Pastiera napoletana')
      expect(hasAncestor(pill, (n) => n.tag === 'h1')).toBe(true)
    }
  })

  it('«indietro» torna da dove si veniva: in Libreria se veniva di lì, in chat altrimenti', async () => {
    renderPage({ content: CONTENT, item: DOC }, 'library')
    await click('page-close')
    expect(useStore.getState().openPageInfo).toBeNull()
    expect(useStore.getState().openLibraryId).toBe('')
    renderPage({ content: CONTENT, item: DOC }, 'chat')
    await click('page-close')
    expect(useStore.getState().openPageInfo).toBeNull()
    expect(useStore.getState().openLibraryId).toBeNull()
  })
})

describe('DS4 il documento aperto: il corpo', () => {
  it('il titolo del documento in h1 (font-display, text-page, semibold), la riga della versione text-caption grigia, l\'indice in una scheda rounded-surface con le voci text-body', () => {
    const { root } = renderPage({ content: { ...CONTENT, content: MD_TOC }, item: DOC })
    const h1 = byId(root, 'page-title')[0]!
    expect(h1.tag).toBe('h1')
    expect(textOf(h1)).toBe('Pastiera napoletana')
    hasAll(h1, ['font-display', 'text-page', 'font-semibold'])
    const version = byId(root, 'page-version')[0]!
    expect(version.tag).toBe('button')
    expect(textOf(version)).toContain('versione 1')
    hasAll(version, ['text-caption', 'text-muted-foreground'])
    const toc = byId(root, 'page-toc')[0]!
    expect(toc.tag).toBe('nav')
    hasAll(toc, ['rounded-surface'])
    const items = byId(root, 'page-toc-item')
    expect(items).toHaveLength(12)
    for (const item of items) {
      expect(item.tag).toBe('button')
      hasAll(item, ['text-body'])
    }
    hasAll(byId(root, 'page-toc-all')[0]!, ['text-small'])
    expect(textOf(byId(root, 'page-toc-all')[0]!)).toBe('Mostra tutti (14)')
  })

  it('gli avvisi sono righe con un\'ICONA lucide (16 px) al posto del «⚠»: la pagina da dati esterni (rossa, text-small) e quella archiviata, con «Ripristina»', async () => {
    const { root, html } = renderPage({ content: CONTENT, item: { ...DOC, tainted: true, archived: true } })
    expect(html).not.toContain('⚠')
    const tainted = byId(root, 'page-tainted')[0]!
    expect(textOf(tainted)).toBe('Proveniente da dati esterni')
    hasAll(tainted, ['text-small', 'text-destructive'])
    hasAll(svgsIn(tainted)[0]!, ['size-4'])
    const archived = byId(root, 'page-archived-notice')[0]!
    expect(textOf(archived)).toContain('Archiviata')
    hasAll(archived, ['text-small'])
    hasAll(svgsIn(archived)[0]!, ['size-4'])
    expect(byId(root, 'page-restore')[0]!.tag).toBe('button')
    await click('page-restore')
    expect(callsOf('libraryArchive').at(-1)!.args).toEqual(['lib_1', false])
    // senza avvisi non c'è nessuna riga
    const pulita = renderPage({ content: CONTENT, item: DOC }).root
    for (const id of ['page-tainted', 'page-archived-notice', 'page-restore']) expect(byId(pulita, id), id).toHaveLength(0)
  })
})

describe('DS4 la scheda del documento in chat', () => {
  const openOf = (): { type: unknown; props: Record<string, unknown> } => capture.els.find((e) => e.type === 'button' && String(e.props.className ?? '').includes('rounded-surface'))!

  it('è LA STESSA scheda della Libreria: rounded-surface col bordo, il titolo in due righe, l\'anteprima in quattro, l\'etichetta in fondo — e il primo bottone della scheda apre la pagina dalla chat', () => {
    const { root, html } = renderCard(DocumentCard, { type: 'document', id: 'lib_1', title: 'Pastiera napoletana', version: 2 })
    const card = byId(root, 'page-card')[0]!
    // la larghezza la decide la colonna della chat: non più una max-w-3xl scritta qui
    expect(card.attrs.class ?? '').not.toMatch(/max-w-/)
    const open = buttonsIn(card)[0]!
    expect(buttonsIn(root)).toHaveLength(1)
    hasAll(open, ['flex', 'flex-col', 'rounded-surface', 'border', 'bg-card', 'p-4', 'text-left'])
    const title = findAll(open, (n) => has(n, 'line-clamp-2'))[0]!
    expect(textOf(title)).toBe('Pastiera napoletana')
    hasAll(title, ['text-body', 'font-medium'])
    // l'anteprima DENTRO la scheda (lo cerca così la sonda di fase pagine)
    const preview = byId(root, 'page-card-preview')[0]!
    expect(hasAncestor(preview, (n) => n === card)).toBe(true)
    hasAll(preview, ['line-clamp-4', 'text-small', 'text-muted-foreground'])
    const label = byId(root, 'page-card-label')[0]!
    hasAll(label, ['text-caption', 'text-muted-foreground'])
    expect(textOf(label)).toBe('Pagina · versione 2')
    // il clic apre la pagina DALLA CHAT (il VERO handler del bottone della scheda)
    const onClick = openOf().props.onClick as () => void
    onClick()
    expect(useStore.getState().openPageInfo).toMatchObject({ id: 'lib_1', from: 'chat' })
    // alla prima versione l'etichetta è sola («Pagina»: lo cerca così una sonda di fase pagine)
    expect(textOf(byId(renderCard(DocumentCard, { type: 'document', id: 'lib_9', title: 'T', version: 1 }).root, 'page-card-label')[0]!)).toBe('Pagina')
    // niente più misure scritte a mano nella scheda
    expect(html).not.toMatch(/(rounded|h|w|max-h|max-w)-\[/)
  })

  it('gli avvisi delle card (modulo sicuro, contatto): un\'icona lucide da 16 davanti a un testo text-small — più nessun «⚠»', () => {
    const modulo = renderCard(SecureInputCard, { type: 'secure-input', kind: 'login', origin: 'https://spa.example', label: 'Portale', reason: 'Serve la password.', untrusted: true })
    expect(modulo.html).not.toContain('⚠')
    const avviso = findAll(modulo.root, (n) => textOf(n).startsWith('Richiesta nata dopo contenuti letti dal web'))[0]!
    hasAll(avviso, ['text-small', 'text-destructive'])
    hasAll(svgsIn(avviso)[0]!, ['size-4'])

    const contatto = renderCard(ContactCard, { type: 'contact', name: 'Anna Rossi', emails: ['anna@example.com'], phones: [], untrusted: true })
    expect(contatto.html).not.toContain('⚠')
    const esterno = findAll(contatto.root, (n) => textOf(n).startsWith('dati letti da una fonte esterna'))[0]!
    hasAll(esterno, ['text-small'])
    hasAll(svgsIn(esterno)[0]!, ['size-4'])
  })

  it('i campi delle card sono il campo di DS1 (36 px, il raggio dei campi, text-body) e le azioni sono Button: la principale è una pillola', () => {
    const { root } = renderCard(SecureInputCard, { type: 'secure-input', kind: 'login', origin: 'https://spa.example', label: 'Portale', reason: 'Serve la password.' })
    const inputs = findAll(root, (n) => n.tag === 'input')
    expect(inputs).toHaveLength(5)
    for (const input of inputs) hasAll(input, ['h-control', 'rounded-control', 'text-body'])
    const buttons = buttonsIn(root)
    expect(buttons.map(textOf)).toEqual(['Salva nel vault', 'Annulla'])
    hasAll(buttons[0]!, ['rounded-full', 'bg-foreground', 'h-control'])
  })
})

describe('DS4 Libreria: il CSS compilato', () => {
  it('ogni classe scritta nelle tre pagine genera la sua regola: una classe sbagliata tace, e non si vede finché non si guarda la pagina', async () => {
    const tokens = new Set<string>()
    for (const file of ['LibraryPanel', 'PageView', 'LibraryCards']) {
      const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), 'utf8')
      // le liste di classi lette dall'AST (la stessa lettura della guardia): i commenti non contano
      for (const value of stringsOf(source)) {
        if (!isClassList(value)) continue
        for (const token of value.split(/\s+/)) if (token !== '') tokens.add(token)
      }
    }
    expect(tokens.size).toBeGreaterThan(80)
    const css = await compileRenderer([...tokens])
    expect(deadClasses(css, tokens)).toEqual([])
  })
})
