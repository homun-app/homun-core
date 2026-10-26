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
import { getAgent, listAgents, listRoutines, getEntries, updateAgent, appendEntry, updateEntryContent, updateEntryMeta, getSetting, holdOutboxEntry, db } from '../store/db'
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

/** Chiude il turno con un evento meta.turnEnd (§3bis L2: esito del turno nel transcript). */
function endTurn(agentId: string, outcome: TurnEnd, emit: Emitter): void {
  appendEntry({ agentId, kind: 'event', role: 'system', content: TURN_END_LABELS[outcome], meta: { turnEnd: outcome } })
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
  extra: Record<string, unknown> = {}
): import('../../shared/types').TranscriptEntry {
  const content = message.type === 'text' ? message.text
    : message.type === 'widget' ? message.prompt
    : message.type === 'connector' ? (message.reason || message.name)
    : (message.subject || message.to || '')
  const entry = appendEntry({
    agentId, kind: 'send-message', role: 'assistant', content,
    meta: { call: { id: call.id, name: call.name, arguments: call.arguments }, message, ...extra }
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
  /** Fase 7: meta extra del messaggio che apre il turno (es. templateName per TEMPLATE_IMPORT). */
  extraMeta?: Record<string, unknown>
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
    appendEntry({ agentId, kind: 'notice', role: 'system', content: "Configura prima un provider e un modello nelle impostazioni dell'agente." })
    emitLastEntry(agentId, emit)
    return
  }
  const provider = getProvider(agent.providerId)
  if (!provider) throw new Error('Provider non trovato')

  const controller = new AbortController()
  const run: Running = { controller, approvals: new Map() }
  running.set(agentId, run)

  // id dell'entry che apre il turno: serve a decidere se l'utente ha VISTO qualcosa
  let turnEntryId = 0
  // ultimo testo libero non vuoto del modello nel turno (ripiego del fallback)
  let lastFreeText = ''
  // fase 7 (residuo 0b): nei turni automatici al massimo UN urgent per esecuzione
  let urgentUsed = false

  try {
    if (opts.resume) {
      // R1: ripresa dal transcript — il messaggio utente NON viene riscritto;
      // il turno interrotto viene riparato PRIMA di chiamare il modello
      turnEntryId = opts.resume.entryId
      const plan = planResume(getEntries(agentId), opts.resume.entryId)
      if (plan.alreadyComplete) {
        // il turno era già concluso: completa senza chiamare il modello
        // (l'evento di fine c'è già, a meno che il crash non precedesse la fase 3)
        const alreadyEnded = getEntries(agentId).some(
          (e) => e.id > opts.resume!.entryId && e.kind === 'event' && e.meta?.turnEnd
        )
        if (!alreadyEnded) endTurn(agentId, 'FINISHED', emit)
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
        const res = appendEntry({
          agentId, kind: 'tool-result', role: 'system', content: INTERRUPTED_TOOL_RESULT,
          meta: { callId: String(call.meta?.id ?? call.id) }
        })
        emit({ type: 'entries', agentId, entries: [res] })
      }
      appendEntry({ agentId, kind: 'notice', role: 'system', content: RESUME_NOTICE })
      emitLastEntry(agentId, emit)
    } else {
      const entry = appendEntry({
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
    // taglio a confine di turno già fatto da buildMessages)
    await maybeCompactHistory(
      agentId, provider.id, agent.model,
      (digest) => summarizeWithLlm(provider, agent.model!, digest, secondaryPrompts.compaction),
      emit
    )

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
      getEntries(agentId),
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

    // fase 3 (§3bis L5): quali tool MCP sono invii verso l'esterno
    const externalCfg = getSetting<ExternalSendConfig>('externalSendTools', DEFAULT_EXTERNAL_SEND_TOOLS)

    setStatus(agentId, 'thinking', emit)

    let awaitingUser = false
    let finished = false

    for (let step = 0; step < MAX_STEPS; step++) {
      if (controller.signal.aborted) break
      const stream = llmStream(provider, agent.model, messages, allTools, controller.signal)
      // fase 3: il testo libero è ragionamento interno, non una risposta
      const entry = appendEntry({ agentId, kind: 'thinking', role: 'assistant', content: '' })
      emit({ type: 'entries', agentId, entries: [entry] })

      let acc = ''
      let final: { text: string; toolCalls: ToolCall[]; finishReason: string }
      let finalToolCalls: ToolCall[] = []
      let finalFinish = 'stop'
      try {
        for await (const ch of stream) {
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
        const msg = err instanceof Error ? err.message : String(err)
        updateEntryContent(entry.id, acc)
        appendEntry({ agentId, kind: 'notice', role: 'system', content: `Errore dal modello: ${msg}` })
        emitLastEntry(agentId, emit)
        endTurn(agentId, 'STOPPED', emit)
        setStatus(agentId, 'idle', emit)
        return
      }
      const text = final.text
      updateEntryContent(entry.id, text)
      if (text.trim()) lastFreeText = text

      if (!text && !final.toolCalls?.length) {
        appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Il modello non ha prodotto risposta (vuota).' })
        emitLastEntry(agentId, emit)
        endTurn(agentId, 'STOPPED', emit)
        setStatus(agentId, 'idle', emit)
        return
      }

      if (!final.toolCalls?.length) {
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

        // ---- fase 3 (§3bis L2/L5): comunicazione e invii esterni, gestiti dal loop ----

        // invio esterno chiamato direttamente: MAI eseguito, diventa una bozza
        if (isExternalSend(call.name, externalCfg)) {
          const draft = appendSend(agentId, call, draftFromExternalCall(call.name, input), emit, { status: 'pending' })
          emitNeedsInput(agentId, draft, `bozza in attesa: ${draft.content.slice(0, 80)}`, emit)
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: 'Invio esterno non eseguito: trasformato in una bozza in attesa della conferma dell’utente. Per gli invii usa draft_external.'
          })
          continue
        }

        if (call.name === 'send_to_user') {
          // fase 7 (residuo 0b): alcuni modelli mettono urgent a OGNI
          // send_to_user dei turni automatici, svuotando l'outbox: nei turni
          // di routine il primo urgent passa, i successivi diventano non
          // urgenti (e finiscono trattenuti come gli altri)
          let urgent = input.urgent === true
          if (urgent && source === 'routine') {
            if (urgentUsed) urgent = false
            else urgentUsed = true
          }
          const message: SendMessagePayload = { type: 'text', text: String(input.text ?? ''), ...(urgent ? { urgent: true } : {}) }
          // fase 6 (§3bis L4): i messaggi NON urgenti dei turni automatici
          // (routine/trigger) restano in outbox fino alla finestra di consegna
          // o all'apertura della chat; urgent e turni utente passano subito
          const hold = source === 'routine' && !urgent
          const sent = appendSend(agentId, call, message, emit, hold ? { held: true } : {})
          if (hold) holdOutboxEntry(sent.id, agentId, sent.createdAt)
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: hold
              ? 'inviato all’utente: la consegna è rinviata alla prossima finestra di consegna (o a quando apre la chat), salvo urgenza'
              : 'inviato all’utente'
          })
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
          const draft = appendSend(agentId, call, prepared.message, emit, { status: 'pending' })
          emitNeedsInput(agentId, draft, `bozza in attesa: ${draft.content.slice(0, 80)}`, emit)
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: prepared.viaRejected
              ? `bozza creata di solo testo: "via" scartato perché ${prepared.viaRejected} non è un tool di invio esterno configurato (nessun canale di invio collegato).`
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
          const widget = appendSend(agentId, call, message, emit)
          emitNeedsInput(agentId, widget, String(input.prompt ?? ''), emit)
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
          appendSend(agentId, call, message, emit, { status: 'pending' })
          messages.push({
            role: 'tool', toolCallId: call.id,
            content: `offerta mostrata all'utente: la connessione di ${entry2.name} avviene SOLO dal suo click sul bottone Connetti. Quando l'utente connette riceverai un messaggio di sistema e potrai usare i tool mcp__${entry2.id}__*.`
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
          // protezione anti-ciclo: hop del messaggio che ha aperto QUESTO
          // turno + messaggi tra la coppia nell'ultima ora (entrambe le direzioni)
          const incomingHop = opts.agentMessage?.hop ?? 0
          const pairLastHour = countPairMessagesLastHour([...getEntries(agentId), ...getEntries(toId)], agentId, toId, Date.now())
          const guard = agentSendGuard({ incomingHop, pairLastHour })
          if (!guard.ok) {
            messages.push({ role: 'tool', toolCallId: call.id, content: guard.error })
            continue
          }
          const { enqueueJob } = await import('../store/jobs')
          const now = Date.now()
          enqueueJob(db(), {
            agentId: toId,
            kind: 'user-message',
            payload: {
              text: formatAgentMessage(agent.name, text),
              initiator: 'AGENT',
              fromAgentId: agentId,
              fromAgentName: agent.name,
              toAgentId: toId,
              hop: guard.hop
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

        // ---- tool normali: entry tool-call, gate permessi, esecuzione ----

        const callEntry = appendEntry({
          agentId, kind: 'tool-call', role: 'assistant', content: `${call.name}`,
          meta: { id: call.id, name: call.name, arguments: call.arguments }
        })
        emit({ type: 'entries', agentId, entries: [callEntry] })

        // §5.1: il gate run-command analizza OGNI comando della riga (tree-sitter);
        // agentId serve al gate C5 (letture dentro/fuori dalla box in host)
        const verdict = await permissions.check(call.name, input, agentId)

        if (verdict.kind === 'deny') {
          const denied = appendEntry({
            agentId, kind: 'notice', role: 'system',
            content: `Bloccato dai permessi: ${call.name}`, meta: { callId: call.id, denied: true }
          })
          emit({ type: 'entries', agentId, entries: [denied] })
          messages.push({ role: 'tool', toolCallId: call.id, content: 'Command blocked by permissions configuration' })
          continue
        }

        if (verdict.kind === 'ask') {
          // pause-for-approval: crea approval, attende decisione (come l'originale)
          const approval: Approval = {
            id: randomUUID(), agentId, tool: call.name, input, status: 'pending', createdAt: Date.now()
          }
          run.approvals.set(approval.id, () => undefined)
          const approvalEntry = appendEntry({
            agentId, kind: 'approval', role: 'system',
            content: `${call.name}: ${verdict.reason}`,
            // C4: la card mostra i nomi dei segreti usati dal comando
            meta: {
              approvalId: approval.id, tool: call.name, input, status: 'pending', keys: verdict.keys,
              ...(verdict.secretRefs?.length ? { secretRefs: verdict.secretRefs } : {})
            }
          })
          setStatus(agentId, 'paused-for-approval', emit)
          emit({ type: 'entries', agentId, entries: [approvalEntry] })
          emit({ type: 'approval', agentId, approval })
          // fase 6 (§3bis L9): l'agente è fermo su un'approval → notifica
          emitNeedsInput(agentId, approvalEntry, `${call.name}: ${verdict.reason}`, emit)

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
          if (decision === 'cancelled') {
            // fase 4 (0c): interrupt dell'utente — l'approval si chiude subito,
            // niente esecuzione, il turno finirà STOPPED (controller abortito)
            messages.push({ role: 'tool', toolCallId: call.id, content: 'Interrotto dall’utente.' })
            const res = appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'Interrotto dall’utente', meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            break
          }
          if (decision === 'superseded') {
            // fase 3: un nuovo messaggio utente ha sostituito il turno
            messages.push({ role: 'tool', toolCallId: call.id, content: 'Sostituito da un nuovo messaggio dell’utente.' })
            const res = appendEntry({ agentId, kind: 'tool-result', role: 'system', content: 'Sostituito da un nuovo messaggio utente', meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            break
          }
          if (decision === 'timeout') {
            appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Approvazione scaduta.' })
            emitLastEntry(agentId, emit)
          }
          if (decision !== 'allow') {
            messages.push({
              role: 'tool', toolCallId: call.id,
              content: decision === 'deny' ? 'Denied by user: azione rifiutata.' : 'Approval expired.'
            })
            const res = appendEntry({ agentId, kind: 'tool-result', role: 'system', content: "Rifiutato dall'utente", meta: { callId: call.id } })
            emit({ type: 'entries', agentId, entries: [res] })
            setStatus(agentId, 'thinking', emit)
            paused = true
            continue
          }
          // allow: la standing grant la registra il resolver se "always"
          setStatus(agentId, 'thinking', emit)
        }

        // esecuzione
        try {
          const { output, meta, images } = await executeTool(agentId, call.name, input)
          const res = appendEntry({
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
              { status: 'pending', needsAuth: true }
            )
          }
          // fase 4 (§3ter T2/T4): ogni azione su routine produce l'evento
          // "automation-changed" in chat (meta.automation: azione, id, nome)
          if (meta.automation && typeof meta.automation === 'object') {
            const a = meta.automation as { action?: unknown; id?: unknown; name?: unknown }
            appendEntry({
              agentId, kind: 'event', role: 'system',
              content: automationEventText(String(a.action ?? ''), String(a.name ?? '')),
              meta: { automation: a }
            })
            emitLastEntry(agentId, emit)
          }
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
          const res = appendEntry({ agentId, kind: 'tool-result', role: 'system', content: `Errore: ${msg}`, meta: { callId: call.id, error: true } })
          emit({ type: 'entries', agentId, entries: [res] })
          messages.push({ role: 'tool', toolCallId: call.id, content: `Error: ${msg}` })
        }
      }
      if (paused && messages[messages.length - 1]?.role === 'tool') {
        // dopo un rifiuto il modello può decidere come proseguire: continua il loop
      }
      if (awaitingUser || controller.signal.aborted) break
    }

    // ---- fase 3: chiusura del turno con esito ----
    if (awaitingUser) {
      endTurn(agentId, 'AWAITING_USER', emit)
    } else if (controller.signal.aborted) {
      endTurn(agentId, run.superseded ? 'SUPERSEDED' : 'STOPPED', emit)
    } else if (!finished) {
      appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Turno interrotto: limite di passi raggiunto.' })
      emitLastEntry(agentId, emit)
      endTurn(agentId, 'STOPPED', emit)
    } else {
      // turno FINISHED: se l'UTENTE non ha visto nulla (nessuna send-message nel
      // turno) una chiamata di recupero chiede al modello send_to_user; se non
      // lo fa nemmeno ora, il testo libero diventa send-message con fallback
      if (source === 'user' && visibleReplyEntries(getEntries(agentId), turnEntryId).length === 0) {
        messages.push({ role: 'user', content: RECOVERY_NUDGE })
        setStatus(agentId, 'thinking', emit)
        try {
          const stream = llmStream(provider, agent.model, messages, allTools, controller.signal)
          let acc = ''
          let recoveryCalls: ToolCall[] = []
          for await (const ch of stream) {
            if (ch.textDelta) acc += ch.textDelta
            if (ch.toolCalls) recoveryCalls = ch.toolCalls
          }
          const sends = recoveryCalls.filter((c) => c.name === 'send_to_user')
          if (sends.length) {
            for (const call of sends) {
              let input: Record<string, unknown>
              try { input = JSON.parse(call.arguments || '{}') } catch { input = {} }
              const message: SendMessagePayload = { type: 'text', text: String(input.text ?? acc), ...(input.urgent ? { urgent: true } : {}) }
              appendSend(agentId, call, message, emit)
            }
          } else {
            const fallback = (acc.trim() ? acc : lastFreeText).trim()
            if (fallback) {
              appendEntry({
                agentId, kind: 'send-message', role: 'assistant', content: fallback,
                meta: { message: { type: 'text', text: fallback }, fallback: true }
              })
              emitLastEntry(agentId, emit)
            }
          }
        } catch {
          // la chiamata di recupero stessa fallisce: si prova il fallback col testo già avuto
          if (lastFreeText.trim()) {
            appendEntry({
              agentId, kind: 'send-message', role: 'assistant', content: lastFreeText.trim(),
              meta: { message: { type: 'text', text: lastFreeText.trim() }, fallback: true }
            })
            emitLastEntry(agentId, emit)
          }
        }
      }
      endTurn(agentId, 'FINISHED', emit)
      // fase 6 (§3bis L9): agent-done = turno finito con almeno un messaggio
      // visibile (quelli trattenuti in outbox non contano: l'utente non lo
      // ha ancora visto, la notifica arriverà alla consegna... o mai)
      const visible = visibleReplyEntries(getEntries(agentId), turnEntryId).filter((e) => !e.meta?.held)
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

export function resolveApproval(agentId: string, approvalId: string, decision: 'allow' | 'deny', always: boolean): void {
  const run = running.get(agentId)
  const cb = run?.approvals.get(approvalId)
  if (!cb) {
    console.log(`[sandbot] approval ${approvalId.slice(0, 8)} non in attesa (click stantio o già risolta)`)
    return
  }
  if (decision === 'allow' && always) {
    // registra standing grant per il tool+target dell'approval in sospeso
    const entry = getEntries(agentId).findLast((e: import('../../shared/types').TranscriptEntry) => e.kind === 'approval' && e.meta?.approvalId === approvalId)
    if (entry) {
      void permissions.grantStanding(String(entry.meta?.tool), entry.meta?.input as Record<string, unknown>)
    }
  }
  cb(decision)
}
