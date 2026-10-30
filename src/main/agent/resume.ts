// Piano di ripresa di un turno interrotto (crash del daemon o retry del job)
// — modulo PURO come history.ts: decide COSA riparare nel transcript prima
// di chiamare di nuovo il modello; lo applica runTurn.
//
// Un agente durevole RIPRENDE dal transcript, non ripete: il messaggio utente
// non viene riscritto e i tool con effetti esterni non vengono rieseguiti
// alla cieca (al modello arriva un esito "sconosciuto", così decide lui se e
// come verificare prima di ripetere l'azione).
import type { TranscriptEntry } from '../../shared/types'

/** Result sintetico per una tool-call il cui esito è andato perso con l'interruzione. */
export const INTERRUPTED_TOOL_RESULT =
  'interrupted by a restart: the outcome is unknown. Check the state before repeating actions with external effects.'

/** Notice visibile quando un turno riprende dopo un'interruzione. */
export const RESUME_NOTICE = 'Turno ripreso dopo un\'interruzione.'

export interface ResumePlan {
  /** Il turno era già concluso (ultimo entry = messaggio assistant finale): nessuna chiamata al modello. */
  alreadyComplete: boolean
  /** Approval ancora pending dell'agente: da marcare expired. */
  pendingApprovals: TranscriptEntry[]
  /** Tool-call del turno rimaste senza tool-result: ricevono un result sintetico persistito. */
  interruptedToolCalls: TranscriptEntry[]
}

/**
 * Calcola il piano di ripresa dato il transcript dell'agente e l'id dell'entry
 * che ha aperto il turno (payload.entryId del job). Il "turno" è tutto ciò che
 segue quella entry.
 */
export function planResume(entries: TranscriptEntry[], entryId: number): ResumePlan {
  const turn = entries.filter((e) => e.id > entryId)
  const last = turn[turn.length - 1]
  // turno concluso: evento di fine turno (fase 3, meta.turnEnd) oppure —
  // transcript pre-fase 3 — messaggio assistant finale con testo e nessuna
  // tool-call dopo
  const alreadyComplete =
    turn.some((e) => e.kind === 'event' && e.meta?.turnEnd) ||
    (!!last && last.kind === 'message' && last.role === 'assistant' && last.content.trim() !== '')
  // ogni approval ancora pending dell'agente scade (anche di turni precedenti)
  const pendingApprovals = entries.filter((e) => e.kind === 'approval' && e.meta?.status === 'pending')
  // tool-call del turno senza tool-result: l'esito è andato perso con il crash
  const answered = new Set(
    turn.filter((e) => e.kind === 'tool-result').map((e) => String(e.meta?.callId ?? ''))
  )
  const interruptedToolCalls = turn.filter(
    (e) => e.kind === 'tool-call' && !answered.has(String(e.meta?.id ?? e.id))
  )
  return { alreadyComplete, pendingApprovals, interruptedToolCalls }
}
