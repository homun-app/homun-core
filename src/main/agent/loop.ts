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
// routine; se runTurn viene chiamato su un agente occupato (invariante violato)
// il turno viene scartato con una notice, mai sovrascritto.
import { randomUUID } from 'node:crypto'
import { getAgent, getEntries, updateAgent, appendEntry, updateEntryContent, updateEntryMeta, getSetting } from '../store/db'
import { llmStream, type ChatMessage, type ToolCall } from './llm'
import { systemPrompt } from './prompts'
import { toolDefs, executeTool } from './tools'
import * as permissions from './permissions'
import { getProvider } from './providers'
import { buildMessages } from './history'
import { planResume, INTERRUPTED_TOOL_RESULT, RESUME_NOTICE } from './resume'
import type { Approval, SandbotEvent } from '../../shared/types'

// §5.3: buildMessages vive in history.ts (modulo puro, testabile senza Electron)
export { buildMessages } from './history'

const MAX_STEPS = 24

type Emitter = (e: SandbotEvent) => void

interface Running {
  controller: AbortController
  approvals: Map<string, (decision: 'allow' | 'deny') => void>
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

  try {
    if (opts.resume) {
      // R1: ripresa dal transcript — il messaggio utente NON viene riscritto;
      // il turno interrotto viene riparato PRIMA di chiamare il modello
      const plan = planResume(getEntries(agentId), opts.resume.entryId)
      if (plan.alreadyComplete) {
        // il turno era già concluso: completa senza chiamare il modello
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
      const entry = appendEntry({ agentId, kind: 'message', role: 'user', content: userText, meta: images?.length ? { images: images.length } : undefined })
      emitLastEntry(agentId, emit)
      // R1: l'id dell'entry che apre il turno finisce nel payload del job,
      // PRIMA di chiamare il modello, per poter riprendere dopo un crash
      opts.onTurnEntry?.(entry.id)
    }

    // §5.3: il messaggio corrente è l'ultimo entry del transcript → compare una volta sola
    const messages: ChatMessage[] = buildMessages(systemPrompt(agent), getEntries(agentId), images)

    // tool statici + tool MCP attivi (server esterni → mcp__<server>__<tool>)
    const { toolDefs } = await import('./tools')
    let allTools = toolDefs
    try {
      const { activeTools } = await import('../mcp')
      allTools = [...toolDefs, ...(await activeTools())]
    } catch {
      // MCP non disponibile: prosegue coi tool base
    }

    setStatus(agentId, 'thinking', emit)

    for (let step = 0; step < MAX_STEPS; step++) {
      if (controller.signal.aborted) break
      const stream = llmStream(provider, agent.model, messages, allTools, controller.signal)
      const entry = appendEntry({ agentId, kind: 'message', role: 'assistant', content: '' })
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
        setStatus(agentId, 'idle', emit)
        return
      }
      const text = final.text
      updateEntryContent(entry.id, text)

      if (!text && !final.toolCalls?.length) {
        appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Il modello non ha prodotto risposta (vuota).' })
        emitLastEntry(agentId, emit)
        setStatus(agentId, 'idle', emit)
        return
      }

      if (!final.toolCalls?.length) {
        // turno concluso senza tool: fine
        setStatus(agentId, 'idle', emit)
        updateAgent(agentId, { unread: 0 })
        emit({ type: 'agents' })
        return
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

          const decision = await new Promise<'allow' | 'deny' | 'timeout'>((resolve) => {
            run.approvals.set(approval.id, (d) => resolve(d))
            setTimeout(() => resolve('timeout'), getSetting<number>('permissions.timeoutMs', 5 * 60_000))
          })
          run.approvals.delete(approval.id)
          updateEntryMeta(approvalEntry.id, {
            ...approvalEntry.meta,
            status: decision === 'timeout' ? 'expired' : decision === 'allow' ? 'allowed' : 'denied'
          })
          const updatedApproval = getEntries(agentId).find((x: import('../../shared/types').TranscriptEntry) => x.id === approvalEntry.id)
          if (updatedApproval) emit({ type: 'entries', agentId, entries: [updatedApproval] })
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
    }

    // MAX_STEPS raggiunto
    appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Turno interrotto: limite di passi raggiunto.' })
    emitLastEntry(agentId, emit)
    setStatus(agentId, 'idle', emit)
  } finally {
    running.delete(agentId)
    if (getAgent(agentId)?.status !== 'offline') setStatus(agentId, 'idle', emit)
    emit({ type: 'agents' })
  }
}

export function interrupt(agentId: string): void {
  running.get(agentId)?.controller.abort()
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
