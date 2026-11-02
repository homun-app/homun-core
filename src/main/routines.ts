// Routines: attività ricorrenti per agente + suggestion engine con il prompt
// originale "repeated user behaviors" trovato nel client Grok Bot.
// Fase 2: niente più node-cron in-process — la pianificazione la calcola lo
// scheduler del daemon (src/daemon/scheduler.ts) che accoda job 'routine-run'
// nella tabella jobs quando scade il prossimo run.
import { getEntries, getAgent, getSetting, recordModelUsage } from './store/db'
import { llmStream } from './agent/llm'
import { getProvider } from './agent/providers'
import { resolveAgentModel } from './agent/model-defaults'
import { secondaryPrompts } from './agent/prompts'
import { currentUserLanguage } from './agent/user-language'
// fase 18a (E0): gli errori della suggestion sono per la UI — catalogo UI
import { uiError } from './ui-language'
import { UI } from '../shared/ui-messages'
import type { MainModel } from '../shared/types'

export interface RoutineSuggestion {
  title: string
  schedule: string
  description: string
}

/** Suggerisce routine dai comportamenti ricorrenti osservati nel transcript. */
export async function suggestRoutines(agentId: string): Promise<RoutineSuggestion[]> {
  const agent = getAgent(agentId)
  // fase 16c (C3.3): il modello risolto — anche per i bot «Come gli altri»
  const resolved = agent ? resolveAgentModel(agent, getSetting<MainModel | null>('models.main', null)) : null
  // fase 18a (E0): errori della UI dal catalogo, non testo cablato
  if (!resolved) throw uiError(UI.rpcConfigureProvider)
  const provider = getProvider(resolved.providerId)
  if (!provider) throw uiError(UI.rpcProviderNotFound)
  const model = resolved.model

  const transcript = getEntries(agentId)
    .slice(-40)
    .filter((e) => e.kind === 'message' || e.kind === 'tool-call')
    // fase 18a (E0): etichette inglesi, le legge il modello
    .map((e) => `${e.role === 'user' ? 'USER' : e.role === 'assistant' ? 'BOT' : 'TOOL'}: ${e.content.slice(0, 300)}`)
    .join('\n')
  if (!transcript.trim()) return []

  const prompt = secondaryPrompts.routinesSuggestion(transcript, currentUserLanguage())
  const controller = new AbortController()
  const stream = llmStream(provider, model, [{ role: 'user', content: prompt }], [], controller.signal)
  const { text } = await (async () => {
    let acc = ''
    let usage: import('./agent/llm').LlmChunk['usage'] | undefined
    for await (const ch of stream) {
      if (ch.textDelta) acc += ch.textDelta
      if (ch.usage) usage = ch.usage
    }
    // fase 18a (E4): uso registrato della suggestion (source 'routine-suggest')
    if (usage) {
      recordModelUsage({
        agentId,
        providerId: provider.id,
        providerKind: provider.kind,
        model,
        source: 'routine-suggest',
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        costUsd: usage.costUsd ?? null
      })
    }
    return { text: acc }
  })()

  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  try {
    const parsed = JSON.parse(jsonMatch[0]) as RoutineSuggestion[]
    return parsed
      .filter((p) => p && typeof p.title === 'string' && typeof p.schedule === 'string')
      .map((p) => ({ title: p.title.slice(0, 80), schedule: p.schedule, description: String(p.description ?? '').slice(0, 300) }))
      .slice(0, 5)
  } catch {
    return []
  }
}
