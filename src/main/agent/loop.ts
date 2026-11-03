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
import { randomUUID, createHash } from 'node:crypto'
import { getAgent, listAgents, listRoutines, getEntries, updateAgent, appendEntry, updateEntryContent, updateEntryMeta, getSetting, holdOutboxEntry, db, getTask, createTask, updateTask, openTasksOf, MAX_OPEN_TASKS, createAgent, subagentRefusal, addGrant, listGrants, recordModelUsage, type Grant, type AppendEntry } from '../store/db'
import { llmStream, type ChatMessage, type ToolCall } from './llm'
import { systemPrompt, secondaryPrompts, mainAgentSection, withLanguage } from './prompts'
import { toolDefs, executeTool } from './tools'
import * as permissions from './permissions'
// fase 16c (C1/C3.3): i provider si leggono dal modulo providers (vista del
// daemon, chiavi in memoria) — MAI dallo store grezzo, che non ha la chiave
import { getProvider, listProviders } from './providers'
// fase 16c (C3.3): il modello risolto («Come gli altri»)
import { resolveAgentModel, type ResolvedAgentModel } from './model-defaults'
import { buildMessages, visibleReplyEntries } from './history'
import { planResume, INTERRUPTED_TOOL_RESULT } from './resume'
import { isExternalSend, draftFromExternalCall, prepareDraft, DEFAULT_EXTERNAL_SEND_TOOLS, type ExternalSendConfig, type SendCandidate } from './external-send'
import { normalizeOptions, findDismissibleWidgets } from './widgets'
import { buildMemorySection, estimateTokensOf } from './memory'
import { buildSkillsSection } from './skills'
import { maybeCompactHistory, summarizeWithLlm } from './compaction'
import { automationEventText } from './update-state'
import { formatAgentMessage, agentSendGuard, countPairMessagesLastHour, AGENT_HOP_MAX, formatWebSearchEvidence, formatWebFetchEvidence, formatWebBrowserEvidence, formatExternalDataEvidence } from '../../shared/agent-message'
import { mainAgentOf } from '../../daemon/presence'
import { analyzeCommand } from './shell-ast'
import { commandKey, isNeverAuto } from './permission-rules'
import { autoReviewDecision, reviewWithConfiguredModel, liftContaminatedAllow, AUTO_REVIEW_MAX_PER_TURN, type AutoReviewAction } from './auto-review'
import { activityOf, isToolLoop, stopReasonOfError } from './loop-guard'
import { nextWithDeadline, DEFAULT_STREAM_DEADLINES, StreamDeadlineError } from './stream-deadline'
// fase 9 (punto 0): regole dei send_to_user dentro il turno (dedup, tetto
// avanzamenti, result col testo consegnato)
import { deliveredResultText, alreadyDeliveredResult, isDuplicateSend, isWorkTool, messageCapResult, emptySendResult, turnCapResult, MAX_DELIVERED_PER_TURN } from './turn-sends'
// fase 9 (punto 1) → fase 18b (H2): la riserva è una CATENA di anelli
// provider+modello (modello dei router LLM maturi); il raffreddamento (H2.3)
// tiene in pausa chi ha appena fallito, in memoria nel processo del daemon
import { type ModelDefaultsMap } from './model-defaults'
import { routeChain, nextRoute, fallbackEligible, routeIncompatibility, type Route } from './model-fallback'
import { coolDown, isCooled, cooledUntil, markHealthy } from './route-health'
// fase 18b (H4): la visione conosciuta del modello del turno (use-app, immagini)
// fase 18b (K3): la lettura delle capability Ollama prima di calcolare la visione
// fase 18b (K7): i dati noti di un anello per la regola pura routeIncompatibility
import { modelCapabilities, routeModelCaps } from './llm-pi'
import { readOllamaCapabilities } from './live-models'
import type { ThinkingSetting } from '../../shared/types'
// fase 10: gruppi (store) e regole del turno di gruppo (puro); correzioni C1-C3;
// correzione E2 (terzo giro): il recupero dei turni di gruppo finiti con la
// consegna scritta come testo libero
import { getGroup, getGroupMessage, isGroupMember, addGroupMessage, scheduleTurnsForMessage } from '../store/groups'
import {
  nextPostDepth, hasSentToUserInChain, alreadySentToUserResult,
  needsGroupRecovery, groupRecoveryTools, GROUP_RECOVERY_NUDGE, GROUP_CLOSING_RECOVERY_NUDGE,
  GROUP_CALLED_RECOVERY_NUDGE, GROUP_CALLED_CLOSING_RECOVERY_NUDGE
} from './group-turns'
import { MAX_CREATE_AGENTS_PER_TURN, wakeParentToolDef } from './tools'
// fase 13 (punto 3): add_mcp_server/install_plugin SOLO nei turni dell'utente;
// (punto 5): tool MCP deferiti oltre connectors.maxInlineTools
import { toolsForTurnSource, connectorProposalOffered, CONNECTOR_PROPOSAL_DENIED } from './connectors-policy'
import { PROPOSAL_RESULT } from '../connectors/install'
import {
  findToolsToolDef, rankTools, requiredParamsOf, formatFindToolsResult, toolsDeferred,
  activeToolsFromTranscript, connectorsActiveSection, DEFAULT_MAX_INLINE_TOOLS
} from '../mcp/find-tools'
import type { Approval, ProviderConfig, SandbotEvent, SendMessagePayload, TurnEnd } from '../../shared/types'
// fase 12: sottoagenti — policy pura del figlio, store del registro, formatters
import {
  subagentToolDenyReason, subagentBriefError, subagentClosure, autoCloseSummary,
  SUBAGENT_RECOVERY_NUDGE, MAX_SPAWNS_PER_TURN, MAX_OPEN_SUBAGENTS, WAKE_SUMMARY_MAX_CHARS
} from './subagents'
import {
  insertSubagent, getSubagent, updateSubagent, closeSubagent, openSubagentsOf,
  newSubagentId, newSubagentBatchId, DEFAULT_SUBAGENT_DEADLINE_MIN
} from '../store/subagents'
import { onSubagentTerminal, sealTurnBatch, subagentsChanged } from '../../daemon/subagent-ops'
import { subagentSystemPrompt } from './prompts'
import { formatSubagentBrief } from '../../shared/agent-message'
// fase 17b (A3): la lingua dell'utente, globale e persistente — la sezione
// Language va in FONDO al system prompt di OGNI variante
import { currentUserLanguage } from './user-language'
// fase 17c (C2): i testi U del loop — id stabili nel catalogo UI; le entry
// salvate portano meta.ui (id+valori) e il content nella lingua dell'interfaccia.
// Il formattatore viene dalle foglie shared e la lingua si legge dallo store
// qui (getSetting è già importato): così il loop NON dipende da ui-language
// e il grafo dei mock dei test resta quello di prima.
import { formatUi, ui } from '../../shared/ui-text'
import { UI, type UiMessage } from '../../shared/ui-messages'
import type { UiText } from '../../shared/types'
import type { UiLanguage } from '../../shared/ui-language'

/** La lingua attiva dell'interfaccia per i testi del loop (ui.activeLanguage, ripiego 'en'). */
function loopUiLanguage(): UiLanguage {
  const v = getSetting<unknown>('ui.activeLanguage', null)
  return v === 'it' || v === 'en' ? v : 'en'
}

/**
 * Fase 17c (C2): entry di sistema col testo del catalogo UI — content scritto
 * con formatUi(…, uiLanguage()) (anteprima della sidebar, ricerca, client
 * vecchi) e meta.ui per chi la mostra ritradotta nella lingua corrente.
 */
function uiSystemEntry(agentId: string, kind: 'notice' | 'event', text: UiText, extra: Record<string, unknown> = {}): AppendEntry {
  return { agentId, kind, role: 'system', content: formatUi(text, loopUiLanguage()), meta: { ui: text, ...extra } }
}

/**
 * Fase 17c (C2): i valori del motivo dell'ask del browser per l'id
 * card.browserAsk (select su reasonKind): il codice del motivo e le parti
 * variabili (ref, campo, nome, ruolo dell'elemento).
 */
function riskAskValues(ask: import('./browser-guard').BrowserAskInfo): Record<string, string> {
  const vals: Record<string, string> = { reasonKind: ask.kind }
  if (ask.ref !== undefined) vals.ref = ask.ref
  if (ask.field !== undefined) vals.field = ask.field
  if (ask.name !== undefined) vals.name = ask.name
  if (ask.role !== undefined) vals.role = ask.role
  return vals
}

/**
 * Fase 17c (C2): l'UiText del verdetto ask (singolo o lista di motivi, per
 * run-command) da salvare in meta.ui; null se il verdetto non ne ha.
 */
function verdictUiOf(verdict: import('./permissions').Verdict): UiText | UiText[] | null {
  if (verdict.kind !== 'ask') return null
  if (verdict.uis?.length) return verdict.uis.length === 1 ? verdict.uis[0]! : verdict.uis
  return verdict.ui ?? null
}

/** Il testo del motivo per il content/preview: la lingua dell'interfaccia quando c'è l'UiText, il reason (modello) altrimenti. */
function verdictReasonText(verdict: import('./permissions').Verdict): string {
  if (verdict.kind !== 'ask') return ''
  if (verdict.uis?.length) return verdict.uis.map((u) => formatUi(u, loopUiLanguage())).join('; ')
  return verdict.ui ? formatUi(verdict.ui, loopUiLanguage()) : verdict.reason
}

// §5.3: buildMessages vive in history.ts (modulo puro, testabile senza Electron)
export { buildMessages } from './history'

/** I passi di un turno (correzione J4: l'eval lo IMPORTA, così il figlio eval ha lo stesso budget del loop vero). */
export const MAX_STEPS = 24

/** Fase 3: il sollecito della chiamata di recupero quando un turno utente finisce senza send_to_user. */
export const RECOVERY_NUDGE =
  "You called neither send_to_user nor ask_user: the user has seen no answer. Answer NOW by calling send_to_user (that only, no other tool)."

/**
 * Fase 17b correzioni (B4): i result fissi di ask_user e wake_parent, esportati
 * perché l'eval li RIUSA — la storia dell'eval deve contenere i testi che il
 * codice produce, non copie a mano.
 */
export const ASK_USER_RESULT =
  'widget shown to the user: the turn ends and the answer will arrive as a new user message. Do not repeat the question.'
export const WAKE_PARENT_RESULT = 'Delivered to the parent. You are done: do nothing else.'
/**
 * Fase 19a (V5): il result fisso di request_takeover — il turno FINISCE
 * (come ask_user); quando l'utente preme «Ho finito» arriva un nuovo messaggio
 * col testo costante TAKEOVER_DONE_TEXT (exportato per l'eval, come questi).
 */
export const REQUEST_TAKEOVER_RESULT =
  'the user has been asked to take over your screen: your turn ends here. When they are done you receive a message and can continue. Never ask the user to paste passwords or codes in chat.'

type Emitter = (e: SandbotEvent) => void

interface Running {
  controller: AbortController
  // 'cancelled' = interrupt dell'utente (fase 4 0c): chiude l'approval in attesa
  approvals: Map<string, (decision: 'allow' | 'deny' | 'superseded' | 'cancelled') => void>
  /** true quando un nuovo messaggio utente ha sostituito il turno (solo supersedeIfPaused lo imposta). */
  superseded?: boolean
  /** fase 8 (punto 2): chiavi concesse "per questo turno" (in memoria, mai nel DB). */
  turnAllows: Set<string>
  /**
   * F8: epoca dei grant di turno. La lettura web che contamina il turno
   * revoca i grant concessi PRIMA (clear + incremento): anche un grant ancora
   * in fase di registrazione (analisi shell async) vede l'epoca cambiata e
   * non si registra. I grant concessi DOPO la contaminazione non sono toccati.
   */
  turnGrantEpoch: number
  /** fase 8 (punto 2): grant di turno in arrivo (l'analisi shell è async: il prossimo ask la aspetta). */
  pendingTurnGrant?: Promise<void>
  /** fase 8 (§3bis L7): il turno gira nel sotto-transcript di questo task. */
  taskId?: number
}
const running = new Map<string, Running>()

/**
 * M5 (fase 0.3.1001): i messaggi «in consegna» al turno in corso. Un messaggio
 * DIRETTO dell'utente (niente initiator, niente respondedTo) che arriva mentre
 * un turno è attivo — e non è fermo su un'approvazione — si consegna al confine
 * di passo: entra nella storia come entry utente visibile e la chiamata al
 * modello successiva lo vede. Nessuno stream viene troncato e nessuno
 * strumento interrotto a metà. Il job della coda corrispondente (se c'è) si
 * consuma QUI: se il turno finisce prima di arrivare al confine, il job resta
 * e il messaggio parte in un turno nuovo (gara) — nessun messaggio perso né
 * letto due volte.
 */
interface MidTurnDelivery {
  /** il job della coda da consumare quando il turno prende la consegna (null = nessuno) */
  jobId: number | null
  text: string
  images?: string[]
}
const midTurnDeliveries = new Map<string, MidTurnDelivery[]>()

/**
 * M5: registra un messaggio per la consegna al turno in corso. Torna false se
 * non c'è un turno che può prenderlo (libero, fermo su un'approval, in
 * corse di chiusura): il chiamante lo lascia in coda come oggi.
 */
export function deliverToRunningTurn(agentId: string, delivery: MidTurnDelivery): boolean {
  const run = running.get(agentId)
  if (!run || run.controller.signal.aborted) return false
  // fermo su un'approval → NON si consegna: vale la supersede di sempre
  // (il messaggio sostituisce il turno, enqueue.ts lo gestisce)
  if (run.approvals.size > 0) return false
  const list = midTurnDeliveries.get(agentId) ?? []
  list.push(delivery)
  midTurnDeliveries.set(agentId, list)
  return true
}

/**
 * Fase 18b (H2.3): le notice di raffreddamento già emesse, per bot e periodo
 * di raffreddamento (chiave bot|provider|modello → fine della pausa): una
 * sola notice per pausa, non una a ogni turno. In memoria, come la pausa.
 */
const cooledNotices = new Map<string, number>()

/**
 * Fase 16c correzioni (R3.6): per quale provider era già stata mostrata la
 * notice ownModelUnavailable di un bot (agentId → providerId mancante). Serve
 * a mostrarla UNA volta per situazione, non a ogni turno.
 */
const lastOwnModelMissing = new Map<string, string>()

/** HH:MM locale della fine del raffreddamento (valore della notice modelRouteCooled). */
function hhmmOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

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

/** Etichette umane degli esiti di turno (la UI mostra gli event solo col toggle ragionamento). Fase 17c: id del catalogo UI. */
const TURN_END_LABELS: Record<TurnEnd, UiMessage> = {
  FINISHED: UI.turnEndFinished,
  STOPPED: UI.turnEndStopped,
  SUPERSEDED: UI.turnEndSuperseded,
  AWAITING_USER: UI.turnEndAwaitingUser
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
    ...uiSystemEntry(agentId, 'event', ui(TURN_END_LABELS[outcome])),
    meta: {
      ui: ui(TURN_END_LABELS[outcome]),
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
  // fase 17c (C2): i titoli fissi delle card diventano id del catalogo UI —
  // meta.ui sulla entry, content nella lingua dell'interfaccia
  const cardUi: UiText | null =
    message.type === 'mcp-server' ? ui(UI.cardMcpServer, { name: message.name })
    : message.type === 'plugin' ? ui(UI.cardPlugin, { name: message.name })
    : message.type === 'fill' ? ui(UI.cardFill, { label: message.label, origin: message.origin })
    : message.type === 'secure-input' ? ui(UI.cardSecureInput, { reason: message.reason })
    : message.type === 'contact' ? ui(UI.cardContact, { name: message.name })
    // fase 19a (V5): la card della presa di controllo chiesta dal bot
    : message.type === 'takeover-request' ? ui(UI.cardTakeover, { reason: message.reason.slice(0, 120) })
    : null
  const content = message.type === 'text' ? message.text
    : message.type === 'widget' ? message.prompt
    : message.type === 'connector' ? (message.reason || message.name)
    : message.type === 'task' ? message.title
    : message.type === 'subagent' ? message.title
    : message.type === 'rule' ? message.text
    : message.type === 'document' ? message.title
    : message.type === 'chart' ? message.title
    : message.type === 'takeover-request' ? message.reason
    : cardUi ? formatUi(cardUi, loopUiLanguage())
    : 'subject' in message ? (message.subject || message.to || '') : ''
  const entry = appendEntry({
    agentId, kind: 'send-message', role: 'assistant', content,
    meta: {
      call: { id: call.id, name: call.name, arguments: call.arguments }, message,
      ...(cardUi ? { ui: cardUi } : {}),
      ...extra, ...(taskId !== undefined ? { taskId } : {})
    }
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
   * Fase 12 (punti 3-4): il turno è del FIGLIO (un sottoagente). Contesto suo
   * (brief + proprie entry), tool della whitelist, chiusura con wake_parent e
   * la chiusura robusta se non consegna. spawn_subagent qui non esiste.
   */
  subagent?: { id: string; parentId: string }
  /**
   * Fase 12 (punto 5): il turno parte GIÀ contaminato (il risveglio di un
   * lotto con almeno un figlio contaminato): lift F8 sui tool con effetti e
   * revoca dei grant di turno, come dopo una lettura web.
   */
  contaminated?: boolean
  /**
   * Fase 18b (H7): la rotta di un modello PROPRIo della routine (provider +
   * modello, ragionamento facoltativo). Con `route` il primario della catena
   * H2 è QUESTO; se il provider non esiste più o è disabilitato si usa il
   * modello del bot con la notice routineModelUnavailable. Vale SOLO per il
   * turno della routine: le continuazioni di task usano il modello del bot.
   */
  route?: { providerId: string; model: string; thinking?: ThinkingSetting }
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
  // fase 14 (7d): il grant "per questo turno" del fill vale per QUEL login su
  // QUELL'origine (l'origine la mette il loop nell'input dell'approval)
  if (tool === 'fill_credential') {
    return `fill_credential|${String(input.id ?? '')}|${String(input.origin ?? '')}`
  }
  if (tool === 'run-command') {
    const analysis = await analyzeCommand(String(input.command ?? ''))
    if (!analysis.commands.length || analysis.commands.some((c) => isNeverAuto(c))) return null
    return [...new Set(analysis.commands.map(commandKey))].sort().join(';')
  }
  return `${tool}|${permissions.targetKey(tool, input)}`
}

/** Il contesto del turno del padre che i tool dei sottoagenti devono sapere (fase 12). */
interface SubagentToolDeps {
  emit: Emitter
  /** il turno è di gruppo: spawn rifiutato (lì si coordina col gruppo) */
  inGroupTurn: boolean
  /** il turno è di un FIGLIO: niente annidamento (rete di sicurezza) */
  inSubagent: boolean
  /** se il turno gira in un task, i risultati del figlio tornano al task */
  parentTaskId?: number
  untrustedTurn: boolean
  automatic: boolean
  /** le spawn già passate di qui in questo turno (compresa l'eventuale corrente) */
  spawnsInTurn: number
  /** il lotto del turno corrente (creato alla prima spawn) */
  batchIdOf(): string
}

interface SubagentToolResult {
  output: string
  /** card da aggiungere nella chat del padre (spawn riuscita) */
  card?: SendMessagePayload
  /** lo stato dei figli è cambiato: evento alla UI */
  changed?: boolean
}

/**
 * Fase 12 (punto 2): i tool del PADRE — spawn_subagent, check_subagent,
 * message_subagent, stop_subagent. Il figlio è una riga agents nascosta con
 * parent_id + una riga subagents; il job subagent-run è sulla SUA corsia (il
 * parallelismo arriva gratis: tre figli sono tre agenti).
 */
async function runSubagentTool(
  agentId: string,
  call: { name: string },
  input: Record<string, unknown>,
  deps: SubagentToolDeps
): Promise<SubagentToolResult> {
  const database = db()
  if (deps.inSubagent) {
    return { output: 'not available to subagents: no subagents inside subagents' }
  }
  const deadlineMin = getSetting<number>('subagents.deadlineMin', DEFAULT_SUBAGENT_DEADLINE_MIN)

  if (call.name === 'spawn_subagent') {
    if (deps.inGroupTurn) {
      return { output: 'In group turns subagents are not launched: there you coordinate with the group (post_to_group).' }
    }
    const title = String(input.title ?? '').trim()
    const brief = String(input.brief ?? '').trim()
    if (!title || !brief) return { output: 'Subagent not launched: title and brief are required.' }
    const briefError = subagentBriefError(brief)
    if (briefError) return { output: `Subagent not launched: ${briefError}.` }
    if (deps.spawnsInTurn > MAX_SPAWNS_PER_TURN) {
      return { output: `Turn limit reached: at most ${MAX_SPAWNS_PER_TURN} spawn_subagent per turn.` }
    }
    if (openSubagentsOf(database, agentId) >= MAX_OPEN_SUBAGENTS) {
      return { output: `There are already ${MAX_OPEN_SUBAGENTS} open subagents (queued or working): stop some with stop_subagent or wait for the batch results.` }
    }
    const parent = getAgent(agentId)
    const batchId = deps.batchIdOf()
    const now = Date.now()
    const childId = newSubagentId()
    // il figlio: riga agents NASCOSTA (parent_id), nome "<padre> · <title>",
    // modello e provider COPIATI dal padre
    // fase 16c correzioni (R3.3): NON passa da resolveAgentModel e va bene così
    // — è una COPIA dei CAMPI del padre (providerId e model, anche null/null),
    // non una risoluzione: un padre «Come gli altri» genera un figlio
    // null/null che a sua volta segue il principale quando il suo turno gira
    // (runTurn → resolveAgentModel, l'unico punto che decide)
    createAgent(`${parent?.name ?? agentId} · ${title}`, title, { parentId: agentId, id: childId })
    updateAgent(childId, { providerId: parent?.providerId ?? null, model: parent?.model ?? null })
    insertSubagent(database, {
      id: childId, parentId: agentId, parentTaskId: deps.parentTaskId ?? null, batchId, title, brief,
      deadlineAt: now + deadlineMin * 60_000, createdAt: now,
      untrusted: deps.untrustedTurn, automatic: deps.automatic
    })
    const { enqueueJob } = await import('../store/jobs')
    enqueueJob(database, {
      agentId: childId, kind: 'subagent-run',
      payload: { subagentId: childId, first: true },
      runAt: now, now
    })
    return {
      output: `Subagent "${title}" launched (id ${childId}): it works in parallel; the batch results all arrive together when the last one finishes. Do not wait for it in a loop.`,
      card: { type: 'subagent', subagentId: childId, title },
      changed: true
    }
  }

  const id = String(input.id ?? '')
  const row = getSubagent(database, id)
  // solo figli PROPRI: il registro lo dice, non serve listAgents
  if (!row || row.parent_id !== agentId) {
    return { output: `Subagent not found ("${id}"): the ids are the sub_… returned by spawn_subagent, and only YOUR own children.` }
  }

  if (call.name === 'check_subagent') {
    const entries = getEntries(row.id)
    const steps = entries.filter((e) => e.kind === 'tool-call').length
    const lastCall = [...entries].reverse().find((e) => e.kind === 'tool-call' && e.meta?.name)
    let activity = 'no activity yet'
    if (lastCall) {
      try {
        const args = JSON.parse(String(lastCall.meta?.arguments ?? '{}')) as Record<string, unknown>
        activity = `${String(lastCall.meta?.name)} ${activityOf(String(lastCall.meta?.name), args).target}`.trim()
      } catch {
        activity = String(lastCall.meta?.name ?? '')
      }
    }
    const now = Date.now()
    const elapsed = Math.max(0, Math.round((now - row.created_at) / 60_000))
    const left = Math.max(0, Math.round((row.deadline_at - now) / 60_000))
    const childStatus = getAgent(row.id)?.status
    const waiting = childStatus === 'paused-for-approval' ? ' — waiting for the user\'s confirmation on one of the child\'s cards' : ''
    const lines = [
      `Subagent "${row.title}" (id ${row.id}): status ${row.status}${waiting}.`,
      `Time: ${elapsed} min elapsed, deadline in ${left} min. Steps: ${steps}. Last activity: ${activity}.`
    ]
    if (row.status === 'done' || row.status === 'failed' || row.status === 'stopped' || row.status === 'expired') {
      lines.push(`Summary: ${row.summary ?? '(none)'}`)
      if (row.report_path) lines.push(`Report: ${row.report_path}`)
    }
    return { output: lines.join('\n') }
  }

  if (call.name === 'message_subagent') {
    const text = String(input.text ?? '').trim()
    if (!text) return { output: 'Missing text: write the message in the text field.' }
    if (row.status === 'stopped' || row.status === 'expired') {
      return { output: `"${row.title}" is ${row.status === 'stopped' ? 'stopped' : 'expired'}: it does not reopen with a message (a new spawn_subagent is needed).` }
    }
    const now = Date.now()
    // done/failed → RIAPRE sul LOTTO DEL TURNO CORRENTE (lo stesso delle
    // spawn, correzione J2): due figli riaperti nello stesso turno del padre
    // formano UN lotto e danno UN solo risveglio; il sigillo lo mette la fine
    // del turno. Nuova scadenza e woken azzero come prima
    const reopened = row.status === 'done' || row.status === 'failed'
    if (reopened) {
      updateSubagent(database, row.id, {
        status: 'queued', batch_id: deps.batchIdOf(), woken: false, sealed: false,
        deadline_at: now + deadlineMin * 60_000
      })
    }
    const { enqueueJob } = await import('../store/jobs')
    enqueueJob(database, {
      agentId: row.id, kind: 'subagent-run',
      payload: { subagentId: row.id, message: text },
      runAt: now, now
    })
    return {
      output: reopened
        ? `Subagent "${row.title}" (id ${row.id}) REOPENED on this message: it works and the result arrives when this turn's batch has closed.`
        : `Message queued for "${row.title}" (id ${row.id}): it will receive it in its turn.`,
      changed: true
    }
  }

  // stop_subagent: interrompe il turno, cancella i job in coda, chiude
  if (call.name === 'stop_subagent') {
    interrupt(row.id)
    const { cancelAgentJobs } = await import('../store/jobs')
    cancelAgentJobs(database, row.id)
    const closed = closeSubagent(database, row.id, { status: 'stopped', finishedAt: Date.now() })
    if (closed) onSubagentTerminal(database, row.id, deps.emit)
    return {
      output: `Subagent "${row.title}" stopped: turn interrupted and queued jobs cancelled. The batch result still arrives when the other children finish.`,
      changed: true
    }
  }

  return { output: `Unknown tool: ${call.name}` }
}

export async function runTurn(agentId: string, userText: string, emit: Emitter, images?: string[], opts: RunTurnOptions = {}): Promise<void> {
  const source = opts.source ?? 'user'

  // §5.7: un turno per agente — mai due run concurrently sulla stessa mappa.
  // In produzione il worker della coda jobs garantisce la serializzazione per
  // agente; qui la guardia resta come rete di sicurezza: il turno in eccesso
  // viene scartato con notice, non accodato né sovrascritto.
  if (running.has(agentId)) {
    const notice = source === 'routine'
      ? ui(UI.routineSkipped, { title: opts.title ?? userText.slice(0, 40) })
      : ui(UI.agentBusyDiscard)
    appendEntry(uiSystemEntry(agentId, 'notice', notice))
    emitLastEntry(agentId, emit)
    return
  }

  const agent = getAgent(agentId)
  // fase 18a (E0): errore interno in inglese (la UI ha rpc.agentNotFound)
  if (!agent) throw new Error('agent not found')
  // fase 16c (C3.3): il modello risolto — quello del bot se l'ha scelto, il
  // principale se segue gli altri («Come gli altri»), niente altrimenti.
  // Fase 16c correzioni (R3.6): resolveAgentModel riceve anche i provider
  // ATTIVI — il modello proprio di un bot vale solo se il suo provider è
  // ancora collegato; se no si segue il principale (ownModelMissing)
  const resolved: ResolvedAgentModel | null = resolveAgentModel(
    agent,
    getSetting<import('../../shared/types').MainModel | null>('models.main', null),
    listProviders().map((p) => ({ id: p.id, enabled: p.enabled }))
  )
  if (!resolved) {
    // fase 10 (residuo 0e): durante l'onboarding, se il provider ESISTE ma il
    // widget del ruolo è ancora in attesa, il problema non è la configurazione:
    // chiedere di configurare porta fuori strada
    const onboardingWaiting =
      listProviders().some((p) => p.enabled) &&
      getEntries(agentId).some((e) => e.kind === 'send-message' && e.meta?.onboardingRole && e.meta?.respondedValue === undefined)
    appendEntry(uiSystemEntry(
      agentId, 'notice',
      onboardingWaiting ? ui(UI.onboardingWaitingProvider) : ui(UI.configureProviderFirst)
    ))
    emitLastEntry(agentId, emit)
    return
  }
  if (resolved.ownModelMissing) {
    // fase 16c correzioni (R3.6): il provider del modello PROPRIO non c'è più
    // (o è disattivato): il turno parte col principale. La notice si mostra
    // UNA volta per situazione — finché quel provider resta giù non si ripete
    // a ogni turno; se il provider torna (e poi ricasca), si rivede
    if (lastOwnModelMissing.get(agentId) !== agent.providerId) {
      lastOwnModelMissing.set(agentId, agent.providerId ?? '')
      appendEntry(uiSystemEntry(
        agentId, 'notice',
        ui(UI.ownModelUnavailable, { provider: agent.providerId ?? '', model: resolved.model })
      ))
      emitLastEntry(agentId, emit)
    }
  } else {
    // il modello proprio è tornato attivo (o il bot segue e basta): il
    // ricordo della notice si azzera, così un'eventuale ricaduta si rivede
    lastOwnModelMissing.delete(agentId)
  }
  const provider = getProvider(resolved.providerId)
  // fase 18a (E0): errore interno in inglese (la UI ha rpc.providerNotFound)
  if (!provider) throw new Error('provider not found')

  const controller = new AbortController()
  const run: Running = { controller, approvals: new Map(), turnAllows: new Set(), turnGrantEpoch: 0 }
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
  // fase 11 (punto 2): dal PRIMO web_search o web_fetch con contenuto il turno
  // è CONTAMINATO: dato non fidato nel contesto — le azioni con effetti
  // (run-command, draft_external, send_to_agent, create_agent, create_group)
  // tornano a chiedere all'utente, l'auto-review non le approva da sola.
  // Fase 12 (punto 5): può PARTIRE contaminato (risveglio SUBAGENTS_DONE con
  // un figlio contaminato nel lotto) — stessi lift, stessi divieti
  let contaminated = opts.contaminated === true

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
  // fase 12 (punti 2-3): il lotto del turno del padre (una sola spawn batch per
  // turno) e la chiusura del figlio (ha consegnato? il sollecito è già stato?)
  let turnBatchId: string | null = null
  let wakeDone = false
  let subagentNudged = false

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
  /**
   * Fase 12 (punto 3): chiusura di FALLIMENTO del figlio per errore del modello
   * (niente sollecito su un modello che non risponde). Se il turno è stato
   * interrotto (stop/scadenza) la riga è già terminale e closeSubagent non
   * tocca nulla; il controllo del lotto resta idempotente (wakeBatch atomico).
   */
  const failSubagent = (reason: string): void => {
    if (!opts.subagent || controller.signal.aborted) return
    const closed = closeSubagent(db(), opts.subagent.id, {
      status: 'failed', summary: reason, finishedAt: Date.now()
    })
    if (closed) onSubagentTerminal(db(), opts.subagent.id, emit)
  }

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
   * Fase 14: una card che ASPETTA la decisione dell'utente (fill, modulo
   * sicuro, contatto, export): crea l'Approval, l'entry che la UI renderizza
   * con la sua forma (kind 'approval' o send-message), attende la decisione
   * e aggiorna lo stato dell'entry. Ritorna la decisione ('allow' vale per
   * Consenti/Salva/Esporta).
   */
  const awaitCard = async (
    approval: Approval,
    entryKind: 'approval' | 'send-message',
    content: string,
    entryMeta: Record<string, unknown>
  ): Promise<'allow' | 'deny' | 'timeout' | 'superseded' | 'cancelled'> => {
    run.approvals.set(approval.id, () => undefined)
    const entry = add({
      agentId, kind: entryKind, ...(entryKind === 'send-message' ? { role: 'assistant' as const } : { role: 'system' as const }),
      content, meta: { approvalId: approval.id, status: 'pending', ...entryMeta }
    })
    emit({ type: 'entries', agentId, entries: [entry] })
    emit({ type: 'approval', agentId, approval })
    emitNeedsInput(agentId, entry, content.slice(0, 80), emit)
    taskNeedsInput()
    setStatus(agentId, 'paused-for-approval', emit)
    const decision = await new Promise<'allow' | 'deny' | 'timeout' | 'superseded' | 'cancelled'>((resolve) => {
      run.approvals.set(approval.id, (d) => resolve(d))
      setTimeout(() => resolve('timeout'), getSetting<number>('permissions.timeoutMs', 5 * 60_000))
    })
    run.approvals.delete(approval.id)
    // il meta si RILEGGE: l'RPC può aver già scritto esiti (secureinput:submit
    // salva savedOutcome prima di risolvere) e non vanno persi
    const freshMeta = getEntries(agentId).find((x) => x.id === entry.id)?.meta ?? entry.meta
    updateEntryMeta(entry.id, {
      ...freshMeta,
      status: decision === 'timeout' ? 'expired' : decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : decision === 'cancelled' ? 'cancelled' : 'superseded'
    })
    const updated = getEntries(agentId).find((x) => x.id === entry.id)
    if (updated) emit({ type: 'entries', agentId, entries: [updated] })
    taskWorking()
    setStatus(agentId, 'thinking', emit)
    return decision
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
    // fase 16b (S1.2): nel turno di CHIUSURA del coordinatore il riepilogo
    // finisce NEL GRUPPO, dove l'utente ha chiesto (non nella chat privata):
    // autore il coordinatore, flag summary, automatic. NESSUN nuovo giro —
    // planGroupTurns ignora i riepiloghi. Dedup e tetti sono già passati; il
    // result del tool resta IDENTICO (il modello non vede differenze)
    if (opts.groupTurn?.closing) {
      const g = getGroup(opts.groupTurn.groupId)
      if (g) {
        const depth = nextPostDepth(opts.groupTurn.readMaxDepth)
        const msg = addGroupMessage({
          groupId: g.id, authorKind: 'agent', authorId: agentId, authorName: agent.name,
          text, rootId: opts.groupTurn.rootId ?? null, depth, automatic: true, summary: true
        })
        // fase 16b correzioni (P1): la riga discreta della chat privata salva
        // anche ciò che serve alla STORIA del modello — meta.call e meta.message
        // come una send-message, e in meta.resultText il result ESATTO che il
        // modello ha visto nel turno (così resta identico anche se la funzione
        // cambierà). Resta una event: niente bolla in chat privata, niente
        // effetto su outbox, contatori o notifiche.
        const resultText = deliveredResultText(text, { held: false })
        const row = add({
          ...uiSystemEntry(agentId, 'event', ui(UI.groupSummaryPosted, { name: g.name }), {
            groupId: g.id, summaryMessageId: msg.id,
            call: { id: call.id, name: call.name, arguments: call.arguments },
            message: { type: 'text', text },
            resultText
          })
        })
        emit({ type: 'entries', agentId, entries: [row] })
        emit({ type: 'groups' })
        // la notifica porta ALLA SQUADRA, non alla chat privata del coordinatore
        emit({ type: 'agent-notify', agentId, kind: 'done', preview: text.slice(0, 120), at: msg.created_at, openGroupId: g.id })
        deliveredTexts.push(text)
        sendsSinceWork++
        return resultText
      }
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
        appendEntry(uiSystemEntry(agentId, 'notice', ui(UI.taskCancelled, { id: opts.taskId })))
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
      add({ ...uiSystemEntry(agentId, 'notice', ui(UI.resume)) })
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
        agentId, provider.id, resolved.model,
        (digest) => summarizeWithLlm(provider, resolved.model, digest, secondaryPrompts.compaction, agentId),
        emit
      )
    }

    // §5.3: il messaggio corrente è l'ultimo entry del transcript → compare una volta sola.
    // Fase 4: il system prompt include memoria (§3bis L6) e skill disponibili.
    // Fase 5: include le istruzioni personalizzate dei connettori connessi.
    // Fase 7: se questo è il bot principale, la sezione di coordinamento con
    // l'elenco degli altri bot (nome, descrizione, routine attive)
    let mainSection = ''
    let connectorsSection = ''
    let systemText: string
    // fase 17b (A3): la lingua del turno si legge QUI, all'inizio della
    // composizione: se il turno nasce da un messaggio umano, noteHumanText è
    // già stato chiamato all'ingresso (enqueue), quindi vale la lingua nuova
    const userLang = currentUserLanguage()
    if (opts.subagent) {
      // fase 12 (punto 3): il FIGLIO ha un prompt SEPARATO (costruttore proprio,
      // ~450 token): identità da sottoagente, come lavorare, chiusura col
      // wake_parent. Memoria e skill sono quelle del PADRE (sola lettura:
      // update_memory/update_skill non sono nella whitelist del figlio)
      const subRow = getSubagent(db(), opts.subagent.id)
      const parent = getAgent(opts.subagent.parentId)
      // correzione J1: anche il ripiego porta l'id — il path del report nel
      // prompt è sempre quello VERO del figlio
      systemText = subagentSystemPrompt(parent ?? agent, subRow ?? { id: opts.subagent.id, title: '' }) +
        buildMemorySection(opts.subagent.parentId) + buildSkillsSection(opts.subagent.parentId)
    } else {
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
      // fase 12 (punto 6): la sezione Sottoagenti solo nei bot NORMALI, mai
      // nei turni di gruppo (lì si coordina col gruppo)
      // fase 14 (punto 8): le righe delle credenziali solo nei turni NON di gruppo
      systemText = systemPrompt(agent, { subagents: opts.groupTurn === undefined, connectors: opts.groupTurn === undefined, credentials: opts.groupTurn === undefined }) +
        mainSection + buildMemorySection(agentId) + buildSkillsSection(agentId) + connectorsSection
    }

    // tool statici + tool MCP attivi (server esterni → mcp__<server>__<tool>)
    // fase 13 (punto 5): i tool MCP sono PER BOT (enabledFor via
    // serversForAgent; un figlio eredita dal padre); sopra
    // connectors.maxInlineTools si DEFERISCONO: niente schemi MCP nel prompt,
    // la sezione "Connettori attivi" e il tool find_tools al loro posto
    const { toolDefs, computerToolDefs } = await import('./tools')
    let allTools = toolDefs
    let mcpToolDefs: import('./llm').ToolDef[] = []
    try {
      const { activeTools } = await import('../mcp')
      mcpToolDefs = await activeTools(agentId)
    } catch {
      // MCP non disponibile: prosegue coi tool base
    }
    const maxInlineTools = getSetting<number>('connectors.maxInlineTools', DEFAULT_MAX_INLINE_TOOLS)
    const deferredMcp = toolsDeferred(mcpToolDefs.length, maxInlineTools)
    let offeredMcpDefs = mcpToolDefs
    if (!deferredMcp) {
      allTools = [...toolDefs, ...mcpToolDefs]
    } else {
      // nessuno schema MCP nel prompt: restano attivi solo quelli già
      // attivati con find_tools in QUESTA conversazione (dal transcript,
      // ultimi 20), aggiunti in FONDO in ordine stabile (cache del prompt)
      const prevActive = activeToolsFromTranscript(scopedEntries())
      const prevSet = new Set(prevActive)
      offeredMcpDefs = mcpToolDefs.filter((t) => prevSet.has(t.name))
      allTools = [
        ...toolDefs,
        findToolsToolDef,
        ...offeredMcpDefs
      ]
    }
    // M1: i tool MCP offerti in QUESTO turno, con annotazioni e schema —
    // servono a compilare la via di un draft_external senza via quando per
    // il canale c'è esattamente un invio esterno
    const sendCandidates: SendCandidate[] = offeredMcpDefs.map((t) => ({
      name: t.name,
      ...(permissions.mcpAnnotationsOf(t.name) ? { annotations: permissions.mcpAnnotationsOf(t.name)! } : {}),
      parameters: t.parameters
    }))
    // fase 11b (punto 2): i tool del browser compaiono SOLO quando il browser
    // è disponibile (docker + rete bridge): in host il modello non li vede.
    // fase 19a (V7): anche i tre dello SCHERMO (request_takeover,
    // computer_observe, computer_act) esistono solo dove esiste il browser
    try {
      const { browserToolDefs, browserAvailable } = await import('./browser')
      if (browserAvailable()) allTools = [...allTools, ...browserToolDefs, ...computerToolDefs]
    } catch {
      // browser non disponibile: prosegue senza
    }
    // fase 12 (punto 3): nel FIGLIO solo i tool della whitelist (run-command,
    // file, web, browser, memoria/skill in LETTURA, connettori via gate) più
    // wake_parent; i tool del padre non compaiono proprio
    if (opts.subagent) {
      allTools = [...allTools.filter((t) => subagentToolDenyReason(t.name) === null), wakeParentToolDef]
    }
    // fase 13 (punto 3): add_mcp_server e install_plugin SOLO nei turni nati
    // da un messaggio diretto dell'utente in chat (regola 9 dell'onboarding)
    allTools = toolsForTurnSource(allTools, {
      source,
      groupTurn: opts.groupTurn,
      subagent: opts.subagent,
      taskId: opts.taskId,
      automatic,
      agentMessage: opts.agentMessage,
      initiator: opts.initiator
    })
    // i nomi dei tool MCP attivi del turno: in modalità differita un mcp__*
    // fuori da questo insieme NON si esegue ("strumento non attivo")
    const activeMcpNames = new Set(allTools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name))
    // fase 13 (punto 5): in modalità differita il prompt porta la sezione
    // "Connettori attivi" al posto degli schemi MCP (una riga per server)
    if (deferredMcp && !opts.subagent) {
      try {
        const { activeServersForAgent } = await import('../mcp')
        const servers = await activeServersForAgent(agentId)
        systemText +=
          '\n' + connectorsActiveSection(servers.map((x) => ({
            name: x.name,
            toolCount: x.tools.length,
            description: (x.tools[0]?.description ?? '').replace(/^\[MCP:[^\]]*\]\s*/, '')
          })))
      } catch {
        // MCP non disponibile: nessuna sezione
      }
    }
    // fase 17b (A3): la sezione Language è l'ULTIMA cosa del systemText, in
    // tutte e tre le varianti (bot normale, turno di gruppo, figlio) e DOPO
    // memoria, skill, bot principale, connettori e sezione connettori attivi
    systemText = withLanguage(systemText, userLang)
    const messages: ChatMessage[] = buildMessages(systemText, scopedEntries(), images)

    // fase 3 (§3bis L5): quali tool MCP sono invii verso l'esterno.
    // Fase 0.3.1001 (M1): classificazione per annotazioni e NOME (funzione
    // pura external-send.ts), l'elenco resta come sovrascrittura esplicita
    // dell'utente — anche i server aggiunti a mano (es. "ufficio" con
    // send_email) diventano bozze, mai invii diretti del modello
    const externalCfg = getSetting<ExternalSendConfig>('externalSendTools', DEFAULT_EXTERNAL_SEND_TOOLS)
    const extSend = (tool: string): boolean => isExternalSend(tool, permissions.mcpAnnotationsOf(tool), externalCfg)

    // fase 8 (§3bis L11): scadenze dello stream — 150 s per il primo token,
    // 90 s di inattività tra due chunk (configurabili): scaduto si abortisce
    // il SOLO stream e il turno chiude STOPPED (ripresa normale al messaggio
    // successivo)
    const deadlines = {
      firstTokenMs: getSetting<number>('llm.firstTokenMs', DEFAULT_STREAM_DEADLINES.firstTokenMs),
      idleMs: getSetting<number>('llm.streamIdleMs', DEFAULT_STREAM_DEADLINES.idleMs)
    }

    // fase 9 (punto 1) → fase 18b (H2): la CATENA delle riserve —
    // [primario, fallbackModel dello stesso provider, ...models.fallbackChain].
    // Il primario è quello della ROUTINE quando c'è (H7); chi non configura
    // niente ha esattamente il comportamento di oggi (un anello in più al
    // massimo, sullo stesso provider)
    const modelDefaults = getSetting<ModelDefaultsMap>('providers.modelDefaults', {})
    const fallbackChain = getSetting<Route[]>('models.fallbackChain', [])
    const allProviders = listProviders()
    const providerById = (id: string): ProviderConfig | undefined =>
      allProviders.find((x) => x.id === id) ?? (provider.id === id ? provider : undefined)
    // fase 18b (H2.4): la ROTTA attiva del turno — provider + modello, cambia
    // quando si passa d'anello. Tutte le chiamate del turno la usano.
    let activeProvider: ProviderConfig = provider
    let primary: Route = { providerId: provider.id, model: resolved.model }
    // fase 18b (H3): il livello di ragionamento del turno (la routine può
    // avere il suo, H7); l'adattatore clamps sul modello di OGNI chiamata.
    // 'default' o assente NON passa proprio: il comportamento della 18a ESATTO
    // fase 16c (C3.3): il thinking è quello RISOLTO (del bot se l'ha scelto,
    // altrimenti quello del principale)
    let turnThinking: ThinkingSetting | undefined =
      resolved.thinking && resolved.thinking !== 'default' ? resolved.thinking : undefined
    if (opts.route) {
      const rp = providerById(opts.route.providerId)
      if (rp?.enabled && opts.route.model) {
        primary = { providerId: rp.id, model: opts.route.model }
        if (opts.route.thinking && opts.route.thinking !== 'default') turnThinking = opts.route.thinking
        else if (opts.route.thinking === 'default') turnThinking = undefined
        activeProvider = rp
      } else {
        // H7: il provider della routine non c'è più (o è disabilitato): si usa
        // il modello del bot, con una notice — la routine NON si perde
        add({ ...uiSystemEntry(agentId, 'notice', ui(UI.routineModelUnavailable, { provider: opts.route.providerId, model: resolved.model })) })
        emitLastEntry(agentId, emit)
      }
    }
    const chain = routeChain(primary, {
      // il provider del bot entra sempre (è quello di primary: EnabledByConstruction)
      providers: [...allProviders.filter((x) => x.id !== provider.id), provider],
      modelDefaults,
      chain: fallbackChain
    })
    // H2.3: il turno parte dal primo anello NON raffreddato; se lo sono
    // tutti, parte da primary (meglio un tentativo che un turno muto)
    const now0 = Date.now()
    let chainIdx = chain.findIndex((r) => !isCooled(r, now0))
    if (chainIdx < 0) chainIdx = 0
    let activeRoute: Route = chain[chainIdx]!
    if (activeProvider.id !== activeRoute.providerId) activeProvider = providerById(activeRoute.providerId) ?? activeProvider
    let routeSwitches = 0
    // la notice di raffreddamento: una SOLA volta per periodo di pausa e per
    // bot (H2.3), per ogni anello in pausa prima di quello attivo
    if (chainIdx > 0) {
      const now = Date.now()
      for (let i = 0; i < chainIdx; i++) {
        const r = chain[i]!
        const until = cooledUntil(r, now)
        if (until === null) continue
        const key = `${agentId}|${r.providerId}|${r.model}`
        if (cooledNotices.get(key) === until) continue
        cooledNotices.set(key, until)
        const inUse = providerById(activeRoute.providerId)
        add({
          ...uiSystemEntry(agentId, 'notice', ui(UI.modelRouteCooled, {
            model: r.model,
            provider: providerById(r.providerId)?.name ?? r.providerId,
            until: hhmmOf(until),
            fallback: activeRoute.model,
            fallbackProvider: inUse?.name ?? activeRoute.providerId
          }))
        })
        emitLastEntry(agentId, emit)
      }
    }
    // fase 18b (H1.3): i prezzi personalizzati passano allo stream dal
    // CHIAMANTE (l'adattatore non legge lo store: nessun ciclo di import)
    const modelPrices = getSetting<import('../../shared/types').ModelPriceMap>('providers.modelPrices', {})

    // fase 18b (K3): dopo un riavvio la cache delle capability Ollama è vuota
    // finché qualcuno non apre le Impostazioni; senza questa lettura un
    // modello senza visione avrebbe vision null e H4 non scattarebbe mai. UNA
    // sola /api/show per modello per vita del daemon (stesso helper e stessa
    // cache dell'elenco e del check dei tool), 1500 ms al massimo, errori
    // ignorati: la visione resta sconosciuta, come prima
    if (activeProvider.kind === 'ollama') await readOllamaCapabilities(activeProvider, activeRoute.model)

    // fase 18b (H4): visione conosciuta FALSA del modello del turno → use-app
    // (l'unico tool che restituisce images) non viene offerto. Con vision
    // sconosciuta (null) tutto resta come prima. Se la riserva cambia modello
    // a metà turno la lista non si tocca: un'eventuale chiamata riceve
    // l'errore inglese al momento dell'esecuzione (giù, nel gate dei tool).
    // fase 19a (V7): computer_observe e computer_act restituiscono IMMAGINI
    // dello schermo del bot → stessa regola di use-app; request_takeover è
    // testuale e resta per TUTTI i modelli
    if (modelCapabilities(activeProvider, activeRoute.model).vision === false) {
      allTools = allTools.filter((t) => t.name !== 'use-app' && t.name !== 'computer_observe' && t.name !== 'computer_act')
    }
    // fase 18b (H4): il turno parte con IMMAGINI e il modello del turno ha
    // visione conosciuta FALSA → notice per l'utente. Il segnaposto di pi-ai
    // al modello resta: non si toglie (con vision sconosciuta, niente notice)
    if (images?.length && modelCapabilities(activeProvider, activeRoute.model).vision === false) {
      add({ ...uiSystemEntry(agentId, 'notice', ui(UI.imagesNotSeen, { model: activeRoute.model })) })
      emitLastEntry(agentId, emit)
    }

    // correzione E2: i tool del passo corrente — la chiamata di recupero di un
    // turno di gruppo li restringe a quelli del sollecito (DOPO il filtro
    // use-app della visione, così anche il recupero non lo offre)
    let turnTools = allTools

    // fase 18b (K7): la regola pura sugli anelli CANDIDATI (i > chainIdx, li
    // valuta nextRoute quando l'anello attivo fallisce). Il bisogno del turno
    // si legge AL MOMENTO del passaggio: i messaggi crescono a ogni passo. Il
    // motivo dello scarto finisce nel log del daemon (inglese, SOLO numeri:
    // mai testo dei messaggi); l'anello scartato NON si raffredda — al turno
    // dopo, o con una conversazione più corta, resta utilizzabile.
    const routeIncompatible = (r: Route): string | null => {
      const rp = providerById(r.providerId)
      if (!rp) return null
      // K8: il bisogno di immagini viene SOLO dalle immagini già nei messaggi
      // (allegati dell'utente e screenshot di use-app, che entrano come
      // messaggi user con images). NON da use-app tra i tool offerti: è nei
      // tool base di OGNI turno, e una riserva senza visione verrebbe saltata
      // sempre. Se la riserva chiama use-app, il gate a metà turno la rifiuta.
      const need = {
        inputTokens: messages.reduce((n, m) => n + estimateTokensOf(m.content), 0),
        needsImages: messages.some((m) => m.role === 'user' && (m.images?.length ?? 0) > 0)
      }
      const reason = routeIncompatibility(routeModelCaps(rp, r.model), need)
      if (reason) console.log(`[sandbot] fallback skipped (incompatible): ${r.providerId}/${r.model}: ${reason}`)
      return reason
    }

    setStatus(agentId, 'thinking', emit)

    let awaitingUser = false
    let finished = false
    // fase 8 (§3bis L11): le tool call eseguite nel turno, per la loop detection
    const executedCalls: Array<{ name: string; args: string }> = []
    // fase 19a (V6): l'hash dell'ultimo screenshot dello schermo del bot mandato
    // in QUESTO turno — identico → niente immagine, il result lo dice
    let lastScreenHash: string | null = null

    for (let step = 0; step < MAX_STEPS; step++) {
      if (controller.signal.aborted) break
      // M5 (fase 0.3.1001): consegna al confine di passo — i messaggi utente
      // diretti arrivati mentre il turno lavorava entrano nella storia come
      // entry visibili e la chiamata al modello che sta per partire li vede.
      // Il job della coda corrispondente si consuma QUI (completeJob): se il
      // turno fosse finito prima, la consegna sarebbe stata buttata via alla
      // chiusura del turno e il job sarebbe partito come turno nuovo.
      const due = midTurnDeliveries.get(agentId)
      if (due?.length) {
        midTurnDeliveries.delete(agentId)
        for (const d of due) {
          add({
            agentId, kind: 'message', role: 'user', content: d.text,
            meta: { ...(d.images?.length ? { images: d.images.length } : {}) }
          })
          emitLastEntry(agentId, emit)
          messages.push({ role: 'user', content: d.text, ...(d.images?.length ? { images: d.images } : {}) })
          if (d.jobId !== null) {
            const { completeJob } = await import('../store/jobs')
            completeJob(db(), d.jobId)
          }
        }
      }
      // lo stream ha un abort dedicato: la scadenza ferma SOLO lui, non il turno
      const streamAbort = new AbortController()
      const onTurnAbort = (): void => streamAbort.abort()
      controller.signal.addEventListener('abort', onTurnAbort)
      // fase 18b (K6): se dopo l'anello attivo c'è almeno un anello ancora
      // utilizzabile (i > chainIdx NON raffreddato), niente retry dell'SDK
      // (maxRetries: 0): il passaggio d'anello sostituisce il retry e il turno
      // non aspetta i backoff dell'SDK (fino a ~2 minuti con retry-after su un
      // provider che ha già finito la quota). Sull'ULTIMO anello utile resta il
      // default (2): senza riserve un blip di rete merita il retry. maxRetries
      // NON va sul filo: è un'opzione dell'SDK, il body non cambia.
      const usableAhead = chain.some((r, i) => i > chainIdx && !isCooled(r, Date.now()))
      const stream = llmStream(activeProvider, activeRoute.model, messages, turnTools, AbortSignal.any([controller.signal, streamAbort.signal]), {
        thinking: turnThinking,
        modelPrices,
        ...(usableAhead ? { maxRetries: 0 } : {})
      })
      // fase 3: il testo libero è ragionamento interno, non una risposta
      const entry = add({ agentId, kind: 'thinking', role: 'assistant', content: '' })
      emit({ type: 'entries', agentId, entries: [entry] })

      let acc = ''
      let final: { text: string; toolCalls: ToolCall[]; finishReason: string }
      let finalToolCalls: ToolCall[] = []
      let finalFinish = 'stop'
      let finalUsage: import('./llm').LlmChunk['usage'] | undefined
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
          if (ch.usage) finalUsage = ch.usage
        }
        final = { text: acc, toolCalls: finalToolCalls, finishReason: finalFinish }
        // fase 18b (H2.3): una chiamata riuscita toglie il raffreddamento
        markHealthy(activeRoute)
        // fase 18a (E4): uso registrato della chiamata — la riga va al modello
        // che ha risposto DAVVERO (la rotta attiva, non il provider del bot)
        if (finalUsage) {
          recordModelUsage({
            agentId,
            providerId: activeProvider.id,
            providerKind: activeProvider.kind,
            model: activeRoute.model,
            source: opts.subagent ? 'subagent' : opts.groupTurn !== undefined ? 'group' : 'turn',
            input: finalUsage.input,
            output: finalUsage.output,
            cacheRead: finalUsage.cacheRead ?? 0,
            cacheWrite: finalUsage.cacheWrite ?? 0,
            costUsd: finalUsage.costUsd ?? null
          })
        }
      } catch (err) {
        streamAbort.abort()
        updateEntryContent(entry.id, acc)
        // fase 18b (H2.2/H2.3): errore transitorio → l'anello che ha fallito si
        // raffredda (429/limite 10 minuti, 5xx/rete/scadenza 60 secondi) e il
        // turno passa al primo anello successivo ammesso (mai sui 4xx, mai su
        // interrupt; col 429 si salta lo stesso provider: la quota è
        // dell'account). Lo step consumato conta nel tetto MAX_STEPS, come
        // sempre; al massimo 3 passaggi per turno.
        const rateLimited = stopReasonOfError(err) === 'rate-limit'
        if (!controller.signal.aborted && (rateLimited || fallbackEligible(err))) {
          coolDown(activeRoute, rateLimited ? 'rate-limit' : 'server', Date.now())
        }
        const next = nextRoute(err, {
          chain,
          current: chainIdx,
          switches: routeSwitches,
          cooled: (r) => isCooled(r, Date.now()),
          aborted: controller.signal.aborted,
          // K7: gli anelli incompatibili si saltano senza raffreddarli
          incompatible: routeIncompatible
        })
        if (next !== null) {
          routeSwitches++
          const failed = activeRoute
          const failedProvider = activeProvider
          chainIdx = next
          activeRoute = chain[next]!
          activeProvider = providerById(activeRoute.providerId) ?? activeProvider
          const why = (err instanceof Error ? err.message : String(err)).slice(0, 200)
          if (activeProvider.id === failedProvider.id) {
            // lo stesso provider: la notice di sempre (fase 9)
            add({ ...uiSystemEntry(agentId, 'notice', ui(UI.modelFallback, { model: failed.model, why, fallback: activeRoute.model })) })
          } else {
            // fase 18b (H2.4): la riserva è di un ALTRO provider
            add({
              ...uiSystemEntry(agentId, 'notice', ui(UI.modelFallbackRoute, {
                model: failed.model,
                provider: failedProvider.name ?? failed.providerId,
                why,
                fallback: activeRoute.model,
                fallbackProvider: activeProvider.name ?? activeProvider.id
              }))
            })
          }
          emitLastEntry(agentId, emit)
          continue
        }
        if (err instanceof StreamDeadlineError) {
          // fase 8 (§3bis L11): il modello non risponde — abort del solo stream
          add({ ...uiSystemEntry(agentId, 'notice', ui(UI.modelNotResponding, { why: err.message })) })
          emitLastEntry(agentId, emit)
          // fase 12 (punto 3): il figlio che non risponde chiude failed col motivo
          // (fase 17c correzioni D2: inglese — il summary arriva al PADRE)
          failSubagent(`the model did not respond (${err.message})`)
          endTurn(agentId, 'STOPPED', emit, opts.taskId, 'model-error')
          setStatus(agentId, 'idle', emit)
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        add({ ...uiSystemEntry(agentId, 'notice', ui(UI.modelError, { message: msg })) })
        emitLastEntry(agentId, emit)
        // fase 12 (punto 3): errore del modello → il figlio chiude failed col motivo
        // (fase 17c correzioni D2: inglese — il summary arriva al PADRE)
        if (!controller.signal.aborted) failSubagent(`model error: ${msg}`)
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
        add({ ...uiSystemEntry(agentId, 'notice', ui(UI.modelEmpty)) })
        emitLastEntry(agentId, emit)
        // fase 12 (punto 3): flash a volte risponde vuoto — la chiusura del
        // figlio non dipende dal modello: sollecito e chiusura automatica
        if (opts.subagent) break
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
          add({ ...uiSystemEntry(agentId, 'notice', ui(UI.toolLoop)) })
          emitLastEntry(agentId, emit)
          // fase 12 (punto 3): il figlio inceppato chiude failed col motivo
          // (fase 17c correzioni D2: inglese — il summary arriva al PADRE)
          failSubagent(`the model kept repeating the exact same call (${call.name})`)
          endTurn(agentId, 'STOPPED', emit, opts.taskId, 'loop')
          setStatus(agentId, 'idle', emit)
          return
        }
        executedCalls.push({ name: call.name, args: call.arguments })
        // fase 9 (punto 0d): ogni tool che non è "parlare" è lavoro — azzera
        // il conteggio dei messaggi consecutivi senza lavoro in mezzo
        if (isWorkTool(call.name)) sendsSinceWork = 0

        // fase 12 (punto 3): nel FIGLIO i tool esclusi non compaiono nella
        // lista, ma se il modello li chiama lo stesso il rifiuto dice PERCHÉ
        if (opts.subagent) {
          const denyReason = subagentToolDenyReason(call.name)
          if (denyReason) {
            const refused = `not available to subagents: ${denyReason}`
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: refused, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            messages.push({ role: 'tool', toolCallId: call.id, content: refused })
            continue
          }
        }

        // ---- fase 3 (§3bis L2/L5): comunicazione e invii esterni, gestiti dal loop ----

        // invio esterno chiamato direttamente: MAI eseguito, diventa una bozza
        // (M1: il classificatore ora riconosce per nome anche i server aggiunti
        // a mano — readOnlyHint true resta sempre fuori)
        if (extSend(call.name)) {
          const draft = appendSend(agentId, call, draftFromExternalCall(call.name, input), emit, { status: 'pending' }, opts.taskId)
          emitNeedsInput(agentId, draft, formatUi(ui(UI.draftAwaiting, { preview: draft.content.slice(0, 80) }), loopUiLanguage()), emit)
          taskNeedsInput()
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: 'Outbound send not executed: turned into a draft awaiting the user\'s confirmation. For sends use draft_external.'
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
          // esterno secondo il classificatore (M1); to/subject/body entrano in
          // via.args secondo la fieldMap, così la card mostra esattamente ciò
          // che verrà inviato. M1: senza via del modello, la via si compila dai
          // tool del bot se per il canale c'è ESATTAMENTE un invio disponibile
          const viaTool = (input.via as { tool?: unknown } | undefined)?.tool
          const prepared = prepareDraft({
            channel,
            to: String(input.to ?? ''),
            ...(input.subject !== undefined ? { subject: String(input.subject) } : {}),
            body: String(input.body ?? ''),
            via: input.via,
            cfg: externalCfg,
            ...(typeof viaTool === 'string' && viaTool ? { viaAnnotations: permissions.mcpAnnotationsOf(viaTool) } : {}),
            candidates: sendCandidates
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
              neverAuto: false, untrustedTurn,
              ...(contaminated ? { contaminated: true } : {})
            }
            const review = await reviewWithConfiguredModel(action, userLang)
            if (review) {
              const decision = autoReviewDecision(review.cfg, action, review.outcome, autoApprovals)
              if (decision.autoAllow) {
                // come il click su Invia: il gate resta in mezzo (una regola
                // blocked nega comunque l'invio)
                const verdict = await permissions.check(via.tool, via.args, agentId)
                if (verdict.kind === 'deny') {
                  autoSend = { ok: false, error: 'send blocked by permissions' }
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
                    add({ ...uiSystemEntry(agentId, 'notice', ui(UI.draftAutoSent, { tool: via.tool, output: output.slice(0, 300) })) })
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
            emitNeedsInput(agentId, draft, formatUi(ui(UI.draftAwaiting, { preview: draft.content.slice(0, 80) }), loopUiLanguage()), emit)
            taskNeedsInput()
          }
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: prepared.viaRejected
              ? `text-only draft created: "via" discarded because ${prepared.viaRejected} is not an external-send tool (no send channel connected).`
              : autoSend?.ok
                ? `draft SENT automatically under the user's auto-review rule "${autoSend.ruleMatched}": outcome reported in chat.`
                : autoSend && !autoSend.ok
                  ? `automatic send of the draft failed (${autoSend.error}): the draft waits for the user's click.`
                  : prepared.viaAuto && prepared.message.via
                    ? `draft created with via ${prepared.message.via.tool} (chosen automatically: it is the only send tool for this channel); it will be sent only if the user clicks Send.`
                    : prepared.message.sendHint === 'pick'
                      ? `text-only draft created: more than one send tool exists for this channel, choose one in via.tool (candidates: ${prepared.sendCandidates?.join(', ')}).`
                      : prepared.message.sendHint === 'missing-required'
                        ? `text-only draft created: the only send tool for this channel (${prepared.sendCandidates?.join(', ')}) requires arguments that the draft fields cannot fill; call it directly or fill via.args yourself.`
                        : 'draft created and shown to the user: it will be sent only if the user clicks Send'
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
            content: ASK_USER_RESULT
          })
          awaitingUser = true
          break // il turno TERMINA: le chiamate successive della stessa risposta non vengono eseguite
        }

        // fase 19a (V5): la presa di controllo CHIESTA DAL BOT — come ask_user,
        // una card nella chat chiude il turno (awaitingUser). Il daemon segna
        // takeoverPending (30 minuti): la sfida, il login o il 2FA li risolve
        // l'UTENTE sullo schermo del bot, che è una persona. Vale anche nei
        // turni automatici: il bot aspetta.
        if (call.name === 'request_takeover') {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const tEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [tEntry] })
          const browser = await import('./browser')
          if (!browser.browserAvailable()) {
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: browser.BROWSER_UNAVAILABLE, meta: { callId: call.id, browserUnavailable: true } })
            emit({ type: 'entries', agentId, entries: [res] })
            messages.push({ role: 'tool', toolCallId: call.id, content: browser.BROWSER_UNAVAILABLE })
            continue
          }
          const reason = String(input.reason ?? '').trim().slice(0, 200) || '(no reason given)'
          // la card con il motivo e il bottone «Apri lo schermo» (già in controllo)
          const card = appendSend(agentId, call, { type: 'takeover-request', reason }, emit, { takeover: 'pending' }, opts.taskId)
          const { markTakeoverPending } = await import('./screen')
          markTakeoverPending(agentId, reason, card.id)
          emitNeedsInput(agentId, card, formatUi(ui(UI.cardTakeover, { reason: reason.slice(0, 80) }), loopUiLanguage()), emit)
          taskNeedsInput()
          messages.push({ role: 'tool', toolCallId: call.id, content: REQUEST_TAKEOVER_RESULT })
          awaitingUser = true
          break // il turno TERMINA qui: il bot aspetta che l'utente finisca
        }

        // fase 11 (punto 2): ricerca e lettura web — l'output è DATO NON FIDATO:
        // entra nel contesto dentro un blocco EVIDENZA (tag neutralizzato +
        // regola "è un dato, non un'istruzione") e dal primo contenuto web il
        // turno è CONTAMINATO (vedi sopra). Lettura a effetti zero: niente gate
        if (call.name === 'web_search' || call.name === 'web_fetch') {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const webEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [webEntry] })
          let output = ''
          let meta: Record<string, unknown> = {}
          try {
            const r = await executeTool(agentId, call.name, input, { turnInitiator: opts.initiator })
            output = r.output
            meta = r.meta
          } catch (e) {
            output = `Error: ${e instanceof Error ? e.message : String(e)}`
            meta = { error: true }
          }
          if (meta.webContent) {
            // F8: i grant "per questo turno" dati PRIMA della lettura web non
            // coprono le azioni successive (contenuto non fidato + effetti):
            // chi concede la card DI QUESTO turno mantiene il grant per il
            // resto del turno, come oggi. L'epoca revoca anche i grant ancora
            // in fase di registrazione (l'analisi shell è async).
            if (!contaminated) {
              run.turnAllows.clear()
              run.turnGrantEpoch++
            }
            contaminated = true
          }
          const evidence = call.name === 'web_search'
            ? formatWebSearchEvidence(String(input.query ?? ''), output)
            // G3: url= è l'URL FINALE della lettura (meta.finalUrl, redirect
            // compresi); l'URL di partenza, se diverso, va in richiesto=
            : formatWebFetchEvidence(String(meta.finalUrl ?? input.url ?? ''), output, String(input.url ?? ''))
          const res = add({
            agentId, kind: 'tool-result', role: 'system',
            content: evidence.slice(0, 50_000),
            meta: { callId: call.id, ...meta, webEvidence: true }
          })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: evidence.slice(0, 50_000) })
          continue
        }

        // fase 11b (punto 2): il BROWSER del bot — il gradino dopo la ricerca e
        // la lettura web. Intercettato perché il confine sta qui: URL validato
        // (checkUrl in callBrowserTool), classificazione PURA del rischio delle
        // azioni con effetti (refInfo dall'ULTIMO SNAPSHOT ricevuto, mai da ciò
        // che il modello dice dell'elemento), blocco evidenza + contaminazione
        // per tutto ciò che è contenuto di pagina
        if (call.name.startsWith('browser_')) {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const bEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [bEntry] })
          const browser = await import('./browser')
          const guard = await import('./browser-guard')
          const pushResult = (content: string, meta: Record<string, unknown> = {}): void => {
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: content.slice(0, 50_000), meta: { callId: call.id, ...meta } })
            emit({ type: 'entries', agentId, entries: [res] })
            messages.push({ role: 'tool', toolCallId: call.id, content: content.slice(0, 50_000) })
          }
          if (!browser.browserAvailable()) {
            pushResult(browser.BROWSER_UNAVAILABLE, { browserUnavailable: true })
            continue
          }
          let risk = guard.browserActionRisk(call.name, input, browser.refInfoOf(agentId, String(input.ref ?? '')))
          // fase 12 (0a, correzione J3, giro K1): per browser_type col ref
          // valido e presente nello snapshot il daemon verifica INTERNAMENTE
          // il campo con browser_evaluate (mai esposto al modello). I segnali
          // indipendenti (nome accessibile dello snapshot, campo vero) si
          // combinano in modo CONSERVATIVO: il campo vero può AGGIUNGERE un
          // deny (password senza nome, carta nascosta in aria-labelledby),
          // MAI toglierne uno al nome; quando la verifica FALLISCE (errore
          // MCP, result non leggibile) restano le regole dello snapshot e un
          // free diventa ask, mai free
          const askedRef = String(input.ref ?? '')
          if (call.name === 'browser_type' && guard.VALID_REF_RE.test(askedRef) && browser.refInfoOf(agentId, askedRef)) {
            const credential = await browser.fieldIsCredentialRef(agentId, askedRef)
            risk = guard.applyFieldProbe(risk, input, browser.refInfoOf(agentId, askedRef), credential)
          }
          if (risk.kind === 'deny') {
            pushResult(risk.reason, { browserDeny: true })
            continue
          }
          if (risk.kind === 'ask') {
            // auto-review come per le altre ask; nel turno contaminato (dopo
            // una pagina letta lo è SEMPRE) CONTAMINATED_ASK_TOOLS non lascia
            // approvare da sola: la card va all'utente
            let autoAllowed: { ruleMatched: string; reason?: string } | null = null
            const action: AutoReviewAction = {
              tool: call.name, args: input, neverAuto: false, untrustedTurn,
              ...(contaminated ? { contaminated: true } : {})
            }
            const review = await reviewWithConfiguredModel(action, userLang)
            if (review) {
              const decision = autoReviewDecision(review.cfg, action, review.outcome, autoApprovals)
              if (decision.autoAllow) {
                autoAllowed = { ruleMatched: decision.ruleMatched, ...(decision.reason ? { reason: decision.reason } : {}) }
                autoApprovals++
              }
            }
            if (!autoAllowed) {
              // la card mostra URL corrente, elemento (ruolo e nome dallo
              // snapshot) e testo da scrivere. Fase 12 (0d): press_key dice il
              // TASTO, non "su ref ?" (il tasto non ha ref).
              // Fase 17c (C2): la card è UN id del catalogo UI (select su
              // bersaglio e motivo), content nella lingua dell'interfaccia
              const url = browser.lastUrlOf(agentId) ?? formatUi(ui(UI.cardNoPageOpen), loopUiLanguage())
              const info = browser.refInfoOf(agentId, String(input.ref ?? ''))
              // il nome accessibile, o il testo in linea quando manca (generic)
              const elem = info ? `${info.role} "${info.name || info.text}"` : `ref ${String(input.ref ?? '?')}`
              const askUi = ui(UI.cardBrowserAsk, {
                tool: call.name,
                target: call.name === 'browser_press_key' ? 'key' : 'element',
                ...(call.name === 'browser_press_key'
                  ? { key: String(input.key ?? '?') }
                  : { element: elem }),
                url,
                typed: call.name === 'browser_type' ? 'yes' : 'no',
                ...(call.name === 'browser_type' ? { text: String(input.text ?? '').slice(0, 80) } : {}),
                ...(risk.ask ? riskAskValues(risk.ask) : { reasonKind: 'other', reason: risk.reason })
              })
              const approval: Approval = {
                id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now()
              }
              run.approvals.set(approval.id, () => undefined)
              const approvalEntry = add({
                agentId, kind: 'approval', role: 'system',
                content: formatUi(askUi, loopUiLanguage()),
                meta: {
                  approvalId: approval.id, tool: call.name, input, status: 'pending', ui: askUi,
                  browser: {
                    url,
                    ...(info ? { element: info } : {}),
                    ...(call.name === 'browser_type' ? { text: String(input.text ?? '') } : {})
                  },
                  keys: [`${call.name} ${call.name === 'browser_press_key' ? String(input.key ?? '?') : elem}`]
                }
              })
              setStatus(agentId, 'paused-for-approval', emit)
              emit({ type: 'entries', agentId, entries: [approvalEntry] })
              emit({ type: 'approval', agentId, approval })
              emitNeedsInput(agentId, approvalEntry, formatUi(askUi, loopUiLanguage()).slice(0, 80), emit)
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
              taskWorking()
              if (decision !== 'allow') {
                setStatus(agentId, 'thinking', emit)
                pushResult(
                  decision === 'deny' ? 'Browser action cancelled by the user: do not retry it without their ok.' : 'Approval expired or interrupted: browser action not executed.',
                  { browserAsk: 'denied' }
                )
                continue
              }
              setStatus(agentId, 'thinking', emit)
            }
          }
          let bOutput = ''
          let bMeta: Record<string, unknown> = {}
          try {
            const r = await browser.callBrowserTool(agentId, call.name, input)
            bOutput = r.output
            bMeta = r.meta
          } catch (e) {
            bOutput = `Browser error: ${e instanceof Error ? e.message : String(e)}`
            bMeta = { error: true }
          }
          if (bMeta.browserPage && !bMeta.browserError) {
            // contenuto di pagina → blocco evidenza col tag neutralizzato e
            // CONTAMINAZIONE del turno (come web_fetch): il dato non fidato
            // non sblocca da solo le azioni con effetti
            if (!contaminated) {
              run.turnAllows.clear()
              run.turnGrantEpoch++
            }
            contaminated = true
            const evidence = formatWebBrowserEvidence(String(bMeta.url ?? ''), bOutput)
            pushResult(evidence, { ...bMeta, webEvidence: true })
            continue
          }
          pushResult(bOutput, bMeta)
          continue
        }

        // fase 19a (V6/V7): il computer use NEL BOX — il desktop del bot dove
        // gira il suo browser (computer_observe / computer_act), da non
        // confondere con use-app che controlla il MAC dell'utente. Il confine
        // di OGNI azione è computerActRisk (puro, browser-guard): un click a
        // coordinate non aggira la classificazione del rischio, il probe della
        // pagina passa dalla browser_evaluate INTERNA e le azioni rifiutate
        // fermano la sequenza. computer_observe ha il modo di lettura di
        // browser_snapshot (nessun gate); computer_act quello di browser_click.
        if (call.name === 'computer_observe' || call.name === 'computer_act') {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const cEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [cEntry] })
          const browser = await import('./browser')
          const guard = await import('./browser-guard')
          const computer = await import('./computer')
          const screen = await import('./screen')
          const pushResult = (content: string, meta: Record<string, unknown> = {}): void => {
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: content.slice(0, 50_000), meta: { callId: call.id, ...meta } })
            emit({ type: 'entries', agentId, entries: [res] })
            messages.push({ role: 'tool', toolCallId: call.id, content: content.slice(0, 50_000) })
          }
          if (!browser.browserAvailable()) {
            pushResult(browser.BROWSER_UNAVAILABLE, { browserUnavailable: true })
            continue
          }
          // H4 a metà turno (V7), come use-app: il modello non può vedere lo
          // screenshot che riceverebbe
          if (modelCapabilities(activeProvider, activeRoute.model).vision === false) {
            pushResult(`${call.name} needs a vision model; the current model cannot see images`, { error: true })
            continue
          }
          // la cattura con dedup: lo schermo IDENTICO a quello già mandato in
          // questo turno non si rimanda (il result lo dice, come Rakazo)
          const pushScreen = (prefix: string, image: string | null, meta: Record<string, unknown> = {}): void => {
            if (!image) {
              pushResult(`${prefix}\nScreenshot not available.`, { ...meta, error: true })
              return
            }
            const hash = createHash('sha256').update(image).digest('hex')
            if (hash === lastScreenHash) {
              pushResult(`${prefix}\nThe screen is unchanged since your last screenshot.`, { ...meta, screenUnchanged: true })
              return
            }
            lastScreenHash = hash
            pushResult(`${prefix}\nThe screenshot follows (the coordinates you want to click are in pixels of THAT image).`, meta)
            messages.push({
              role: 'user',
              content: `[screenshot] Here is the current screen of your own computer in the sandbox requested by the ${call.name} tool (the coordinates you want to click are in pixels of THIS image):`,
              images: [image]
            })
          }
          if (call.name === 'computer_observe') {
            const r = await computer.computerObserve(agentId)
            if (!r.ok) pushResult(r.error, { error: true })
            else pushScreen(`Screen: ${r.width}x${r.height}.`, r.image, { computerScreen: true })
            continue
          }
          // ---- computer_act: preparazione (validazione pura + geometria) ----
          const prep = await computer.computerPrepareAct(agentId, input)
          if (!prep.ok) {
            pushResult(`Invalid computer_act: ${prep.error}`, { error: true })
            continue
          }
          // controllo dell'utente in corso: errore inglese, NULLA viene eseguito
          if (screen.userControlActive(agentId)) {
            pushResult(guard.USER_CONTROL_ERROR_TEXT, { error: true, userControl: true })
            continue
          }
          const info = await computer.desktopInfoOf(agentId)
          if (!info) {
            pushResult('The bot has no screen open: it starts when a page is opened in its browser.', { error: true })
            continue
          }
          // sfida anti-bot nell'ultimo snapshot noto → ogni azione è negata
          const challenge = guard.snapshotChallenge(browser.lastSnapshotOf(agentId) ?? '')
          // l'offset del viewport si calcola UNA volta per chiamata: dalle
          // correzioni L3 è solo il RIPIEGO della formula della sonda del punto
          const view = await browser.probeViewportOffset(agentId)
          let executed = 0
          let refused: { index: number; kind: string; reason: string } | null = null
          for (let i = 0; i < prep.actions.length; i++) {
            const action = prep.actions[i]!
            const ctx = await computer.computerActContextOf(agentId, action, view, {
              challenge, userControl: false, desktop: info
            })
            const risk = guard.computerActRisk(action, ctx)
            if (risk.kind === 'deny' || risk.kind === 'error') {
              refused = { index: i, kind: action.kind, reason: risk.reason }
              break
            }
            if (risk.kind === 'ask') {
              // la STESSA card di approvazione di oggi (id card.browserAsk):
              // auto-review come per le altre ask, poi la card all'utente
              let autoAllowed: { ruleMatched: string } | null = null
              const arAction: AutoReviewAction = { tool: call.name, args: input, neverAuto: false, untrustedTurn, ...(contaminated ? { contaminated: true } : {}) }
              const review = await reviewWithConfiguredModel(arAction, userLang)
              if (review) {
                const decision = autoReviewDecision(review.cfg, arAction, review.outcome, autoApprovals)
                if (decision.autoAllow) {
                  autoAllowed = { ruleMatched: decision.ruleMatched }
                  autoApprovals++
                }
              }
              if (!autoAllowed) {
                const url = browser.lastUrlOf(agentId) ?? formatUi(ui(UI.cardNoPageOpen), loopUiLanguage())
                // L3: la sonda del punto è un'unione — l'etichetta della card
                // mostra l'elemento solo quando c'è davvero (outside, frame e
                // unknown restano "the screen")
                const elem = ctx.click && ctx.click.kind === 'element'
                  ? `${ctx.click.role} "${ctx.click.name || ctx.click.text}"`
                  : action.kind === 'key' ? `key ${action.key}` : 'the screen'
                const askUi = ui(UI.cardBrowserAsk, {
                  tool: call.name,
                  target: action.kind === 'key' ? 'key' : 'element',
                  ...(action.kind === 'key' ? { key: action.key } : { element: elem }),
                  url,
                  typed: action.kind === 'type' ? 'yes' : 'no',
                  ...(action.kind === 'type' ? { text: action.text.slice(0, 80) } : {}),
                  ...(risk.ask ? riskAskValues(risk.ask) : { reasonKind: 'other', reason: risk.reason })
                })
                const approval: Approval = { id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now() }
                run.approvals.set(approval.id, () => undefined)
                const approvalEntry = add({
                  agentId, kind: 'approval', role: 'system',
                  content: formatUi(askUi, loopUiLanguage()),
                  meta: { approvalId: approval.id, tool: call.name, input, status: 'pending', ui: askUi, keys: [`${call.name} ${elem}`] }
                })
                setStatus(agentId, 'paused-for-approval', emit)
                emit({ type: 'entries', agentId, entries: [approvalEntry] })
                emit({ type: 'approval', agentId, approval })
                emitNeedsInput(agentId, approvalEntry, formatUi(askUi, loopUiLanguage()).slice(0, 80), emit)
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
                taskWorking()
                if (decision !== 'allow') {
                  setStatus(agentId, 'thinking', emit)
                  refused = { index: i, kind: action.kind, reason: decision === 'deny' ? 'cancelled by the user' : 'approval expired or interrupted' }
                  break
                }
                setStatus(agentId, 'thinking', emit)
              }
            }
            const err = await computer.computerExecAction(agentId, info, action)
            if (err) {
              refused = { index: i, kind: action.kind, reason: err }
              break
            }
            executed++
          }
          const summary = `Executed ${executed} of ${prep.actions.length} actions.` +
            (refused ? `\nAction ${refused.index} (${refused.kind}) was refused: ${refused.reason}` : '')
          if (input.observe === false) {
            pushResult(summary, { computerAct: true })
          } else {
            const img = await computer.captureScreen(info)
            pushScreen(summary, img, { computerAct: true })
          }
          continue
        }

        // fase 11 (punto 4): lo scambio di file Mac <-> box chiede SEMPRE
        // all'utente — card con path, dimensione e direzione; mai approvabile
        // dall'auto-review (nemmeno con una regola: non passa dal gate).
        // I rifiuti FISSI (cartelle sensibili del Mac, dati di SandBot, confini
        // del box, tetto dei 200 MB) scattano PRIMA della card
        if (call.name === 'copy_to_box' || call.name === 'copy_from_box') {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const copyEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [copyEntry] })
          const { getPrepareFileExchange, getRunFileExchange } = await import('./file-exchange')
          const pre = await getPrepareFileExchange()(agentId, call.name, input)
          if (!pre.ok) {
            const r = add({ agentId, kind: 'tool-result', role: 'system', content: pre.error, meta: { callId: call.id, error: true } })
            emit({ type: 'entries', agentId, entries: [r] })
            messages.push({ role: 'tool', toolCallId: call.id, content: pre.error })
            continue
          }
          const arrow = pre.plan.direction === 'to_box' ? `Mac ${pre.plan.macPath} → box ${pre.plan.boxPath}` : `box ${pre.plan.boxPath} → Mac ${pre.plan.macPath}`
          const approval: Approval = {
            id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now()
          }
          run.approvals.set(approval.id, () => undefined)
          const exchangeUi = ui(UI.cardFileExchange, {
            tool: call.name,
            direction: pre.plan.direction === 'to_box' ? 'toBox' : 'fromBox',
            macPath: pre.plan.macPath, boxPath: pre.plan.boxPath, size: pre.plan.size
          })
          const approvalEntry = add({
            agentId, kind: 'approval', role: 'system',
            content: formatUi(exchangeUi, loopUiLanguage()),
            meta: {
              approvalId: approval.id, tool: call.name, input, status: 'pending', ui: exchangeUi,
              fileExchange: { direction: pre.plan.direction, macPath: pre.plan.macPath, boxPath: pre.plan.boxPath, size: pre.plan.size },
              keys: [arrow]
            }
          })
          setStatus(agentId, 'paused-for-approval', emit)
          emit({ type: 'entries', agentId, entries: [approvalEntry] })
          emit({ type: 'approval', agentId, approval })
          emitNeedsInput(agentId, approvalEntry, formatUi(exchangeUi, loopUiLanguage()).slice(0, 80), emit)
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
          taskWorking()
          if (decision !== 'allow') {
            const msg = decision === 'deny' ? 'Copy denied by the user.' : 'Approval expired or interrupted: copy not executed.'
            messages.push({ role: 'tool', toolCallId: call.id, content: msg })
            const r = add({ agentId, kind: 'tool-result', role: 'system', content: msg, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [r] })
            setStatus(agentId, 'thinking', emit)
            continue
          }
          setStatus(agentId, 'thinking', emit)
          let out: string
          try {
            out = (await getRunFileExchange()(agentId, pre.plan)).output
            // fase 19b (T4.1): la copia È AVVENUTA (approvata dall'utente) →
            // riga nel feed «Attività». La regola di Rakazo vale anche qui:
            // un errore nel registrare si logga, non ferma il tool
            try {
              const { recordComputerAction } = await import('./computer-activity')
              const macName = pre.plan.macPath.split('/').pop() ?? ''
              recordComputerAction({
                agentId,
                kind: pre.plan.direction === 'to_box' ? 'copy_in' : 'copy_out',
                target: pre.plan.direction === 'to_box'
                  ? pre.plan.boxPath
                  : `${pre.plan.boxPath} → ${macName}`,
                bytes: pre.plan.size
              })
            } catch (recErr) {
              console.error('[activity] copia non registrata:', recErr)
            }
          } catch (e) {
            out = `Error in the copy: ${e instanceof Error ? e.message : String(e)}`
            try {
              const { recordComputerAction } = await import('./computer-activity')
              recordComputerAction({
                agentId,
                kind: pre.plan.direction === 'to_box' ? 'copy_in' : 'copy_out',
                target: pre.plan.boxPath,
                error: e instanceof Error ? e.message : String(e)
              })
            } catch {
              // il feed è una vista
            }
          }
          const r = add({ agentId, kind: 'tool-result', role: 'system', content: out, meta: { callId: call.id } })
          emit({ type: 'entries', agentId, entries: [r] })
          messages.push({ role: 'tool', toolCallId: call.id, content: out })
          continue
        }

        // fase 13 (punto 1): search_connectors — quando il result contiene righe
        // di REGISTRO o MARKETPLACE è testo di TERZI: blocco dati esterni (come
        // web_fetch) e CONTAMINAZIONE del turno; le righe del catalogo
        // verificato sono nostre e restano un result normale
        if (call.name === 'search_connectors') {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const sEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [sEntry] })
          let output = ''
          let thirdParty = false
          try {
            const r = await executeTool(agentId, call.name, input, { turnInitiator: opts.initiator })
            output = r.output
            thirdParty = r.meta.thirdParty === true
          } catch (e) {
            output = `Error: ${e instanceof Error ? e.message : String(e)}`
          }
          let content = output
          if (thirdParty) {
            if (!contaminated) {
              run.turnAllows.clear()
              run.turnGrantEpoch++
            }
            contaminated = true
            content = formatExternalDataEvidence('search_connectors', output)
          }
          const res = add({
            agentId, kind: 'tool-result', role: 'system', content: content.slice(0, 50_000),
            meta: { callId: call.id, ...(thirdParty ? { webEvidence: true, thirdParty: true } : {}) }
          })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: content.slice(0, 50_000) })
          continue
        }

        // fase 13 (punto 2): PROPONENTE di un server MCP del registro (o di un
        // URL) — il tool NON installa nulla: crea SOLO la card "Aggiungi server
        // MCP" e torna subito. La card è TUTTA in codice (solo reason è del
        // modello); l'installazione parte dal click dell'utente, mai "sempre".
        // Punto 3: una chiamata arrivata fuori da un turno dell'utente viene
        // negata col testo fisso
        if (call.name === 'add_mcp_server' || call.name === 'install_plugin') {
          const propEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [propEntry] })
          const offerFacts = {
            source, groupTurn: opts.groupTurn, subagent: opts.subagent, taskId: opts.taskId,
            automatic, agentMessage: opts.agentMessage, initiator: opts.initiator
          }
          if (!connectorProposalOffered(offerFacts)) {
            const refused = CONNECTOR_PROPOSAL_DENIED
            messages.push({ role: 'tool', toolCallId: call.id, content: refused })
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: refused, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            continue
          }
          const { getInstallDeps } = await import('../connectors/install-bridge')
          const reason = String(input.reason ?? '')
          const built = call.name === 'add_mcp_server'
            ? await (await import('../connectors/install')).buildMcpServerCard(String(input.id ?? ''), reason, getInstallDeps())
            : await (await import('../connectors/install')).buildPluginCard(String(input.id ?? ''), reason, getInstallDeps())
          if (!built.ok) {
            messages.push({ role: 'tool', toolCallId: call.id, content: built.error })
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: built.error, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            continue
          }
          // turno contaminato: la card mostra l'avviso in cima (punto 3)
          const message = contaminated ? { ...built.card, untrusted: true as const } : built.card
          appendSend(agentId, call, message, emit, { status: 'pending' }, opts.taskId)
          messages.push({ role: 'tool', toolCallId: call.id, content: PROPOSAL_RESULT })
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: PROPOSAL_RESULT, meta: { callId: call.id } })
          emit({ type: 'entries', agentId, entries: [res] })
          continue
        }

        // fase 13 (punto 5): find_tools — cerca fra i tool MCP DEFERITI del
        // bot e li ATTIVA dal passo successivo (in fondo, ordine stabile)
        if (call.name === 'find_tools') {
          const fEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: 'find_tools',
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [fEntry] })
          const found = rankTools(
            mcpToolDefs.map((t) => ({ name: t.name, description: t.description, requiredParams: requiredParamsOf(t) })),
            String(input.query ?? '')
          )
          const text = formatFindToolsResult(found)
          const res = add({
            agentId, kind: 'tool-result', role: 'system', content: text,
            meta: { callId: call.id, activated: found.map((t) => t.name) }
          })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: text })
          // i tool trovati diventano ATTIVI dal passo successivo e restano
          // nella lista, in FONDO e in ordine stabile (cache del prompt)
          for (const t of found) {
            activeMcpNames.add(t.name)
            const def = mcpToolDefs.find((x) => x.name === t.name)
            if (def && !turnTools.some((x) => x.name === t.name)) turnTools = [...turnTools, def]
          }
          continue
        }

        // ---- fase 14: libreria e credenziali ----

        // punto 5: export_from_library — card di conferma come copy_from_box
        // (nome, formato, destinazione), poi la copia in ~/Downloads/SandBot
        // con nome non in conflitto
        if (call.name === 'export_from_library') {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const xEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [xEntry] })
          const { prepareLibraryExport, runLibraryExport } = await import('./library')
          const pre = prepareLibraryExport(input)
          if (!pre.ok) {
            messages.push({ role: 'tool', toolCallId: call.id, content: pre.error })
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: pre.error, meta: { callId: call.id, error: true } })
            emit({ type: 'entries', agentId, entries: [res] })
            continue
          }
          const plan = pre.value
          const approval: Approval = { id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now() }
          const exportUi = ui(UI.cardExportLibrary, { name: plan.name, format: plan.format, destination: plan.destination })
          const decision = await awaitCard(approval, 'approval', formatUi(exportUi, loopUiLanguage()), {
            tool: call.name, input, libraryExport: plan, keys: [`export ${plan.name}`], ui: exportUi
          })
          if (decision !== 'allow') {
            const msg = decision === 'deny' ? 'Export cancelled by the user.' : 'Approval expired or interrupted: export not executed.'
            messages.push({ role: 'tool', toolCallId: call.id, content: msg })
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: msg, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            continue
          }
          let out: string
          try {
            const { getPrintToPdf } = await import('../../daemon/host-bridge')
            const fn = getPrintToPdf()
            out = (await runLibraryExport(plan, fn ? { printToPdf: fn } : {})).output
          } catch (e) {
            out = `Error in the export: ${e instanceof Error ? e.message : String(e)}`
          }
          messages.push({ role: 'tool', toolCallId: call.id, content: out })
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: out, meta: { callId: call.id } })
          emit({ type: 'entries', agentId, entries: [res] })
          continue
        }

        // punto 7d: fill_credential — i controlli in CODICE e in ordine
        // (origine, ref+tipo, approvazione), poi il DAEMON compila i campi col
        // valore del vault e il result per il modello non contiene MAI i valori
        // (il flusso sta in fill.ts, testabile col MCP finto)
        if (call.name === 'fill_credential') {
          emit({ type: 'activity', agentId, activity: activityOf(call.name, input) })
          const fillEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [fillEntry] })
          const pushResult = (content: string, meta: Record<string, unknown> = {}): void => {
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: content.slice(0, 50_000), meta: { callId: call.id, ...meta } })
            emit({ type: 'entries', agentId, entries: [res] })
            messages.push({ role: 'tool', toolCallId: call.id, content: content.slice(0, 50_000) })
          }
          const browser = await import('./browser')
          const { runFillCredential } = await import('./fill')
          const vault = await import('../vault')
          const outcome = await runFillCredential(input, {
            getLogin: (id) => vault.getLoginForFill(id),
            lastUrl: () => browser.lastUrlOf(agentId),
            refInfo: (ref) => browser.refInfoOf(agentId, ref),
            probe: (ref) => browser.probeFieldType(agentId, ref),
            typeInto: (ref, value) => browser.typeIntoFieldForFill(agentId, ref, value),
            hasStandingGrant: (loginId, origin) =>
              listGrants().some((g: Grant) => g.tool === 'fill_credential' && g.target === `${loginId}|${origin}`),
            hasTurnAllow: (loginId, origin) => run.turnAllows.has(`fill_credential|${loginId}|${origin}`),
            requestApproval: async (login, origin, fields) => {
              const approval: Approval = { id: randomUUID(), agentId, tool: call.name, input: { ...input, origin }, status: 'pending', createdAt: Date.now() }
              const fillUi = ui(UI.cardFillAsk, { label: login.label, origin })
              const decision = await awaitCard(approval, 'send-message', formatUi(fillUi, loopUiLanguage()), {
                message: { type: 'fill', id: login.id, label: login.label, origin, fields },
                tool: call.name, input: { ...input, origin }, fill: { loginId: login.id, origin }, ui: fillUi
              })
              if (decision === 'allow') return 'allow-turn' // 'always' lo registra resolveApproval
              if (decision === 'deny') return 'deny'
              return 'timeout'
            }
          })
          // "Consenti" (mode 'turn') registra il grant del turno in
          // resolveApproval via turnGrantKey; "Sempre per questo sito" (mode
          // 'always') registra la concessione (loginId, origin)
          pushResult(outcome.output, { ...(outcome.denied ? { fillDenied: true } : {}), ...(outcome.error ? { error: true } : {}) })
          continue
        }

        // punto 7e: request_secure_input — il modulo nella UI chiede il dato
        // sensibile SENZA chat; i valori salvano nel vault via RPC e il
        // modello riceve solo l'esito
        if (call.name === 'request_secure_input') {
          const kind = input.kind === 'secret' ? 'secret' : 'login'
          const reason = String(input.reason ?? '').trim()
          const label = String(input.label ?? '').trim()
          const name = String(input.name ?? '').trim()
          const origin = String(input.origin ?? '').trim()
          const sEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [sEntry] })
          const pushResult = (content: string): void => {
            messages.push({ role: 'tool', toolCallId: call.id, content })
            const res = add({ agentId, kind: 'tool-result', role: 'system', content, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
          }
          if (kind === 'login' && !label) {
            pushResult('A login needs the label, e.g. "ASPI portal": the user sees it in the form.')
            continue
          }
          if (kind === 'secret' && !name) {
            pushResult('A secret needs the name, e.g. API_KEY.')
            continue
          }
          const approval: Approval = { id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now() }
          // P5 (fase 14 correzioni): una pagina ostile può spingere il modello a
          // chiedere un login con l'origine GIA' precompilata — come save_contact,
          // una richiesta nata in un turno contaminato porta untrusted e la UI
          // dice all'utente di controllare che l'origine sia davvero quella del sito
          const secureUi = kind === 'login'
            ? ui(UI.cardSecureInputAskLogin, { label, reason })
            : ui(UI.cardSecureInputAskSecret, { name, reason })
          const decision = await awaitCard(approval, 'send-message', formatUi(secureUi, loopUiLanguage()), {
            message: {
              type: 'secure-input', kind,
              ...(kind === 'login' ? { label, ...(origin ? { origin } : {}) } : { name }),
              reason,
              ...(contaminated ? { untrusted: true as const } : {})
            },
            tool: call.name, input, secureInput: true, ui: secureUi
          })
          if (decision !== 'allow') {
            pushResult('cancelled by the user')
            continue
          }
          // l'utente ha salvato: l'esito (con l'id/nome reale) sta nell'entry
          // meta.savedOutcome, scritta dall'RPC secureinput:submit
          const savedOutcome = (() => {
            const e = getEntries(agentId).findLast((x) => x.kind === 'send-message' && x.meta?.approvalId === approval.id)
            return (e?.meta?.savedOutcome as string | undefined) ?? null
          })()
          pushResult(savedOutcome ?? 'cancelled by the user')
          continue
        }

        // punto 7f: save_contact — card di conferma coi campi; "Salva" crea
        // la voce nel vault e il modello riceve l'id
        if (call.name === 'save_contact') {
          const cEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [cEntry] })
          const pushResult = (content: string): void => {
            messages.push({ role: 'tool', toolCallId: call.id, content })
            const res = add({ agentId, kind: 'tool-result', role: 'system', content, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
          }
          const name = String(input.name ?? '').trim()
          if (!name) {
            pushResult('Contact not saved: the name is required.')
            continue
          }
          const contact = {
            name,
            emails: Array.isArray(input.emails) ? input.emails.map(String) : [],
            phones: Array.isArray(input.phones) ? input.phones.map(String) : [],
            ...(input.address !== undefined && String(input.address).trim() ? { address: String(input.address) } : {}),
            ...(input.notes !== undefined && String(input.notes).trim() ? { notes: String(input.notes) } : {})
          }
          const approval: Approval = { id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now() }
          // proposta nata in un turno contaminato: la card avvisa che i dati
          // arrivano da una fonte esterna
          const contactUi = ui(UI.cardContactAsk, { name })
          const decision = await awaitCard(approval, 'send-message', formatUi(contactUi, loopUiLanguage()), {
            message: { type: 'contact', ...contact, ...(contaminated ? { untrusted: true as const } : {}) },
            tool: call.name, input, contactProposal: contact, ui: contactUi
          })
          if (decision !== 'allow') {
            pushResult('Contact not saved: cancelled by the user.')
            continue
          }
          const vault = await import('../vault')
          try {
            const id = await vault.saveContact(contact)
            pushResult(`Contact "${name}" saved in the vault (id ${id}).`)
          } catch (e) {
            pushResult(`Contact not saved: ${e instanceof Error ? e.message : String(e)}`)
          }
          continue
        }

        // fase 5 (§3ter T2-T3, funnel): OFFERTA di connessione — l'agente NON
        // può connettere da solo, crea solo la card col bottone "Connetti";
        // quando l'utente connette, arriverà un messaggio di sistema
        // (meta.initiator CONNECTOR_CONNECTED) per proseguire
        if (call.name === 'offer_connector') {
          // fase 13: search_connectors mostra gli id come 'catalog:<id>' — si accetta anche quello
          const wanted = String(input.id ?? '').replace(/^catalog:/, '')
          const entry2 = (await import('../connectors')).loadCatalog().find((c) => c.id === wanted)
          if (!entry2) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: `Connector "${String(input.id ?? '')}" does not exist: find the right one with search_connectors.`
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
            content: `offer shown to the user: connecting ${entry2.name} happens ONLY from their click on the Connect button. When the user connects you will receive a system message and will be able to use the mcp__${entry2.id}__* tools.`
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
              content: 'Invalid proposal: kind ("allow" or "block") and the rule text in natural language are required.'
            })
            continue
          }
          const message: SendMessagePayload = { type: 'rule', kind, text, ...(input.why !== undefined ? { why: String(input.why) } : {}) }
          appendSend(agentId, call, message, emit, {}, opts.taskId)
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: 'Proposal shown to the user: the rule will be saved only if they accept it from the card (Settings → Automatic approval).'
          })
          continue
        }

        // fase 12 (punto 3): la CONSEGNA del figlio — chiude il sottoagente
        // (status, summary, report_path) e passa al controllo del lotto (punto
        // 5). Il turno del figlio termina lì, come pass
        if (call.name === 'wake_parent') {
          const wakeEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: 'wake_parent',
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [wakeEntry] })
          if (!opts.subagent) {
            const msg = 'wake_parent is only valid inside a subagent: here you are the parent, the result arrives with the batch message.'
            messages.push({ role: 'tool', toolCallId: call.id, content: msg })
            const res = add({ agentId, kind: 'tool-result', role: 'system', content: msg, meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            continue
          }
          const status = input.status === 'failed' ? 'failed' : 'done'
          const summary = String(input.summary ?? '').slice(0, WAKE_SUMMARY_MAX_CHARS)
          // il report va nella home CONDIVISA: il path si valida come write-file
          // (confini della home; fuori → il report non si registra)
          let reportPath: string | null = null
          if (input.report_path !== undefined && String(input.report_path).trim()) {
            const { validBoxPathOf } = await import('../sandbox')
            reportPath = validBoxPathOf(agentId, String(input.report_path)) ? String(input.report_path) : null
          }
          const closed = closeSubagent(db(), opts.subagent.id, {
            status,
            ...(summary.trim() ? { summary } : {}),
            ...(reportPath ? { report_path: reportPath } : {}),
            contaminated,
            finishedAt: Date.now()
          })
          if (closed) onSubagentTerminal(db(), opts.subagent.id, emit)
          const okMsg = WAKE_PARENT_RESULT
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: okMsg, meta: { callId: call.id } })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: okMsg })
          wakeDone = true
          finished = true
          break
        }

        // fase 12 (punto 2): i tool del PADRE — lancio, controllo, messaggio e
        // stop dei figli. Non nei turni di gruppo (lì si coordina col gruppo)
        // e non nei figli (niente annidamento: la whitelist li ha già tolti,
        // qui la doppia rete di sicurezza)
        if (call.name === 'spawn_subagent' || call.name === 'check_subagent' || call.name === 'message_subagent' || call.name === 'stop_subagent') {
          const subEntry = add({
            agentId, kind: 'tool-call', role: 'assistant', content: call.name,
            meta: { id: call.id, name: call.name, arguments: call.arguments }
          })
          emit({ type: 'entries', agentId, entries: [subEntry] })
          const result = await runSubagentTool(agentId, call, input, {
            emit,
            inGroupTurn: opts.groupTurn !== undefined,
            inSubagent: opts.subagent !== undefined,
            parentTaskId: opts.taskId,
            untrustedTurn,
            automatic,
            // il tetto conta le spawn già passate di qui nel turno (compresa questa)
            spawnsInTurn: executedCalls.filter((c) => c.name === 'spawn_subagent').length,
            batchIdOf: () => {
              if (!turnBatchId) turnBatchId = newSubagentBatchId()
              return turnBatchId
            }
          })
          // card nella chat del padre (entry send-message type subagent) quando
          // la spawn riesce; nel turno di un task va nel sotto-transcript
          if (result.card) appendSend(agentId, call, result.card, emit, {}, opts.taskId)
          if (result.changed) subagentsChanged(agentId, emit)
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: result.output, meta: { callId: call.id } })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: result.output })
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
              content: 'Task not created: title and brief are required (goal and full context: the task does NOT see this conversation).'
            })
            continue
          }
          // correzione B2: niente task dentro un task — senza limite un modello
          // apre catene annidate che girano all'infinito
          if (opts.taskId !== undefined) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: 'You cannot open a task from inside another task: you are already in a task, do the work here (close it with update_task when done).'
            })
            continue
          }
          // correzione B2: al massimo 5 task aperti (working o needs_input)
          if (openTasksOf(agentId) >= MAX_OPEN_TASKS) {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: `You cannot open more tasks: there are already ${MAX_OPEN_TASKS} open tasks (running or awaiting an answer). Close some with update_task or talk to the user.`
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
            content: `Task "${title}" created (id ${task.id}): it starts at the end of this turn (same queue, serially). The task does not see this conversation: the context is in the brief. Close it with update_task({id: ${task.id}, status: 'done' | 'failed', summary}) when you are done.`
          })
          continue
        }

        // fase 7 (§3bis L8): messaggio a un ALTRO bot — accodato come job
        // user-message con initiator AGENT; il destinatario lo riceverà come
        // blocco evidenza <messaggio_da_agente> e potrà rispondere al mittente
        if (call.name === 'send_to_agent') {
          const toId = String(input.agentId ?? '')
          // fase 12 (punto 1): un id di FIGLIO non è un destinatario (non è un
          // bot: è un sottoagente del padre che lo ha lanciato)
          const childRefusal = subagentRefusal(toId)
          if (childRefusal) {
            messages.push({ role: 'tool', toolCallId: call.id, content: childRefusal })
            continue
          }
          const dest = listAgents().find((a) => a.id === toId)
          if (!dest) {
            messages.push({ role: 'tool', toolCallId: call.id, content: `Recipient not found ("${toId}"): find the exact id with list_agents.` })
            continue
          }
          if (toId === agentId) {
            messages.push({ role: 'tool', toolCallId: call.id, content: 'You cannot send a message to yourself: talk to the user or delegate to another bot.' })
            continue
          }
          const text = String(input.text ?? '')
          if (!text.trim()) {
            messages.push({ role: 'tool', toolCallId: call.id, content: 'Missing text: write the message for the other bot in the text field.' })
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
              content: `Queue full for ${dest.name} (${MAX_USER_MESSAGE_QUEUE} messages already waiting): message NOT queued. Try again later or summarize everything in a single message.`
            })
            continue
          }
          // fase 11 (punto 2): il turno è CONTAMINATO da contenuti web → anche
          // la delega a un altro bot torna all'utente: è un canale verso
          // l'esterno e una pagina iniettata non deve poter usarlo
          if (contaminated) {
            const approval: Approval = {
              id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now()
            }
            run.approvals.set(approval.id, () => undefined)
            const delegationUi = ui(UI.cardUntrustedDelegation, { name: dest.name })
            const approvalEntry = add({
              agentId, kind: 'approval', role: 'system',
              content: formatUi(delegationUi, loopUiLanguage()),
              meta: {
                approvalId: approval.id, tool: call.name, input, status: 'pending', ui: delegationUi,
                contaminated: true, keys: [`delega a ${dest.name}`]
              }
            })
            setStatus(agentId, 'paused-for-approval', emit)
            emit({ type: 'entries', agentId, entries: [approvalEntry] })
            emit({ type: 'approval', agentId, approval })
            emitNeedsInput(agentId, approvalEntry, formatUi(ui(UI.cardUntrustedDelegationPreview, { name: dest.name }), loopUiLanguage()), emit)
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
            taskWorking()
            if (decision !== 'allow') {
              messages.push({
                role: 'tool', toolCallId: call.id,
                content: decision === 'deny'
                  ? 'Delegation denied by the user (untrusted web content in the turn): do not send this message to other bots.'
                  : 'Approval expired or interrupted: the delegation did not start.'
              })
              const res = add({ agentId, kind: 'tool-result', role: 'system', content: 'Delegation not started', meta: { callId: call.id } })
              emit({ type: 'entries', agentId, entries: [res] })
              setStatus(agentId, 'thinking', emit)
              continue
            }
            setStatus(agentId, 'thinking', emit)
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
            content: `Message queued for ${dest.name}: it will enter their next turn (hop ${guard.hop} of ${AGENT_HOP_MAX}). They do not see this conversation: if context is needed, put it in the message.`
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
            result = 'Missing group: inside a group turn it is implicit; outside you need groupId (your groups are in list_agents).'
          } else if (opts.groupTurn?.closing) {
            // correzione C2: nel turno di chiusura non si pubblica più nel
            // gruppo — resta solo il riepilogo all'utente (o pass)
            result = 'The round is closed: now only the summary to the user (send_to_user). If you already sent it, close with pass.'
          } else if (!opts.groupTurn && !isGroupMember(gid, agentId)) {
            result = `You are not a member of the group "${g.name}": only members write in the group.`
          } else if (!text) {
            result = 'Missing text: write the message in the text field.'
          } else if (groupPosted) {
            result = 'You have already written in the group in this turn: at most one message per turn. Merge the content or wait for the next round.'
          } else {
            const replyTo = input.replyTo !== undefined && input.replyTo !== null ? Number(input.replyTo) : null
            if (replyTo !== null && !getGroupMessage(replyTo)) {
              result = `The message ${replyTo} you are replying to does not exist in this group.`
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
              result = `Published in the group "${g.name}": "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}". The other members will receive it in their turn (those not called may stay silent).`
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
            ? 'Silence registered: your turn in the group ends here.'
            : 'pass is only valid inside group turns: outside you can simply write nothing.'
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
            content: `Turn limit reached: at most ${MAX_CREATE_AGENTS_PER_TURN} create_agent per turn. Continue with the group you have.`
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
        // Fase 11 (punto 2): anche nei turni CONTAMINATI da contenuti web.
        // Inverso: update_agent dei PROPRI bot e update_group del gruppo CREATO
        // bypassano il gate (per gli altri valgono le regole → card)
        const forcedOriginAsk =
          (call.name === 'create_agent' || call.name === 'create_group') && (automatic || untrustedTurn || contaminated)
        const ownTarget = call.name === 'update_agent'
          ? getAgent(String(input.agentId ?? ''))
          : null
        const ownGroup = call.name === 'update_group' ? getGroup(Number(input.groupId)) : null
        let verdict: import('./permissions').Verdict
        if (forcedOriginAsk) {
          verdict = {
            kind: 'ask',
            reason: `${call.name}: the turn is not the user's — creating bots or groups requires their approval`,
            ui: ui(UI.approvalForcedOrigin)
          }
        } else if (ownTarget && ownTarget.createdBy === agentId) {
          verdict = { kind: 'allow', via: 'rule' }
        } else if (ownGroup && ownGroup.created_by === agentId) {
          verdict = { kind: 'allow', via: 'rule' }
        } else {
          // M3 (fase 0.3.1001): il turno è aperto da un messaggio diretto
          // dell'utente? (niente initiator, non automatico, non contaminato —
          // il criterio dei turni fidati) — serve a update_state create
          // activate:true, che solo qui può nascere attiva con una card
          const userDirectTurn =
            source === 'user' && opts.initiator === undefined && !automatic && !untrustedTurn && !contaminated
          verdict = await permissions.check(call.name, input, agentId, {
            ...(userDirectTurn ? { userDirectTurn: true } : {})
          })
        }
        // F8: nel turno contaminato un allow (regola dell'utente o bypass del
        // proprio target) dei tool con effetti torna a chiedere — contenuto
        // non fidato + strumento con effetti non passano insieme. Le regole
        // blocked continuano a negare: il check è già stato eseguito sopra.
        verdict = liftContaminatedAllow(verdict, call.name, contaminated)

        if (verdict.kind === 'deny') {
          const denied = add({
            ...uiSystemEntry(agentId, 'notice', ui(UI.deniedByPermissions, { tool: call.name })),
            meta: { ui: ui(UI.deniedByPermissions, { tool: call.name }), callId: call.id, denied: true }
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
            // (il revisore giudicherebbe testo non dell'utente); fase 11: nemmeno
            // le azioni con effetti di un turno CONTAMINATO da contenuti web
            const action: AutoReviewAction = {
              tool: call.name, args: input, neverAuto: neverAutoCmd || forcedOriginAsk, untrustedTurn,
              ...(contaminated ? { contaminated: true } : {})
            }
            const review = await reviewWithConfiguredModel(action, userLang)
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
            const reasonText = verdictReasonText(verdict)
            const approvalEntry = add({
              agentId, kind: 'approval', role: 'system',
              content: `${call.name}: ${reasonText}`,
              meta: {
                tool: call.name, input, status: 'allowed', keys: verdict.keys,
                ...(verdictUiOf(verdict) ? { ui: verdictUiOf(verdict)! } : {}),
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
            const reasonText = verdictReasonText(verdict)
            const approvalEntry = add({
              agentId, kind: 'approval', role: 'system',
              content: `${call.name}: ${reasonText}`,
              // C4: la card mostra i nomi dei segreti usati dal comando.
              // Fase 17c (C2): meta.ui (id+valori) per la lingua dell'interfaccia
              meta: {
                approvalId: approval.id, tool: call.name, input, status: 'pending', keys: verdict.keys,
                ...(verdictUiOf(verdict) ? { ui: verdictUiOf(verdict)! } : {}),
                ...(verdict.secretRefs?.length ? { secretRefs: verdict.secretRefs } : {}),
                ...(verdict.mcpServerRead ? { mcpServerRead: verdict.mcpServerRead } : {}),
                ...(neverAutoCmd ? { neverAuto: true } : {})
              }
            })
            setStatus(agentId, 'paused-for-approval', emit)
            emit({ type: 'entries', agentId, entries: [approvalEntry] })
            emit({ type: 'approval', agentId, approval })
            // fase 6 (§3bis L9): l'agente è fermo su un'approval → notifica
            emitNeedsInput(agentId, approvalEntry, `${call.name}: ${reasonText}`, emit)
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
              messages.push({ role: 'tool', toolCallId: call.id, content: 'Interrupted by the user.' })
              const res = add({ agentId, kind: 'tool-result', role: 'system', content: 'Interrupted by the user', meta: { callId: call.id } })
              emit({ type: 'entries', agentId, entries: [res] })
              break
            }
            if (decision === 'superseded') {
              // fase 3: un nuovo messaggio utente ha sostituito il turno
              messages.push({ role: 'tool', toolCallId: call.id, content: 'Superseded by a new user message.' })
              const res = add({ agentId, kind: 'tool-result', role: 'system', content: 'Superseded by a new user message', meta: { callId: call.id } })
              emit({ type: 'entries', agentId, entries: [res] })
              break
            }
            if (decision === 'timeout') {
              add({ ...uiSystemEntry(agentId, 'notice', ui(UI.approvalExpired)) })
              emitLastEntry(agentId, emit)
            }
            if (decision !== 'allow') {
              messages.push({
                role: 'tool', toolCallId: call.id,
                content: decision === 'deny' ? 'Denied by user: action refused.' : 'Approval expired.'
              })
              const res = add({ agentId, kind: 'tool-result', role: 'system', content: 'Refused by the user', meta: { callId: call.id } })
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

        // fase 13 (punto 5): in modalità differita un tool MCP NON attivo non si
        // esegue — niente esecuzione cieca di un nome indovinato: il result
        // dice di cercarlo con find_tools
        if (deferredMcp && call.name.startsWith('mcp__') && !activeMcpNames.has(call.name)) {
          const refused = 'tool not active: find it with find_tools({query}) and call it from the next step'
          messages.push({ role: 'tool', toolCallId: call.id, content: refused })
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: refused, meta: { callId: call.id, inactive: true } })
          emit({ type: 'entries', agentId, entries: [res] })
          continue
        }

        // fase 18b (H4): la riserva ha portato il turno su un modello con
        // visione conosciuta FALSA a metà turno — use-app è RESTATO nella
        // lista (non si cambia la lista a metà turno), ma la chiamata non si
        // esegue: il modello non può vedere lo screenshot che riceverebbe.
        // fase 19a (V7): computer_observe e computer_act restituiscono lo
        // screenshot dello schermo del BOT: stessa regola, stesso messaggio
        if (
          (call.name === 'use-app' || call.name === 'computer_observe' || call.name === 'computer_act') &&
          modelCapabilities(activeProvider, activeRoute.model).vision === false
        ) {
          const refused = `${call.name} needs a vision model; the current model cannot see images`
          messages.push({ role: 'tool', toolCallId: call.id, content: refused })
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: refused, meta: { callId: call.id, error: true } })
          emit({ type: 'entries', agentId, entries: [res] })
          continue
        }

        // esecuzione
        try {
          // correzione A5: il contesto del turno (chi lo ha aperto) serve a
          // update_state per decidere se accettare la provenance 'template';
          // correzione B3: il task corrente serve a update_task (dentro un
          // task si chiude SOLO quello); fase 14 (punto 6): contaminato e
          // turno utente servono alle scritture in libreria (tainted)
          const { output, meta, images } = await executeTool(agentId, call.name, input, {
            turnInitiator: opts.initiator,
            ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
            ...(contaminated ? { contaminated: true } : {}),
            ...(source === 'user' && !automatic && !untrustedTurn ? { userTurn: true } : {}),
            // M3: activate on update_state create only in the user's direct turn
            ...(source === 'user' && opts.initiator === undefined && !automatic && !untrustedTurn && !contaminated
              ? { routineActivateOk: true }
              : {})
          })
          // fase 13 (punto 8): OGNI result MCP è un DATO ESTERNO (email, pagine
          // Notion, issue): blocco evidenza con la fonte mcp:<server> e
          // CONTAMINAZIONE del turno, con le stesse conseguenze di web_fetch
          // (le regole "consenti" tornano a chiedere, l'auto-review non
          // approva le azioni con effetti). Nessuna eccezione in questa fase.
          let finalOutput = output
          if (call.name.startsWith('mcp__')) {
            const serverSlug = call.name.split('__')[1] ?? 'server'
            finalOutput = formatExternalDataEvidence(`mcp:${serverSlug}`, output)
            if (!contaminated) {
              run.turnAllows.clear()
              run.turnGrantEpoch++
            }
            contaminated = true
          }
          // fase 14 (punto 6): la lettura di una voce tainted della libreria è
          // un DATO ESTERNO (fonte libreria:<id>) e contamina il turno che
          // legge — un'istruzione iniettata in una pagina, copiata in un
          // report, non diventa "fidata" quando un altro bot legge il report
          if (meta.libraryTainted) {
            const source14 = meta.libraryTainted === 'list' ? 'search_connectors' : `libreria:${meta.libraryTainted}`
            finalOutput = formatExternalDataEvidence(String(source14), finalOutput)
            if (!contaminated) {
              run.turnAllows.clear()
              run.turnGrantEpoch++
            }
            contaminated = true
          }
          // fase 14 (7d-5): OGNI result del bot passa dalla redazione dei
          // valori compilati da fill_credential (snapshot e testo di pagina
          // li redige già browser.ts: qui copre comandi, web e MCP)
          {
            const browserMod = await import('./browser')
            finalOutput = browserMod.redactBrowserSecrets(agentId, finalOutput)
          }
          const res = add({
            agentId, kind: 'tool-result', role: 'system',
            content: finalOutput.slice(0, 50_000),
            meta: { callId: call.id, ...meta, ...(call.name.startsWith('mcp__') ? { webEvidence: true, mcpEvidence: true } : {}) }
          })
          emit({ type: 'entries', agentId, entries: [res] })
          // fase 14 (punti 2-3): la card del documento/grafico salvato in
          // libreria — stessa destinazione dei messaggi del turno, col bottone
          // Apri; il documento NON si incolla in chat
          if (meta.libraryCard) {
            appendSend(agentId, call, meta.libraryCard as SendMessagePayload, emit, {}, opts.taskId)
          }
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
            const a = meta.automation as { action?: unknown; id?: unknown; name?: unknown; active?: unknown }
            const autoUi = automationEventText(String(a.action ?? ''), String(a.name ?? ''), {
              ...(a.active === true ? { active: true } : {})
            })
            add({
              agentId, kind: 'event', role: 'system',
              content: formatUi(autoUi, loopUiLanguage()),
              meta: { automation: a, ui: autoUi }
            })
            emitLastEntry(agentId, emit)
          }
          // fase 10: il gruppo è cambiato (creato, membri, descrizione) — la
          // sidebar e la vista gruppo si aggiornano
          if (meta.groupChanged) emit({ type: 'groups' })
          // run-command restituisce output GIÀ redatto (§5.6): stesso testo al modello e al transcript
          messages.push({ role: 'tool', toolCallId: call.id, content: finalOutput.slice(0, 50_000) })
          // immagini (computer use): le inietta come messaggio vision — il formato
          // "immagine dentro il tool result" non è supportato ovunque, un user message sì
          if (images?.length) {
            messages.push({
              role: 'user',
              content: '[screenshot] Here is the screenshot requested by the use-app tool (the coordinates you want to click are in pixels of THIS image):',
              images
            })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const res = add({ agentId, kind: 'tool-result', role: 'system', content: `Error: ${msg}`, meta: { callId: call.id, error: true } })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: `Error: ${msg}` })
        }
      }
      if (paused && messages[messages.length - 1]?.role === 'tool') {
        // dopo un rifiuto il modello può decidere come proseguire: continua il loop
      }
      // correzione C1: pass ha chiuso il turno di gruppo (niente altre chiamate).
      // fase 12: anche wake_parent chiude il turno del FIGLIO lì
      if (awaitingUser || passedSilence || wakeDone || controller.signal.aborted) break
    }

    // ---- fase 12 (punto 3): la chiusura robusta del FIGLIO ----
    // Il turno del figlio è finito senza wake_parent (anche per MAX_STEPS o
    // risposta vuota): UNA chiamata di recupero col sollecito (solo wake_parent),
    // poi chiusura automatica — done col testo libero se c'è, failed se è vuoto.
    // Turno abortito (stop/scadenza): la riga è già terminale, qui non si tocca
    if (opts.subagent && !wakeDone && !controller.signal.aborted) {
      const decision = subagentClosure({ wakeCalled: false, nudged: subagentNudged, freeText: lastFreeText, modelError: false })
      if (decision.kind === 'nudge') {
        subagentNudged = true
        add({ ...uiSystemEntry(agentId, 'notice', ui(UI.wakeNudge)) })
        emitLastEntry(agentId, emit)
        messages.push({ role: 'user', content: SUBAGENT_RECOVERY_NUDGE })
        setStatus(agentId, 'thinking', emit)
        try {
          const rstream = llmStream(activeProvider, activeRoute.model, messages, [wakeParentToolDef], controller.signal, {
            thinking: turnThinking,
            modelPrices
          })
          let racc = ''
          let recoveryCalls: ToolCall[] = []
          let rusage: import('./llm').LlmChunk['usage'] | undefined
          const rit = rstream[Symbol.asyncIterator]()
          let rfirst = false
          for (;;) {
            const r = await nextWithDeadline(rit, rfirst, deadlines)
            if (r.done) break
            const ch = r.value
            rfirst = true
            if (ch.textDelta) racc += ch.textDelta
            if (ch.toolCalls) recoveryCalls = ch.toolCalls
            if (ch.usage) rusage = ch.usage
          }
          // fase 18a (E4): uso registrato del sollecito di chiusura del figlio
          if (rusage) {
            recordModelUsage({
              agentId,
              providerId: activeProvider.id,
              providerKind: activeProvider.kind,
              model: activeRoute.model,
              source: 'wake',
              input: rusage.input,
              output: rusage.output,
              cacheRead: rusage.cacheRead ?? 0,
              cacheWrite: rusage.cacheWrite ?? 0,
              costUsd: rusage.costUsd ?? null
            })
          }
          if (racc.trim()) lastFreeText = racc
          const wake = recoveryCalls.find((c) => c.name === 'wake_parent')
          if (wake) {
            let winput: Record<string, unknown>
            try { winput = JSON.parse(wake.arguments || '{}') } catch { winput = {} }
            const closed = closeSubagent(db(), opts.subagent.id, {
              status: winput.status === 'failed' ? 'failed' : 'done',
              summary: String(winput.summary ?? '').slice(0, WAKE_SUMMARY_MAX_CHARS) || autoCloseSummary(lastFreeText),
              finishedAt: Date.now()
            })
            if (closed) onSubagentTerminal(db(), opts.subagent.id, emit)
            wakeDone = true
          }
        } catch {
          // la chiamata di recupero stessa fallisce: chiusura automatica sotto
        }
      }
      if (!wakeDone) {
        const final2 = subagentClosure({ wakeCalled: false, nudged: subagentNudged, freeText: lastFreeText, modelError: false })
        if (final2.kind === 'auto-done' || final2.kind === 'auto-failed') {
          const closed = closeSubagent(db(), opts.subagent.id, {
            status: final2.kind === 'auto-done' ? 'done' : 'failed',
            summary: autoCloseSummary(lastFreeText),
            finishedAt: Date.now()
          })
          if (closed) onSubagentTerminal(db(), opts.subagent.id, emit)
        }
      }
    }

    // ---- fase 3: chiusura del turno con esito ----
    if (awaitingUser) {
      endTurn(agentId, 'AWAITING_USER', emit, opts.taskId)
    } else if (controller.signal.aborted) {
      endTurn(agentId, run.superseded ? 'SUPERSEDED' : 'STOPPED', emit, opts.taskId, 'interrupt')
    } else if (!finished) {
      // fase 12: nel figlio la notice non serve (la chiusura robusta ha già
      // scritto cosa è successo: sollecito o chiusura automatica)
      if (!opts.subagent) {
        add({ ...uiSystemEntry(agentId, 'notice', ui(UI.stepsLimit)) })
        emitLastEntry(agentId, emit)
      }
      endTurn(agentId, 'STOPPED', emit, opts.taskId, 'loop')
    } else {
      // turno FINISHED: se l'UTENTE non ha visto nulla (nessuna send-message nel
      // turno) una chiamata di recupero chiede al modello send_to_user; se non
      // lo fa nemmeno ora, il testo libero diventa send-message con fallback.
      // Fase 8: nel contesto di un task valgono le SOLE entry del task.
      // Fase 10 (§3): nei turni di GRUPPO niente recupero — il silenzio è un
      // esito valido (PASS) e il testo libero non diventa mai un messaggio
      if (source === 'user' && opts.groupTurn === undefined && opts.subagent === undefined && visibleReplyEntries(scopedEntries(), turnEntryId).length === 0) {
        messages.push({ role: 'user', content: RECOVERY_NUDGE })
        setStatus(agentId, 'thinking', emit)
        try {
          const rstream = llmStream(activeProvider, activeRoute.model, messages, allTools, controller.signal, {
            thinking: turnThinking,
            modelPrices
          })
          let acc = ''
          let recoveryCalls: ToolCall[] = []
          let rusage: import('./llm').LlmChunk['usage'] | undefined
          const rit = rstream[Symbol.asyncIterator]()
          let rfirst = false
          for (;;) {
            const r = await nextWithDeadline(rit, rfirst, deadlines)
            if (r.done) break
            const ch = r.value
            rfirst = true
            if (ch.textDelta) acc += ch.textDelta
            if (ch.toolCalls) recoveryCalls = ch.toolCalls
            if (ch.usage) rusage = ch.usage
          }
          // fase 18a (E4): uso registrato della chiamata di recupero del turno
          if (rusage) {
            recordModelUsage({
              agentId,
              providerId: activeProvider.id,
              providerKind: activeProvider.kind,
              model: activeRoute.model,
              source: 'turn',
              input: rusage.input,
              output: rusage.output,
              cacheRead: rusage.cacheRead ?? 0,
              cacheWrite: rusage.cacheWrite ?? 0,
              costUsd: rusage.costUsd ?? null
            })
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
    // correzione J2: il lotto di questo turno si SIGILLA alla fine del turno,
    // con QUALUNQUE esito (FINISHED, STOPPED, AWAITING_USER, SUPERSEDED,
    // errore): il padre non lancerà altro qui. Subito dopo il controllo — se
    // i figli erano già tutti finiti, il risveglio parte da qui, non dalla
    // prima consegna arrivata a metà turno
    if (turnBatchId) sealTurnBatch(db(), turnBatchId, emit)
    running.delete(agentId)
    // M5: consegne rimaste indietro (il turno è finito prima del confine di
    // passo) — si buttano via QUI: i job corrispondenti restano in coda e i
    // messaggi partiranno come turni nuovi (gara), senza doppioni
    midTurnDeliveries.delete(agentId)
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
  // fase 14: anche le card send-message (fill, modulo sicuro, contatto)
  // registrano approvalId
  const entry = getEntries(agentId).findLast(
    (e: import('../../shared/types').TranscriptEntry) =>
      (e.kind === 'approval' || e.kind === 'send-message') && e.meta?.approvalId === approvalId
  )
  if (decision === 'allow' && mode === 'always') {
    // fase 14 (7d-3): "Sempre per questo sito" della card fill crea la
    // concessione (loginId, origin) — MAI una concessione generica del tool
    const fill = entry?.meta?.fill as { loginId: string; origin: string } | undefined
    if (fill) {
      // fase 14 (7d-3): concessione (loginId, origin) — mai generica
      addGrant('fill_credential', `${fill.loginId}|${fill.origin}`)
    } else if (entry) {
      // registra standing grant per il tool+target dell'approval in sospeso
      void permissions.grantStanding(String(entry.meta?.tool), entry.meta?.input as Record<string, unknown>)
    }
  }
  if (decision === 'allow' && mode === 'turn' && entry) {
    // la chiave è registrata appena l'analisi shell è pronta; il prossimo
    // ramo ask attende la promise prima di controllare (niente race).
    // F8: se nel frattempo la contaminazione revoca i grant (epoca cambiata),
    // la registrazione non avviene
    const epoch = run.turnGrantEpoch
    run.pendingTurnGrant = turnGrantKey(String(entry.meta?.tool), entry.meta?.input as Record<string, unknown>)
      .then((key) => {
        if (key && run.turnGrantEpoch === epoch) run.turnAllows.add(key)
      })
      .catch(() => undefined)
  }
  cb(decision)
}
