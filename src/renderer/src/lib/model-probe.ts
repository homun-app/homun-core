// Fase 16c (C3.4): la prova automatica della chiave API. Vale SOLO l'ultima
// prova: un contatore di revisione scarta le risposte vecchie (l'idea dello
// schema model-probe di Rakazo, in una funzione pura testabile).
export interface ModelProbeState {
  /** una prova è in volo */
  probing: boolean
  /** null = nessun esito ancora */
  ok: boolean | null
  /** gli id dei modelli visti (solo se ok) */
  models: string[]
  /** il CODICE dell'errore ('invalid-key' | 'unreachable' | 'error') */
  error: string | null
}

export const EMPTY_MODEL_PROBE: ModelProbeState = { probing: false, ok: null, models: [], error: null }

export type ModelProbeEvent =
  | { type: 'start'; revision: number }
  | { type: 'result'; revision: number; ok: true; models: string[] }
  | { type: 'result'; revision: number; ok: false; error: string }
  | { type: 'reset' }

/**
 * PURA: il nuovo stato della prova. La risposta di una revisione che non è
 * l'ULTIMA si scarta (una prova più recente è partita o il campo è cambiato):
 * resta lo stato corrente, com'era.
 */
export function nextModelProbe(state: ModelProbeState, ev: ModelProbeEvent, latestRevision: number): ModelProbeState {
  if (ev.type === 'reset') return EMPTY_MODEL_PROBE
  if (ev.revision !== latestRevision) return state
  if (ev.type === 'start') return { ...EMPTY_MODEL_PROBE, probing: true }
  if (ev.ok) return { probing: false, ok: true, models: ev.models, error: null }
  return { probing: false, ok: false, models: [], error: ev.error }
}
