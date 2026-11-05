// Fase skill · Sfoglia (B2.6): la ricerca dei pacchetti di sole skill —
// PURA e CONDIVISA: la usa il daemon (skills:browse) e il renderer (il campo
// «Cerca skill» filtra l'elenco già caricato). Maiuscole e accenti non
// contano; la query batte nome, displayName, descrizione, keywords e
// categoria; l'ordinamento mette gli ufficiali prima, poi il nome.
import type { SkillBrowseEntry } from './types'

type EntryLike = Omit<SkillBrowseEntry, 'installed'> | SkillBrowseEntry

/** minuscole e senza accenti (NFKD, i segni diacritici via). */
export function normalizeSkillPackText(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** La query batte nome, displayName, descrizione, keywords e categoria (pura). */
export function matchesSkillPackQuery(entry: EntryLike, query: string): boolean {
  const q = normalizeSkillPackText(query)
  if (!q) return true
  const hay = [entry.name, entry.displayName, entry.description, entry.category, ...entry.keywords]
    .map(normalizeSkillPackText)
    .join(' ')
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

/** L'ordinamento del catalogo (puro): gli ufficiali prima, poi per nome. */
export function sortSkillPacks<T extends EntryLike>(entries: T[]): T[] {
  return [...entries].sort((a, b) =>
    a.official !== b.official
      ? a.official ? -1 : 1
      : a.name.localeCompare(b.name))
}

/** filtro + ordinamento: la ricerca del campo «Cerca skill». */
export function searchSkillPacks(entries: SkillBrowseEntry[], query: string): SkillBrowseEntry[] {
  return sortSkillPacks(entries.filter((e) => matchesSkillPackQuery(e, query)))
}
