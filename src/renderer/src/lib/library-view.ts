// Fase 16c (C6): filtri e ordine della Libreria globale come FUNZIONE PURA:
// i fissati in CIMA, poi per updatedAt (il più recente prima). Il filtro per
// bot si fa sul client con authorAgentId; il tipo è quello di library:list.
// B4 (fase b20-bug): la stessa funzione decide anche il filtro «Archiviati»
// (le voci archiviate SPARISCONO dalla vista normale), e qui vivono le pure
// della selezione multipla: gli argomenti di library:list, l'intento di un
// clic (normale, ⌘/Ctrl, Maiusc) e come cambia la selezione.
import type { LibraryItemInfo } from '../../../shared/types'

/** Il filtro tipo della Libreria ('' = tutti). */
export type LibraryKindFilter = '' | 'document' | 'chart' | 'file'

/**
 * PURA: le voci della libreria filtrate per bot e tipo e ordinate — i fissati
 * (pinned) in cima, poi per updatedAt desc. Il filtro per bot è client-side
 * su authorAgentId (i dati sono quelli di library:list di oggi).
 * B4: `archived` (default false) è il filtro «Archiviati» — nella vista
 * normale le archiviate non ci sono, col filtro SOLO loro. Vale anche su una
 * lista vecchia (o del test) che le contiene: la vista non le mostra mai per
 * sbaglio. Una voce senza il campo (record vecchio) non è archiviata.
 */
export function libraryRows(
  items: LibraryItemInfo[],
  agentFilter: string,
  kindFilter: LibraryKindFilter,
  archived = false
): LibraryItemInfo[] {
  return items
    .filter((i) => (archived ? i.archived === true : i.archived !== true))
    .filter((i) => (agentFilter ? i.authorAgentId === agentFilter : true))
    .filter((i) => (kindFilter ? i.kind === kindFilter : true))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

/**
 * B4: gli argomenti di `api.libraryList` per una ricerca e il filtro
 * «Archiviati» — PURA (il componente li usa tal quali). Nella vista normale
 * il terzo argomento non si manda: il daemon risponde senza le archiviate.
 */
export function libraryListArgs(query: string, archived: boolean): [string | undefined, undefined, true | undefined] {
  return [query || undefined, undefined, archived ? true : undefined]
}

/** Cosa chiede un clic su una voce della Libreria. */
export type LibraryClickIntent = 'open' | 'toggle' | 'range'

/**
 * B4: l'intento di un clic dai tasti modificatori — PURA. Clic normale:
 * apre. ⌘-clic (Ctrl su Windows): seleziona o deseleziona quella voce.
 * Maiusc-clic: l'intervallo dall'ultima voce toccata (vince su ⌘).
 */
export function libraryClickIntent(mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): LibraryClickIntent {
  if (mods.shiftKey) return 'range'
  if (mods.metaKey || mods.ctrlKey) return 'toggle'
  return 'open'
}

/** La selezione multipla: le voci selezionate e l'ancora (l'ultima toccata, da cui partono gli intervalli). */
export interface LibrarySelection {
  selected: Set<string>
  anchor: string | null
}

/** La selezione di partenza (nessuna voce). */
export const LIBRARY_SELECTION_EMPTY: LibrarySelection = { selected: new Set(), anchor: null }

/**
 * B4: la selezione DOPO un clic di selezione — PURA, mai muta quella di
 * partenza. `order` sono gli id nell'ordine in cui le voci si vedono (l'
 * intervallo segue la vista, non l'ordine del database). ⌘-clic ('toggle'):
 * aggiunge o toglie la voce, che diventa l'ancora. Maiusc-clic ('range'):
 * AGGIUNGE tutto l'intervallo dall'ancora alla voce (in giù e in su), l'
 * ancora non si muove; senza ancora (o con un'ancora che non si vede più)
 * seleziona solo la voce cliccata, che diventa l'ancora.
 */
export function librarySelectionAfter(
  order: readonly string[],
  current: LibrarySelection,
  id: string,
  intent: 'toggle' | 'range'
): LibrarySelection {
  if (intent === 'toggle') {
    const selected = new Set(current.selected)
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    return { selected, anchor: id }
  }
  const from = current.anchor === null ? -1 : order.indexOf(current.anchor)
  const to = order.indexOf(id)
  // niente ancora (o fuori vista): la voce cliccata è tutta la selezione che si aggiunge
  if (from === -1 || to === -1) return { selected: new Set([...current.selected, id]), anchor: id }
  const selected = new Set(current.selected)
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selected.add(order[i]!)
  return { selected, anchor: current.anchor }
}

/**
 * B4: la selezione ridotta alle voci che si vedono — PURA. Una voce
 * selezionata che il filtro o la ricerca hanno nascosto non conta più (le
 * azioni multiple valgono per quello che si vede); l'ancora che non si vede
 * più si dimentica.
 */
export function librarySelectionVisible(selection: LibrarySelection, shownIds: Iterable<string>): LibrarySelection {
  const shown = new Set(shownIds)
  const selected = new Set([...selection.selected].filter((id) => shown.has(id)))
  return { selected, anchor: selection.anchor !== null && shown.has(selection.anchor) ? selection.anchor : null }
}
