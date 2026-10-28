// Agent loop: messaggio → LLM streaming → tool-call → permessi → esecuzione → risultato.
// Rispecchia la semantica dei turni dell'originale, con pause-for-approval.
//
// §5.3: la cronologia per il modello si costruisce con buildMessages (history.ts,
// puro): [system, ...history] in ordine cronologico, taglio solo a confine di
// turno, nessuna coppia tool orfana, immagini sull'ultimo messaggio utente.
//
// §5.7: un turno per agente. La mappa `running` non viene MAI sovrascritta:
// running.set avviene solo quando non c'è già un run in corso per quell'agente.
// Fase 2: la coda per agente non vive più in memoria qui — è la tabella jobs
// del daemon (worker con lease) ad accodare i messaggi utente e a scartare le
// routine; se runTurn viene chiamato su un agente occupato (invariante violata)
// il turno viene scartato con una notice, mai sovrascritto.
//
// Fase 3 (§3bis L2): l'agente comunica SOLO tramite tool. Il testo libero del
// modello è ragionamento (entry 'thinking', nascosto in chat): all'utente
// arrivano solo le entry 'send-message' create da send_to_user / ask_user /
// draft_external. Ogni turno si chiude con un evento meta.turnEnd ∈
// FINISHED | STOPPED | SUPERSEDED | AWAITING_USER.
import { randomUUID } from 'node:crypto'
import { getAgent, listAgents, listRoutines, getEntries, updateAgent, appendEntry, updateEntryContent, updateEntryMeta, getSetting, holdOutboxEntry, db, getTask, createTask, updateTask, openTasksOf, MAX_OPEN_TASKS, listProviders, type AppendEntry } from '../store/db'
import { llmStream, type ChatMessage, type ToolCall } from './llm'
import { systemPrompt, secondaryPrompts, mainAgentSection } from './prompts'
import { toolDefs, executeTool } from './tools'
import * as permissions from './permissions'
import { getProvider } from './providers'
import { buildMessages, visibleReplyEntries } from './history'
import { planResume, INTERRUPTED_TOOL_RESULT, RESUME_NOTICE } from './resume'
import { isExternalSend, draftFromExternalCall, prepareDraft, DEFAULT_EXTERNAL_SEND_TOOLS, type ExternalSendConfig } from './external-send'
import { normalizeOptions, findDismissibleWidgets } from './widgets'
import { buildMemorySection } from './memory'
import { buildSkillsSection } from './skills'
import { maybeCompactHistory, summarizeWithLlm } from './compaction'
import { automationEventText } from './update-state'
import { formatAgentMessage, agentSendGuard, countPairMessagesLastHour, AGENT_HOP_MAX } from '../../shared/agent-message'
import { mainAgentOf } from '../../daemon/presence'
import { analyzeCommand } from './shell-ast'
import { commandKey, isNeverAuto } from './permission-rules'
import { autoReviewDecision, reviewWithConfiguredModel, AUTO_REVIEW_MAX_PER_TURN, type AutoReviewAction } from './auto-review'
import { activityOf, isToolLoop, stopReasonOfError } from './loop-guard'
import { nextWithDeadline, DEFAULT_STREAM_DEADLINES, StreamDeadlineError } from './stream-deadline'
// fase 9 (punto 0): regole dei send_to_user dentro il turno (dedup, tetto
// avanzamenti, result col testo consegnato)
import { deliveredResultText, alreadyDeliveredResult, isDuplicateSend, isWorkTool, messageCapResult, emptySendResult, turnCapResult, MAX_DELIVERED_PER_TURN } from './turn-sends'
// fase 9 (punto 1): modello di riserva quando il principale non risponde
import { fallbackModelFor, type ModelDefaultsMap } from './model-defaults'
import { shouldUseFallback } from './model-fallback'
// fase 10: gruppi (store) e regole del turno di gruppo (puro); correzioni C1-C3;
// correzione E2 (terzo giro): il recupero dei turni di gruppo finiti con la
// consegna scritta come testo libero
import { getGroup, getGroupMessage, isGroupMember, addGroupMessage, scheduleTurnsForMessage } from '../store/groups'
import {
  nextPostDepth, hasSentToUserInChain, alreadySentToUserResult,
  needsGroupRecovery, groupRecoveryTools, GROUP_RECOVERY_NUDGE, GROUP_CLOSING_RECOVERY_NUDGE,
  GROUP_CALLED_RECOVERY_NUDGE, GROUP_CALLED_CLOSING_RECOVERY_NUDGE
} from './group-turns'
import { MAX_CREATE_AGENTS_PER_TURN } from './tools'
import type { Approval, SandbotEvent, SendMessagePayload, TurnEnd } from '../../shared/types'

// §5.3: buildMessages vive in history.ts (modulo puro, testabile senza Electron)
export { buildMessages } from './history'

const MAX_STEPS = 24

/** Fase 3: il sollecito della chiamata di recupero quando un turno utente finisce senza send_to_user. */
export const RECOVERY_NUDGE =
  "Non hai chiamato né send_to_user né ask_user: l'utente non ha visto alcuna risposta. Rispondi ORA chiamando send_to_user (solo quello, nessun altro tool)."

type Emitter = (e: SandbotEvent) => void

interface Running {
  controller: AbortController
  // 'cancelled' = interrupt dell'utente (fase 4 0c): chiude l'approval in attesa
  approvals: Map<string, (decision: 'allow' | 'deny' | 'superseded' | 'cancelled') => void>
  /** true quando un nuovo messaggio utente ha sostituito il turno (solo supersedeIfPaused lo imposta). */
  superseded?: boolean
  /** fase 8 (punto 2): chiavi concesse "per questo turno" (in memoria, mai nel DB). */
  turnAllows: Set<string>
  /** fase 8 (punto 2): grant di turno in arrivo (l'analisi shell è async: il prossimo ask la aspetta). */
  pendingTurnGrant?: Promise<void>
  /** fase 8 (§3bis L7): il turno gira nel sotto-transcript di questo task. */
  taskId?: number
}
const running = new Map<string, Running>()

function setStatus(agentId: string, status: import('../../shared/types').AgentStatus, emit: Emitter): void {
  updateAgent(agentId, { status })
  emit({ type: 'status', agentId, status })
}

function emitLastEntry(agentId: string, emit: Emitter): void {
  emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })
}
export { emitLastEntry }

export function isRunning(agentId: string): boolean {
  return running.has(agentId)
}

/** Etichette umane degli esiti di turno (la UI mostra gli event solo col toggle ragionamento). */
const TURN_END_LABELS: Record<TurnEnd, string> = {
  FINISHED: 'Turno completato',
  STOPPED: 'Turno interrotto',
  SUPERSEDED: 'Turno sostituito da un nuovo messaggio',
  AWAITING_USER: 'In attesa della risposta dell’utente'
}

/**
 * Chiude il turno con un evento meta.turnEnd (§3bis L2: esito del turno nel
 * transcript). Correzione C5: gli STOPPED portano anche il motivo in
 * meta.stopReason ∈ loop | interrupt | model-error | rate-limit (il runner
 * dei turni di gruppo lo usa per l'esito nel registro).
 */
function endTurn(
  agentId: string,
  outcome: TurnEnd,
  emit: Emitter,
  taskId?: number,
  stopReason?: 'loop' | 'interrupt' | 'model-error' | 'rate-limit'
): void {
  appendEntry({
    agentId, kind: 'event', role: 'system', content: TURN_END_LABELS[outcome],
    meta: {
      turnEnd: outcome,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(outcome === 'STOPPED' && stopReason ? { stopReason } : {})
    }
  })
  emitLastEntry(agentId, emit)
}

/**
 * Fase 3: appende una entry 'send-message' (l'UNICO contenuto visibile in chat)
 * con meta.call = la tool-call che l'ha prodotta, così la storia ricostruita
 * dal transcript mostra al modello la chiamata originale.
 * Fase 6: ritorna l'entry (serve all'outbox per trattenere i messaggi non
 * urgenti dei turni automatici, meta.held).
 */
function appendSend(
  agentId: string,
  call: { id: string; name: string; arguments: string },
  message: SendMessagePayload,
  emit: Emitter,
  extra: Record<string, unknown> = {},
  taskId?: number
): import('../../shared/types').TranscriptEntry {
  const content = message.type === 'text' ? message.text
    : message.type === 'widget' ? message.prompt
    : message.type === 'connector' ? (message.reason || message.name)
    : message.type === 'task' ? message.title
    : message.type === 'rule' ? message.text
    : (message.subject || message.to || '')
  const entry = appendEntry({
    agentId, kind: 'send-message', role: 'assistant', content,
    meta: { call: { id: call.id, name: call.name, arguments: call.arguments }, message, ...extra, ...(taskId !== undefined ? { taskId } : {}) }
  })
  emit({ type: 'entries', agentId, entries: [entry] })
  return entry
}

/** Fase 6 (§3bis L9): l'agente aspetta l'utente (ask_user/approval/bozza) → evento di notifica. */
function emitNeedsInput(agentId: string, entry: import('../../shared/types').TranscriptEntry, preview: string, emit: Emitter): void {
  emit({ type: 'agent-notify', agentId, kind: 'needs-input', preview, at: entry.createdAt })
}

/**
 * Fase 3 (§3bis L10): l'utente ha scritto altro senza rispondere → i widget
 * pendenti con dismissOnMoveOn vengono marcati widgetDismissed.
 */
export function dismissPendingWidgets(agentId: string, emit: Emitter): void {
  for (const w of findDismissibleWidgets(getEntries(agentId))) {
    updateEntryMeta(w.id, { ...w.meta, widgetDismissed: true })
    const updated = getEntries(agentId).find((e) => e.id === w.id)
    if (updated) emit({ type: 'entries', agentId, entries: [updated] })
  }
}

export interface RunTurnOptions {
  /** 'user' (default): accodato se l'agente è occupato; 'routine': scartato con notice. */
  source?: 'user' | 'routine'
  /** Titolo routine per la notice di scarto. */
  title?: string
  /**
   * Ripresa dopo crash/retry (R1): id dell'entry del messaggio che ha aperto
   * il turno (payload.entryId del job). Il messaggio NON viene riscritto e il
   * turno interrotto viene riparato dal transcript prima di chiamare il modello.
   */
  resume?: { entryId: number }
  /** Primo tentativo: chiamato con l'id dell'entry utente appena aggiunta, PRIMA del modello. */
  onTurnEntry?: (entryId: number) => void
  /** Fase 3: la risposta a un widget ask_user (meta.respondedTo sul messaggio utente). */
  respondedTo?: number
  /** Fase 5: chi ha avviato il turno (es. 'CONNECTOR_CONNECTED' dopo la connessione di un connettore offerto). */
  initiator?: string
  /**
   * Fase 7 (§3bis L8): il turno è stato aperto da un messaggio di un altro
   * bot (initiator AGENT) — serve al limite anti-ciclo dei send_to_agent.
   */
  agentMessage?: { fromAgentId: string; fromAgentName: string; hop: number }
  /**
   * Fase 7 (correzione A3): il turno è una catena tra bot partita da un turno
   * automatico (routine/trigger, o a sua volta una catena automatica): i suoi
   * send_to_user seguono le regole dell'outbox come i turni di routine, e le
   * catene che genera restano automatiche. Una catena partita da un messaggio
   * dell'utente NON lo è e resta immediata.
   */
  automatic?: boolean
  /** Fase 7: meta extra del messaggio che apre il turno (es. templateName per TEMPLATE_IMPORT). */
  extraMeta?: Record<string, unknown>
  /**
   * Fase 8 (punto 1): il turno di routine è stato aperto da un evento esterno
   * (blocco <evento> di un trigger): il testo che ha generato le azioni non è
   * dell'utente — l'auto-review non può togliergli l'ultimo controllo.
   */
  externalEvent?: boolean
  /**
   * Fase 8 (correzione B1): origine salvata sulla riga del task alla creazione
   * e ripropagata dal runner a OGNI turno del task (continuazioni incluse) e
   * al TASK_DONE — un task nato da un turno non fidato non torna approvabile
   * in automatico solo perché il suo job gira con source 'user'.
   */
  untrusted?: boolean
  /** Fase 8 (§3bis L7): il turno gira nel sotto-transcript di questo task. */
  taskId?: number
  /**
   * Fase 10 (§3): il turno è un TURNO DI GRUPPO per questo membro. Le entry
   * portano meta.groupId (visibili nella storia del membro, nascoste nella
   * chat diretta tranne i messaggi all'utente e le card), niente recupero di
   * fine turno (il silenzio è un esito valido) e post_to_group conosce gruppo
   * e profondità della catena letta.
   */
  groupTurn?: {
    groupId: number
    /** profondità massima dei messaggi letti nell'apertura (il post avrà +1) */
    readMaxDepth: number
    /** root della catena letta nell'apertura (i post ereditano la root) */
    rootId: number | null
    /**
     * Correzione C2: è il turno di CHIUSURA del coordinatore — post_to_group
     * è rifiutato, la send all'utente non ha il tetto di catena (C3) e
     * l'apertura porta il flag chiusura="true".
     */
    closing?: boolean
    /**
     * Fase 11 (residuo 0b): il membro era @menzionato nella finestra letta
     * (@tutti compreso) oppure è il turno di chiusura. Con risposta vuota e
     * called vero il loop fa UNA chiamata di recupero col sollecito dedicato.
     */
    called?: boolean
  }
}

/**
 * Fase 8 (punto 2): chiave della grant "Consenti per questo turno" — lo stesso
 * tool con la stessa chiave del gate fino a fine turno. Per run-command la
 * chiave è l'insieme delle chiavi dei comandi della riga. null = azione non
 * turn-grantabile (update_state come "Consenti sempre", comandi never-auto):
 * il click ricade su "Consenti una volta".
 */
async function turnGrantKey(tool: string, input: Record<string, unknown>): Promise<string | null> {
  if (tool === 'update_state') return null
  if (tool === 'run-command') {
    const analysis = await analyzeCommand(String(input.command ?? ''))
    if (!analysis.commands.length || analysis.commands.some((c) => isNeverAuto(c))) return null
    return [...new Set(analysis.commands.map(commandKey))].sort().join(';')
  }
  return `${tool}|${permissions.targetKey(tool, input)}`
}

export async function runTurn(agentId: string, userText: string, emit: Emitter, images?: string[], opts: RunTurnOptions = {}): Promise<void> {
  const source = opts.source ?? 'user'

  // §5.7: un turno per agente — mai due run concurrently sulla stessa mappa.
  // In produzione il worker della coda jobs garantisce la serializzazione per
  // agente; qui la guardia resta come rete di sicurezza: il turno in eccesso
  // viene scartato con notice, non accodato né sovrascritto.
  if (running.has(agentId)) {
    const content = source === 'routine'
      ? `Routine "${opts.title ?? userText.slice(0, 40)}" saltata: l'agente è occupato.`
      : 'Agente occupato: messaggio scartato (la coda vive nella tabella jobs del daemon).'
    appendEntry({ agentId, kind: 'notice', role: 'system', content })
    emitLastEntry(agentId, emit)
    return
  }

  const agent = getAgent(agentId)
  if (!agent) throw new Error('Agente non trovato')
  if (!agent.providerId || !agent.model) {
    // fase 10 (residuo 0e): durante l'onboarding, se il provider ESISTE ma il
    // widget del ruolo è ancora in attesa, il problema non è la configurazione:
    // chiedere di configurare porta fuori strada
    const onboardingWaiting =
      listProviders().some((p) => p.enabled) &&
      getEntries(agentId).some((e) => e.kind === 'send-message' && e.meta?.onboardingRole && e.meta?.respondedValue === undefined)
    appendEntry({
      agentId, kind: 'notice', role: 'system',
      content: onboardingWaiting
        ? "C'è già un provider attivo: per farmi partire scegli il ruolo nel messaggio qui sopra (con la risposta preparo i tuoi bot)."
        : "Configura prima un provider e un modello nelle impostazioni dell'agente."
    })
    emitLastEntry(agentId, emit)
    return
  }
  const provider = getProvider(agent.providerId)
  if (!provider) throw new Error('Provider non trovato')

  const controller = new AbortController()
  const run: Running = { controller, approvals: new Map(), turnAllows: new Set() }
  if (opts.taskId !== undefined) run.taskId = opts.taskId
  running.set(agentId, run)

  // fase 7 (correzione A3): un turno è AUTOMATICO se è di routine/trigger o
  // se è stato aperto da una catena tra bot a sua volta automatica: outbox e
  // tetto urgent valgono per TUTTI i suoi send_to_user (recupero compreso)
  const automatic = source === 'routine' || opts.automatic === true

  // fase 8 (punto 1): i turni aperti da un altro bot o da un evento esterno
  // restano fuori dall'auto-review (prompt injection: l'ultimo controllo
  // umano non si toglie su testo che non è dell'utente). Correzione B1: vale
  // anche per l'origine propagata dai turni di task e dal TASK_DONE
  const untrustedTurn =
    opts.agentMessage !== undefined || opts.initiator === 'AGENT' || opts.externalEvent === true || opts.untrusted === true
  // fase 8 (punto 1): approvazioni automatiche concesse in questo turno (tetto 20)
  let autoApprovals = 0

  // id dell'entry che apre il turno: serve a decidere se l'utente ha VISTO qualcosa
  let turnEntryId = 0
  // ultimo testo libero non vuoto del modello nel turno (ripiego del fallback)
  let lastFreeText = ''
  // fase 7 (residuo 0b): nei turni automatici al massimo UN urgent per esecuzione
  let urgentUsed = false
  // fase 9 (punto 0c): i testi consegnati in questo turno, per la dedup
  const deliveredTexts: string[] = []
  // fase 9 (punto 0d): send_to_user consegnati dall'ultima tool call di lavoro
  // (più messaggi di fila senza lavoro in mezzo non diventano chat)
  let sendsSinceWork = 0
  // fase 10 (§3): un solo post_to_group per membro per turno (il secondo ha un
  // result esplicito che lo spiega); correzione C1: il silenzio esplicito
  // (pass) CHIUDE il turno di gruppo; correzione E2 (terzo giro): al massimo
  // UNA chiamata di recupero per turno quando la consegna è finita nel testo
  let groupPosted = false
  let passedSilence = false
  let groupRecoveryDone = false

  // fase 8 (§3bis L7): ogni entry scritta da un turno di TASK porta meta.taskId —
  // vive nel sotto-transcript del task, esclusa dalla chat principale.
  // fase 10 (§3): le entry di un TURNO DI GRUPPO portano meta.groupId — restano
  // nella storia del membro (il suo transcript unico) ma la chat diretta le
  // nasconde; i messaggi all'utente e le card NON lo portano e restano visibili
  const add = (e: AppendEntry): import('../../shared/types').TranscriptEntry =>
    appendEntry(
      opts.taskId === undefined && opts.groupTurn === undefined
        ? e
        : {
            ...e,
            meta: {
              ...(e.meta ?? {}),
              ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
              ...(opts.groupTurn !== undefined ? { groupId: opts.groupTurn.groupId } : {})
            }
          }
    )
  // le approval e gli ask_user dentro un task portano lo stato a needs_input
  // (la card in chat principale lo segnala); le risposte lo riportano a working
  const taskNeedsInput = (): void => {
    if (opts.taskId === undefined) return
    updateTask(opts.taskId, { status: 'needs_input' })
    emit({ type: 'tasks' })
  }
  const taskWorking = (): void => {
    if (opts.taskId === undefined) return
    updateTask(opts.taskId, { status: 'working' })
    emit({ type: 'tasks' })
  }

  /**
   * Un send_to_user con le regole dei turni automatici (residuo 0b + §3bis L4):
   * il primo urgent passa, i successivi diventano non urgenti, e i non urgenti
   * restano in outbox fino alla finestra di consegna o all'apertura della chat.
   * Correzione A3: lo usa anche la chiamata di recupero, così nemmeno quella
   * svuota l'outbox di una catena automatica. Torna true se trattenuto.
   */
  const sendToUser = (call: { id: string; name: string; arguments: string }, input: Record<string, unknown>): boolean => {
    let urgent = input.urgent === true
    if (urgent && automatic) {
      if (urgentUsed) urgent = false
      else urgentUsed = true
    }
    const message: SendMessagePayload = { type: 'text', text: String(input.text ?? ''), ...(urgent ? { urgent: true } : {}) }
    const hold = automatic && !urgent
    // correzione C3: le send dei turni di gruppo portano la CATENA (chiave
    // diversa da meta.groupId: i messaggi all'utente restano visibili in chat)
    const extra: Record<string, unknown> = { ...(hold ? { held: true } : {}) }
    if (opts.groupTurn) {
      extra.groupChain = { groupId: opts.groupTurn.groupId, rootId: opts.groupTurn.rootId ?? null }
    }
    const sent = appendSend(agentId, call, message, emit, extra, opts.taskId)
    if (hold) holdOutboxEntry(sent.id, agentId, sent.createdAt)
    return hold
  }

  /**
   * Fase 9 (punto 0): consegna una send_to_user con le regole del turno — un
   * testo uguale o contenuto in uno già consegnato NON viene riconsegnato
   * (0c) e dopo un messaggio non seguito da lavoro il testo diventa
   * ragionamento, non chat (0d). Il result riporta sempre l'inizio del testo
   * consegnato (0b), così il modello può verificare che è arrivato intero.
   * La usa anche la chiamata di recupero: stesse regole a fine turno.
   */
  const deliverSend = (call: { id: string; name: string; arguments: string }, input: Record<string, unknown>): string => {
    const text = String(input.text ?? '')
    // testo vuoto: niente messaggio vuoto in chat (visto nell'eval: un modello
    // a volte chiama send_to_user senza text)
    if (!text.trim()) return emptySendResult()
    // correzione C3: nei turni di gruppo NON di chiusura al massimo UN
    // messaggio per membro per catena — dal secondo il testo è ragionamento,
    // il riepilogo arriva alla chiusura. La chiusura ha sempre il suo messaggio.
    if (
      opts.groupTurn && !opts.groupTurn.closing &&
      hasSentToUserInChain(getEntries(agentId), { groupId: opts.groupTurn.groupId, rootId: opts.groupTurn.rootId ?? null })
    ) {
      add({ agentId, kind: 'thinking', role: 'assistant', content: text })
      emitLastEntry(agentId, emit)
      return alreadySentToUserResult()
    }
    if (isDuplicateSend(deliveredTexts, text)) return alreadyDeliveredResult(text)
    // fase 10 (residuo 0c): dal quarto send_to_user consegnato del turno il
    // testo è ragionamento — tre messaggi bastano per un turno di lavoro
    if (deliveredTexts.length >= MAX_DELIVERED_PER_TURN) {
      add({ agentId, kind: 'thinking', role: 'assistant', content: text })
      emitLastEntry(agentId, emit)
      return turnCapResult()
    }
    if (sendsSinceWork >= 1) {
      add({ agentId, kind: 'thinking', role: 'assistant', content: text })
      emitLastEntry(agentId, emit)
      return messageCapResult()
    }
    const hold = sendToUser(call, input)
    deliveredTexts.push(text)
    sendsSinceWork++
    return deliveredResultText(text, { held: hold })
  }

  try {
    // fase 8 (§3bis L7): il turno di un task rimosso o annullato dall'utente
    // mentre era in coda non parte; ogni avvio di job del task lo riporta working
    if (opts.taskId !== undefined) {
      const t = getTask(opts.taskId)
      if (!t || t.status === 'cancelled') {
        appendEntry({ agentId, kind: 'notice', role: 'system', content: `Task ${opts.taskId} annullato: esecuzione saltata.` })
        emitLastEntry(agentId, emit)
        return
      }
      updateTask(opts.taskId, { status: 'working' })
      emit({ type: 'tasks' })
    }
    // fase 8 (§3bis L7): contesto SEPARATO — il task vede solo il brief (il
    // messaggio che lo apre) e le proprie entry; la chat principale non vede
    // le entry dei task (e viceversa)
    const scopedEntries = () =>
      opts.taskId === undefined
        ? getEntries(agentId).filter((e) => e.meta?.taskId === undefined)
        : getEntries(agentId).filter((e) => e.meta?.taskId === opts.taskId)

    if (opts.resume) {
      // R1: ripresa dal transcript — il messaggio utente NON viene riscritto;
      // il turno interrotto viene riparato PRIMA di chiamare il modello
      turnEntryId = opts.resume.entryId
      const plan = planResume(scopedEntries(), opts.resume.entryId)
      if (plan.alreadyComplete) {
        // il turno era già concluso: completa senza chiamare il modello
        // (l'evento di fine c'è già, a meno che il crash non precedesse la fase 3)
        const alreadyEnded = scopedEntries().some(
          (e) => e.id > opts.resume!.entryId && e.kind === 'event' && e.meta?.turnEnd
        )
        if (!alreadyEnded) endTurn(agentId, 'FINISHED', emit, opts.taskId)
        setStatus(agentId, 'idle', emit)
        updateAgent(agentId, { unread: 0 })
        emit({ type: 'agents' })
        return
      }
      for (const appr of plan.pendingApprovals) {
        updateEntryMeta(appr.id, { ...appr.meta, status: 'expired' })
        const updated = getEntries(agentId).find((e) => e.id === appr.id)
        if (updated) emit({ type: 'entries', agentId, entries: [updated] })
      }
      for (const call of plan.interruptedToolCalls) {
        const res = add({
          agentId, kind: 'tool-result', role: 'system', content: INTERRUPTED_TOOL_RESULT,
          meta: { callId: String(call.meta?.id ?? call.id) }
        })
        emit({ type: 'entries', agentId, entries: [res] })
      }
      add({ agentId, kind: 'notice', role: 'system', content: RESUME_NOTICE })
      emitLastEntry(agentId, emit)
    } else {
      const entry = add({
        agentId, kind: 'message', role: 'user', content: userText,
        meta: {
          ...(opts.respondedTo !== undefined ? { respondedTo: opts.respondedTo } : {}),
          ...(opts.initiator ? { initiator: opts.initiator } : {}),
          // fase 7: provenienza del messaggio di un altro bot (rate per coppia)
          ...(opts.agentMessage ? { fromAgentId: opts.agentMessage.fromAgentId, fromAgentName: opts.agentMessage.fromAgentName, toAgentId: agentId, hop: opts.agentMessage.hop } : {}),
          ...(opts.extraMeta ?? {}),
          ...(images?.length ? { images: images.length } : {})
        }
      })
      emitLastEntry(agentId, emit)
      turnEntryId = entry.id
      // R1: l'id dell'entry che apre il turno finisce nel payload del job,
      // PRIMA di chiamare il modello, per poter riprendere dopo un crash
      opts.onTurnEntry?.(entry.id)
    }

    // fase 4: compaction della history PRIMA di costruire i messaggi — se la
    // storia stimata supera il 70% del budget di contesto, i turni più vecchi
    // diventano un'entry summary (se la chiamata LLM fallisce si prosegue col
    // taglio a confine di turno già fatto da buildMessages).
    // Fase 8: i task hanno un contesto separato (brief + entry del task): la
    // compaction della chat principale non li tocca
    if (opts.taskId === undefined) {
      await maybeCompactHistory(
        agentId, provider.id, agent.model,
        (digest) => summarizeWithLlm(provider, agent.model!, digest, secondaryPrompts.compaction),
        emit
      )
    }

    // §5.3: il messaggio corrente è l'ultimo entry del transcript → compare una volta sola.
    // Fase 4: il system prompt include memoria (§3bis L6) e skill disponibili.
    // Fase 5: include le istruzioni personalizzate dei connettori connessi.
    // Fase 7: se questo è il bot principale, la sezione di coordinamento con
    // l'elenco degli altri bot (nome, descrizione, routine attive)
    let mainSection = ''
    try {
      const agents = listAgents()
      if (mainAgentOf(agents, getSetting<string | null>('mainAgentId', null))?.id === agentId) {
        mainSection = mainAgentSection(
          agents
            .filter((a) => a.id !== agentId)
            .map((a) => ({
              name: a.name,
              description: a.description,
              routines: listRoutines(a.id).filter((r) => r.enabled).map((r) => r.title)
            }))
        )
      }
    } catch {
      // elenco non disponibile: il prompt resta quello di base
    }
    let connectorsSection = ''
    try {
      const { connectorInstructionsFromSettings } = await import('../connectors')
      const { listServers } = await import('../mcp')
      connectorsSection = connectorInstructionsFromSettings(
        listServers(),
        getSetting<Record<string, import('../connectors').ConnectorState>>('connectors.state', {})
      )
    } catch {
      // connettori non disponibili: il system prompt resta quello di base
    }
    const messages: ChatMessage[] = buildMessages(
      systemPrompt(agent) + mainSection + buildMemorySection(agentId) + buildSkillsSection(agentId) + connectorsSection,
      scopedEntries(),
      images
    )

    // tool statici + tool MCP attivi (server esterni → mcp__<server>__<tool>)
    const { toolDefs } = await import('./tools')
    let allTools = toolDefs
    try {
      const { activeTools } = await import('../mcp')
      allTools = [...toolDefs, ...(await activeTools())]
    } catch {
      // MCP non disponibile: prosegue coi tool base
    }
    // correzione E2: i tool del passo corrente — la chiamata di recupero di un
    // turno di gruppo li restringe a quelli del sollecito
    let turnTools = allTools

    // fase 3 (§3bis L5): quali tool MCP sono invii verso l'esterno
    const externalCfg = getSetting<ExternalSendConfig>('externalSendTools', DEFAULT_EXTERNAL_SEND_TOOLS)

    // fase 8 (§3bis L11): scadenze dello stream — 150 s per il primo token,
    // 90 s di inattività tra due chunk (configurabili): scaduto si abortisce
    // il SOLO stream e il turno chiude STOPPED (ripresa normale al messaggio
    // successivo)
    const deadlines = {
      firstTokenMs: getSetting<number>('llm.firstTokenMs', DEFAULT_STREAM_DEADLINES.firstTokenMs),
      idleMs: getSetting<number>('llm.streamIdleMs', DEFAULT_STREAM_DEADLINES.idleMs)
    }

    // fase 9 (punto 1): la RISERVA — se il modello principale non risponde
    // (5xx, timeout, scadenza dello stream) il turno riprova UNA volta col
    // modello di riserva dello stesso provider; mai sui 4xx
    const fallbackModel = fallbackModelFor(provider, getSetting<ModelDefaultsMap>('providers.modelDefaults', {}))
    let activeModel = agent.model
    let fallbackUsed = false

    setStatus(agentId, 'thinking', emit)

    let awaitingUser = false
    let finished = false
    // fase 8 (§3bis L11): le tool call eseguite nel turno, per la loop detection
    const executedCalls: Array<{ name: string; args: string }> = []

    for (let step = 0; step < MAX_STEPS; step++) {
      if (controller.signal.aborted) break
      // lo stream ha un abort dedicato: la scadenza ferma SOLO lui, non il turno
      const streamAbort = new AbortController()
      const onTurnAbort = (): void => streamAbort.abort()
      controller.signal.addEventListener('abort', onTurnAbort)
      const stream = llmStream(provider, activeModel, messages, turnTools, AbortSignal.any([controller.signal, streamAbort.signal]))
      // fase 3: il testo libero è ragionamento interno, non una risposta
      const entry = add({ agentId, kind: 'thinking', role: 'assistant', content: '' })
      emit({ type: 'entries', agentId, entries: [entry] })

      let acc = ''
      let final: { text: string; toolCalls: ToolCall[]; finishReason: string }
      let finalToolCalls: ToolCall[] = []
      let finalFinish = 'stop'
      try {
        const it = stream[Symbol.asyncIterator]()
        let firstChunk = false
        for (;;) {
          const r = await nextWithDeadline(it, firstChunk, deadlines)
          if (r.done) break
          const ch = r.value
          firstChunk = true
          if (ch.textDelta) {
            acc += ch.textDelta
            emit({ type: 'delta', agentId, entryId: entry.id, text: ch.textDelta })
          }
          if (ch.reasoningDelta) {
            emit({ type: 'delta', agentId, entryId: entry.id, text: ch.reasoningDelta, reasoning: true })
          }
          if (ch.toolCalls) finalToolCalls = ch.toolCalls
          if (ch.finishReason) finalFinish = ch.finishReason
        }
        final = { text: acc, toolCalls: finalToolCalls, finishReason: finalFinish }
      } catch (err) {
        streamAbort.abort()
        updateEntryContent(entry.id, acc)
        // fase 9 (punto 1): il modello principale non risponde → UNA riprova
        // col modello di riserva (lo step consumato conta nel tetto MAX_STEPS)
        if (
          shouldUseFallback(err, {
            fallbackModel, model: activeModel, fallbackUsed, aborted: controller.signal.aborted
          })
        ) {
          fallbackUsed = true
          activeModel = fallbackModel!
          const why = err instanceof Error ? err.message : String(err)
          add({
            agentId, kind: 'notice', role: 'system',
            content: `Il modello principale ${agent.model} non risponde (${why}): uso la riserva ${activeModel}.`
          })
          emitLastEntry(agentId, emit)
          continue
        }
        if (err instanceof StreamDeadlineError) {
          // fase 8 (§3bis L11): il modello non risponde — abort del solo stream
          add({ agentId, kind: 'notice', role: 'system', content: `Il modello non risponde (${err.message}): turno interrotto.` })
          emitLastEntry(agentId, emit)
          endTurn(agentId, 'STOPPED', emit, opts.taskId, 'model-error')
          setStatus(agentId, 'idle', emit)
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        add({ agentId, kind: 'notice', role: 'system', content: `Errore dal modello: ${msg}` })
        emitLastEntry(agentId, emit)
        // correzione C5: il motivo distingue il limite d'uso del provider (429)
        // dagli altri errori; se il turno era già stato interrotto è un interrupt
        endTurn(agentId, 'STOPPED', emit, opts.taskId, controller.signal.aborted ? 'interrupt' : stopReasonOfError(err))
        setStatus(agentId, 'idle', emit)
        return
      } finally {
        controller.signal.removeEventListener('abort', onTurnAbort)
      }
      const text = final.text
      updateEntryContent(entry.id, text)
      if (text.trim()) lastFreeText = text

      if (!text && !final.toolCalls?.length) {
        // fase 11 (residuo 0b): risposta VUOTA in un turno di gruppo del membro
        // CHIAMATO (menzionato nella finestra o turno di chiusura) → UNA chiamata
        // di recupero col sollecito dedicato, lo stesso passo in più di E2 per il
        // testo libero non pubblicato; il chiamato che non risponde non lascia la
        // richiesta senza risposta
        if (
          opts.groupTurn !== undefined && !groupRecoveryDone &&
          needsGroupRecovery({
            finished: true,
            passed: passedSilence,
            posted: groupPosted,
            userContact: scopedEntries().some((e) => e.id > turnEntryId && (e.kind === 'send-message' || e.kind === 'approval')),
            freeText: '',
            called: opts.groupTurn.called
          })
        ) {
          groupRecoveryDone = true
          turnTools = groupRecoveryTools(allTools, opts.groupTurn.closing === true)
          messages.push({
            role: 'user',
            content: opts.groupTurn.closing ? GROUP_CALLED_CLOSING_RECOVERY_NUDGE : GROUP_CALLED_RECOVERY_NUDGE
          })
          continue
        }
        add({ agentId, kind: 'notice', role: 'system', content: 'Il modello non ha prodotto risposta (vuota).' })
        emitLastEntry(agentId, emit)
        endTurn(agentId, 'STOPPED', emit, opts.taskId, 'model-error')
        setStatus(agentId, 'idle', emit)
        return
      }

      if (!final.toolCalls?.length) {
        // correzione E2 (terzo giro): un turno di gruppo FINISHED senza post,
        // senza pass e senza contatto con l'utente, ma CON testo libero, è una
        // consegna scritta come ragionamento che nessuno ha letto — UNA
        // chiamata di recupero col sollecito, SOLO coi tool del sollecito
        // (post_to_group e pass; nella chiusura send_to_user e pass). Le
        // chiamate che produce passano dallo STESSO percorso del turno (depth,
        // rootId, tetti, rifiuto del post nella chiusura); se anche il recupero
        // risponde solo testo il turno resta PASS: il testo NON diventa mai un
        // post (il registro segna il motivo).
        if (
          opts.groupTurn !== undefined && !groupRecoveryDone &&
          needsGroupRecovery({
            finished: true,
            passed: passedSilence,
            posted: groupPosted,
            userContact: scopedEntries().some((e) => e.id > turnEntryId && (e.kind === 'send-message' || e.kind === 'approval')),
            freeText: text,
            called: opts.groupTurn.called
          })
        ) {
          groupRecoveryDone = true
          turnTools = groupRecoveryTools(allTools, opts.groupTurn.closing === true)
          messages.push({ role: 'user', content: opts.groupTurn.closing ? GROUP_CLOSING_RECOVERY_NUDGE : GROUP_RECOVERY_NUDGE })
          continue
        }
        // turno concluso senza tool: fine
        finished = true
        break
      }

      messages.push({ role: 'assistant', content: text, toolCalls: final.toolCalls })

      setStatus(agentId, 'running', emit)
      let paused = false

      for (const call of final.toolCalls) {
        if (controller.signal.aborted) break
        let input: Record<string, unknown>
        try {
          input = JSON.parse(call.arguments || '{}')
        } catch {
          input = {}
        }

        // fase 8 (§3bis L11): loop detection — la stessa identica chiamata
        // (nome + argomenti) per la TERZA volta di fila ferma il turno con una
        // notice leggibile, invece di consumare tutti i MAX_STEPS
        if (isToolLoop(executedCalls, { name: call.name, args: call.arguments })) {
          add({ agentId, kind: 'notice', role: 'system', content: 'Turno interrotto: la stessa identica chiamata si ripete (loop).' })
          emitLastEntry(agentId, emit)
          endTurn(agentId, 'STOPPED', emit, opts.taskId, 'loop')
          setStatus(agentId, 'idle', emit)
          return
        }
        executedCalls.push({ name: call.name, args: call.arguments })
        // fase 9 (punto 0d): ogni tool che non è "parlare" è lavoro — azzera
        // il conteggio dei messaggi consecutivi senza lavoro in mezzo
        if (isWorkTool(call.name)) sendsSinceWork = 0

        // ---- fase 3 (§3bis L2/L5): comunicazione e invii esterni, gestiti dal loop ----

        // invio esterno chiamato direttamente: MAI eseguito, diventa una bozza
        if (isExternalSend(call.name, externalCfg)) {
          const draft = appendSend(agentId, call, draftFromExternalCall(call.name, input), emit, { status: 'pending' }, opts.taskId)
          emitNeedsInput(agentId, draft, `bozza in attesa: ${draft.content.slice(0, 80)}`, emit)
          taskNeedsInput()
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: 'Invio esterno non eseguito: trasformato in una bozza in attesa della conferma dell’utente. Per gli invii usa draft_external.'
          })
          continue
        }

        if (call.name === 'send_to_user') {
          // fase 6/7: tetto urgent e outbox dei turni automatici vivono in
          // sendToUser (dentro deliverSend); fase 9 (0b/0c/0d): result col
          // testo consegnato, dedup e tetto degli avanzamenti
          messages.push({ role: 'tool', toolCallId: call.id, content: deliverSend(call, input) })
          continue
        }

        if (call.name === 'draft_external') {
          const channel = input.channel === 'email' || input.channel === 'slack' ? input.channel : 'other'
          // D1 (review fase 3): il via del modello è tenuto SOLO se è un invio
          // esterno configurato; to/subject/body entrano in via.args secondo la
          // fieldMap, così la card mostra esattamente ciò che verrà inviato
          const prepared = prepareDraft({
            channel,
            to: String(input.to ?? ''),
            ...(input.subject !== undefined ? { subject: String(input.subject) } : {}),
            body: String(input.body ?? ''),
            via: input.via,
            cfg: externalCfg
          })
          const draft = appendSend(agentId, call, prepared.message, emit, { status: 'pending' }, opts.taskId)
          // fase 8 (punto 1): l'auto-review può approvare l'INVIO della bozza
          // con le regole dell'utente ("Continua da solo quando…"); tutto ciò
          // che non convince il revisore resta card come prima
          const via = prepared.message.via
          let autoSend: { ok: true; ruleMatched: string } | { ok: false; error: string } | null = null
          if (via && !prepared.viaRejected && autoApprovals < AUTO_REVIEW_MAX_PER_TURN) {
            const action: AutoReviewAction = {
              tool: 'draft_external',
              draft: {
                channel: prepared.message.channel, to: prepared.message.to,
                ...(prepared.message.subject !== undefined ? { subject: prepared.message.subject } : {}),
                body: prepared.message.body
              },
              neverAuto: false, untrustedTurn
            }
            const review = await reviewWithConfiguredModel(action)
            if (review) {
              const decision = autoReviewDecision(review.cfg, action, review.outcome, autoApprovals)
              if (decision.autoAllow) {
                // come il click su Invia: il gate resta in mezzo (una regola
                // blocked nega comunque l'invio)
                const verdict = await permissions.check(via.tool, via.args, agentId)
                if (verdict.kind === 'deny') {
                  autoSend = { ok: false, error: 'invio bloccato dai permessi' }
                } else {
                  autoApprovals++
                  try {
                    const { output } = await executeTool(agentId, via.tool, via.args, { turnInitiator: opts.initiator })
                    updateEntryMeta(draft.id, {
                      ...draft.meta, status: 'sent',
                      autoApproved: true, ruleMatched: decision.ruleMatched
                    })
                    const updated = getEntries(agentId).find((e) => e.id === draft.id)
                    if (updated) emit({ type: 'entries', agentId, entries: [updated] })
                    add({ agentId, kind: 'notice', role: 'system', content: `Bozza inviata automaticamente (${via.tool}). Esito: ${output.slice(0, 300)}` })
                    emitLastEntry(agentId, emit)
                    autoSend = { ok: true, ruleMatched: decision.ruleMatched }
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    updateEntryMeta(draft.id, { ...draft.meta, status: 'error' })
                    const updated = getEntries(agentId).find((e) => e.id === draft.id)
                    if (updated) emit({ type: 'entries', agentId, entries: [updated] })
                    autoSend = { ok: false, error: msg }
                  }
                }
              }
            }
          }
          if (!autoSend?.ok) {
            // niente invio automatico (o fallito): la bozza aspetta l'utente
            emitNeedsInput(agentId, draft, `bozza in attesa: ${draft.content.slice(0, 80)}`, emit)
            taskNeedsInput()
          }
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: prepared.viaRejected
              ? `bozza creata di solo testo: "via" scartato perché ${prepared.viaRejected} non è un tool di invio esterno configurato (nessun canale di invio collegato).`
              : autoSend?.ok
                ? `bozza INVIATA automaticamente per la regola di auto-review "${autoSend.ruleMatched}" dell'utente: esito riportato in chat.`
                : autoSend && !autoSend.ok
                  ? `invio automatico della bozza non riuscito (${autoSend.error}): la bozza resta in attesa del click dell'utente.`
                  : 'bozza creata e mostrata all’utente: l’invio avverrà solo se l’utente clicca Invia'
          })
          continue
        }

        if (call.name === 'ask_user') {
          const options = normalizeOptions(input.options)
          const message: SendMessagePayload = {
            type: 'widget', prompt: String(input.prompt ?? ''), options,
            ...(input.helpText !== undefined ? { helpText: String(input.helpText) } : {}),
            ...(input.multiSelect ? { multiSelect: true } : {}),
            ...(input.allowCustom ? { allowCustom: true } : {}),
            ...(input.dismissOnMoveOn ? { dismissOnMoveOn: true } : {})
          }
          const widget = appendSend(agentId, call, message, emit, {}, opts.taskId)
          emitNeedsInput(agentId, widget, String(input.prompt ?? ''), emit)
          taskNeedsInput()
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: 'widget mostrato all’utente: il turno termina e la risposta arriverà come nuovo messaggio utente. Non ripetere la domanda.'
          })
          awaitingUser = true
          break // il turno TERMINA: le chiamate successive della stessa risposta non vengono eseguite
        }

        // fase 5 (§3ter T2-T3, funnel): OFFERTA di connessione — l'agente NON
        // può connettere da solo, crea solo la card col bottone "Connetti";
        // quando l'utente connette, arriverà un messaggio di sistema
        // (meta.initiator CONNECTOR_CONNECTED) per proseguire
        if (call.name === 'offer_connector') {
          const entry2 = (await import('../connectors')).loadCatalog().find((c) => c.id === String(input.id ?? ''))
          if (!entry2) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: `Connettore "${String(input.id ?? '')}" non esistente: cerca quello giusto con search_connectors.`
            })
            continue
          }
          const message: SendMessagePayload = {
            type: 'connector', connectorId: entry2.id, name: entry2.name,
            ...(input.reason !== undefined ? { reason: String(input.reason) } : {})
          }
          appendSend(agentId, call, message, emit, { status: 'pending' }, opts.taskId)
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: `offerta mostrata all'utente: la connessione di ${entry2.name} avviene SOLO dal suo click sul bottone Connetti. Quando l'utente connette riceverai un messaggio di sistema e potrai usare i tool mcp__${entry2.id}__*.`
          })
          continue
        }

        // fase 8 (§3bis L5): proposta di regola di auto-review — l'agente NON
        // può scriversi le regole da solo: la proposta diventa una card e la
        // regola si salva SOLO al click dell'utente
        if (call.name === 'propose_rule_change') {
          const kind = input.kind === 'allow' ? 'allow' : input.kind === 'block' ? 'block' : null
          const text = String(input.text ?? '').trim()
          if (!kind || !text) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: 'Proposta non valida: serve kind ("allow" o "block") e il testo della regola in linguaggio naturale.'
            })
            continue
          }
          const message: SendMessagePayload = { type: 'rule', kind, text, ...(input.why !== undefined ? { why: String(input.why) } : {}) }
          appendSend(agentId, call, message, emit, {}, opts.taskId)
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: 'Proposta mostrata all\'utente: la regola verrà salvata solo se lui la accetta dalla card (Impostazioni → Approvazione automatica).'
          })
          continue
        }

        // fase 8 (§3bis L7): apertura di un TASK THREAD — lavoro lungo in un
        // contesto separato: la chat principale resta pulita, il task gira
        // come job della stessa coda per agente (in serie con gli altri turni)
        if (call.name === 'create_task') {
          const title = String(input.title ?? '').trim()
          const brief = String(input.brief ?? '').trim()
          if (!title || !brief) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: 'Task non creato: servono title e brief (obiettivo e contesto completo: il task NON vede questa conversazione).'
            })
            continue
          }
          // correzione B2: niente task dentro un task — senza limite un modello
          // apre catene annidate che girano all'infinito
          if (opts.taskId !== undefined) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: 'Non puoi aprire un task da dentro un altro task: sei già in un task, fai il lavoro qui (chiudilo con update_task quando hai finito).'
            })
            continue
          }
          // correzione B2: al massimo 5 task aperti (working o needs_input)
          if (openTasksOf(agentId) >= MAX_OPEN_TASKS) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: `Non puoi aprire altri task: ci sono già ${MAX_OPEN_TASKS} task aperti (in corso o in attesa di una risposta). Chiudine qualcuno con update_task o parlane con l'utente.`
            })
            continue
          }
          // correzione B1: l'origine del turno che crea il task si salva sulla
          // riga — untrusted (altro bot/evento esterno: nel task l'auto-review
          // resta esclusa) e automatic (routine: outbox e tetto urgent)
          const task = createTask(agentId, title, { untrusted: untrustedTurn, automatic })
          // card nella chat principale (entry SENZA taskId: è il punto d'ingresso)
          appendSend(agentId, call, { type: 'task', taskId: task.id, title }, emit)
          const { enqueueJob } = await import('../store/jobs')
          const now = Date.now()
          enqueueJob(db(), {
            agentId, kind: 'task-run',
            payload: { taskId: task.id, brief },
            runAt: now, now
          })
          emit({ type: 'tasks' })
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: `Task "${title}" creato (id ${task.id}): partirà alla fine di questo turno (stessa coda, in serie). Il task non vede questa conversazione: il contesto sta nel brief. Chiudilo con update_task({id: ${task.id}, status: 'done' | 'failed', summary}) quando hai finito.`
          })
          continue
        }

        // fase 7 (§3bis L8): messaggio a un ALTRO bot — accodato come job
        // user-message con initiator AGENT; il destinatario lo riceverà come
        // blocco evidenza <messaggio_da_agente> e potrà rispondere al mittente
        if (call.name === 'send_to_agent') {
          const toId = String(input.agentId ?? '')
          const dest = listAgents().find((a) => a.id === toId)
          if (!dest) {
            messages.push({ role: 'tool', toolCallId: call.id, content: `Destinatario non trovato ("${toId}"): cerca l'id esatto con list_agents.` })
            continue
          }
          if (toId === agentId) {
            messages.push({ role: 'tool', toolCallId: call.id, content: 'Non puoi mandare un messaggio a te stesso: parla con l\'utente o delega a un altro bot.' })
            continue
          }
          const text = String(input.text ?? '')
          if (!text.trim()) {
            messages.push({ role: 'tool', toolCallId: call.id, content: 'Testo mancante: scrivi il messaggio per l\'altro bot nel campo text.' })
            continue
          }
          const { enqueueJob, pendingUserMessages, pendingAgentPairJobs, MAX_USER_MESSAGE_QUEUE } = await import('../store/jobs')
          const now = Date.now()
          // correzione A1: il limite per coppia si conta AL MOMENTO DELL'INVIO
          // e la fonte comprende i messaggi già ACCODATI (job non ancora
          // consegnati): con più tool call nella stessa risposta il tetto orario
          // scatta comunque, non solo quando il turno del destinatario parte
          const incomingHop = opts.agentMessage?.hop ?? 0
          const pairLastHour =
            countPairMessagesLastHour([...getEntries(agentId), ...getEntries(toId)], agentId, toId, now) +
            pendingAgentPairJobs(db(), agentId, toId, now)
          const guard = agentSendGuard({ incomingHop, pairLastHour })
          if (!guard.ok) {
            messages.push({ role: 'tool', toolCallId: call.id, content: guard.error })
            continue
          }
          // correzione A1: stesso tetto di coda dei messaggi dell'utente (fase 2)
          if (pendingUserMessages(db(), toId) >= MAX_USER_MESSAGE_QUEUE) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: `Coda piena per ${dest.name} (${MAX_USER_MESSAGE_QUEUE} messaggi già in attesa): messaggio NON accodato. Riprova più tardi o riassumi tutto in un solo messaggio.`
            })
            continue
          }
          // correzione A2: traccia lato MITTENTE — l'utente vede cosa è stato
          // delegato ("A <nome bot>") e buildMessages riporta l'entry al modello
          // come coppia send_to_agent + esito della coda nel turno successivo
          appendSend(agentId, call, { type: 'text', text }, emit, {
            toAgentId: toId, toAgentName: dest.name, hop: guard.hop, agentSend: true
          }, opts.taskId)
          enqueueJob(db(), {
            agentId: toId,
            kind: 'user-message',
            payload: {
              text: formatAgentMessage(agent.name, text),
              initiator: 'AGENT',
              fromAgentId: agentId,
              fromAgentName: agent.name,
              toAgentId: toId,
              hop: guard.hop,
              // correzione A3: la catena eredita l'automaticità del turno
              // mittente (routine/trigger, o catena automatica a sua volta)
              ...(automatic ? { automatic: true } : {})
            },
            runAt: now,
            now
          })
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: `Messaggio in coda per ${dest.name}: entrerà nel suo prossimo turno (passaggio ${guard.hop} di ${AGENT_HOP_MAX}). Lui non vede questa conversazione: se serve contesto, mettilo nel messaggio.`
          })
          continue
        }

        // ---- fase 10 (§3): il gruppo — scrivere e tacere ----

        // scrivere nel gruppo: intercettato perché serve il contesto del turno
        // (gruppo implicito, profondità della catena letta, un post per turno)
        // e perché ogni post genera i turni degli ALTRI membri (planGroupTurns)
        if (call.name === 'post_to_group') {
          const gid = opts.groupTurn?.groupId ?? (Number(input.groupId) > 0 ? Number(input.groupId) : 0)
          const text = String(input.text ?? '').trim()
          let result: string
          const g = gid ? getGroup(gid) : null
          if (!g) {
            result = 'Gruppo mancante: dentro un turno di gruppo è implicito; fuori serve groupId (i tuoi gruppi sono in list_agents).'
          } else if (opts.groupTurn?.closing) {
            // correzione C2: nel turno di chiusura non si pubblica più nel
            // gruppo — resta solo il riepilogo all'utente (o pass)
            result = "Il giro è chiuso: ora solo il riepilogo all'utente (send_to_user). Se l'hai già mandato, chiudi con pass."
          } else if (!opts.groupTurn && !isGroupMember(gid, agentId)) {
            result = `Non fai parte del gruppo "${g.name}": nel gruppo scrivono solo i membri.`
          } else if (!text) {
            result = 'Testo mancante: scrivi il messaggio nel campo text.'
          } else if (groupPosted) {
            result = 'Hai già scritto nel gruppo in questo turno: al massimo un messaggio per turno. Fondi il contenuto o aspetta il prossimo giro.'
          } else {
            const replyTo = input.replyTo !== undefined && input.replyTo !== null ? Number(input.replyTo) : null
            if (replyTo !== null && !getGroupMessage(replyTo)) {
              result = `Il messaggio ${replyTo} a cui rispondi non esiste in questo gruppo.`
            } else {
              // catena causale: il post di un turno di gruppo ha depth = max(depth
              // dei messaggi letti) + 1; un post da fuori (es. il messaggio di
              // avvio) apre una catena NUOVA (depth 0, root = se stesso)
              const depth = opts.groupTurn ? nextPostDepth(opts.groupTurn.readMaxDepth) : 0
              const msg = addGroupMessage({
                groupId: g.id, authorKind: 'agent', authorId: agentId, authorName: agent.name,
                text, replyTo,
                rootId: depth === 0 ? null : opts.groupTurn?.rootId ?? null,
                depth,
                automatic
              })
              groupPosted = true
              scheduleTurnsForMessage(msg, emit)
              emit({ type: 'groups' })
              result = `Pubblicato nel gruppo "${g.name}": «${text.slice(0, 120)}${text.length > 120 ? '…' : ''}». Gli altri membri lo riceveranno nel loro turno (chi non è chiamato può restare in silenzio).`
            }
          }
          const postEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: 'post_to_group',
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          const postRes = add({ agentId, kind: 'tool-result', role: 'system', content: result, meta: { callId: call.id } })
          emit({ type: 'entries', agentId, entries: [postEntry, postRes] })
          messages.push({ role: 'tool', toolCallId: call.id, content: result })
          continue
        }

        // tacere è un esito esplicito del turno di gruppo (vale anche chiudere
        // senza scrivere, ma così il modello lo dichiara e non riempie il gruppo).
        // Correzione C1: nei turni di gruppo pass è TERMINALE — registra il
        // silenzio e il turno finisce SUBITO (nessun'altra chiamata al modello;
        // i tool chiesti dopo pass nella stessa risposta non vengono eseguiti)
        if (call.name === 'pass') {
          const terminal = opts.groupTurn !== undefined
          const result = terminal
            ? 'Silenzio registrato: il tuo turno nel gruppo finisce qui.'
            : 'pass vale solo dentro i turni di gruppo: fuori puoi semplicemente non scrivere nulla.'
          const passEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: 'pass',
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          const passRes = add({ agentId, kind: 'tool-result', role: 'system', content: result, meta: { callId: call.id } })
          emit({ type: 'entries', agentId, entries: [passEntry, passRes] })
          messages.push({ role: 'tool', toolCallId: call.id, content: result })
          if (terminal) {
            passedSilence = true
            finished = true
            break
          }
          continue
        }

        // fase 10 (punto 1): al massimo 6 create_agent per turno — si contano
        // le chiamate già passate di qui in questo turno (compresa questa),
        // PRIMA del gate: dalla settima in poi si rifiuta
        if (call.name === 'create_agent' && executedCalls.filter((c) => c.name === 'create_agent').length > MAX_CREATE_AGENTS_PER_TURN) {
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: `Limite del turno raggiunto: al massimo ${MAX_CREATE_AGENTS_PER_TURN} create_agent per turno. Prosegui col gruppo che hai.`
          })
          continue
        }

        // ---- tool normali: entry tool-call, gate permessi, esecuzione ----

        // fase 8 (§3bis L7): stato live — nome del tool e target (dai SOLI
        // argomenti, mai testo generato dal modello) per la sidebar
        emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })

        const callEntry = add({
          agentId, kind: 'tool-call', role: 'assistant', content: `${call.name}`,
          meta: { id: call.id, name: call.name, arguments: call.arguments }
        })
        emit({ type: 'entries', agentId, entries: [callEntry] })

        // §5.1: il gate run-command analizza OGNI comando della riga (tree-sitter);
        // agentId serve al gate C5 (letture dentro/fuori dalla box in host).
        // fase 10 (punti 1-2): permessi PER ORIGINE — creare bot e gruppi parte
        // senza card SOLO nei turni dell'utente; nei turni automatici, di altri
        // bot, di gruppo o con contenuto esterno la card è SEMPRE (mai
        // auto-approvata: un'istruzione iniettata in un'email non crea bot).
        // Inverso: update_agent dei PROPRI bot e update_group del gruppo CREATO
        // bypassano il gate (per gli altri valgono le regole → card)
        const forcedOriginAsk = (call.name === 'create_agent' || call.name === 'create_group') && (automatic || untrustedTurn)
        const ownTarget = call.name === 'update_agent'
          ? getAgent(String(input.agentId ?? ''))
          : null
        const ownGroup = call.name === 'update_group' ? getGroup(Number(input.groupId)) : null
        let verdict: import('./permissions').Verdict
        if (forcedOriginAsk) {
          verdict = { kind: 'ask', reason: `${call.name}: il turno non è dell'utente — creare bot o gruppi richiede la sua approvazione` }
        } else if (ownTarget && ownTarget.createdBy === agentId) {
          verdict = { kind: 'allow', via: 'rule' }
        } else if (ownGroup && ownGroup.created_by === agentId) {
          verdict = { kind: 'allow', via: 'rule' }
        } else {
          verdict = await permissions.check(call.name, input, agentId)
        }

        if (verdict.kind === 'deny') {
          const denied = add({
            agentId, kind: 'notice', role: 'system',
            content: `Bloccato dai permessi: ${call.name}`, meta: { callId: call.id, denied: true }
          })
          emit({ type: 'entries', agentId, entries: [denied] })
          messages.push({ role: 'tool', toolCallId: call.id, content: 'Command blocked by permissions configuration' })
          continue
        }

        if (verdict.kind === 'ask') {
          // fase 8 (punto 2): una grant "per questo turno" appena concessa può
          // essere ancora in fase di calcolo (l'analisi shell è async)
          if (run.pendingTurnGrant) {
            await run.pendingTurnGrant
            run.pendingTurnGrant = undefined
          }
          // fase 8 (punto 2): "Consenti per questo turno" — stessa chiave del
          // gate fino alla fine del turno (in memoria, mai nel DB), niente card
          const tKey = await turnGrantKey(call.name, input)
          const turnGranted = tKey !== null && run.turnAllows.has(tKey)
          // fase 8 (punto 1): l'auto-review sta DOPO il gate e può SOLO
          // trasformare ask in allow, secondo le regole dell'utente
          let autoAllowed: { ruleMatched: string; reason?: string } | null = null
          // per la UI: i comandi never-auto non offrono "per questo turno"
          const neverAutoCmd = call.name === 'run-command'
            ? (await analyzeCommand(String(input.command ?? ''))).commands.some((c) => isNeverAuto(c))
            : false
          if (!turnGranted) {
            // fase 10: le ask forzate dall'ORIGINE non sono mai auto-approvabili
            // (il revisore giudicherebbe testo non dell'utente)
            const action: AutoReviewAction = { tool: call.name, args: input, neverAuto: neverAutoCmd || forcedOriginAsk, untrustedTurn }
            const review = await reviewWithConfiguredModel(action)
            if (review) {
              const decision = autoReviewDecision(review.cfg, action, review.outcome, autoApprovals)
              if (decision.autoAllow) {
                autoAllowed = { ruleMatched: decision.ruleMatched, ...(decision.reason ? { reason: decision.reason } : {}) }
                autoApprovals++
              }
            }
          }
          if (autoAllowed) {
            // tracciabilità: entry approval chiusa, la UI la mostra compressa
            // come "Approvato automaticamente dalla regola: …" ed espandibile
            const approvalEntry = add({
              agentId, kind: 'approval', role: 'system',
              content: `${call.name}: ${verdict.reason}`,
              meta: {
                tool: call.name, input, status: 'allowed', keys: verdict.keys,
                autoApproved: true, ruleMatched: autoAllowed.ruleMatched,
                ...(autoAllowed.reason ? { reason: autoAllowed.reason } : {}),
                ...(verdict.secretRefs?.length ? { secretRefs: verdict.secretRefs } : {})
              }
            })
            emit({ type: 'entries', agentId, entries: [approvalEntry] })
            // fall through: esecuzione come dopo un "allow" dell'utente
          } else if (!turnGranted) {
            // pause-for-approval: crea approval, attende decisione (come l'originale)
            const approval: Approval = {
              id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now()
            }
            run.approvals.set(approval.id, () => undefined)
            const approvalEntry = add({
              agentId, kind: 'approval', role: 'system',
              content: `${call.name}: ${verdict.reason}`,
              // C4: la card mostra i nomi dei segreti usati dal comando
              meta: {
                approvalId: approval.id, tool: call.name, input, status: 'pending', keys: verdict.keys,
                ...(verdict.secretRefs?.length ? { secretRefs: verdict.secretRefs } : {}),
                ...(neverAutoCmd ? { neverAuto: true } : {})
              }
            })
            setStatus(agentId, 'paused-for-approval', emit)
            emit({ type: 'entries', agentId, entries: [approvalEntry] })
            emit({ type: 'approval', agentId, approval })
            // fase 6 (§3bis L9): l'agente è fermo su un'approval → notifica
            emitNeedsInput(agentId, approvalEntry, `${call.name}: ${verdict.reason}`, emit)
            // fase 8 (§3bis L7): un'approval dentro un task lo mette in needs_input
            taskNeedsInput()

            const decision = await new Promise<'allow' | 'deny' | 'timeout' | 'superseded' | 'cancelled'>((resolve) => {
              run.approvals.set(approval.id, (d) => resolve(d))
              setTimeout(() => resolve('timeout'), getSetting<number>('permissions.timeoutMs', 5 * 60_000))
            })
            run.approvals.delete(approval.id)
            updateEntryMeta(approvalEntry.id, {
              ...approvalEntry.meta,
              status: decision === 'timeout' ? 'expired' : decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : decision === 'cancelled' ? 'cancelled' : 'superseded'
            })
            const updatedApproval = getEntries(agentId).find((x: import('../../shared/types').TranscriptEntry) => x.id === approvalEntry.id)
            if (updatedApproval) emit({ type: 'entries', agentId, entries: [updatedApproval] })
            // fase 8: la decisione dell'utente sblocca il task (working)
            taskWorking()
            if (decision === 'cancelled') {
              // fase 4 (0c): interrupt dell'utente — l'approval si chiude subito,
              // niente esecuzione, il turno finirà STOPPED (controller abortito)
              messages.push({ role: 'tool', toolCallId: call.id, content: 'Interrotto dall’utente.' })
              const res = add({ agentId, kind: 'tool-result', role: 'system', content: 'Interrotto dall’utente', meta: { callId: call.id } })
              emit({ type: 'entries', agentId, entries: [res] })
              break
            }
            if (decision === 'superseded') {
              // fase 3: un nuovo messaggio utente ha sostituito il turno
              messages.push({ role: 'tool', toolCallId: call.id, content: 'Sostituito da un nuovo messaggio dell’utente.' })
              const res = add({ agentId, kind: 'tool-result', role: 'system', content: 'Sostituito da un nuovo messaggio utente', meta: { callId: call.id } })
              emit({ type: 'entries', agentId, entries: [res] })
              break
            }
            if (decision === 'timeout') {
              add({ agentId, kind: 'notice', role: 'system', content: 'Approvazione scaduta.' })
              emitLastEntry(agentId, emit)
            }
            if (decision !== 'allow') {
              messages.push({
                role: 'tool', toolCallId: call.id,
                content: decision === 'deny' ? 'Denied by user: azione rifiutata.' : 'Approval expired.'
              })
              const res = add({ agentId, kind: 'tool-result', role: 'system', content: "Rifiutato dall'utente", meta: { callId: call.id } })
              emit({ type: 'entries', agentId, entries: [res] })
              setStatus(agentId, 'thinking', emit)
              paused = true
              continue
            }
            // allow: la standing grant la registra il resolver se "always"
            setStatus(agentId, 'thinking', emit)
          }
          // turnGranted: esecuzione senza chiedere di nuovo (grant di turno)
        }

        // esecuzione
        try {
          // correzione A5: il contesto del turno (chi lo ha aperto) serve a
          // update_state per decidere se accettare la provenance 'template';
          // correzione B3: il task corrente serve a update_task (dentro un
          // task si chiude SOLO quello)
          const { output, meta, images } = await executeTool(agentId, call.name, input, {
            turnInitiator: opts.initiator,
            ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {})
          })
          const res = add({
            agentId, kind: 'tool-result', role: 'system',
            content: output.slice(0, 50_000),
            meta: { callId: call.id, ...meta }
          })
          emit({ type: 'entries', agentId, entries: [res] })
          // fase 5: il tool MCP ha rifiutato perché il connettore ha il token
          // scaduto → card "Riconnetti" in chat (il click dell'utente riavvia l'OAuth)
          const reconnect = meta.needsReconnect as { serverName: string; connectorId: string } | undefined
          if (reconnect) {
            appendSend(
              agentId, call,
              { type: 'connector', connectorId: reconnect.connectorId, name: reconnect.serverName },
              emit,
              { status: 'pending', needsAuth: true },
              opts.taskId
            )
          }
          // fase 4 (§3ter T2/T4): ogni azione su routine produce l'evento
          // "automation-changed" in chat (meta.automation: azione, id, nome)
          if (meta.automation && typeof meta.automation === 'object') {
            const a = meta.automation as { action?: unknown; id?: unknown; name?: unknown }
            add({
              agentId, kind: 'event', role: 'system',
              content: automationEventText(String(a.action ?? ''), String(a.name ?? '')),
              meta: { automation: a }
            })
            emitLastEntry(agentId, emit)
          }
          // fase 10: il gruppo è cambiato (creato, membri, descrizione) — la
          // sidebar e la vista gruppo si aggiornano
          if (meta.groupChanged) emit({ type: 'groups' })
          // run-command restituisce output GIÀ redatto (§5.6): stesso testo al modello e al transcript
          messages.push({ role: 'tool', toolCallId: call.id, content: output.slice(0, 50_000) })
          // immagini (computer use): le inietta come messaggio vision — il formato
          // "immagine dentro il tool result" non è supportato ovunque, un user message sì
          if (images?.length) {
            messages.push({
              role: 'user',
              content: `[screenshot] Ecco lo screenshot richiesto dal tool use-app (le coordinate che vuoi cliccare si intendono in pixel di QUESTA immagine):`,
              images
            })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: `Errore: ${msg}`, meta: { callId: call.id, error: true } })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: `Error: ${msg}` })
        }
      }
      if (paused && messages[messages.length - 1]?.role === 'tool') {
        // dopo un rifiuto il modello può decidere come proseguire: continua il loop
      }
      // correzione C1: pass ha chiuso il turno di gruppo (niente altre chiamate)
      if (awaitingUser || passedSilence || controller.signal.aborted) break
    }

    // ---- fase 3: chiusura del turno con esito ----
    if (awaitingUser) {
      endTurn(agentId, 'AWAITING_USER', emit, opts.taskId)
    } else if (controller.signal.aborted) {
      endTurn(agentId, run.superseded ? 'SUPERSEDED' : 'STOPPED', emit, opts.taskId, 'interrupt')
    } else if (!finished) {
      add({ agentId, kind: 'notice', role: 'system', content: 'Turno interrotto: limite di passi raggiunto.' })
      emitLastEntry(agentId, emit)
      endTurn(agentId, 'STOPPED', emit, opts.taskId, 'loop')
    } else {
      // turno FINISHED: se l'UTENTE non ha visto nulla (nessuna send-message nel
      // turno) una chiamata di recupero chiede al modello send_to_user; se non
      // lo fa nemmeno ora, il testo libero diventa send-message con fallback.
      // Fase 8: nel contesto di un task valgono le SOLE entry del task.
      // Fase 10 (§3): nei turni di GRUPPO niente recupero — il silenzio è un
      // esito valido (PASS) e il testo libero non diventa mai un messaggio
      if (source === 'user' && opts.groupTurn === undefined && visibleReplyEntries(scopedEntries(), turnEntryId).length === 0) {
        messages.push({ role: 'user', content: RECOVERY_NUDGE })
        setStatus(agentId, 'thinking', emit)
        try {
          const rstream = llmStream(provider, activeModel, messages, allTools, controller.signal)
          let acc = ''
          let recoveryCalls: ToolCall[] = []
          const rit = rstream[Symbol.asyncIterator]()
          let rfirst = false
          for (;;) {
            const r = await nextWithDeadline(rit, rfirst, deadlines)
            if (r.done) break
            const ch = r.value
            rfirst = true
            if (ch.textDelta) acc += ch.textDelta
            if (ch.toolCalls) recoveryCalls = ch.toolCalls
          }
          const sends = recoveryCalls.filter((c) => c.name === 'send_to_user')
          if (sends.length) {
            for (const call of sends) {
              let input: Record<string, unknown>
              try { input = JSON.parse(call.arguments || '{}') } catch { input = {} }
              // correzione A3: anche il recupero di una catena automatica passa
              // dall'outbox (stesso tetto urgent dei turni di routine);
              // fase 9 (0c/0d): stesse regole di consegna del turno
              deliverSend(call, { ...input, text: String(input.text ?? acc) })
            }
          } else {
            const fallback = (acc.trim() ? acc : lastFreeText).trim()
            if (fallback) {
              add({
                agentId, kind: 'send-message', role: 'assistant', content: fallback,
                meta: { message: { type: 'text', text: fallback }, fallback: true }
              })
              emitLastEntry(agentId, emit)
            }
          }
        } catch {
          // la chiamata di recupero stessa fallisce: si prova il fallback col testo già avuto
          if (lastFreeText.trim()) {
            add({
              agentId, kind: 'send-message', role: 'assistant', content: lastFreeText.trim(),
              meta: { message: { type: 'text', text: lastFreeText.trim() }, fallback: true }
            })
            emitLastEntry(agentId, emit)
          }
        }
      }
      endTurn(agentId, 'FINISHED', emit, opts.taskId)
      // fase 6 (§3bis L9): agent-done = turno finito con almeno un messaggio
      // visibile (quelli trattenuti in outbox non contano: l'utente non lo
      // ha ancora visto, la notifica arriverà alla consegna... o mai)
      const visible = visibleReplyEntries(scopedEntries(), turnEntryId).filter((e) => !e.meta?.held)
      if (visible.length) {
        const last = visible[visible.length - 1]!
        emit({ type: 'agent-notify', agentId, kind: 'done', preview: last.content, at: last.createdAt })
      }
    }
    setStatus(agentId, 'idle', emit)
    updateAgent(agentId, { unread: 0 })
    emit({ type: 'agents' })
  } finally {
    running.delete(agentId)
    // fase 8 (§3bis L7): fine del turno = niente attività in corso
    emit({ type: 'activity', agentId, activity: null })
    if (getAgent(agentId)?.status !== 'offline') setStatus(agentId, 'idle', emit)
    emit({ type: 'agents' })
  }
}

export function interrupt(agentId: string): void {
  const run = running.get(agentId)
  if (!run) return
  // fase 4 (0c): le approval in attesa si risolvono SUBITO con 'cancelled' —
  // prima l'abort dello stream lasciava la promise appesa fino al timeout e
  // l'entry restava pending. Le entry le marca il loop quando riprende.
  for (const cb of run.approvals.values()) cb('cancelled')
  run.approvals.clear()
  run.controller.abort()
}

/**
 * Fase 8 (§3bis L7): interrompe il turno di un SOLO task (bottone sulla card):
 * stessa logica di interrupt, ma solo se il turno in corso è quello del task.
 */
export function interruptTask(agentId: string, taskId: number): boolean {
  const run = running.get(agentId)
  if (!run || run.taskId !== taskId) return false
  interrupt(agentId)
  return true
}

/**
 * Fase 3: un nuovo messaggio utente mentre l'agente è in paused-for-approval
 * sostituisce il turno in corso (SUPERSEDED): le approval pendenti diventano
 * 'superseded', il turno termina e il nuovo messaggio parte subito invece di
 * restare in coda. True se il supersede è avvenuto.
 */
export function supersedeIfPaused(agentId: string): boolean {
  const run = running.get(agentId)
  if (!run) return false
  const agent = getAgent(agentId)
  if (!agent || agent.status !== 'paused-for-approval') return false
  run.superseded = true
  for (const e of getEntries(agentId)) {
    if (e.kind === 'approval' && e.meta?.status === 'pending') {
      updateEntryMeta(e.id, { ...e.meta, status: 'superseded' })
      run.approvals.get(String(e.meta.approvalId))?.('superseded')
    }
  }
  run.controller.abort()
  return true
}

/**
 * Fase 8 (punto 2): mode 'once' = consentito una volta; 'always' = standing
 * grant persistente; 'turn' = chiave in memoria fino alla fine del turno
 * (mai nel DB). Per update_state e comandi never-auto 'turn' ricade su
 * 'once' (turnGrantKey → null): valgono gli stessi divieti di "Consenti sempre".
 */
export function resolveApproval(
  agentId: string,
  approvalId: string,
  decision: 'allow' | 'deny',
  mode: 'once' | 'always' | 'turn' = 'once'
): void {
  const run = running.get(agentId)
  const cb = run?.approvals.get(approvalId)
  if (!run || !cb) {
    console.log(`[sandbot] approval ${approvalId.slice(0, 8)} non in attesa (click stantio o già risolta)`)
    return
  }
  const entry = getEntries(agentId).findLast((e: import('../../shared/types').TranscriptEntry) => e.kind === 'approval' && e.meta?.approvalId === approvalId)
  if (decision === 'allow' && mode === 'always') {
    // registra standing grant per il tool+target dell'approval in sospeso
    if (entry) {
      void permissions.grantStanding(String(entry.meta?.tool), entry.meta?.input as Record<string, unknown>)
    }
  }
  if (decision === 'allow' && mode === 'turn' && entry) {
    // la chiave è registrata appena l'analisi shell è pronta; il prossimo
    // ramo ask attende la promise prima di controllare (niente race)
    run.pendingTurnGrant = turnGrantKey(String(entry.meta?.tool), entry.meta?.input as Record<string, unknown>)
      .then((key) => {
        if (key) run.turnAllows.add(key)
      })
      .catch(() => undefined)
  }
  cb(decision)
}
