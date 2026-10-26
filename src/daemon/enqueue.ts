// Policy di accodamento sulla coda durevole, con la stessa semantica della
// coda in memoria della fase 1: i messaggi utente vengono accodati con una
// notice di posizione (tetto 10, poi scartati con notice "Coda piena"); le
// routine su agente occupato vengono scartate con notice (decisione presa
// dallo scheduler, vedi scheduler.ts).
//
// Fase 3 (§3bis L2): se l'agente è fermo su un'approval, un nuovo messaggio
// utente SOPRAVVEDE il turno in corso (SUPERSEDED) e parte subito invece di
// restare in coda; un messaggio che non risponde a un widget scarta i widget
// pendenti con dismissOnMoveOn.
import type { DatabaseSync } from 'node:sqlite'
import { appendEntry, getEntries, updateAgent, updateEntryMeta } from '../main/store/db'
import { activeJobForAgent, pendingUserMessages, enqueueJob, type Job } from '../main/store/jobs'
import { emitLastEntry, supersedeIfPaused, dismissPendingWidgets } from '../main/agent/loop'
import { findDismissibleWidgets, widgetPayload, responseDisplayText } from '../main/agent/widgets'
import type { SandbotEvent } from '../shared/types'

const MAX_QUEUE = 10

type Emitter = (e: SandbotEvent) => void

/**
 * Accoda un messaggio utente: parte subito se l'agente è libero, altrimenti
 * resta in coda con notice. Se la coda è al tetto il messaggio è SCARTATO:
 * la notice "Coda piena" viene scritta e nessun job viene creato (null).
 *
 * Fase 3: `respondedTo` è l'entry del widget a cui questo messaggio risponde
 * (ask_user): in quel caso i widget pendenti NON vengono scartati e il
 * messaggio partirà col meta.respondedTo giusto.
 */
export function enqueueUserMessage(
  db: DatabaseSync,
  agentId: string,
  text: string,
  images: string[] | undefined,
  emit: Emitter,
  respondedTo?: number,
  initiator?: string
): Job | null {
  updateAgent(agentId, { unread: 0 })
  // un messaggio che NON risponde a un widget scarta i widget "muoviti oltre"
  if (respondedTo === undefined && findDismissibleWidgets(getEntries(agentId)).length) {
    dismissPendingWidgets(agentId, emit)
  }
  if (activeJobForAgent(db, agentId)) {
    // fase 3: l'agente è fermo su un'approval → il nuovo messaggio sostituisce
    // il turno (SUPERSEDED) e parte subito, non in coda
    if (supersedeIfPaused(agentId)) {
      // il job in corso completa da solo (il controller è abortito): il
      // nuovo job viene reclamato al tick successivo del worker
    } else {
      const waiting = pendingUserMessages(db, agentId)
      if (waiting >= MAX_QUEUE) {
        appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Coda piena: messaggio scartato.' })
        emitLastEntry(agentId, emit)
        return null
      }
      appendEntry({ agentId, kind: 'notice', role: 'system', content: `Agente occupato: messaggio in coda (posizione ${waiting + 1}).` })
      emitLastEntry(agentId, emit)
    }
  }
  const now = Date.now()
  const payload: Record<string, unknown> = images?.length ? { text, images } : { text }
  if (respondedTo !== undefined) payload.respondedTo = respondedTo
  // fase 5: chi ha avviato il turno (es. CONNECTOR_CONNECTED dopo il click su
  // "Connetti" di una card offerta dal bot) — finisce in meta.initiator
  if (initiator) payload.initiator = initiator
  return enqueueJob(db, {
    agentId,
    kind: 'user-message',
    payload,
    runAt: now,
    now
  })
}

/**
 * Fase 3 (§3bis L10): registra la risposta a un widget ask_user e la accoda
 * come messaggio utente (meta.respondedTo = entry del widget). Torna il job
 * (o null se la coda è piena / il widget non è rispondibile).
 */
export function enqueueWidgetResponse(
  db: DatabaseSync,
  agentId: string,
  entryId: number,
  value: string | string[],
  emit: Emitter
): Job | null {
  const widget = getEntries(agentId).find((e) => e.id === entryId)
  const payload = widget ? widgetPayload(widget) : null
  if (!widget || !payload) return null
  const meta = widget.meta ?? {}
  if (meta.respondedValue !== undefined || meta.widgetDismissed) return null
  // il widget salva la risposta; il testo del messaggio utente è leggibile:
  // le etichette delle opzioni scelte (o il testo libero per allowCustom)
  updateEntryMeta(entryId, { ...meta, respondedValue: value })
  const updated = getEntries(agentId).find((e) => e.id === entryId)
  if (updated) emit({ type: 'entries', agentId, entries: [updated] })
  return enqueueUserMessage(db, agentId, responseDisplayText(payload, value), undefined, emit, entryId)
}
