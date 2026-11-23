// B4 (fase b20-bug): le funzioni PURE della Libreria attorno ad Archivia ed
// Elimina — le righe della vista (gli archiviati SPARISCONO dalla vista
// normale e stanno solo nel filtro «Archiviati»), gli argomenti di
// library:list per quel filtro, e la selezione multipla: a che intento porta
// un clic (normale, ⌘/Ctrl, Maiusc) e come cambia la selezione (uno alla
// volta, o l'intervallo dall'ancora nell'ordine in cui le voci si vedono).
// Nessun DOM: il componente è un rivestimento sottile di queste.
import { describe, expect, it } from 'vitest'
import {
  libraryRows, libraryListArgs, libraryClickIntent, librarySelectionAfter, librarySelectionVisible,
  LIBRARY_SELECTION_EMPTY,
  type LibrarySelection
} from '../library-view'
import type { LibraryItemInfo } from '../../../../shared/types'

const item = (id: string, over: Partial<LibraryItemInfo> = {}): LibraryItemInfo => ({
  id, kind: 'document', title: id, authorAgentId: 'bot', createdAt: 1, updatedAt: 10,
  pinned: false, tainted: false, currentVersion: 1, chartKind: null, fileName: null, fileSize: null, fileMime: null,
  ...over
})
// a (vecchio), b (fissato), c (il più recente), z (archiviato, il più recente di tutti)
const ITEMS = [
  item('a', { updatedAt: 10 }),
  item('b', { updatedAt: 20, pinned: true }),
  item('c', { updatedAt: 30 }),
  item('z', { updatedAt: 40, archived: true })
]
const ids = (rows: LibraryItemInfo[]): string[] => rows.map((r) => r.id)
const sel = (selected: string[], anchor: string | null = null): LibrarySelection => ({ selected: new Set(selected), anchor })
const out = (s: LibrarySelection): { selected: string[]; anchor: string | null } => ({ selected: [...s.selected].sort(), anchor: s.anchor })

describe('B4: libraryRows — gli archiviati spariscono dalla vista normale', () => {
  it('vista normale (default): le voci archiviate NON ci sono; l\'ordine resta fissati in cima, poi updatedAt', () => {
    expect(ids(libraryRows(ITEMS, '', ''))).toEqual(['b', 'c', 'a'])
  })

  it('filtro «Archiviati»: SOLO le archiviate (stessi filtri di bot e tipo, stesso ordine)', () => {
    expect(ids(libraryRows(ITEMS, '', '', true))).toEqual(['z'])
    expect(ids(libraryRows([...ITEMS, item('z2', { updatedAt: 5, archived: true }), item('zp', { updatedAt: 1, archived: true, pinned: true })], '', '', true)))
      .toEqual(['zp', 'z', 'z2'])
    // il filtro per tipo vale anche qui
    expect(ids(libraryRows([...ITEMS, item('grafico', { kind: 'chart', archived: true })], '', 'chart', true))).toEqual(['grafico'])
  })

  it('una voce senza il campo `archived` (record vecchio, chiamante di oggi) NON è archiviata', () => {
    const vecchio = item('v')
    expect('archived' in vecchio).toBe(false)
    expect(ids(libraryRows([vecchio], '', ''))).toEqual(['v'])
    expect(ids(libraryRows([vecchio], '', '', true))).toEqual([])
  })

  it('il filtro per bot e per tipo continuano a funzionare nella vista normale', () => {
    const items = [
      item('a', { authorAgentId: 'uno', updatedAt: 10 }),
      item('b', { authorAgentId: 'due', kind: 'chart', updatedAt: 20 }),
      item('c', { authorAgentId: 'uno', updatedAt: 30 }),
      item('az', { authorAgentId: 'uno', archived: true, updatedAt: 40 })
    ]
    expect(ids(libraryRows(items, 'uno', ''))).toEqual(['c', 'a'])
    expect(ids(libraryRows(items, '', 'chart'))).toEqual(['b'])
  })
})

describe('B4: libraryListArgs — cosa chiede la vista al daemon', () => {
  it('vista normale: niente terzo argomento (le archiviate non si chiedono nemmeno)', () => {
    expect(libraryListArgs('', false)).toEqual([undefined, undefined, undefined])
    expect(libraryListArgs('ricet', false)).toEqual(['ricet', undefined, undefined])
  })
  it('filtro «Archiviati»: terzo argomento true, con la stessa ricerca', () => {
    expect(libraryListArgs('', true)).toEqual([undefined, undefined, true])
    expect(libraryListArgs('ricet', true)).toEqual(['ricet', undefined, true])
  })
})

describe('B4: libraryClickIntent — il clic su una voce', () => {
  const mods = (shiftKey = false, metaKey = false, ctrlKey = false) => ({ shiftKey, metaKey, ctrlKey })
  it('clic normale → apre; ⌘-clic (Maiusc no) → seleziona/deseleziona; Ctrl-clic uguale (Windows)', () => {
    expect(libraryClickIntent(mods())).toBe('open')
    expect(libraryClickIntent(mods(false, true))).toBe('toggle')
    expect(libraryClickIntent(mods(false, false, true))).toBe('toggle')
  })
  it('Maiusc-clic → l\'intervallo dall\'ultima voce toccata (vince su ⌘)', () => {
    expect(libraryClickIntent(mods(true))).toBe('range')
    expect(libraryClickIntent(mods(true, true))).toBe('range')
  })
})

describe('B4: librarySelectionAfter — la selezione multipla', () => {
  const ORDER = ['a', 'b', 'c', 'd', 'e']

  it('⌘-clic: aggiunge una voce e la fa diventare l\'ancora; di nuovo la toglie', () => {
    expect(out(librarySelectionAfter(ORDER, LIBRARY_SELECTION_EMPTY, 'b', 'toggle'))).toEqual({ selected: ['b'], anchor: 'b' })
    const due = librarySelectionAfter(ORDER, sel(['b'], 'b'), 'd', 'toggle')
    expect(out(due)).toEqual({ selected: ['b', 'd'], anchor: 'd' })
    expect(out(librarySelectionAfter(ORDER, due, 'b', 'toggle'))).toEqual({ selected: ['d'], anchor: 'b' })
  })

  it('Maiusc-clic: TUTTO l\'intervallo dall\'ancora alla voce cliccata, nell\'ordine in cui si vede (in giù e in su)', () => {
    expect(out(librarySelectionAfter(ORDER, sel(['b'], 'b'), 'd', 'range'))).toEqual({ selected: ['b', 'c', 'd'], anchor: 'b' })
    expect(out(librarySelectionAfter(ORDER, sel(['d'], 'd'), 'a', 'range'))).toEqual({ selected: ['a', 'b', 'c', 'd'], anchor: 'd' })
  })

  it('Maiusc-clic AGGIUNGE l\'intervallo a ciò che era già selezionato (non lo sostituisce); l\'ancora non si muove', () => {
    const prima = sel(['a', 'c'], 'c')
    expect(out(librarySelectionAfter(ORDER, prima, 'e', 'range'))).toEqual({ selected: ['a', 'c', 'd', 'e'], anchor: 'c' })
    // un intervallo ripetito non toglie niente
    expect(out(librarySelectionAfter(ORDER, prima, 'e', 'range'))).toEqual({ selected: ['a', 'c', 'd', 'e'], anchor: 'c' })
  })

  it('Maiusc-clic senza ancora (o con l\'ancora che non si vede più): AGGIUNGE solo la voce cliccata, che diventa l\'ancora', () => {
    expect(out(librarySelectionAfter(ORDER, LIBRARY_SELECTION_EMPTY, 'c', 'range'))).toEqual({ selected: ['c'], anchor: 'c' })
    // l'ancora x non è più in vista: niente intervallo, la selezione di prima resta e c diventa l'ancora
    expect(out(librarySelectionAfter(['a', 'c'], sel(['a'], 'x'), 'c', 'range'))).toEqual({ selected: ['a', 'c'], anchor: 'c' })
  })

  it('non muta la selezione di partenza (nuovo Set ogni volta)', () => {
    const prima = sel(['b'], 'b')
    const dopo = librarySelectionAfter(ORDER, prima, 'd', 'toggle')
    expect(dopo.selected).not.toBe(prima.selected)
    expect([...prima.selected]).toEqual(['b'])
  })
})

describe('B4: librarySelectionVisible — valgono solo le voci che si vedono', () => {
  it('una voce selezionata che il filtro (o la ricerca) ha nascosto non conta più', () => {
    expect(out(librarySelectionVisible(sel(['a', 'c'], 'c'), ['b', 'c']))).toEqual({ selected: ['c'], anchor: 'c' })
  })
  it('l\'ancora che non si vede più si dimentica; una selezione vuota è quella di partenza', () => {
    expect(out(librarySelectionVisible(sel(['a'], 'a'), ['b', 'c']))).toEqual({ selected: [], anchor: null })
    expect(out(librarySelectionVisible(sel(['a', 'b'], 'a'), ['a', 'b']))).toEqual({ selected: ['a', 'b'], anchor: 'a' })
    expect(LIBRARY_SELECTION_EMPTY).toEqual({ selected: new Set(), anchor: null })
  })
})
