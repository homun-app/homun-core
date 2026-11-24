// Fase design (DS4): il pannello del bot è una COLONNA del sistema. Qui il
// CONTRATTO del pannello reso in node (renderHtml / parseHtml: componente
// VERO, store VERO, handler VERI). La geometria la misura la sonda
// fase-design sull'app vera — in node non c'è DOM: qui si controlla che il
// sorgente non possa tornare indietro.
//   - la testata (DS3): la riga interna è larga quanto la testata (w-full) —
//     è figlia di un contenitore flex in RIGA: senza w-full è larga quanto il
//     suo contenuto, justify-end non ha spazio e la ✕ sta a SINISTRA;
//   - la radice è un contenitore (@container) e il corpo che scorre è un
//     figlio diretto della radice, largo quanto il pannello, col gutter della
//     barra su tutti e due i lati;
//   - il margine sta DENTRO lo scorrimento (PageColumn), alla stessa ascissa
//     della testa ferma (px-1.5);
//   - i pezzi del sistema: UnderlineTabs per le schede, Section per i titoli,
//     FlatRow per le righe (dentro un <button>: le sonde di fase pagine le
//     cercano così), Button per le azioni;
//   - ciò che le sonde delle altre fasi cercano (testid, «button» col testo);
//   - nessuna classe dei file del pannello è morta nel CSS compilato (un nome
//     sbagliato sta nell'HTML e non fa nulla: lo dice solo l'output).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, hasAncestor, dialogPassThroughMock, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'
import { SRC, isClassList, stringsOf } from './design-scan'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
// il grafo del pannello porta il Computer (novnc/xterm toccano document
// all'import): File e Attività del computer si rendono da soli, qui sotto
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))

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

const { RightPanel } = await import('../components/RightPanel')
const { ComputerPrepRow } = await import('../components/ComputerPrepRow')
const { ComputerActivity } = await import('../components/ComputerActivity')
const { ComputerFiles } = await import('../components/ComputerFiles')
const { MemoryPanel } = await import('../components/MemoryPanel')
const { useStore } = await import('../store')

const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter(Boolean)
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!
const byTestid = (root: HtmlNode, id: string): HtmlNode[] => findAll(root, (n) => n.attrs['data-testid'] === id)
const render = (element: React.ReactElement): HtmlNode => parseHtml(renderHtml(element))
/** La variante dell'anello che scatta ANCHE al clic (vietata: la regola di B5). */
const clickFocus = (node: HtmlNode): boolean => classes(node).some((c) => /^focus:(ring|outline)/.test(c))
/** Un margine esterno (m-…): le sezioni e i pezzi del pannello non ne hanno, le distanze le decide chi li elenca. */
const outerMargin = (node: HtmlNode): boolean => classes(node).some((c) => /^m[trblxy]?-/.test(c))
const guttersOf = (node: HtmlNode): HtmlNode[] => findAll(node, (n) => 'data-page-gutter' in n.attrs)

const LAYOUT = { sidebar: 'full' as const, sidebarWidth: 264, panel: 'docked' as const, panelWidth: 340 }
const OVERLAY = { sidebar: 'rail' as const, sidebarWidth: 76, panel: 'overlay' as const, panelWidth: 340 }
const agent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'bot-1', name: 'Trello', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1, ...over
})
const STORE = {
  rightPanel: true, openGroupId: null, activeId: 'bot-1', agents: [agent()],
  providers: [{ id: 'p1', name: 'Anthropic', kind: 'anthropic', enabled: true }],
  mainModel: null, entries: [], tasks: [], groups: [],
  panelTab: 'activity', botSheetOpen: false, botSheetFocus: null, botModelOpen: false, computerPanel: { open: false, tab: 'activity' },
  botPanelTabRequest: null, openTaskId: null,
  boxRuntime: null, boxInUse: false, boxSetup: null, screenStatus: {}, activity: {},
  memoryProgress: null, memoryFocusId: null
}
/** Una squadra aperta: due bot, il primo coordina. */
const GROUP = {
  id: 1, name: 'Weekend', description: '', createdBy: 'me', coordinatorId: 'bot-1', createdAt: 1, lastMessageAt: null, autonomy: 'ask',
  members: [{ agentId: 'bot-1', name: 'Trello', coordinator: true }, { agentId: 'bot-2', name: 'Capo', coordinator: false }]
}
const WITH_GROUP = { openGroupId: 1, groups: [GROUP], agents: [agent(), agent({ id: 'bot-2', name: 'Capo' })], groupOverview: { members: [], produced: [] } }

/** Il pannello a destra (del bot, o dei Membri con una squadra aperta) con lo store del caso. */
const panel = (over: Record<string, unknown> = {}, layout: Record<string, unknown> = LAYOUT): HtmlNode => {
  capture.els.length = 0
  setStoreStateForRender(useStore, { ...STORE, ...over })
  return render(createElement(RightPanel, { layout: layout as never }))
}
const asideOf = (root: HtmlNode): HtmlNode => byTestid(root, 'bot-panel')[0]!
const scrollerOf = (root: HtmlNode): HtmlNode | undefined => byTestid(root, 'bot-panel-scroll')[0]
const tabsOf = (root: HtmlNode): HtmlNode[] => findAll(root, (n) => n.attrs.role === 'tab')
/** L'elemento reso col testid, come lo ha creato React: le sue props VERE (handler compreso). */
const rendered = (testid: string): { type: unknown; props: Record<string, unknown> } => {
  const el = capture.els.find((e) => e.props['data-testid'] === testid)
  expect(el, `l'elemento reso «${testid}»`).toBeTruthy()
  return el!
}
/** La posizione di un nodo nell'ordine del documento (per controllare che uno sta sopra l'altro). */
const documentIndex = (root: HtmlNode): (n: HtmlNode) => number => {
  const all = findAll(root, () => true)
  return (n) => all.indexOf(n)
}

describe('DS4 · il pannello del bot: la testata (DS3)', () => {
  it('la riga interna della testata è larga quanto la testata (w-full): figlia di un flex in riga, senza w-full la ✕ resterebbe a sinistra', () => {
    // il pannello del bot (agganciato e in overlay) e quello dei Membri: la stessa testata
    const roots = [panel(), panel({}, OVERLAY), panel(WITH_GROUP)]
    expect(roots.map((r) => findAll(r, (n) => n.attrs['data-col-head'] === 'pannello').length)).toEqual([1, 1, 1])
    for (const root of roots) {
      const head = first(root, (n) => n.attrs['data-col-head'] === 'pannello')
      // (il testo fisso dell'attributo — drag-region, h-col-head — lo guarda window-frame.test.ts)
      expect(head.children).toHaveLength(1)
      const row = head.children[0]!
      for (const cls of ['flex', 'h-full', 'w-full', 'items-center', 'justify-end']) expect(has(row, cls), `riga interna: ${cls}`).toBe(true)
      const close = first(row, (n) => n.tag === 'button')
      expect(close.attrs['aria-label']).toBe('Chiudi il pannello')
      expect(close.attrs['title']).toBe('Chiudi il pannello')
      // un bottone da 32, tondo, dentro la fascia di trascinamento: porta no-drag
      for (const cls of ['size-control-sm', 'rounded-full', 'no-drag']) expect(has(close, cls), cls).toBe(true)
    }
  })
})

describe('DS4 · il pannello del bot: una colonna larga quanto il pannello, col margine dentro', () => {
  it('la radice è un contenitore (@container): il margine delle colonne dipende dalla larghezza del PANNELLO, non della finestra', () => {
    for (const layout of [LAYOUT, OVERLAY]) {
      const aside = asideOf(panel({}, layout))
      expect(has(aside, '@container')).toBe(true)
      expect(has(aside, 'flex-col')).toBe(true)
    }
  })

  it('il corpo che scorre è un figlio diretto della radice, largo quanto il pannello, col gutter della barra su tutti e due i lati — e senza margine suo', () => {
    for (const panelTab of ['activity', 'library']) {
      const aside = asideOf(panel({ panelTab }))
      const scroller = scrollerOf(aside)!
      expect(scroller.parent).toBe(aside)
      for (const cls of ['scroll-thin', 'min-h-0', 'flex-1', 'overflow-y-auto', 'overflow-x-hidden', '[scrollbar-gutter:stable_both-edges]']) {
        expect(has(scroller, cls), cls).toBe(true)
      }
      // il margine sta DENTRO: nessun padding né margine sullo scorrimento
      expect(classes(scroller).some((c) => /^-?([pm][xytrbl]?|gap)-/.test(c))).toBe(false)
    }
  })

  it('il margine sta DENTRO lo scorrimento (PageColumn), alla stessa ascissa della testa ferma (px-1.5 e la stessa colonna)', () => {
    const aside = asideOf(panel())
    const scroller = scrollerOf(aside)!
    // nella radice: la testata (assoluta), la testa ferma, il corpo
    const headWrap = aside.children[aside.children.indexOf(scroller) - 1]!
    expect(headWrap.parent).toBe(aside)
    for (const cls of ['shrink-0', 'px-1.5']) expect(has(headWrap, cls), cls).toBe(true)
    for (const host of [headWrap, scroller]) {
      const gutters = guttersOf(host)
      expect(gutters).toHaveLength(1)
      for (const cls of ['w-full', 'px-page-margin', '@max-[900px]:px-page-margin-narrow']) expect(has(gutters[0]!, cls), cls).toBe(true)
      const content = first(gutters[0]!, (n) => 'data-page-content' in n.attrs)
      for (const cls of ['mx-auto', 'w-full']) expect(has(content, cls), cls).toBe(true)
    }
    // il corpo ha il ritmo di una pagina: i blocchi a 16 px, il respiro in testa e in fondo
    const body = first(scroller, (n) => 'data-page-content' in n.attrs)
    for (const cls of ['flex', 'flex-col', 'gap-4', 'pt-4', 'pb-6']) expect(has(body, cls), cls).toBe(true)
  })

  it('sulla scheda Computer non c\'è lo scorrimento di colonna: il pannello del computer è un figlio diretto della radice; le due schede restano, nessuna scelta', () => {
    const aside = asideOf(panel({ panelTab: 'computer' }, { ...LAYOUT, panelWidth: 560 }))
    expect(scrollerOf(aside)).toBeUndefined()
    expect(tabsOf(aside).map((t) => t.attrs['aria-selected'])).toEqual(['false', 'false'])
    expect(byTestid(aside, 'bot-tab-activity')).toHaveLength(1)
    expect(byTestid(aside, 'bot-tab-library')).toHaveLength(1)
  })

  it('anche il pannello dei Membri è la stessa colonna: scorrimento largo quanto il pannello, margine dentro, titolo all\'altezza della testata', () => {
    const root = panel(WITH_GROUP)
    // niente testid sulla radice dei Membri (com'era): la si riconosce dalla testata
    const aside = first(root, (n) => n.attrs['data-col-head'] === 'pannello').parent!
    expect(has(aside, '@container')).toBe(true)
    const scroller = aside.children[aside.children.length - 1]!
    expect(has(scroller, '[scrollbar-gutter:stable_both-edges]')).toBe(true)
    expect(has(scroller, 'overflow-y-auto')).toBe(true)
    const gutters = guttersOf(scroller)
    expect(gutters).toHaveLength(1)
    expect(gutters[0]!.parent).toBe(scroller)
    const title = first(scroller, (n) => n.tag === 'h2')
    expect(textOf(title)).toBe('Weekend')
    for (const cls of ['text-title', 'font-semibold']) expect(has(title, cls), cls).toBe(true)
    expect(has(title.parent!, 'pt-col-head')).toBe(true)
  })
})

describe('DS4 · il pannello del bot: i pezzi del sistema', () => {
  it('le schede Attività · Libreria sono UnderlineTabs: una tablist che non va mai a capo, centrata in modo SICURO, senza pillola', () => {
    const root = panel()
    const list = first(root, (n) => n.attrs.role === 'tablist')
    for (const cls of ['flex-nowrap', 'overflow-x-auto', '[scrollbar-width:none]']) expect(has(list, cls), cls).toBe(true)
    // l'involucro è largo quanto la colonna — in una colonna items-center sarebbe
    // largo quanto le due etichette — così il filetto di base la attraversa e
    // divide la testa dal corpo che scorre; le schede stanno al centro come la
    // testa, e «safe»: se non ci stanno, dall'inizio della riga che scorre si arriva lo stesso
    const wrap = list.parent!
    for (const cls of ['w-full', 'border-b', '[&>[role=tablist]]:justify-center-safe']) expect(has(wrap, cls), cls).toBe(true)
    const tabs = tabsOf(root)
    expect(tabs.map(textOf)).toEqual(['Attività', 'Libreria'])
    for (const t of tabs) {
      expect(t.tag).toBe('button')
      expect(has(t, 'whitespace-nowrap')).toBe(true)
      expect(has(t, 'text-body')).toBe(true)
      // niente pillola: nessun fondo
      expect(classes(t).some((c) => /^bg-/.test(c))).toBe(false)
      // solo da tastiera: mai la variante che scatta anche al clic (la regola di B5)
      expect(clickFocus(t)).toBe(false)
    }
  })

  it('i testid delle due schede (bot-tab-activity, bot-tab-library) restano, dentro i bottoni; la scheda scelta è quella dello store', () => {
    const library = panel({ panelTab: 'library' })
    const tabs = tabsOf(library)
    expect(tabs.map((t) => t.attrs['aria-selected'])).toEqual(['false', 'true'])
    // tabindex a scacchi: solo la scelta entra nel giro di Tab
    expect(tabs.map((t) => t.attrs.tabindex)).toEqual(['-1', '0'])
    expect(byTestid(tabs[0]!, 'bot-tab-activity')).toHaveLength(1)
    expect(byTestid(tabs[1]!, 'bot-tab-library')).toHaveLength(1)
    // il testid è sull'ETICHETTA (il pezzo non ha un testid per scheda): un clic lì arriva al bottone
    const label = byTestid(library, 'bot-tab-library')[0]!
    expect(textOf(label)).toBe('Libreria')
    expect(label.parent).toBe(tabs[1])
    // appena aperto il pannello la sonda fase-design li trova entrambi
    const fresh = panel()
    expect(byTestid(fresh, 'bot-tab-activity')).toHaveLength(1)
    expect(byTestid(fresh, 'bot-tab-library')).toHaveLength(1)
  })

  it('il nome del bot è il titolo del pannello (text-title, 600, in Figtree) e la riga del modello è il bottone del sistema, tondo', () => {
    const root = panel()
    const name = first(root, (n) => n.tag === 'h2' && textOf(n) === 'Trello')
    for (const cls of ['text-title', 'font-semibold']) expect(has(name, cls), cls).toBe(true)
    expect(has(name, 'font-display')).toBe(false)
    const trigger = byTestid(root, 'bot-settings-trigger')[0]!
    expect(trigger.tag).toBe('button')
    expect(trigger.attrs['aria-label']).toBe('Impostazioni del bot')
    expect(trigger.attrs['title']).toBe('Impostazioni del bot')
    // l'anello del fuoco solo da tastiera
    expect(has(trigger, 'focus-visible:ring-2')).toBe(true)
    expect(clickFocus(trigger)).toBe(false)
    const model = byTestid(root, 'bot-model-row')[0]!
    expect(model.tag).toBe('button')
    expect(model.attrs['data-slot']).toBe('button')
    for (const cls of ['rounded-full', 'h-control-sm']) expect(has(model, cls), cls).toBe(true)
    // sta sotto il nome e sopra le schede (l'ordine del documento)
    expect(name.parent).toBe(trigger)
    const at = documentIndex(root)
    expect(at(trigger)).toBeLessThan(at(model))
    expect(at(model)).toBeLessThan(at(first(root, (n) => n.attrs.role === 'tablist')))
  })

  it('«Nessun modello» resta in colore d\'avviso: la classe vince sul grigio del bottone «testo»', () => {
    const none = byTestid(panel(), 'bot-model-row')[0]!
    expect(textOf(none)).toContain('Nessun modello')
    expect(has(none, 'text-waiting')).toBe(true)
    expect(has(none, 'text-muted-foreground')).toBe(false)
    const own = byTestid(panel({ agents: [agent({ providerId: 'p1', model: 'claude-4-5' })] }), 'bot-model-row')[0]!
    expect(textOf(own)).toContain('Anthropic · claude-4-5')
    expect(has(own, 'text-waiting')).toBe(false)
    expect(has(own, 'text-muted-foreground')).toBe(true)
  })

  it('Attività: i titoli di gruppo sono Section (caption grigio a 500, 12 px dal contenuto, nessun margine esterno)', () => {
    const root = panel()
    const head = byTestid(root, 'bot-settings-trigger')[0]!
    const titles = findAll(root, (n) => n.tag === 'h2' && !hasAncestor(n, (a) => a === head))
    expect(titles.map(textOf)).toEqual(['Routine', 'Ultimi lavori'])
    for (const h of titles) {
      for (const cls of ['text-caption', 'font-medium', 'text-muted-foreground']) expect(has(h, cls), cls).toBe(true)
      const section = h.parent!.parent!
      expect(section.tag).toBe('section')
      expect(has(section, 'gap-section-head')).toBe(true)
      expect(outerMargin(section)).toBe(false)
      expect(has(section.children[1]!, 'gap-block')).toBe(true)
    }
  })

  it('Attività: «Tutte ›» resta un <button> (la sonda di fase memoria apre il foglio del bot così) e il clic VERO apre le routine', () => {
    panel()
    // i figli del bottone: <Trans>Tutte</Trans> e il «›»
    const el = capture.els.find((e) => e.type === 'button' && Array.isArray(e.props.children) && (e.props.children as unknown[])[1] === ' ›')
    expect(el).toBeTruthy()
    ;(el!.props.onClick as () => void)()
    expect(useStore.getState().botSheetOpen).toBe(true)
    expect(useStore.getState().botSheetFocus).toBe('routines')
  })

  it('Attività: i lavori di oggi sono righe a filo DENTRO un <button> (clic, tastiera e nome accessibili del bottone) e il clic VERO apre il task', () => {
    const root = panel({
      tasks: [
        { id: 7, agentId: 'bot-1', title: 'Riepilogo del mese', status: 'done', createdAt: Date.now() },
        { id: 8, agentId: 'bot-1', title: 'Brief', status: 'working', createdAt: Date.now() }
      ]
    })
    const section = first(root, (n) => n.tag === 'h2' && textOf(n) === 'Ultimi lavori').parent!.parent!
    const list = section.children[1]!.children[0]!
    expect(has(list, 'divide-y')).toBe(true)
    // dal più recente (l'ordine di sempre: gli ultimi cinque, al contrario)
    const buttons = list.children.filter((n) => n.tag === 'button')
    expect(buttons.map(textOf)).toEqual(['Briefin corso', 'Riepilogo del mesecompletato'])
    for (const b of buttons) {
      expect(b.attrs.type).toBe('button')
      expect(clickFocus(b)).toBe(false)
      for (const cls of ['block', 'w-full', 'text-left', 'cursor-pointer']) expect(has(b, cls), cls).toBe(true)
      const row = b.children[0]!
      for (const cls of ['flex', 'w-full', 'items-center', 'gap-row-gap', 'py-row-pad', 'min-h-row-text']) expect(has(row, cls), cls).toBe(true)
      const title = row.children[0]!.children[0]!
      for (const cls of ['truncate', 'text-body', 'font-medium']) expect(has(title, cls), cls).toBe(true)
      const state = row.children[1]!.children[0]!
      for (const cls of ['text-caption', 'text-muted-foreground']) expect(has(state, cls), cls).toBe(true)
    }
    // il VERO handler del bottone (catturato dal runtime JSX): il bottone che ha dentro la riga «Riepilogo del mese»
    const el = capture.els.find((e) => e.type === 'button' && (e.props.children as { props?: { title?: unknown } } | null)?.props?.title === 'Riepilogo del mese')
    expect(el).toBeTruthy()
    ;(el!.props.onClick as () => void)()
    expect(useStore.getState().openTaskId).toBe(7)
  })

  it('Attività: la card «Computer» e la riga della preparazione sono un blocco solo, a 4 px; i blocchi a 16', () => {
    const setup = { phase: 'downloading', bytes: 250, total: 1000, buildPhase: null, error: null, startedAt: null, skipped: [], phaseStartedAt: null, neededBytes: 1 }
    const root = panel({ boxSetup: setup })
    const card = byTestid(root, 'bot-computer-card')[0]!
    const block = card.parent!
    expect(has(block, 'gap-1')).toBe(true)
    // il blocco è la card e la riga della preparazione, nient'altro
    expect(block.children.map((c) => c.attrs['data-testid'])).toEqual(['bot-computer-card', 'bot-prep-row'])
    expect(textOf(block)).toContain('In preparazione… 25%')
    expect(has(block.parent!, 'gap-4')).toBe(true)
  })

  it('la card «Computer» resta un div col ruolo di bottone: la superficie, l\'anello solo da tastiera, lo stato in text-caption — e il clic VERO chiede la scheda', () => {
    const root = panel({ boxInUse: false })
    const card = byTestid(root, 'bot-computer-card')[0]!
    expect(card.tag).toBe('div')
    expect(card.attrs.role).toBe('button')
    expect(card.attrs.tabindex).toBe('0')
    expect(has(card, 'rounded-surface')).toBe(true)
    expect(has(card, 'focus-visible:ring-2')).toBe(true)
    expect(clickFocus(card)).toBe(false)
    const status = byTestid(card, 'bot-computer-status')[0]!
    expect(textOf(status)).toBe('Non in uso')
    expect(has(status, 'text-caption')).toBe(true)
    // il titolo della card, il nome e l'icona: 12 px fra icona e testo, come le righe del sistema
    const title = first(card, (n) => textOf(n) === 'Computer')
    expect(has(title, 'font-medium')).toBe(true)
    expect(has(title.parent!, 'gap-row-gap')).toBe(true)
    // l'anteprima (col suo testid) sta DENTRO la card: la sonda la misura lì
    expect(byTestid(card, 'bot-computer-thumb')).toHaveLength(1)
    ;(rendered('bot-computer-card').props.onClick as () => void)()
    expect(useStore.getState().botPanelTabRequest).toBe('computer')
  })

  it('Libreria: i filtri Tutti · Pagine · Media sono tre bottoni del sistema, figli diretti (la sonda li prende in ordine: button:nth-child)', () => {
    const root = panel({ panelTab: 'library' })
    const filters = byTestid(root, 'bot-library-filters')[0]!
    const buttons = filters.children
    expect(buttons.map((b) => b.tag)).toEqual(['button', 'button', 'button'])
    expect(buttons.map(textOf)).toEqual(['Tutti', 'Pagine', 'Media'])
    // la scelta ha il fondo («secondary»), le altre no («ghost»)
    expect(buttons.map((b) => classes(b).includes('bg-muted'))).toEqual([true, false, false])
    for (const b of buttons) for (const cls of ['rounded-full', 'h-control-sm', 'text-body']) expect(has(b, cls), cls).toBe(true)
    // e tutto sta dentro il contenitore che la sonda legge (bot-library)
    expect(hasAncestor(filters, (n) => n.attrs['data-testid'] === 'bot-library')).toBe(true)
  })

  it('Membri: le righe sono FlatRow, «Togli» è un <button> col solo testo, e i testid che la sonda di fase squadra clicca restano sui bottoni', () => {
    const root = panel(WITH_GROUP)
    // la vista del team sta in una Section (la radice della sezione, due livelli sopra il contenitore col testid)
    const overview = byTestid(root, 'team-overview')
    expect(overview).toHaveLength(1)
    expect(overview[0]!.parent!.parent!.tag).toBe('section')
    // il principale coordina: nessun «Togli»; l'altro sì
    const togli = findAll(root, (n) => n.tag === 'button' && textOf(n) === 'Togli')
    expect(togli).toHaveLength(1)
    // il bottone sta nello slot di destra della riga; la riga è quella a filo del sistema
    const row = togli[0]!.parent!.parent!
    for (const cls of ['flex', 'w-full', 'items-center', 'gap-row-gap', 'py-row-pad']) expect(has(row, cls), cls).toBe(true)
    expect(textOf(row)).toBe('CapoTogli')
    // i testid che la sonda di fase squadra clicca: «button», così il clic della sonda (el.click()) li prende
    for (const testid of ['team-autonomy-open', 'team-archive']) {
      const el = byTestid(root, testid)
      expect(el).toHaveLength(1)
      expect(el[0]!.tag, testid).toBe('button')
    }
  })
})

describe('DS4 · il computer del bot', () => {
  const setup = (patch: Record<string, unknown>): Record<string, unknown> => ({
    phase: 'idle', bytes: null, total: null, buildPhase: null, error: null, startedAt: null, skipped: [], phaseStartedAt: null, neededBytes: 1, ...patch
  })
  const prep = (boxSetup: unknown, boxInUse: unknown = null): HtmlNode => {
    setStoreStateForRender(useStore, { boxSetup, boxInUse })
    return render(createElement(ComputerPrepRow))
  }

  it('la riga della preparazione è una Notice dentro la sua superficie, SENZA margine esterno (la distanza dalla card la decide il pannello)', () => {
    for (const state of [setup({ phase: 'downloading', bytes: 250, total: 1000 }), setup({ phase: 'awaiting-installer' }), setup({ phase: 'ready' })]) {
      const rows = byTestid(prep(state), 'bot-prep-row')
      expect(rows).toHaveLength(1)
      expect(has(rows[0]!, 'rounded-surface')).toBe(true)
      expect(outerMargin(rows[0]!)).toBe(false)
      expect(findAll(rows[0]!, (n) => 'data-notice' in n.attrs)).toHaveLength(1)
    }
  })

  it('a fine preparazione lo slot dell\'icona resta occupato (il testo non salta di posto quando sparisce la rotella): un segno di spunta lucide da 16', () => {
    const ready = byTestid(prep(setup({ phase: 'ready' })), 'bot-prep-row')[0]!
    expect(textOf(ready)).toBe('Pronto')
    const icons = findAll(ready, (n) => n.tag === 'svg')
    expect(icons).toHaveLength(1)
    expect(has(icons[0]!, 'lucide')).toBe(true)
    expect(has(icons[0]!, 'size-4')).toBe(true)
  })

  it('File e Attività del computer: l\'elenco che scorre è largo quanto il pannello (gutter su tutti e due i lati) col margine DENTRO', () => {
    const files = render(createElement(ComputerFiles, { agentId: 'bot-1', active: true }))
    // la barra del percorso, ferma: px-1.5 fuori e la colonna dentro
    const bar = first(files, (n) => n.tag === 'nav').parent!.parent!.parent!
    expect(has(bar, 'shrink-0')).toBe(true)
    expect(has(bar, 'px-1.5')).toBe(true)
    expect(guttersOf(bar)).toHaveLength(1)
    const list = files.children[0]!.children[files.children[0]!.children.length - 1]!.children[0]!
    for (const cls of ['overflow-y-auto', '[scrollbar-gutter:stable_both-edges]']) expect(has(list, cls), cls).toBe(true)
    expect(classes(list).some((c) => /^-?([pm][xytrbl]?|gap)-/.test(c))).toBe(false)
    const gutter = guttersOf(list)
    expect(gutter).toHaveLength(1)
    expect(gutter[0]!.parent).toBe(list)

    const activity = render(createElement(ComputerActivity, { agentId: 'bot-1', active: true }))
    const feed = activity.children[0]!.children[0]!
    for (const cls of ['overflow-y-auto', '[scrollbar-gutter:stable_both-edges]']) expect(has(feed, cls), cls).toBe(true)
    const g = guttersOf(feed)
    expect(g).toHaveLength(1)
    expect(g[0]!.parent).toBe(feed)
  })
})

describe('DS4 · la memoria del bot', () => {
  const memory = (): HtmlNode => {
    setStoreStateForRender(useStore, { memoryProgress: null, memoryFocusId: null })
    return render(createElement(MemoryPanel, { agentId: 'bot-1', onClose: () => undefined }))
  }

  it('il titolo non ha più l\'emoji: un\'icona lucide da 16 davanti a «Memoria di questo bot»; e nessun testo dell\'interfaccia porta emoji', () => {
    const root = memory()
    const h2 = first(root, (n) => n.tag === 'h2')
    expect(textOf(h2)).toBe('Memoria di questo bot')
    const icon = first(h2, (n) => n.tag === 'svg')
    expect(has(icon, 'lucide')).toBe(true)
    expect(has(icon, 'size-4')).toBe(true)
    const emoji = /[\p{Extended_Pictographic}]/u
    expect(findAll(root, (n) => emoji.test(n.text)).map((n) => n.text)).toEqual([])
    expect(findAll(root, (n) => Object.values(n.attrs).some((v) => emoji.test(v))).length).toBe(0)
  })

  it('il «✕» della memoria (che aveva per nome accessibile il solo segno) è un bottone d\'icona con il suo nome; la chiusura è quella VERA', () => {
    capture.els.length = 0
    let closed = 0
    setStoreStateForRender(useStore, { memoryProgress: null, memoryFocusId: null })
    const root = render(createElement(MemoryPanel, { agentId: 'bot-1', onClose: () => { closed += 1 } }))
    const close = first(root, (n) => n.tag === 'button' && n.attrs['aria-label'] === 'Chiudi la memoria')
    expect(close).toBeTruthy()
    expect(close.attrs['title']).toBe('Chiudi la memoria')
    expect(has(close, 'w-control-sm')).toBe(true)
    // il bottone d'icona è quadrato (32 × 32) con l'icona da 16 dentro
    const icon = first(close, (n) => n.tag === 'svg')
    expect(has(icon, 'size-4')).toBe(true)
    const el = capture.els.find((e) => e.props['aria-label'] === 'Chiudi la memoria')!
    ;(el.props.onClick as () => void)()
    expect(closed).toBe(1)
  })

  it('i filtri restano <button> col testo esatto (la sonda di fase memoria cerca «eliminate» così), e sono i bottoni del sistema', () => {
    const root = memory()
    const texts = findAll(root, (n) => n.tag === 'button').map(textOf)
    for (const label of ['del bot', 'condivise', 'tutte', 'core', 'log', 'attive', 'in attesa di conferma', 'eliminate', 'Cerca']) {
      expect(texts, `il bottone «${label}»`).toContain(label)
    }
    const filters = findAll(root, (n) => n.tag === 'button' && ['del bot', 'eliminate'].includes(textOf(n)))
    for (const b of filters) for (const cls of ['rounded-full', 'h-control-sm']) expect(has(b, cls), cls).toBe(true)
    // «del bot» è la scelta (fondo), «eliminate» no
    expect(classes(filters[0]!).includes('bg-muted')).toBe(true)
    expect(classes(filters[1]!).includes('bg-muted')).toBe(false)
  })

  it('i testi ai token: la descrizione e gli stati in text-small, il campo di ricerca alto 32 con il raggio dei campi', () => {
    const root = memory()
    const description = first(root, (n) => textOf(n).startsWith('Fatti e regole che il bot ricorda'))
    for (const cls of ['text-small', 'text-muted-foreground']) expect(has(description, cls), cls).toBe(true)
    const input = first(root, (n) => n.tag === 'input')
    for (const cls of ['h-control-sm', 'rounded-control', 'text-body']) expect(has(input, cls), cls).toBe(true)
    expect(has(input, 'focus-visible:ring-2')).toBe(true)
    expect(clickFocus(input)).toBe(false)
  })
})

describe('DS4 · le classi dei file del pannello, nel CSS vero compilato da Tailwind', () => {
  // i file con dell'interfaccia (screen-thumb.ts, bot-suggestions.ts e ipc-error.ts sono logica pura)
  const FILES = [
    'components/RightPanel.tsx', 'components/MemoryPanel.tsx', 'components/ComputerPanel.tsx', 'components/ComputerActivity.tsx',
    'components/ComputerFiles.tsx', 'components/ComputerTerminal.tsx', 'components/ComputerPrepRow.tsx', 'components/ScreenThumb.tsx',
    'lib/computer-card.ts'
  ]

  // i marcatori delle varianti (group-hover:, peer-…): una classe che non ha
  // una regola sua, serve ad accendere le varianti dei figli
  const NO_RULE = new Set(['group', 'peer'])
  // space-y-* e divide-* Tailwind li compila col selettore avvolto in
  // :where(…) — «:where(.divide-y > :not(:last-child)) {» — e deadClasses, che
  // cerca la riga che comincia col punto della classe, li leggerebbe come morti
  const wrappedSelector = (token: string): boolean => /^(space-[xy]-|divide-)/.test(token)

  it('nessuna è morta (un nome sbagliato sta nell\'HTML e non fa nulla: lo dice solo l\'output)', async () => {
    const tokens = new Set<string>()
    for (const file of FILES) {
      for (const value of stringsOf(readFileSync(join(SRC, file), 'utf8'))) {
        // le stesse stringhe che legge la guardia: le liste di classi (i commenti no)
        if (!isClassList(value)) continue
        for (const token of value.split(/\s+/)) if (token !== '' && !NO_RULE.has(token) && !wrappedSelector(token)) tokens.add(token)
      }
    }
    expect(tokens.size).toBeGreaterThan(100)
    const all = [...tokens]
    const css = await compileRenderer(all)
    expect(deadClasses(css, all)).toEqual([])
    // e il controllo vede davvero: un nome sbagliato è morto
    expect(deadClasses(css, [...all, 'h-controlsm', 'gap-row-gapp'])).toEqual(['h-controlsm', 'gap-row-gapp'])
  })
})
