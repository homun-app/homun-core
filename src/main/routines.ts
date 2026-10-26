// Routines: attività ricorrenti per agente (node-cron) + suggestion engine
// con il prompt originale "repeated user behaviors" trovato nel client Grok Bot.
import * as cron from 'node-cron'
import { listRoutines, touchRoutineRun, getEntries, getAgent } from './store/db'
import { runTurn } from './agent/loop'
import { llmStream } from './agent/llm'
import { getProvider } from './agent/providers'
import { secondaryPrompts } from './agent/prompts'
import type { SandbotEvent } from '../shared/types'

const jobs = new Map<number, cron.ScheduledTask>()
type Emitter = (e: SandbotEvent) => void
let emit: Emitter = () => undefined

function fireRoutine(routineId: number, agentId: string, title: string, prompt: string): void {
  touchRoutineRun(routineId)
  void runTurn(agentId, `[routine ricorrente: ${title}] ${prompt}`, emit)
}

/** (Ri)carica tutti i job cron dalle routine abilitate. */
export function reloadScheduler(emitter: Emitter): void {
  emit = emitter
  for (const [, t] of jobs) t.stop()
  jobs.clear()
  for (const r of listRoutines()) {
    if (!r.enabled) continue
    if (!cron.validate(r.schedule)) continue
    const t = cron.schedule(r.schedule, () => fireRoutine(r.id, r.agent_id, r.title, r.prompt))
    jobs.set(r.id, t)
  }
}

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

  const prompt = secondaryPrompts.routinesSuggestion(transcript)
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
