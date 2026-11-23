// B2 (fase b20-bug): il «Riprova» dell'avviso di risposta vuota. Quando un
// turno finisce senza risposta (nemmeno dopo l'unico tentativo) il loop
// scrive nell'avviso ciò che serve a ripeterlo — meta.retry {kind, payload}:
// lo stesso testo e la stessa origine (chi ha aperto il turno, le sue
// bandiere). L'RPC turn:retry riaccoda QUELLO: il turno nuovo è quello di
// prima, parola per parola; l'apertura porta retryOf (l'id dell'avviso), così
// la chat non mostra di nuovo la bolla dell'utente e un secondo clic non
// accoda un doppione. PURA rispetto alle dipendenze: il DB dei job e l'entry.
import type { DatabaseSync } from 'node:sqlite'
import { enqueueJob, listJobs } from '../main/store/jobs'
import type { TranscriptEntry, TurnRetry } from '../shared/types'

export type RetryTurnResult =
  | { ok: true; jobId: number }
  | { ok: false; error: 'notRetryable' | 'alreadyQueued' | 'notEnqueued' }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Il «Riprova» di questo avviso è già in coda o sta girando? */
function retryAlreadyQueued(db: DatabaseSync, agentId: string, retry: TurnRetry, entryId: number): boolean {
  return listJobs(db).some((j) => {
    if (j.agent_id !== agentId || j.kind !== retry.kind || (j.status !== 'queued' && j.status !== 'leased')) return false
    if (retry.kind === 'task-run') return j.payload.retryOf === entryId
    return isRecord(j.payload.extraMeta) && j.payload.extraMeta.retryOf === entryId
  })
}

/** Riaccoda il turno finito con risposta vuota (l'entry è l'avviso col meta.retry del loop). */
export function retryTurn(db: DatabaseSync, agentId: string, entry: TranscriptEntry | undefined, now: number = Date.now()): RetryTurnResult {
  const raw = isRecord(entry?.meta) ? entry.meta.retry : undefined
  if (
    !entry || entry.agentId !== agentId || entry.kind !== 'notice' ||
    !isRecord(raw) || (raw.kind !== 'user-message' && raw.kind !== 'task-run') || !isRecord(raw.payload)
  ) {
    return { ok: false, error: 'notRetryable' }
  }
  const retry: TurnRetry = { kind: raw.kind, payload: raw.payload }
  if (retryAlreadyQueued(db, agentId, retry, entry.id)) return { ok: false, error: 'alreadyQueued' }
  // il meta dell'avviso NON si tocca: resta quello del turno di partenza
  const payload = retry.kind === 'task-run'
    ? { ...retry.payload, retryOf: entry.id }
    : { ...retry.payload, extraMeta: { ...(isRecord(retry.payload.extraMeta) ? retry.payload.extraMeta : {}), retryOf: entry.id } }
  // enqueueJob ha la guardia centrale (bot rimosso, coda piena): rifiuta con null
  const job = enqueueJob(db, { agentId, kind: retry.kind, payload, runAt: now, now })
  return job ? { ok: true, jobId: job.id } : { ok: false, error: 'notEnqueued' }
}
