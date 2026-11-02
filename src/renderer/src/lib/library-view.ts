// Fase 16c (C6): filtri e ordine della Libreria globale come FUNZIONE PURA:
// i fissati in CIMA, poi per updatedAt (il più recente prima). Il filtro per
// bot si fa sul client con authorAgentId; il tipo è quello di library:list.
import type { LibraryItemInfo } from '../../../shared/types'

/** Il filtro tipo della Libreria ('' = tutti). */
export type LibraryKindFilter = '' | 'document' | 'chart' | 'file'

/**
 * PURA: le voci della libreria filtrate per bot e tipo e ordinate — i fissati
 * (pinned) in cima, poi per updatedAt desc. Il filtro per bot è client-side
 * su authorAgentId (i dati sono quelli di library:list di oggi).
 */
export function libraryRows(
  items: LibraryItemInfo[],
  agentFilter: string,
  kindFilter: LibraryKindFilter
): LibraryItemInfo[] {
  return items
    .filter((i) => (agentFilter ? i.authorAgentId === agentFilter : true))
    .filter((i) => (kindFilter ? i.kind === kindFilter : true))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}
