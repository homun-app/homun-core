// Policy di accodamento sulla coda durevole, con la stessa semantica della
// coda in memoria della fase 1: i messaggi utente vengono accodati con una
// notice di posizione (tetto 10, poi scartati con notice "Coda piena"); le
// routine su agente occupato vengono scartate con notice (decisione presa
// dallo scheduler, vedi scheduler.ts).
import type { DatabaseSync } from 'node:sqlite'
import { appendEntry, getEntries, updateAgent } from '../main/store/db'
import { activeJobForAgent, pendingUserMessages, enqueueJob, type Job } from '../main/store/jobs'
import { emitLastEntry } from '../main/agent/loop'
import type { SandbotEvent } from '../shared/types'

const MAX_QUEUE = 10

type Emitter = (e: SandbotEvent) => void

/** Accoda un messaggio utente: parte subito se l'agente è libero, altrimenti resta in coda con notice. */
export function enqueueUserMessage(
  db: DatabaseSync,
  agentId: string,
  text: string,
  images: string[] | undefined,
  emit: Emitter
): Job {
  updateAgent(agentId, { unread: 0 })
  if (activeJobForAgent(db, agentId)) {
    const waiting = pendingUserMessages(db, agentId)
    if (waiting >= MAX_QUEUE) {
      appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Coda piena: messaggio scartato.' })
      emitLastEntry(agentId, emit)
    } else {
      appendEntry({ agentId, kind: 'notice', role: 'system', content: `Agente occupato: messaggio in coda (posizione ${waiting + 1}).` })
      emitLastEntry(agentId, emit)
    }
  }
  const now = Date.now()
  return enqueueJob(db, {
    agentId,
    kind: 'user-message',
    payload: images?.length ? { text, images } : { text },
    runAt: now,
    now
  })
}
