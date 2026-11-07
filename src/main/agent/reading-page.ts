// Fase pagine · ritocchi (P1): la riga «stai leggendo la pagina» la costruisce
// il DAEMON. Il renderer manda solo l'identità (id, version): il titolo NON è
// testo fidato (lo scrive il bot, anche in un turno contaminato — una pagina
// tainted può mettere «]» e un a-capo con istruzioni nel titolo). Qui si
// risolve la pagina sulla fonte di verità del daemon (la voce della libreria)
// e si ripulisce il titolo: una riga sola, al massimo 120 caratteri. Il modo
// in cui il titolo entra nella riga (escapato) sta in history.ts, insieme
// alla riga stessa. Modulo PURO: stesso input → stesso output.
import type { ReadingPageMeta } from '../../shared/types'

/** Il tetto del titolo nella riga (caratteri, «…» incluso). */
export const PAGE_TITLE_MAX = 120

/** La voce della libreria come serve alla risoluzione (i campi che contano). */
export interface ReadingPageItem {
  id: string
  kind: string
  title: string
  currentVersion: number
}

/**
 * Il titolo della libreria ripulito per la riga: a-capo, tab e caratteri di
 * controllo (C0 e DEL) diventano spazi — una riga sola —, gli spazi si
 * collassano e si tolgono alle estremità; oltre 120 caratteri si taglia con
 * «…» in coda.
 */
export function pageTitleForLine(title: string): string {
  const oneLine = title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (oneLine.length <= PAGE_TITLE_MAX) return oneLine
  return oneLine.slice(0, PAGE_TITLE_MAX - 1) + '…'
}

/**
 * P1: risolve la pagina che l'utente dice di stare leggendo. Il renderer può
 * mandare qualunque cosa (anche un titolo: NON conta, si ignora): vale SOLO
 * l'id — la voce deve esistere in libreria (`lookup`) ed essere un documento.
 * Il titolo viene dalla libreria, ripulito da pageTitleForLine; la versione è
 * quella del renderer solo se è un intero fra 1 e la versione corrente,
 * altrimenti la corrente. Nessuna riga → undefined.
 */
export function resolveReadingPage(
  raw: unknown,
  lookup: (id: string) => ReadingPageItem | null
): ReadingPageMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { id?: unknown; version?: unknown }
  if (typeof r.id !== 'string' || !r.id.trim()) return undefined
  const item = lookup(r.id.trim())
  if (!item || item.kind !== 'document') return undefined
  const current = item.currentVersion
  const wanted = r.version
  const version = Number.isInteger(wanted) && (wanted as number) >= 1 && (wanted as number) <= current
    ? (wanted as number)
    : current
  return { id: item.id, title: pageTitleForLine(item.title), version }
}
