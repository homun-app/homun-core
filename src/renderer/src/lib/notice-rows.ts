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
import { isAutomaticOpening } from './opening-rows'

/** Una riga da mostrare: l'entry e quante volte si è ripetuta di fila. */
export interface NoticeGroup<T extends TranscriptEntry = TranscriptEntry> {
  entry: T
  repeat: number
  /**
   * B2 (fase b20-bug): l'apertura automatica che ha preceduto il gruppo — la
   * vista la rende PRIMA dell'avviso (una riga sola per tutti i turni).
   */
  lead?: T
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
 * B2 (fase b20-bug): raggruppa le notice identiche CONSECUTIVE e anche
 * quelle che tornano uguali dopo OGNI apertura automatica (il caso visto
 * dall'utente: «Avvio automatico» + «risposta vuota», quattro volte di fila).
 * Le aperture in mezzo si raccolgono nel gruppo (una riga sola, `lead`, resa
 * prima dell'avviso) e `repeat` conta gli avvisi. Tutto il resto passa tale
 * e quale (repeat 1): una entry diversa in mezzo — la bolla o la risposta di
 * un bot, un avviso con un altro motivo — spezza il gruppo.
 */
export function groupRepeatedNotices<T extends TranscriptEntry>(entries: readonly T[]): NoticeGroup<T>[] {
  const out: NoticeGroup<T>[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const last = out[out.length - 1]
    if (e.kind === 'notice' && last && last.entry.kind === 'notice' && noticeKey(last.entry) === noticeKey(e)) {
      last.repeat++
      continue
    }
    if (e.kind === 'message' && last && last.entry.kind === 'notice' && isAutomaticOpening(e)) {
      // le aperture automatiche di fila, poi ciò che le segue
      let j = i
      while (j < entries.length && entries[j]!.kind === 'message' && isAutomaticOpening(entries[j]!)) j++
      const next = entries[j]
      if (next && next.kind === 'notice' && noticeKey(next) === noticeKey(last.entry)) {
        // l'avviso è LO STESSO: la riga che precedeva il primo avviso, se è
        // un'apertura automatica, diventa la riga unica del gruppo
        if (last.lead === undefined) {
          const before = out[out.length - 2]
          if (before && before.entry.kind === 'message' && isAutomaticOpening(before.entry)) {
            last.lead = before.entry
            out.splice(out.length - 2, 1)
          }
        }
        last.repeat++
        i = j
        continue
      }
    }
    out.push({ entry: e, repeat: 1 })
  }
  return out
}
