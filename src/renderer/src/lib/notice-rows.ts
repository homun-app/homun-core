// RV4 (fase beta.2), punto 3: la stessa notice consecutiva senza altro in
// mezzo si mostra UNA volta (con un contatore discreto «×N»). Il caso vero:
// senza modello, OGNI invio scrive una notice «Configura prima un provider e
// un modello…» e il messaggio utente NON entra nel transcript — due invii
// di fila appaiono come la stessa notice raddoppiata. PURA sulle entry del
// transcript (testata in __tests__/notice-rows.test.ts): l'IDENTITÀ di una
// notice è il suo meta.ui (id + valori) — la stessa notice scritta in due
// lingue diverse resta LA STESSA — e per le entry vecchie senza meta.ui
// vale il content.
import type { TranscriptEntry } from '../../../shared/types'

/** Una riga da mostrare: l'entry e quante volte si è ripetuta di fila. */
export interface NoticeGroup<T extends TranscriptEntry = TranscriptEntry> {
  entry: T
  repeat: number
}

/** La chiave d'identità di una notice (meta.ui intero, o il content delle vecchie). */
function noticeKey(e: TranscriptEntry): string {
  const ui = (e.meta as { ui?: unknown } | null)?.ui
  if (ui && typeof ui === 'object' && typeof (ui as { id?: unknown }).id === 'string') {
    return JSON.stringify(ui)
  }
  return `\u0000${e.content}`
}

/**
 * Raggruppa le notice identiche CONSECUTIVE: tutto il resto passa tale e
 * quale (repeat 1). Qualsiasi entry diversa in mezzo spezza il gruppo.
 */
export function groupRepeatedNotices<T extends TranscriptEntry>(entries: readonly T[]): NoticeGroup<T>[] {
  const out: NoticeGroup<T>[] = []
  for (const e of entries) {
    const last = out[out.length - 1]
    if (e.kind === 'notice' && last && last.entry.kind === 'notice' && noticeKey(last.entry) === noticeKey(e)) {
      last.repeat++
      continue
    }
    out.push({ entry: e, repeat: 1 })
  }
  return out
}
