// B2 (fase b20-bug): le righe della chat che NON si mostrano affatto. Nel
// transcript vero ogni turno del loop scrive anche ciò che la chat non rende
// (il ragionamento, l'evento di fine turno, le chiamate degli strumenti): la
// vista deve sapere quali righe sono invisibili, perché solo quelle mostrate
// contano per raccogliere l'avviso che torna dopo ogni apertura automatica
// (notice-rows) — e EntryRow deve restituire null esattamente per queste.
// Funzione PURA: la stessa decide per il rendering e per il raggruppamento.
import { hidesUserBubble, openingRowFor } from './opening-rows'
import type { TranscriptEntry } from '../../../shared/types'

/** Ciò che l'utente ha scelto di vedere in chat (Impostazioni › Generali e il menu «Ragiona»). */
export interface ChatRowView {
  /** «Mostra il ragionamento in chat» (menu Ragiona): thinking, summary e fine turno */
  showReasoning: boolean
  /** «passaggi di debug» (Impostazioni › Generali): tool-call e tool-result */
  debugSteps: boolean
}

/**
 * True se la chat NON mostra questa entry (nessuna riga). È l'UNICA lista:
 * EntryRow la usa per restituire null, la vista per non farle spezzare i
 * gruppi degli avvisi.
 */
export function chatRowHidden(entry: TranscriptEntry, view: ChatRowView): boolean {
  switch (entry.kind) {
    case 'thinking':
    case 'summary':
      return !view.showReasoning
    case 'tool-call':
    case 'tool-result':
      return !view.debugSteps
    case 'event':
      // gli esiti di turno (meta.turnEnd) sono dettaglio interno; gli altri eventi (la riga del riepilogo pubblicato, una routine creata) si vedono
      // meta.turnEnd è l'ESITO del turno ('FINISHED', 'STOPPED', …): basta che ci sia
      return entry.meta?.turnEnd !== undefined && entry.meta?.turnEnd !== null && entry.meta.turnEnd !== false && !view.showReasoning
    case 'send-message':
      // fase 6: trattenuto nell'outbox — invisibile finché non è consegnato
      return (entry.meta as { held?: unknown } | null)?.held === true
    case 'message':
      // il prompt nascosto della presentazione (BOT_INTRO) e la risposta a una domanda (vive già nella riga della card)
      return entry.role === 'user' && (openingRowFor(entry).kind === 'hidden' || hidesUserBubble(entry))
    default:
      return false
  }
}
