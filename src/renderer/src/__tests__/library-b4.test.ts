// B4 (fase b20-bug): la LIBRERIA — Elimina, Archivia, anteprime pulite (qui la
// parte a COMPONENTI, resa senza DOM come le altre: react-dom/server, i testi
// reali in italiano, gli handler VERI catturati dal runtime JSX e invocati).
//   · il menu «⋯» su OGNI documento in griglia e in lista, con le sei voci
//     nell'ordine della spec: Apri · Rinomina · Fissa/Sblocca · Esporta ·
//     Archivia · Elimina (per una archiviata «Ripristina» al posto di Archivia);
//   · Elimina NON usa il confirm() del browser: la conferma dell'app (la
//     finestra di «Elimina?» della barra), con «Annulla» ed «Elimina»;
//   · Archivia: il filtro «Archiviati» in testa, la vista normale senza le
//     archiviate, il ripristino;
//   · la selezione multipla: la casella in lista, ⌘/Maiusc + clic, la barra
//     «N selezionati» con Archivia ed Elimina (UNA conferma che dice quanti);
//   · la pagina aperta (PageView) ha lo stesso «⋯», e una pagina archiviata
//     si legge ancora (titolo, avviso, Ripristina).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, dialogPassThroughMock, type HtmlNode } from './render-helper'
import { stubApiMethod, callsOf } from './render-helper-install'
import type { LibraryItemInfo, LibraryContentInfo, Agent } from '../../../shared/types'

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
// il menu si rende PASSANTE: le voci si vedono nell'HTML statico, come farebbe il menu APERTO
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

const PANEL_SRC = readFileSync(fileURLToPath(new URL('../components/LibraryPanel.tsx', import.meta.url)), 'utf8')
const PAGE_SRC = readFileSync(fileURLToPath(new URL('../components/PageView.tsx', import.meta.url)), 'utf8')

const { LibraryPanel, runLibraryAction } = await import('../components/LibraryPanel')
const { PageView } = await import('../components/PageView')
const { useStore } = await import('../store')

const item = (id: string, over: Partial<LibraryItemInfo> = {}): LibraryItemInfo => ({
  id, kind: 'document', title: id, authorAgentId: 'bot', createdAt: 1, updatedAt: 3,
  pinned: false, tainted: false, currentVersion: 1, chartKind: null, fileName: null, fileSize: null, fileMime: null,
  archived: false,
  ...over
})
const DOC = item('lib_1', { title: 'Pastiera napoletana' })
const DOC2 = item('lib_2', { title: 'Ricettario — indice', pinned: true })
const DOC3 = item('lib_3', { title: 'Brief della settimana' })
const ARCH = item('lib_z', { title: 'Vecchio progetto', archived: true, updatedAt: 9 })
const CHART = item('lib_c', { kind: 'chart', title: 'Vendite Q1', chartKind: 'vega-lite' })
const FILE = item('lib_f', { kind: 'file', title: 'Grafico esportato', fileName: 'grafico.png', fileSize: 12 })
const BOT: Agent = { id: 'bot', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 } as Agent

const CONTENT: LibraryContentInfo = {
  kind: 'document', content: '# Pastiera napoletana\n\nGrano, ricotta, cidro.', svg: null,
  fileBase64: null, fileMime: null, versions: [1], authorName: 'Competitoor'
}

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('libraryList', () => [])
  stubApiMethod('libraryStats', () => ({ bytes: 0, warn: false, warnBytes: 0 }))
  stubApiMethod('libraryArchive', () => ({ ok: true }))
  stubApiMethod('libraryDelete', () => ({ ok: true }))
  stubApiMethod('libraryRename', () => ({ ok: true }))
  stubApiMethod('libraryPin', () => ({ ok: true }))
  stubApiMethod('libraryExport', () => ({ ok: true, path: '', output: '' }))
})

const byId = (root: HtmlNode, id: string): HtmlNode[] => findAll(root, (n) => n.attrs['data-testid'] === id)
const el = (id: string) => capture.els.find((e) => e.props['data-testid'] === id)
/** Le chiamate a un metodo dell'api da qui in poi (il registro dell'api finta dura per tutto il file). */
const counter = (method: string): (() => unknown[][]) => {
  const from = callsOf(method).length
  return () => callsOf(method).slice(from).map((c) => c.args)
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const click = async (id: string): Promise<void> => {
  const props = el(id)?.props
  expect(props, `elemento con data-testid="${id}"`).toBeTruthy()
  ;(props!.onClick as (e?: unknown) => unknown)({ preventDefault() {}, stopPropagation() {} })
  await tick()
}

function renderLibrary(initial: Record<string, unknown> = {}): HtmlNode {
  capture.els.length = 0
  setStoreStateForRender(useStore, { openLibraryId: '', openPageInfo: null, agents: [BOT] })
  return parseHtml(renderHtml(createElement(LibraryPanel, { initial } as never)))
}
function renderPage(initial: Record<string, unknown> = {}, from: 'chat' | 'library' = 'library'): HtmlNode {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    openPageInfo: { id: initial.id ?? 'lib_1', from, title: '', version: 0 }, openLibraryId: null, agents: [BOT]
  })
  return parseHtml(renderHtml(createElement(PageView, { initial } as never)))
}

/** Le voci del menu di una voce (il contenitore del menu passante): testid → testo. */
const menuEntries = (root: HtmlNode, where: string, id: string): Array<[string, string]> => {
  const content = byId(root, `library-menu-content-${where}-${id}`)[0]
  expect(content, `menu library-menu-content-${where}-${id}`).toBeTruthy()
  return findAll(content!, (n) => {
    const t = n.attrs['data-testid'] ?? ''
    return (t.startsWith('library-menu-') && t !== `library-menu-content-${where}-${id}`) || t.startsWith('library-export-')
  }).map((n) => [n.attrs['data-testid']!, textOf(n)])
}
/** Le SEI voci (senza i formati dentro «Esporta»). */
const six = (root: HtmlNode, where: string, id: string): string[] =>
  menuEntries(root, where, id).filter(([t]) => !t.startsWith('library-export-')).map(([, text]) => text)
const cardIds = (root: HtmlNode, what: 'card' | 'row'): (string | undefined)[] =>
  findAll(root, (n) => n.attrs['data-testid'] === `library-${what}`).map((n) => n.attrs['data-id'])

describe('B4 render: il menu «⋯» di ogni documento', () => {
  it('in GRIGLIA ogni voce ha il suo «⋯» (aria-label «Altre azioni») dentro la propria card', () => {
    const root = renderLibrary({ items: [DOC, DOC2, CHART, FILE] })
    expect(cardIds(root, 'card')).toEqual(['lib_2', 'lib_1', 'lib_c', 'lib_f'])
    for (const i of [DOC, DOC2, CHART, FILE]) {
      const trigger = byId(root, `library-menu-grid-${i.id}`)[0]
      expect(trigger, `menu di ${i.id}`).toBeTruthy()
      expect(trigger!.tag).toBe('button')
      expect(trigger!.attrs['aria-label']).toBe('Altre azioni')
      expect(trigger!.attrs['aria-haspopup']).toBe('menu')
      // dentro la card della stessa voce
      expect(hasTestidAncestor(trigger!, 'library-card', `data-id`, i.id)).toBe(true)
    }
  })

  it('in LISTA ogni voce ha il suo «⋯» dentro la propria riga', () => {
    const root = renderLibrary({ items: [DOC, CHART], view: 'list' })
    expect(cardIds(root, 'row')).toEqual(['lib_1', 'lib_c'])
    for (const i of [DOC, CHART]) {
      const trigger = byId(root, `library-menu-list-${i.id}`)[0]
      expect(trigger, `menu di ${i.id}`).toBeTruthy()
      expect(trigger!.attrs['aria-label']).toBe('Altre azioni')
      expect(hasTestidAncestor(trigger!, 'library-row', 'data-id', i.id)).toBe(true)
    }
  })

  it('le SEI voci nell\'ordine della spec, in griglia e in lista: Apri · Rinomina · Fissa · Esporta · Archivia · Elimina', () => {
    expect(six(renderLibrary({ items: [DOC] }), 'grid', 'lib_1')).toEqual(['Apri', 'Rinomina', 'Fissa', 'Esporta', 'Archivia', 'Elimina'])
    expect(six(renderLibrary({ items: [DOC], view: 'list' }), 'list', 'lib_1')).toEqual(['Apri', 'Rinomina', 'Fissa', 'Esporta', 'Archivia', 'Elimina'])
    // i testid delle voci (per la sonda): uno per voce, con l'id
    const root = renderLibrary({ items: [DOC] })
    expect(menuEntries(root, 'grid', 'lib_1').map(([t]) => t)).toEqual([
      'library-menu-open-lib_1', 'library-menu-rename-lib_1', 'library-menu-pin-lib_1', 'library-menu-export-lib_1',
      'library-export-md-lib_1', 'library-export-html-lib_1', 'library-export-pdf-lib_1',
      'library-menu-archive-lib_1', 'library-menu-delete-lib_1'
    ])
  })

  it('«Fissa» diventa «Sblocca» per una voce fissata, e fissa/sblocca al contrario di com\'è', async () => {
    expect(six(renderLibrary({ items: [DOC2] }), 'grid', 'lib_2')[2]).toBe('Sblocca')
    expect(six(renderLibrary({ items: [DOC2], view: 'list' }), 'list', 'lib_2')[2]).toBe('Sblocca')
    // fissa/sblocca al contrario di com'è
    const pins = counter('libraryPin')
    renderLibrary({ items: [DOC2] })
    await click('library-menu-pin-lib_2')
    renderLibrary({ items: [DOC] })
    await click('library-menu-pin-lib_1')
    expect(pins()).toEqual([['lib_2', false], ['lib_1', true]])
  })

  it('«Esporta»: per un documento apre i formati (md · html · pdf), per grafici e file è una voce sola', async () => {
    const chart = renderLibrary({ items: [CHART, FILE] })
    expect(six(chart, 'grid', 'lib_c')).toEqual(['Apri', 'Rinomina', 'Fissa', 'Esporta', 'Archivia', 'Elimina'])
    expect(menuEntries(chart, 'grid', 'lib_c').map(([t]) => t)).toEqual([
      'library-menu-open-lib_c', 'library-menu-rename-lib_c', 'library-menu-pin-lib_c', 'library-menu-export-lib_c',
      'library-menu-archive-lib_c', 'library-menu-delete-lib_c'
    ])
    expect(six(chart, 'grid', 'lib_f')[3]).toBe('Esporta')
    // ogni formato chiama library:export con la sua voce
    const exports = counter('libraryExport')
    renderLibrary({ items: [DOC] })
    await click('library-export-pdf-lib_1')
    renderLibrary({ items: [CHART] })
    await click('library-menu-export-lib_c')
    expect(exports()).toEqual([['lib_1', 'pdf'], ['lib_c', 'svg']])
  })

  it('le azioni chiamano le RPC giuste: Apri apre, Archivia archivia (e poi si rilegge la libreria)', async () => {
    // Apri su un documento: apre la PAGINA e chiude la lista
    renderLibrary({ items: [DOC] })
    await click('library-menu-open-lib_1')
    expect(useStore.getState().openPageInfo?.id).toBe('lib_1')
    expect(useStore.getState().openPageInfo?.from).toBe('library')
    expect(useStore.getState().openLibraryId).toBeNull()
    // Apri su un grafico: apre la sua vista nella libreria
    renderLibrary({ items: [CHART] })
    await click('library-menu-open-lib_c')
    expect(useStore.getState().openLibraryId).toBe('lib_c')
    expect(useStore.getState().openPageInfo).toBeNull()
    // Archivia: library:archive(id, true), poi la lista si rilegge
    const archives = counter('libraryArchive')
    const lists = counter('libraryList')
    renderLibrary({ items: [DOC] })
    await click('library-menu-archive-lib_1')
    expect(archives()).toEqual([['lib_1', true]])
    expect(lists().length).toBeGreaterThanOrEqual(1)
  })

  it('il clic sulla card (il bottone che apre) apre ancora la pagina', async () => {
    renderLibrary({ items: [DOC] })
    setStoreStateForRender(useStore, { openPageInfo: null })
    const props = el('library-open-lib_1')!.props
    ;(props.onClick as (e: unknown) => void)({ shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {} })
    expect(useStore.getState().openPageInfo?.id).toBe('lib_1')
  })
})

describe('B4 render: Elimina — la conferma dell\'app, mai il confirm() del browser', () => {
  it('«Elimina» del menu NON cancella subito: prima chiede la conferma (e nel sorgente non c\'è nessun confirm() nativo)', async () => {
    const deletes = counter('libraryDelete')
    const root = renderLibrary({ items: [DOC] })
    // la finestra non c'è finché non la si chiede
    expect(byId(root, 'library-delete-confirm')).toHaveLength(0)
    expect(byId(root, 'library-delete-confirm-ok')).toHaveLength(0)
    await click('library-menu-delete-lib_1')
    expect(deletes()).toEqual([])
    for (const src of [PANEL_SRC, PAGE_SRC]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code).not.toMatch(/(^|[^.\w])confirm\(/)
      expect(code).not.toMatch(/window\.confirm/)
    }
  })

  it('la conferma di UNA voce: «Eliminare «Pastiera napoletana»? Non si può annullare.» — «Elimina» chiama library:delete una volta sola e rilegge', async () => {
    const deletes = counter('libraryDelete')
    const root = renderLibrary({ items: [DOC], confirmDeleteId: 'lib_1' })
    const dialog = byId(root, 'library-delete-confirm')[0]
    expect(dialog).toBeTruthy()
    // il testo della spec, in una finestra: titolo + cosa succede, poi Annulla ed Elimina
    expect(confirmParts(root)).toEqual(CONFERMA_UNA)
    const ok = byId(root, 'library-delete-confirm-ok')[0]!
    expect(textOf(ok)).toBe('Elimina')
    // la voce è rossa (destructive), Annulla no
    expect((ok.attrs.class ?? '')).toContain('text-destructive')
    const lists = counter('libraryList')
    await click('library-delete-confirm-ok')
    expect(deletes()).toEqual([['lib_1']])
    expect(lists().length).toBeGreaterThanOrEqual(1)
  })

  it('«Annulla» ritira la domanda: nessuna chiamata a library:delete', async () => {
    const deletes = counter('libraryDelete')
    renderLibrary({ items: [DOC], confirmDeleteId: 'lib_1' })
    await click('library-delete-confirm-cancel')
    expect(deletes()).toEqual([])
  })

  it('in LISTA è la stessa conferma (stessi testid, stesso testo)', () => {
    const root = renderLibrary({ items: [DOC], view: 'list', confirmDeleteId: 'lib_1' })
    expect(confirmParts(root)).toEqual(CONFERMA_UNA)
    expect(byId(root, 'library-delete-confirm-ok')).toHaveLength(1)
    expect(byId(root, 'library-delete-confirm-cancel')).toHaveLength(1)
  })

  it('un\'eliminazione che fallisce (la voce non c\'è più) non resta muta: l\'errore va nella riga d\'errore della lista', () => {
    const pulita = renderLibrary({ items: [DOC] })
    expect(byId(pulita, 'library-error')).toHaveLength(0)
    const conErrore = renderLibrary({ items: [DOC], error: 'voce non trovata' })
    expect(textOf(byId(conErrore, 'library-error')[0]!)).toBe('voce non trovata')
    // l\'errore è solo un rigo: la lista resta al suo posto
    expect(cardIds(conErrore, 'card')).toEqual(['lib_1'])
  })

  it('un\'azione su più voci con UNA che fallisce: le altre si fanno lo stesso, e gli errori tornano a chi li mostra', async () => {
    const fatte: string[] = []
    const apiFinta = {
      libraryDelete: async (id: string) => { fatte.push(id); if (id === 'lib_2') throw new Error('voce non trovata'); return { ok: true } },
      libraryArchive: async (id: string, archived: boolean) => { fatte.push(`${id}:${archived}`); if (archived) throw 'errore non Error'; return { ok: true } }
    }
    expect(await runLibraryAction(apiFinta, ['lib_1', 'lib_2', 'lib_3'], 'delete')).toEqual([{ id: 'lib_2', error: 'voce non trovata' }])
    expect(fatte).toEqual(['lib_1', 'lib_2', 'lib_3'])
    fatte.length = 0
    expect(await runLibraryAction(apiFinta, ['lib_1', 'lib_2'], 'archive')).toEqual([
      { id: 'lib_1', error: 'errore non Error' }, { id: 'lib_2', error: 'errore non Error' }
    ])
    expect(await runLibraryAction(apiFinta, ['lib_1'], 'restore')).toEqual([])
    expect(fatte).toEqual(['lib_1:true', 'lib_2:true', 'lib_1:false'])
    // lista vuota: niente
    expect(await runLibraryAction(apiFinta, [], 'delete')).toEqual([])
  })
})

describe('B4 render: Archivia e il filtro «Archiviati»', () => {
  it('il filtro «Archiviati» è in testa, accanto agli altri filtri: un interruttore (aria-pressed), spento di default', () => {
    const root = renderLibrary({ items: [DOC] })
    const toggle = byId(root, 'library-filter-archived')[0]
    expect(toggle).toBeTruthy()
    expect(toggle!.tag).toBe('button')
    expect(toggle!.attrs['aria-pressed']).toBe('false')
    expect(textOf(toggle!)).toBe('Archiviati')
    expect(typeof el('library-filter-archived')!.props.onClick).toBe('function')
  })

  it('nella vista normale le archiviate NON si vedono (nemmeno se la lista le contiene)', () => {
    const root = renderLibrary({ items: [DOC, ARCH] })
    expect(cardIds(root, 'card')).toEqual(['lib_1'])
    expect(textOf(root)).not.toContain('Vecchio progetto')
  })

  it('col filtro acceso (aria-pressed="true"): SOLO le archiviate, col «Ripristina» al posto di «Archivia»', () => {
    const root = renderLibrary({ items: [DOC, ARCH], archived: true })
    expect(byId(root, 'library-filter-archived')[0]!.attrs['aria-pressed']).toBe('true')
    expect(cardIds(root, 'card')).toEqual(['lib_z'])
    expect(six(root, 'grid', 'lib_z')).toEqual(['Apri', 'Rinomina', 'Fissa', 'Esporta', 'Ripristina', 'Elimina'])
    expect(byId(root, 'library-menu-archive-lib_z')).toHaveLength(0)
    expect(byId(root, 'library-menu-restore-lib_z')).toHaveLength(1)
  })

  it('nessuna archiviata: lo dice, con una frase sua (non quella della libreria vuota)', () => {
    const root = renderLibrary({ items: [DOC], archived: true })
    expect(textOf(root)).toContain('Nessun documento archiviato.')
    expect(textOf(root)).not.toContain('La libreria è vuota')
    const normale = renderLibrary({ items: [DOC] })
    expect(textOf(normale)).not.toContain('Nessun documento archiviato.')
  })

  it('«Ripristina» del menu chiama library:archive(id, false) e rilegge la lista', async () => {
    const archives = counter('libraryArchive')
    const lists = counter('libraryList')
    renderLibrary({ items: [DOC, ARCH], archived: true })
    await click('library-menu-restore-lib_z')
    expect(archives()).toEqual([['lib_z', false]])
    expect(lists().length).toBeGreaterThanOrEqual(1)
  })

  it('i filtri di bot e di tipo valgono anche tra gli archiviati; la ricerca pure', () => {
    const root = renderLibrary({
      items: [ARCH, item('lib_z2', { title: 'Altro vecchio', archived: true, kind: 'chart', authorAgentId: 'altro' })],
      archived: true
    })
    // senza escolte si vedono entrambe; il filtro per bot (C3: la pillola-menu) offre i bot che hanno voci in questa vista
    expect(cardIds(root, 'card')).toEqual(['lib_z', 'lib_z2'])
    const voci = findAll(root, (n) => (n.attrs['data-mock'] ?? '') === 'dropdown-item').map((o) => textOf(o)).slice(0, 3)
    expect(voci).toEqual(['Tutti i bot', 'Competitoor', 'altro'])
  })
})

describe('B4 render: Rinomina', () => {
  it('«Rinomina» del menu apre la finestra di rinomina: non chiama la RPC', async () => {
    const renames = counter('libraryRename')
    renderLibrary({ items: [DOC] })
    await click('library-menu-rename-lib_1')
    expect(renames()).toEqual([])
  })

  it('la finestra: il titolo di partenza nell\'input; «Salva» chiama library:rename col titolo scritto e rilegge; «Annulla» no', async () => {
    const renames = counter('libraryRename')
    const root = renderLibrary({ items: [DOC], rename: { id: 'lib_1', title: 'Pastiera della domenica' } })
    const dialog = byId(root, 'library-rename-dialog')[0]
    expect(dialog).toBeTruthy()
    expect(textOf(dialog!)).toContain('Rinomina')
    const input = byId(root, 'library-rename-input')[0]!
    expect(input.tag).toBe('input')
    expect(input.attrs.value).toBe('Pastiera della domenica')
    await click('library-rename-save')
    expect(renames()).toEqual([['lib_1', 'Pastiera della domenica']])
    renderLibrary({ items: [DOC], rename: { id: 'lib_1', title: 'Pastiera della domenica' } })
    await click('library-rename-cancel')
    expect(renames()).toEqual([['lib_1', 'Pastiera della domenica']])
  })

  it('un titolo vuoto o uguale a quello di ora non chiama la RPC', async () => {
    const renames = counter('libraryRename')
    renderLibrary({ items: [DOC], rename: { id: 'lib_1', title: '   ' } })
    await click('library-rename-save')
    renderLibrary({ items: [DOC], rename: { id: 'lib_1', title: 'Pastiera napoletana' } })
    await click('library-rename-save')
    expect(renames()).toEqual([])
  })
})

describe('B4 render: la selezione multipla', () => {
  it('in LISTA ogni riga ha la casella (checkbox, «Seleziona <titolo>»); in GRIGLIA no — si seleziona con ⌘/Maiusc + clic', () => {
    const lista = renderLibrary({ items: [DOC, DOC2], view: 'list' })
    const boxes = findAll(lista, (n) => (n.attrs['data-testid'] ?? '').startsWith('library-select-'))
    expect(boxes.map((b) => b.attrs['data-testid'])).toEqual(['library-select-lib_2', 'library-select-lib_1'])
    for (const b of boxes) {
      expect(b.tag).toBe('input')
      expect(b.attrs.type).toBe('checkbox')
      expect(b.attrs['aria-label']).toBe(`Seleziona ${b.attrs['data-testid'] === 'library-select-lib_1' ? 'Pastiera napoletana' : 'Ricettario — indice'}`)
      expect(b.attrs.checked).toBeUndefined()
    }
    const griglia = renderLibrary({ items: [DOC, DOC2] })
    expect(findAll(griglia, (n) => n.attrs.type === 'checkbox')).toHaveLength(0)
  })

  it('un clic normale apre la pagina; ⌘-clic, Ctrl-clic e Maiusc-clic NON aprono (selezionano)', () => {
    const ev = (mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) => ({ shiftKey: false, metaKey: false, ctrlKey: false, ...mods, preventDefault() {}, stopPropagation() {} })
    for (const view of ['grid', 'list'] as const) {
      for (const mods of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
        renderLibrary({ items: [DOC], view })
        ;(el('library-open-lib_1')!.props.onClick as (e: unknown) => void)(ev(mods))
        expect(useStore.getState().openPageInfo, `${view} ${JSON.stringify(mods)}`).toBeNull()
      }
      renderLibrary({ items: [DOC], view })
      ;(el('library-open-lib_1')!.props.onClick as (e: unknown) => void)(ev({}))
      expect(useStore.getState().openPageInfo?.id, view).toBe('lib_1')
      setStoreStateForRender(useStore, { openPageInfo: null })
    }
  })

  it('un clic di selezione non fa anche la selezione del TESTO del browser (Maiusc-clic non tinge mezza lista): preventDefault al mousedown, solo coi modificatori', () => {
    for (const view of ['grid', 'list'] as const) {
      renderLibrary({ items: [DOC], view })
      const onMouseDown = el('library-open-lib_1')!.props.onMouseDown as ((e: unknown) => void) | undefined
      expect(onMouseDown, view).toBeTypeOf('function')
      const ev = (mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) => {
        const called: boolean[] = []
        return { shiftKey: false, metaKey: false, ctrlKey: false, ...mods, preventDefault: () => { called.push(true) }, called }
      }
      for (const mods of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }]) {
        const e = ev(mods)
        onMouseDown!(e)
        expect(e.called, `${view} ${JSON.stringify(mods)}`).toEqual([true])
      }
      const normale = ev({})
      onMouseDown!(normale)
      expect(normale.called, view).toEqual([])
    }
  })

  it('il clic passa da libraryClickIntent e cambia la selezione con librarySelectionAfter (guardia sul sorgente)', () => {
    expect(PANEL_SRC).toMatch(/libraryClickIntent\(/)
    expect(PANEL_SRC).toMatch(/librarySelectionAfter\(/)
    // il bottone che apre (griglia e lista) legge i modificatori dall\'evento
    expect(PANEL_SRC).toMatch(/onClick=\{\(e\) => onItemOpen\(e, i\)\}/)
  })

  it('con DUE selezionate compare la barra: «2 selezionati», Archivia, Elimina, esci dalla selezione — in griglia e in lista', () => {
    for (const view of ['grid', 'list'] as const) {
      const root = renderLibrary({ items: [DOC, DOC2, DOC3], view, selected: ['lib_1', 'lib_2'] })
      const bar = byId(root, 'library-bulk-bar')[0]
      expect(bar, view).toBeTruthy()
      expect(textOf(bar!)).toContain('2 selezionati')
      expect(textOf(byId(root, 'library-bulk-archive')[0]!)).toBe('Archivia')
      for (const id of ['library-bulk-archive', 'library-bulk-delete', 'library-selection-clear']) expect(byId(root, id), `${view}: ${id}`).toHaveLength(1)
      expect(textOf(byId(root, 'library-bulk-delete')[0]!)).toBe('Elimina')
      expect((byId(root, 'library-bulk-delete')[0]!.attrs.class ?? '')).toContain('text-destructive')
      expect(el('library-selection-clear')!.props['aria-label'] ?? el('library-selection-clear')!.props.title).toBe('Esci dalla selezione')
      // in lista le caselle delle due selezionate sono spunte
      if (view === 'list') {
        expect(byId(root, 'library-select-lib_1')[0]!.attrs.checked).toBeDefined()
        expect(byId(root, 'library-select-lib_2')[0]!.attrs.checked).toBeDefined()
        expect(byId(root, 'library-select-lib_3')[0]!.attrs.checked).toBeUndefined()
      }
    }
  })

  it('con UNA selezionata (o nessuna) la barra non c\'è: dalla spec compare da due in su', () => {
    for (const selected of [[], ['lib_1']]) {
      const root = renderLibrary({ items: [DOC, DOC2, DOC3], selected })
      expect(byId(root, 'library-bulk-bar'), JSON.stringify(selected)).toHaveLength(0)
    }
  })

  it('valgono solo le voci che si vedono: due selezionate di cui una nascosta dal filtro → niente barra', () => {
    const root = renderLibrary({ items: [DOC, ARCH], selected: ['lib_1', 'lib_z'] })
    expect(byId(root, 'library-bulk-bar')).toHaveLength(0)
  })

  it('«Archivia» della barra chiama library:archive(id, true) per OGNI selezionata, poi rilegge la lista', async () => {
    const archives = counter('libraryArchive')
    const lists = counter('libraryList')
    renderLibrary({ items: [DOC, DOC2, DOC3], selected: ['lib_1', 'lib_3'] })
    await click('library-bulk-archive')
    expect(archives()).toEqual([['lib_1', true], ['lib_3', true]])
    expect(lists().length).toBeGreaterThanOrEqual(1)
    expect(counter('libraryDelete')()).toEqual([])
  })

  it('«Elimina» della barra NON cancella subito: UNA conferma che dice QUANTI — «Eliminare 2 voci? Non si può annullare.»', async () => {
    const deletes = counter('libraryDelete')
    renderLibrary({ items: [DOC, DOC2], selected: ['lib_1', 'lib_2'] })
    await click('library-bulk-delete')
    expect(deletes()).toEqual([])
    const root = renderLibrary({ items: [DOC, DOC2], selected: ['lib_1', 'lib_2'], confirmDeleteIds: ['lib_1', 'lib_2'] })
    expect(confirmParts(root)).toEqual({ title: 'Eliminare 2 voci?', description: 'Non si può annullare.', buttons: ['Annulla', 'Elimina'] })
    // UNA finestra sola, non una per voce
    expect(byId(root, 'library-delete-confirm')).toHaveLength(1)
    await click('library-delete-confirm-ok')
    expect(deletes()).toEqual([['lib_1'], ['lib_2']])
    // annullata: niente
    renderLibrary({ items: [DOC, DOC2], selected: ['lib_1', 'lib_2'], confirmDeleteIds: ['lib_1', 'lib_2'] })
    await click('library-delete-confirm-cancel')
    expect(deletes()).toEqual([['lib_1'], ['lib_2']])
  })

  it('tra gli archiviati la barra dice «Ripristina» e chiama library:archive(id, false)', async () => {
    const archives = counter('libraryArchive')
    const root = renderLibrary({
      items: [ARCH, item('lib_z2', { title: 'Altro vecchio', archived: true })], archived: true, selected: ['lib_z', 'lib_z2']
    })
    expect(byId(root, 'library-bulk-archive')).toHaveLength(0)
    expect(textOf(byId(root, 'library-bulk-restore')[0]!)).toBe('Ripristina')
    await click('library-bulk-restore')
    expect(archives()).toEqual([['lib_z', false], ['lib_z2', false]])
  })

  it('«Esci dalla selezione» e Esc svuotano la selezione (guardia sul sorgente: l\'ascolto di Escape c\'è solo finché c\'è una selezione)', () => {
    expect(PANEL_SRC).toMatch(/e\.key (!==|===) 'Escape'/)
    expect(PANEL_SRC).toMatch(/librarySelectionVisible\(/)
  })
})

describe('B4 render: la pagina aperta (PageView)', () => {
  const pageItems = (initial: Record<string, unknown>): string[] =>
    menuEntries(renderPage(initial), 'page', 'lib_1').map(([, text]) => text)

  it('in testa c\'è anche il «⋯» del documento: Rinomina · Fissa · Archivia · Elimina (è già aperta; «Esporta» resta al suo posto)', () => {
    const root = renderPage({ content: CONTENT, item: DOC })
    expect(byId(root, 'page-view')).toHaveLength(1)
    expect(byId(root, 'library-menu-page-lib_1')).toHaveLength(1)
    expect(byId(root, 'page-export')).toHaveLength(1)
    expect(pageItems({ content: CONTENT, item: DOC })).toEqual(['Rinomina', 'Fissa', 'Archivia', 'Elimina'])
    // i testid
    expect(menuEntries(root, 'page', 'lib_1').map(([t]) => t)).toEqual([
      'library-menu-rename-lib_1', 'library-menu-pin-lib_1', 'library-menu-archive-lib_1', 'library-menu-delete-lib_1'
    ])
  })

  it('«Fissa» diventa «Sblocca»; «Archivia» chiama library:archive(id, true)', async () => {
    expect(pageItems({ content: CONTENT, item: { ...DOC, pinned: true } })).toEqual(['Rinomina', 'Sblocca', 'Archivia', 'Elimina'])
    renderPage({ content: CONTENT, item: DOC })
    await click('library-menu-archive-lib_1')
    expect(callsOf('libraryArchive').at(-1)!.args).toEqual(['lib_1', true])
  })

  it('una pagina ARCHIVIATA si legge ancora: il titolo è giusto (non l\'id), c\'è l\'avviso e «Ripristina» la riporta in Libreria', async () => {
    const root = renderPage({ content: CONTENT, item: ARCH, id: 'lib_z' })
    expect(byId(root, 'page-view')).toHaveLength(1)
    expect(textOf(byId(root, 'page-title-pill')[0]!)).toBe('Vecchio progetto')
    const notice = byId(root, 'page-archived-notice')[0]
    expect(notice).toBeTruthy()
    expect(textOf(notice!)).toContain('Archiviata')
    expect(menuEntries(root, 'page', 'lib_z').find(([t]) => t === 'library-menu-restore-lib_z')![1]).toBe('Ripristina')
    await click('page-restore')
    expect(callsOf('libraryArchive').at(-1)!.args).toEqual(['lib_z', false])
  })

  it('una pagina NON archiviata non ha l\'avviso', () => {
    expect(byId(renderPage({ content: CONTENT, item: DOC }), 'page-archived-notice')).toHaveLength(0)
  })

  it('Elimina dalla pagina: la conferma; confermata, la pagina si chiude e si torna dov\'era (in Libreria se veniva da lì)', async () => {
    const deletes = counter('libraryDelete')
    renderPage({ content: CONTENT, item: DOC })
    await click('library-menu-delete-lib_1')
    expect(deletes()).toEqual([])
    const root = renderPage({ content: CONTENT, item: DOC, confirmDelete: true }, 'library')
    expect(confirmParts(root)).toEqual(CONFERMA_UNA)
    await click('library-delete-confirm-ok')
    expect(deletes()).toEqual([['lib_1']])
    expect(useStore.getState().openPageInfo).toBeNull()
    expect(useStore.getState().openLibraryId).toBe('')
    // veniva dalla chat: si torna in chat, la Libreria non si apre
    renderPage({ content: CONTENT, item: DOC, confirmDelete: true }, 'chat')
    await click('library-delete-confirm-ok')
    expect(deletes()).toEqual([['lib_1'], ['lib_1']])
    expect(useStore.getState().openPageInfo).toBeNull()
    expect(useStore.getState().openLibraryId).toBeNull()
  })

  it('il documento si cerca ANCHE tra gli archiviati (library:list … \'all\'), così un link a una pagina archiviata la apre (guardia sul sorgente)', () => {
    expect(PAGE_SRC).toContain("api.libraryList(undefined, undefined, 'all')")
  })

  it('il «⋯» sta nella fascia che TRASCINA la finestra: il bottone è no-drag (come la ✕ e «Esporta»), o il clic trascinerebbe la finestra', () => {
    renderPage({ content: CONTENT, item: DOC })
    for (const where of ['page']) {
      const trigger = el(`library-menu-${where}-lib_1`)!
      expect(String(trigger.props.className).split(/\s+/), where).toContain('no-drag')
    }
    // e lo è OVUNQUE stia (griglia, lista, vista della voce): lo decide il bottone, non chi lo piazza
    for (const initial of [{ items: [DOC] }, { items: [DOC], view: 'list' }]) {
      renderLibrary(initial)
      expect(String(el(initial.view === 'list' ? 'library-menu-list-lib_1' : 'library-menu-grid-lib_1')!.props.className).split(/\s+/)).toContain('no-drag')
    }
  })
})

/** La finestra di conferma di Elimina, a pezzi (il mock passante dei dialoghi mette data-mock="dialog-title"…): titolo, descrizione, bottoni. */
function confirmParts(root: HtmlNode): { title: string; description: string; buttons: string[] } {
  const dialog = byId(root, 'library-delete-confirm')[0]!
  const part = (mock: string): string => textOf(findAll(dialog, (n) => n.attrs['data-mock'] === mock)[0]!)
  return {
    title: part('dialog-title'),
    description: part('dialog-description'),
    buttons: findAll(dialog, (n) => n.tag === 'button').map(textOf)
  }
}
const CONFERMA_UNA = { title: 'Eliminare «Pastiera napoletana»?', description: 'Non si può annullare.', buttons: ['Annulla', 'Elimina'] }

/** Il nodo ha un antenato con quel data-testid e quell\'attributo? */
function hasTestidAncestor(node: HtmlNode, testid: string, attr: string, value: string): boolean {
  for (let a = node.parent; a; a = a.parent) {
    if (a.attrs['data-testid'] === testid && a.attrs[attr] === value) return true
  }
  return false
}
