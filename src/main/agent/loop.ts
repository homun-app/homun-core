// Agent loop: messaggio → LLM streaming → tool-call → permessi → esecuzione → risultato.
// Rispecchia la semantica dei turni dell'originale, con pause-for-approval.
import { randomUUID } from 'node:crypto'
import { getAgent, getEntries, updateAgent, appendEntry, updateEntryContent, updateEntryMeta, getSetting } from '../store/db'
import { llmStream, type ChatMessage, type ToolCall } from './llm'
import { systemPrompt } from './prompts'
import { toolDefs, executeTool } from './tools'
import * as permissions from './permissions'
import { getProvider } from './providers'
import type { Approval, SandbotEvent } from '../../shared/types'

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

function historyToMessages(agentId: string, limit = 40): ChatMessage[] {
  const entries = getEntries(agentId).slice(-limit)
  const msgs: ChatMessage[] = []
  for (const e of entries) {
    if (e.kind === 'message') {
      msgs.push({ role: e.role === 'user' ? 'user' : 'assistant', content: e.content })
    } else if (e.kind === 'tool-call') {
      const prev = msgs[msgs.length - 1]
      const call = { id: String(e.meta?.id ?? e.id), name: String(e.meta?.name ?? ''), arguments: String(e.meta?.arguments ?? '{}') }
      if (prev && prev.role === 'assistant') {
        prev.toolCalls = [...(prev.toolCalls ?? []), call]
      } else {
        msgs.push({ role: 'assistant', content: '', toolCalls: [call] })
      }
    } else if (e.kind === 'tool-result') {
      msgs.push({ role: 'tool', toolCallId: String(e.meta?.callId ?? ''), content: e.content })
    }
    // notice/approval/event non entrano nella storia del modello
  }
  return msgs
}

export async function runTurn(agentId: string, userText: string, emit: Emitter, images?: string[]): Promise<void> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error('Agente non trovato')
  if (!agent.providerId || !agent.model) {
    appendEntry({ agentId, kind: 'notice', role: 'system', content: "Configura prima un provider e un modello nelle impostazioni dell'agente." })
    emit({ type: 'entries', agentId, entries: getEntries(agentId, Number.MAX_SAFE_INTEGER - 1).slice(-1) })
    return
  }
  const provider = getProvider(agent.providerId)
  if (!provider) throw new Error('Provider non trovato')

  const controller = new AbortController()
  const run: Running = { controller, approvals: new Map() }
  running.set(agentId, run)

  try {
    appendEntry({ agentId, kind: 'message', role: 'user', content: userText, meta: images?.length ? { images: images.length } : undefined })
    emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(agent) },
      { role: 'user', content: userText, images },
      ...historyToMessages(agentId)
    ]

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
        emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })
        setStatus(agentId, 'idle', emit)
        return
      }
      const text = final.text
      updateEntryContent(entry.id, text)

      if (!text && !final.toolCalls?.length) {
        appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Il modello non ha prodotto risposta (vuota).' })
        emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })
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

        const verdict = permissions.check(call.name, input)

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
            content: `${call.name}: ${permissions.targetKey(call.name, input)}`,
            meta: { approvalId: approval.id, tool: call.name, input, status: 'pending' }
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
          const updatedApproval = getEntries(agentId).find((x) => x.id === approvalEntry.id)
          if (updatedApproval) emit({ type: 'entries', agentId, entries: [updatedApproval] })
          if (decision === 'timeout') {
            appendEntry({ agentId, kind: 'notice', role: 'system', content: 'Approvazione scaduta.' })
            emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })
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
          const { output, meta, images, redactedOutput } = await executeTool(agentId, call.name, input)
          const res = appendEntry({
            agentId, kind: 'tool-result', role: 'system',
            content: (redactedOutput ?? output).slice(0, 50_000),
            meta: { callId: call.id, ...meta }
          })
          emit({ type: 'entries', agentId, entries: [res] })
          // al modello va l'output completo; al transcript solo la versione redatta
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
    emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })
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
      permissions.grantStanding(String(entry.meta?.tool), entry.meta?.input as Record<string, unknown>)
    }
  }
  cb(decision)
}
