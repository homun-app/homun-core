// Esecuzione dei job della coda: mappa user-message/routine-run su un turno
// runTurn. Ripresa R1: al PRIMO tentativo l'id dell'entry che apre il turno
// viene salvato nel payload del job (payload.entryId) prima di chiamare il
// modello; ai tentativi successivi (entryId già presente) torna indietro come
// `resume`, così il turno riprende dal transcript invece di ripetere.
// Fase 6: le routine scattate da un trigger portano l'evento nel payload:
// entra nel prompt nel blocco <evento> come evidenza (dato, non istruzione).
import type { DatabaseSync } from 'node:sqlite'
import { setJobEntryId, type Job } from '../main/store/jobs'
import { runTurn, type RunTurnOptions } from '../main/agent/loop'
import { formatTriggerEvent } from '../shared/triggers'
import type { SandbotEvent, TriggerEventPayload } from '../shared/types'

type Emitter = (e: SandbotEvent) => void
type RunTurnFn = typeof runTurn

/** Runner dei job per il worker (runTurn iniettabile nei test). */
export function makeJobRunner(db: DatabaseSync, runTurnFn: RunTurnFn = runTurn) {
  return async (job: Job, emit: Emitter): Promise<void> => {
    // entryId presente → tentativo successivo: ripresa dal transcript
    const opts: RunTurnOptions = typeof job.payload.entryId === 'number' ? { resume: { entryId: job.payload.entryId } } : {}
    // al primo tentativo l'id dell'entry utente finisce nel payload del job
    const onTurnEntry = (entryId: number): void => setJobEntryId(db, job.id, entryId)
    if (job.kind === 'user-message') {
      const p = job.payload as {
        text: string; images?: string[]; respondedTo?: number; initiator?: string
        // fase 7: messaggio di un altro bot (§3bis L8) — entra come evidenza
        fromAgentId?: string; fromAgentName?: string; hop?: number
        // fase 7 (correzione A3): la catena eredita l'automaticità del mittente
        automatic?: boolean
        // fase 7: meta extra del messaggio che apre il turno (es. templateName)
        extraMeta?: Record<string, unknown>
      }
      // correzione A3: le opzioni derivate dal payload vengono DOPO `opts`, così
      // sopravvivono anche alla ripresa (payload.entryId): una catena automatica
      // resta tale anche dopo un crash a metà turno
      await runTurnFn(job.agent_id, p.text, emit, p.images, {
        source: 'user', onTurnEntry, ...opts,
        ...(p.respondedTo !== undefined ? { respondedTo: p.respondedTo } : {}),
        ...(p.initiator ? { initiator: p.initiator } : {}),
        ...(p.fromAgentId && p.fromAgentName && typeof p.hop === 'number'
          ? { agentMessage: { fromAgentId: p.fromAgentId, fromAgentName: p.fromAgentName, hop: p.hop } }
          : {}),
        ...(p.automatic ? { automatic: true } : {}),
        ...(p.extraMeta ? { extraMeta: p.extraMeta } : {})
      })
      return
    }
    // fase 8 (§3bis L7): il task gira nel proprio sotto-transcript (meta.taskId
    // su ogni entry). Il brief apre il turno PREFIXATO con l'identità del task:
    // il contesto è separato, ma update_task({id}) richiede di sapere il proprio id
    if (job.kind === 'task-run') {
      const p = job.payload as { taskId: number; brief: string; respondedTo?: number }
      const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(p.taskId) as { title?: string } | undefined
      const opening = `[task n. ${p.taskId}${row?.title ? ` "${row.title}"` : ''} — per chiuderlo: update_task con id ${p.taskId}]\n${p.brief}`
      await runTurnFn(job.agent_id, opening, emit, undefined, {
        source: 'user', taskId: p.taskId, ...opts, onTurnEntry,
        ...(p.respondedTo !== undefined ? { respondedTo: p.respondedTo } : {})
      })
      return
    }
    const p = job.payload as { routineId: number; title: string; prompt: string; event?: TriggerEventPayload }
    // fase 6: il turno di un trigger parte dall'evento (evidenza nel blocco
    // delimitato <evento>); le routine a schedule restano come prima.
    // Fase 8 (punto 1): il flag dice al loop che il testo che apre il turno
    // viene da un evento esterno — l'auto-review non lo tocca
    const text = p.event
      ? formatTriggerEvent(p.title, p.prompt, p.event)
      : `[routine ricorrente: ${p.title}] ${p.prompt}`
    await runTurnFn(job.agent_id, text, emit, undefined, {
      source: 'routine', title: p.title, ...opts, onTurnEntry,
      ...(p.event ? { externalEvent: true } : {})
    })
  }
}
