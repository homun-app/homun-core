// Metodi RPC del daemon: gli handler che in fase 1 vivevano in ipc.ts, ora
// raggiungibili dalla UI via WebSocket. I parametri viaggiano come array
// posizionale (stessa firma degli ipcMain.handle), così preload e renderer
// non cambiano. chat:send accoda un job invece di girare il turno in linea.
import { cancelAgentJobs } from '../main/store/jobs'
import * as store from '../main/store/db'
import { db } from '../main/store/db'
import * as loop from '../main/agent/loop'
import * as providers from '../main/agent/providers'
import { suggestRoutines } from '../main/routines'
import { llmStream } from '../main/agent/llm'
import { secondaryPrompts } from '../main/agent/prompts'
import { parseCron } from './cron'
import { enqueueUserMessage } from './enqueue'
import type { JobWorker } from './worker'
import type { SandbotEvent } from '../shared/types'

type Emitter = (e: SandbotEvent) => void

export function buildApiMethods(emit: Emitter, worker: JobWorker): Record<string, (params: unknown[]) => unknown> {
  const mcp = () => import('../main/mcp')
  const vault = () => import('../main/vault')

  return {
    // ---- agenti ----
    'agents:list': () => store.listAgents(),
    'agents:create': ([name, description]) => {
      const a = store.createAgent(name as string, (description as string) ?? '')
      emit({ type: 'agents' })
      return a
    },
    'agents:update': ([id, patch]) => {
      store.updateAgent(id as string, patch as Parameters<typeof store.updateAgent>[1])
      emit({ type: 'agents' })
    },
    'agents:delete': ([id]) => {
      loop.interrupt(id as string)
      cancelAgentJobs(db(), id as string)
      store.deleteAgent(id as string)
      emit({ type: 'agents' })
    },

    // ---- transcript ----
    'agents:entries': ([agentId, afterId]) => store.getEntries(agentId as string, (afterId as number) ?? 0),
    'chat:send': ([agentId, text, images]) => {
      enqueueUserMessage(db(), agentId as string, text as string, images as string[] | undefined, emit)
      worker.poke()
    },
    'chat:interrupt': ([agentId]) => {
      loop.interrupt(agentId as string)
    },

    // ---- quick-ask (domanda effimera, non inquina il transcript) ----
    quickask: async ([agentId, question]) => {
      const agent = store.getAgent(agentId as string)
      if (!agent?.providerId || !agent.model) throw new Error('Configura prima provider e modello.')
      const provider = providers.getProvider(agent.providerId)
      if (!provider) throw new Error('Provider non trovato')
      const context = store.getEntries(agentId as string)
        .slice(-20)
        .filter((e) => e.kind === 'message')
        .map((e) => `${e.role === 'user' ? 'UTENTE' : 'BOT'}: ${e.content.slice(0, 400)}`)
        .join('\n')
      const prompt = secondaryPrompts.quickAsk(context, question as string)
      const controller = new AbortController()
      const stream = llmStream(provider, agent.model, [{ role: 'user', content: prompt }], [], controller.signal)
      let acc = ''
      for await (const ch of stream) if (ch.textDelta) acc += ch.textDelta
      return acc
    },

    // ---- routine (la validazione della schedule è la stessa del parser cron dello scheduler) ----
    'routines:list': ([agentId]) => store.listRoutines(agentId as string | undefined),
    'routines:create': ([agentId, title, prompt, schedule]) => {
      if (!parseCron(String(schedule))) throw new Error('Schedule non valida: usare un cron a 5 campi, es. "0 9 * * *"')
      return store.createRoutine(agentId as string, title as string, prompt as string, schedule as string)
    },
    'routines:update': ([id, patch]) => {
      if (patch && typeof patch === 'object' && 'schedule' in (patch as Record<string, unknown>) && !parseCron(String((patch as Record<string, unknown>).schedule))) {
        throw new Error('Schedule non valida: usare un cron a 5 campi, es. "0 9 * * *"')
      }
      store.updateRoutine(id as number, patch as Parameters<typeof store.updateRoutine>[1])
    },
    'routines:delete': ([id]) => {
      store.deleteRoutine(id as number)
    },
    'routines:suggest': ([agentId]) => suggestRoutines(agentId as string),

    // ---- MCP ----
    'mcp:list': () => mcp().then((x) => x.listServers()),
    'mcp:save': async ([s]) => {
      const x = await mcp()
      x.saveServers([...x.listServers().filter((y) => y.id !== (s as { id: string }).id), s as Parameters<typeof x.saveServers>[0][number]])
      return x.listServers()
    },
    'mcp:delete': async ([id]) => {
      const x = await mcp()
      x.saveServers(x.listServers().filter((y) => y.id !== id))
    },
    'mcp:test': ([id]) => mcp().then((x) => x.testServer(id as string)),

    // ---- vault credenziali ----
    'vault:list': () => vault().then((x) => x.listSecretNames()),
    'vault:store': ([name, value]) => vault().then((x) => x.storeSecret(name as string, value as string)),
    'vault:delete': ([name]) => vault().then((x) => x.deleteSecret(name as string)),

    // ---- approvazioni ----
    'approvals:resolve': ([agentId, approvalId, decision, always]) => {
      loop.resolveApproval(agentId as string, approvalId as string, decision as 'allow' | 'deny', Boolean(always))
    },
    // debug/test: risolve l'approval pending più recente di un agente
    'approvals:resolve-latest': ([agentId, decision]) => {
      const pending = store.getEntries(agentId as string).findLast((x) => x.kind === 'approval' && x.meta?.status === 'pending')
      if (!pending) return null
      loop.resolveApproval(agentId as string, String(pending.meta?.approvalId), decision as 'allow' | 'deny', false)
      return String(pending.meta?.approvalId)
    },

    // ---- provider ----
    'providers:list': () => store.listProviders(),
    'providers:save': ([p]) => {
      const ps = store.listProviders().filter((x) => x.id !== (p as { id: string }).id)
      ps.push(p as Parameters<typeof store.saveProviders>[0][number])
      store.saveProviders(ps)
      emit({ type: 'agents' })
    },
    'providers:delete': ([id]) => {
      store.saveProviders(store.listProviders().filter((x) => x.id !== id))
    },
    'providers:discover': () => providers.discoverProviders(),
    'providers:test': ([id]) => {
      const p = providers.getProvider(id as string)
      return p ? providers.testProvider(p) : { ok: false, error: 'provider non trovato' }
    },
    'models:list': ([providerId]) => {
      const p = providers.getProvider(providerId as string)
      if (!p) throw new Error('provider non trovato')
      return providers.listProviderModels(p)
    },

    // ---- permessi & impostazioni ----
    'permissions:get': () => store.getPermissions(),
    'permissions:set': ([cfg]) => store.setPermissions(cfg as Parameters<typeof store.setPermissions>[0]),
    'settings:get': ([key, fallback]) => store.getSetting(key as string, fallback),
    'settings:set': ([key, value]) => store.setSetting(key as string, value),

    // diagnostica
    ping: () => ({ pong: true, pid: process.pid })
  }
}
