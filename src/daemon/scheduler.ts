// Scheduler delle routine: niente timer per routine — a ogni tick si calcola
// (funzione pura) il prossimo run di ogni routine abilitata e, se è scaduto,
// si accoda un job 'routine-run' nella coda durevole. Se l'agente è occupato
// la routine viene scartata con una notice (stessa semantica della fase 1).
// Senza stato: legge le routine dal db a ogni tick, quindi CRUD e riavvii
// non richiedono ricaricamenti.
import type { DatabaseSync } from 'node:sqlite'
import { listRoutines, touchRoutineRun, appendEntry, getEntries, type Routine } from '../main/store/db'
import { activeJobForAgent, enqueueJob, type Job } from '../main/store/jobs'
import { nextCronRun } from './cron'
import type { SandbotEvent } from '../shared/types'

type Emitter = (e: SandbotEvent) => void

export interface SchedulerDeps {
  now(): number
}

/** Routine abilitate il cui prossimo run è già scaduto (pure, per i test). */
export function dueRoutines(routines: Routine[], now: number): Routine[] {
  return routines.filter((r) => {
    if (!r.enabled) return false
    // base di partenza: ultimo run, o la creazione per le routine mai girate
    const from = r.last_run ?? r.created_at
    const next = nextCronRun(r.schedule, from)
    return next !== null && next <= now
  })
}

/**
 * Un tick dello scheduler: per ogni routine dovuta registra il run
 * (last_run) e accoda il job, oppure la scarta con notice se l'agente ha un
 * job attivo.
 */
export function tickScheduler(db: DatabaseSync, emit: Emitter, now: number): Job[] {
  const due = dueRoutines(listRoutines(), now)
  const enqueued: Job[] = []
  for (const r of due) {
    touchRoutineRun(r.id)
    if (activeJobForAgent(db, r.agent_id)) {
      appendEntry({
        agentId: r.agent_id, kind: 'notice', role: 'system',
        content: `Routine "${r.title}" saltata: l'agente è occupato.`
      })
      emit({ type: 'entries', agentId: r.agent_id, entries: getEntries(r.agent_id).slice(-1) })
      continue
    }
    enqueued.push(enqueueJob(db, {
      agentId: r.agent_id,
      kind: 'routine-run',
      payload: { routineId: r.id, title: r.title, prompt: r.prompt },
      runAt: now,
      now
    }))
  }
  return enqueued
}
