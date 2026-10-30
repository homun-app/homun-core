// update_state (fase 4, §3ter T4): l'agente modifica il proprio stato —
// memoria (come update_memory) e routine (create/update/pause/resume/delete).
// Il verdetto dei permessi è una funzione pura: create/pause/delete sono
// sempre consentiti (una routine creata dall'agente nasce in PAUSA), resume
// e l'update di schedule/prompt su una routine ATTIVA chiedono all'utente
// (cambiano ciò che il bot eseguirà da solo in futuro).
// Fase 17c (C2): i verdetti portano anche l'UiText del motivo (la card lo
// mostra nella lingua dell'interfaccia); la schedule che l'utente vede la
// costruisce la card stessa con describeCron. automationEventText torna un
// UiText (id + nome della routine).
import { describeCron } from '../../shared/cron-human'
import type { Routine } from '../store/db'
import type { UiText } from '../../shared/types'
import { ui } from '../ui-language'
import { UI } from '../../shared/ui-messages'

/** Argomenti possibili di update_state (i campi arrivano dal modello, tutti opzionali). */
export interface UpdateStateArgs {
  target?: unknown
  action?: unknown
  id?: unknown
  name?: unknown
  description?: unknown
  prompt?: unknown
  schedule?: unknown
  timezone?: unknown
  content?: unknown
  tier?: unknown
  scope?: unknown
}

export type StateVerdict = { kind: 'allow' } | { kind: 'ask'; reason: string; ui: UiText }

/** Anteprima del prompt per la card di approvazione (una riga, troncata). */
function promptPreview(prompt: string): string {
  const one = prompt.replace(/\s+/g, ' ').trim()
  return one.length > 200 ? one.slice(0, 200) + '…' : one
}

/**
 * Verdetto per update_state (puro). `routine` è la routine esistente per gli
 * id dell'argomento (null se assente/solo per create): chi chiede la card
 * deve passare la routine corrente letta dallo store.
 */
export function updateStateVerdict(args: UpdateStateArgs, routine: Routine | null): StateVerdict {
  if (args.target !== 'routine') return { kind: 'allow' } // memory: come update_memory

  const action = String(args.action ?? '')
  if (action === 'resume' && routine) {
    const schedule = typeof args.schedule === 'string' && args.schedule ? args.schedule : routine.schedule
    const prompt = typeof args.prompt === 'string' && args.prompt ? args.prompt : routine.prompt
    const preview = promptPreview(prompt)
    return {
      kind: 'ask',
      reason: `activate the routine "${routine.title}" — ${describeCron(schedule, 'en')} — prompt: ${preview}`,
      ui: ui(UI.approvalUsResume, { title: routine.title, ...(preview ? { preview } : {}) })
    }
  }
  if (action === 'update' && routine?.enabled && (args.schedule !== undefined || args.prompt !== undefined)) {
    const schedule = typeof args.schedule === 'string' && args.schedule ? args.schedule : routine.schedule
    const preview = typeof args.prompt === 'string' && args.prompt ? promptPreview(args.prompt) : ''
    return {
      kind: 'ask',
      reason: `change the execution of the active routine "${routine.title}" — ${describeCron(schedule, 'en')}${preview ? ` — prompt: ${preview}` : ''}`,
      ui: preview
        ? ui(UI.approvalUsUpdateWithPrompt, { title: routine.title, preview })
        : ui(UI.approvalUsUpdate, { title: routine.title })
    }
  }
  // create/pause/delete sempre; resume/update senza routine esistente vanno
  // avanti e sarà l'esecuzione a dare l'errore leggibile ("non trovata")
  return { kind: 'allow' }
}

/**
 * Fase 5 (residuo M3): verdetto per una scrittura in memoria. Le memorie
 * CONDIVISE (scope 'user') entrano nel prompt di TUTTI i bot: scriverle,
 * aggiornarle o eliminarle chiede all'utente (la card mostra il contenuto) —
 * un'istruzione iniettata, es. letta in un'email, non può diventare una regola
 * permanente per ogni agente senza conferma. Lo scope 'agent' resta consentito.
 * `currentScope` è lo scope della memoria esistente per update/delete (serve
 * quando l'argomento non lo riporta); null se assente/sconosciuto.
 */
export function memoryScopeVerdict(
  args: UpdateStateArgs,
  currentScope: 'agent' | 'user' | null
): StateVerdict {
  const action = String(args.action ?? '')
  if (action !== 'write' && action !== 'update' && action !== 'delete') return { kind: 'allow' }
  const scope = args.scope === 'user' || args.scope === 'agent' ? args.scope : currentScope ?? 'agent'
  if (scope !== 'user') return { kind: 'allow' }
  const verb = action === 'write' ? 'create a' : action === 'update' ? 'update a' : 'delete a'
  const content = typeof args.content === 'string' && args.content.trim() ? ` — content: ${promptPreview(args.content)}` : ''
  const preview = typeof args.content === 'string' && args.content.trim() ? promptPreview(args.content) : ''
  return {
    kind: 'ask',
    reason: `${verb} memory shared by all bots (scope user)${content}`,
    ui: ui(UI.approvalMemoryScope, { action, withContent: preview ? 'yes' : 'no', ...(preview ? { preview } : {}) })
  }
}

/** Il UiText dell'entry event meta.automation per un'azione su routine (§3ter T2/T4, fase 17c). */
export function automationEventText(action: string, name: string): UiText {
  switch (action) {
    case 'create': return ui(UI.eventRoutineCreate, { name })
    case 'update': return ui(UI.eventRoutineUpdate, { name })
    case 'pause': return ui(UI.eventRoutinePause, { name })
    case 'resume': return ui(UI.eventRoutineResume, { name })
    case 'delete': return ui(UI.eventRoutineDelete, { name })
    default: return ui(UI.eventRoutineOther, { action, name })
  }
}
