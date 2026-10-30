// Routines: attività ricorrenti per agente + suggestion engine con il prompt
// originale "repeated user behaviors" trovato nel client Grok Bot.
// Fase 2: niente più node-cron in-process — la pianificazione la calcola lo
// scheduler del daemon (src/daemon/scheduler.ts) che accoda job 'routine-run'
// nella tabella jobs quando scade il prossimo run.
import { getEntries, getAgent } from './store/db'
import { llmStream } from './agent/llm'
import { getProvider } from './agent/providers'
import { secondaryPrompts } from './agent/prompts'
import { currentUserLanguage } from './agent/user-language'

export interface RoutineSuggestion {
  title: string
  schedule: string
  description: string
}

/** Suggerisce routine dai comportamenti ricorrenti osservati nel transcript. */
export async function suggestRoutines(agentId: string): Promise<RoutineSuggestion[]> {
  const agent = getAgent(agentId)
  if (!agent?.providerId || !agent.model) throw new Error('Configura prima provider e modello del bot.')
  const provider = getProvider(agent.providerId)
  if (!provider) throw new Error('Provider non trovato')

  const transcript = getEntries(agentId)
    .slice(-40)
    .filter((e) => e.kind === 'message' || e.kind === 'tool-call')
    .map((e) => `${e.role === 'user' ? 'UTENTE' : e.role === 'assistant' ? 'BOT' : 'TOOL'}: ${e.content.slice(0, 300)}`)
    .join('\n')
  if (!transcript.trim()) return []

  const prompt = secondaryPrompts.routinesSuggestion(transcript, currentUserLanguage())
  const controller = new AbortController()
  const stream = llmStream(provider, agent.model, [{ role: 'user', content: prompt }], [], controller.signal)
  const { text } = await (async () => {
    let acc = ''
    for await (const ch of stream) if (ch.textDelta) acc += ch.textDelta
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
