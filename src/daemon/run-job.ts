// Esecuzione dei job della coda: mappa user-message/routine-run su un turno
// runTurn. Ripresa R1: al PRIMO tentativo l'id dell'entry che apre il turno
// viene salvato nel payload del job (payload.entryId) prima di chiamare il
// modello; ai tentativi successivi (entryId già presente) torna indietro come
// `resume`, così il turno riprende dal transcript invece di ripetere.
// Fase 6: le routine scattate da un trigger portano l'evento nel payload:
// entra nel prompt nel blocco <evento> come evidenza (dato, non istruzione).
import type { DatabaseSync } from 'node:sqlite'
import { setJobEntryId, type Job } from '../main/store/jobs'
import { runTurn, interrupt, type RunTurnOptions } from '../main/agent/loop'
import { runGroupTurnJob, defaultArmTimeout } from './group-runner'
import { formatTriggerEvent } from '../shared/triggers'
import type { SandbotEvent, TriggerEventPayload } from '../shared/types'

type Emitter = (e: SandbotEvent) => void
type RunTurnFn = typeof runTurn

/**
 * L'apertura del turno di una routine a schedule (fase 17b correzioni, B4):
 * funzione PURA, la usano il job runner e l'eval, così la storia dell'eval è
 * identica a ciò che produce il codice. Il titolo e il prompt li ha scritti
 * l'utente (o il bot nella sua lingua): chi li traduce lo fa prima di chiamare.
 */
export function routineOpening(title: string, prompt: string): string {
  return `[recurring routine: ${title}] ${prompt}`
}

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
        // fase 8 (correzione B1): l'origine del task arriva anche al TASK_DONE
        untrusted?: boolean
        // fase 12 (punto 5): il turno parte GIÀ contaminato (un figlio del lotto
        // ha letto contenuti non fidati) — lift F8 sui tool con effetti
        contaminated?: boolean
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
        ...(p.untrusted ? { untrusted: true } : {}),
        ...(p.contaminated ? { contaminated: true } : {}),
        ...(p.extraMeta ? { extraMeta: p.extraMeta } : {})
      })
      return
    }
    // fase 8 (§3bis L7): il task gira nel proprio sotto-transcript (meta.taskId
    // su ogni entry). Il brief apre il turno PREFIXATO con l'identità del task:
    // il contesto è separato, ma update_task({id}) richiede di sapere il proprio id.
    // Correzione B1: l'origine del turno che ha creato il task (untrusted /
    // automatic, salvata sulla riga) vale per TUTTI i turni del task — anche
    // le continuazioni dopo ask_user o approval ripartono da qui.
    if (job.kind === 'task-run') {
      const p = job.payload as { taskId: number; brief: string; respondedTo?: number; untrusted?: boolean; automatic?: boolean; contaminated?: boolean }
      const row = db.prepare('SELECT title, untrusted, automatic FROM tasks WHERE id = ?').get(p.taskId) as
        | { title?: string; untrusted?: number; automatic?: number }
        | undefined
      // fase 12 (punto 5): un task-run può essere anche il RISVEGLIO del padre
      // (brief = <risultati_sottoagenti>) — le bandiere del payload valgono
      // COME le righe del task (B1: l'origine non si perde)
      const opening = `[task no. ${p.taskId}${row?.title ? ` "${row.title}"` : ''} — to close it: update_task with id ${p.taskId}]\n${p.brief}`
      // fase 17c (C2, MU): il testo per il modello resta inglese; l'apertura
      // che l'utente vede in chat arriva da meta.ui, nella sua lingua
      const { ui, UI } = await import('../main/ui-language')
      const openingUi = ui(UI.openTask, {
        id: p.taskId,
        hasTitle: row?.title ? 'yes' : 'no',
        ...(row?.title ? { title: row.title } : {}),
        brief: p.brief
      })
      await runTurnFn(job.agent_id, opening, emit, undefined, {
        source: 'user', taskId: p.taskId, ...opts, onTurnEntry, extraMeta: { ui: openingUi },
        ...(p.respondedTo !== undefined ? { respondedTo: p.respondedTo } : {}),
        ...(row?.untrusted || p.untrusted ? { untrusted: true } : {}),
        ...(row?.automatic || p.automatic ? { automatic: true } : {}),
        ...(p.contaminated ? { contaminated: true } : {})
      })
      return
    }
    // fase 12 (punti 3-4): il turno del FIGLIO — primo job = il brief (blocco
    // evidenza <brief>), i successivi = i messaggi del padre. La riga dice
    // untrusted/automatic (ereditati dal turno che ha lanciato, come B1).
    // status running + started_at al PRIMO turno; R1 vale così com'è (il
    // figlio è un agente con le sue entry). Un figlio già terminale (stop o
    // scadenza arrivati prima del job) non parte.
    if (job.kind === 'subagent-run') {
      const p = job.payload as { subagentId: string; first?: boolean; message?: string; entryId?: number }
      const { getSubagent, updateSubagent } = await import('../main/store/subagents')
      const row = getSubagent(db, p.subagentId)
      if (!row) return
      if (row.status === 'done' || row.status === 'failed' || row.status === 'stopped' || row.status === 'expired') return
      if (row.status === 'queued') {
        updateSubagent(db, row.id, { status: 'running', started_at: Date.now() })
        const { subagentsChanged } = await import('./subagent-ops')
        subagentsChanged(row.parent_id, emit)
      }
      // il nome del padre si legge dalla STESSA connessione del job (come le
      // righe del task): il runner non dipende dallo store globale
      const parent = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.parent_id) as { name?: string } | undefined
      const agentMessage = await import('../shared/agent-message')
      const opening = p.message !== undefined && parent
        ? agentMessage.formatSubagentParentMessage(parent.name ?? row.parent_id, p.message)
        : agentMessage.formatSubagentBrief(row.title, row.brief)
      await runTurnFn(row.id, opening, emit, undefined, {
        source: 'user',
        subagent: { id: row.id, parentId: row.parent_id },
        ...opts,
        onTurnEntry,
        ...(row.untrusted ? { untrusted: true } : {}),
        ...(row.automatic ? { automatic: true } : {})
      })
      return
    }
    // fase 10 (§3): il turno di gruppo gira nel contesto del MEMBRO, con la
    // sua apertura (blocco evidenza), la scadenza dei 5 minuti e l'esito nel
    // registro (SENT | PASS | TIMEOUT | CANCELLED | ERROR | SKIPPED)
    if (job.kind === 'group-turn') {
      await runGroupTurnJob(
        db,
        { runTurn: runTurnFn, interrupt, now: Date.now, armTimeout: defaultArmTimeout },
        job,
        emit
      )
      return
    }
    const p = job.payload as { routineId: number; title: string; prompt: string; event?: TriggerEventPayload }
    // fase 16c (C5): la riga di routine_runs si apre quando il job parte e si
    // chiude con l'esito — il feed Attività legge da lì, non dai job
    const { startRoutineRun, endRoutineRun, routineFailReason } = await import('../main/store/routine-runs')
    const runId = startRoutineRun(db, {
      routineId: p.routineId,
      agentId: job.agent_id,
      title: p.title,
      now: Date.now()
    })
    // fase 18b (H7): il modello PROPRIo della routine si legge dalla riga
    // ALL'ESECUZIONE (non all'accodamento: la routine può cambiare in coda).
    // Vale SOLO per questo turno; le continuazioni di task usano il bot.
    // Fase 16c correzioni (R3.3): questo NON è un controllo del modello del
    // bot (quello vive SOLO in resolveAgentModel): qui si passa la ROTTA della
    // routine al turno; se il suo provider non è più attivo lo decide runTurn
    // (H7: notice routineModelUnavailable e si usa il modello del bot).
    let route: RunTurnOptions['route'] | undefined
    if (typeof p.routineId === 'number') {
      const row = db.prepare('SELECT provider_id, model, thinking FROM routines WHERE id = ?').get(p.routineId) as
        | { provider_id?: string | null; model?: string | null; thinking?: string | null }
        | undefined
      if (row?.provider_id && row?.model) {
        route = {
          providerId: row.provider_id,
          model: row.model,
          ...(row.thinking ? { thinking: row.thinking as NonNullable<RunTurnOptions['route']>['thinking'] } : {})
        }
      }
    }
    // fase 6: il turno di un trigger parte dall'evento (evidenza nel blocco
    // delimitato <evento>); le routine a schedule restano come prima.
    // Fase 8 (punto 1): il flag dice al loop che il testo che apre il turno
    // viene da un evento esterno — l'auto-review non lo tocca
    const text = p.event
      ? formatTriggerEvent(p.title, p.prompt, p.event)
      : routineOpening(p.title, p.prompt)
    // fase 17c (C2, MU): l'apertura della routine in chat si mostra tradotta;
    // il testo che legge il modello resta quello di sopra (inglese). Fase 17c
    // correzioni (D1): anche l'apertura con evento ha la sua bolla tradotta
    // (open.triggerEvent) — il blocco <evento> grezzo NON entra nella bolla.
    // Un payload vecchio SENZA kind non riceve meta.ui: mostra il content
    // com'è (niente migrazione, niente crash)
    const { ui, UI } = await import('../main/ui-language')
    const openingUi = !p.event
      ? ui(UI.openRoutine, { title: p.title, prompt: p.prompt })
      : p.event.kind
        ? ui(UI.openTriggerEvent, {
          title: p.title,
          kind: p.event.kind,
          ...(p.event.item ? { item: p.event.item, withItem: 'yes' } : { withItem: 'no' })
        })
        : null
    try {
      await runTurnFn(job.agent_id, text, emit, undefined, {
        source: 'routine', title: p.title, ...opts, onTurnEntry,
        ...(p.event ? { externalEvent: true } : {}),
        ...(openingUi ? { extraMeta: { ui: openingUi } } : {}),
        ...(route ? { route } : {})
      })
      endRoutineRun(db, runId, 'ok', null, Date.now())
    } catch (e) {
      // il motivo è un CODICE: mai il testo grezzo del provider nello storico
      const reason = routineFailReason(e)
      endRoutineRun(db, runId, reason === 'cancelled' ? 'cancelled' : 'failed', reason, Date.now())
      throw e
    }
  }
}
