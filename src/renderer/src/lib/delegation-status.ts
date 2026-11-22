// D2 (fase deleghe): il modello PURO della riga di stato della delega in
// chat — «In coda per <bot> · parte alle HH:MM» con Annulla, che diventa
// «Consegnato» quando il messaggio parte (job leased/done) e SPARISCE
// quando il risultato arriva (un messaggio del destinatario dopo la
// delega) o quando il job non c'è più (annullato, scaduto).
import type { TranscriptEntry } from '../../../shared/types'

/** Il meta delle deleghe accodate dal loop (D2): job della coda e orario. */
export interface DelegationQueuedMeta {
  jobId: number
  runAt: number
}

/** Le deleghe in attesa nelle entry del bot (l'ordine è quello del transcript). */
export function collectDelegationJobs(entries: TranscriptEntry[]): Array<{ entryId: number; jobId: number; runAt: number; toAgentName: string }> {
  const out: Array<{ entryId: number; jobId: number; runAt: number; toAgentName: string }> = []
  if (!Array.isArray(entries)) return out
  for (const e of entries) {
    const meta = (e.meta ?? {}) as { agentSend?: unknown; toAgentName?: unknown; delegationQueued?: DelegationQueuedMeta | undefined }
    if (e.kind !== 'send-message' || meta.agentSend !== true) continue
    const q = meta.delegationQueued
    if (!q || typeof q.jobId !== 'number' || typeof q.runAt !== 'number') continue
    out.push({ entryId: e.id, jobId: q.jobId, runAt: q.runAt, toAgentName: String(meta.toAgentName ?? '') })
  }
  return out
}

export type DelegationJobStatus = 'queued' | 'delivered' | 'gone'

/**
 * Lo stato della riga per UNA delega: 'queued' (in coda, con l'orario),
 * 'delivered' (partita) o null (riga via — risultato arrivato dal
 * destinatario, oppure job annullato/sparito).
 */
export function delegationRowState(
  sendEntry: TranscriptEntry,
  jobStatus: DelegationJobStatus,
  entries: TranscriptEntry[]
): 'queued' | 'delivered' | null {
  if (jobStatus === 'gone') return null
  const meta = (sendEntry.meta ?? {}) as { toAgentId?: unknown }
  const toAgentId = String(meta.toAgentId ?? '')
  // il risultato è arrivato: un messaggio del DESTINATARIO dopo la delega
  const resultArrived = entries.some(
    (e) => e.id > sendEntry.id && e.kind === 'message' && e.meta?.initiator === 'AGENT' && String(e.meta?.fromAgentId ?? '') === toAgentId
  )
  if (resultArrived) return null
  return jobStatus
}

/** L'ora breve HH:MM della riga (il fuso dell'utente, formato del locale). */
export function formatDelegationClock(ms: number, locale: string, timeZone?: string | null): string {
  try {
    const zone = timeZone && (() => { try { new Intl.DateTimeFormat('en-US', { timeZone }); return timeZone } catch { return null } })()
    return new Intl.DateTimeFormat(locale, {
      timeZone: zone ?? undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date(ms))
  } catch {
    return ''
  }
}
