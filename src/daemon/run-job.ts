// Esecuzione dei job della coda: mappa user-message/routine-run su un turno
// runTurn. Ripresa R1: al PRIMO tentativo l'id dell'entry che apre il turno
// viene salvato nel payload del job (payload.entryId) prima di chiamare il
// modello; ai tentativi successivi (entryId già presente) torna indietro come
// `resume`, così il turno riprende dal transcript invece di ripetere.
import type { DatabaseSync } from 'node:sqlite'
import { setJobEntryId, type Job } from '../main/store/jobs'
import { runTurn, type RunTurnOptions } from '../main/agent/loop'
import type { SandbotEvent } from '../shared/types'

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
      const p = job.payload as { text: string; images?: string[] }
      await runTurnFn(job.agent_id, p.text, emit, p.images, { source: 'user', ...opts, onTurnEntry })
      return
    }
    const p = job.payload as { routineId: number; title: string; prompt: string }
    await runTurnFn(job.agent_id, `[routine ricorrente: ${p.title}] ${p.prompt}`, emit, undefined, {
      source: 'routine', title: p.title, ...opts, onTurnEntry
    })
  }
}
