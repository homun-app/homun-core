// Metodi RPC del daemon: gli handler che in fase 1 vivevano in ipc.ts, ora
// raggiungibili dalla UI via WebSocket. I parametri viaggiano come array
// posizionale (stessa firma degli ipcMain.handle), così preload e renderer
// non cambiano. chat:send accoda un job invece di girare il turno in linea.
import { cancelAgentJobs } from '../main/store/jobs'
import * as store from '../main/store/db'
import { db } from '../main/store/db'
import * as loop from '../main/agent/loop'
import * as permissions from '../main/agent/permissions'
import { executeTool } from '../main/agent/tools'
import { isExternalSend, applyDraftBody, DEFAULT_EXTERNAL_SEND_TOOLS, type ExternalSendConfig } from '../main/agent/external-send'
import { listMemories, updateMemory, deleteMemory } from '../main/agent/memory'
import { listSkills, deleteSkill } from '../main/agent/skills'
import * as providers from '../main/agent/providers'
import { suggestRoutines } from '../main/routines'
import { llmStream } from '../main/agent/llm'
import { secondaryPrompts } from '../main/agent/prompts'
import { parseCron } from './cron'
import { enqueueUserMessage, enqueueWidgetResponse } from './enqueue'
import type { JobWorker } from './worker'
import type { SandbotEvent, SendMessagePayload } from '../shared/types'

type Emitter = (e: SandbotEvent) => void

export function buildApiMethods(emit: Emitter, worker: JobWorker): Record<string, (params: unknown[]) => unknown> {
  const mcp = () => import('../main/mcp')
  const vault = () => import('../main/vault')

  // fase 3: notice di sistema e entry aggiornata, emesse alla UI come le altre
  const appendLocalNotice = (agentId: string, content: string): void => {
    store.appendEntry({ agentId, kind: 'notice', role: 'system', content })
    emit({ type: 'entries', agentId, entries: store.getEntries(agentId).slice(-1) })
  }
  const emitUpdatedEntry = (agentId: string, entryId: number): void => {
    const updated = store.getEntries(agentId).find((e) => e.id === entryId)
    if (updated) emit({ type: 'entries', agentId, entries: [updated] })
  }

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

    // ---- fase 3: risposta ai widget ask_user ----
    'widget:respond': ([agentId, entryId, value]) => {
      const job = enqueueWidgetResponse(db(), agentId as string, entryId as number, value as string | string[], emit)
      if (job) worker.poke()
      return { ok: !!job }
    },

    // ---- fase 3: azioni sulle bozze (l'invio vero avviene SOLO qui, al click) ----
    'draft:send': async ([agentId, entryId, body]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((x) => x.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'draft') throw new Error('Bozza non trovata')
      const meta = entry.meta ?? {}
      if (meta.status === 'sent' || meta.status === 'discarded') throw new Error(`Bozza già ${meta.status === 'sent' ? 'inviata' : 'scartata'}`)
      // body modificato inline nella card: persistito prima dell'invio
      // D1: aggiorna anche via.args (l'argomento che verrà davvero inviato)
      if (typeof body === 'string' && body.trim() && body !== message.body) applyDraftBody(message, body)
      const via = message.via
      const notice = (content: string): void => {
        appendLocalNotice(aid, content)
      }
      if (!via) {
        notice('La bozza non ha un tool di invio associato: non può essere inviata automaticamente.')
        return { ok: false }
      }
      // D1 (difesa in profondità): si eseguono SOLO tool di invio esterno,
      // anche per le bozze salvate nel DB prima della correzione — il click su
      // Invia non può mai eseguire un tool arbitrario lasciato dal modello
      const externalCfg = store.getSetting<ExternalSendConfig>('externalSendTools', DEFAULT_EXTERNAL_SEND_TOOLS)
      if (!isExternalSend(via.tool, externalCfg)) {
        notice(`Invio rifiutato: ${via.tool} non è un tool di invio esterno configurato.`)
        return { ok: false }
      }
      // il click su Invia è il consenso esplicito dell'utente (ha visto tutto il
      // contenuto), ma il gate dei permessi resta in mezzo: una regola blocked
      // nega comunque l'invio
      const verdict = await permissions.check(via.tool, via.args, aid)
      if (verdict.kind === 'deny') {
        notice(`Invio bloccato dai permessi: ${via.tool}`)
        return { ok: false }
      }
      try {
        const { output } = await executeTool(aid, via.tool, via.args)
        store.updateEntryMeta(entry.id, { ...meta, message, status: 'sent' })
        emitUpdatedEntry(aid, entry.id)
        notice(`Bozza inviata (${via.tool}). Esito: ${output.slice(0, 300)}`)
        return { ok: true }
      } catch (e) {
        store.updateEntryMeta(entry.id, { ...meta, message, status: 'error' })
        emitUpdatedEntry(aid, entry.id)
        notice(`Errore nell'invio della bozza: ${e instanceof Error ? e.message : String(e)}`)
        return { ok: false }
      }
    },
    'draft:discard': ([agentId, entryId]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((x) => x.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'draft') throw new Error('Bozza non trovata')
      if (entry.meta?.status === 'sent') throw new Error('Bozza già inviata')
      store.updateEntryMeta(entry.id, { ...(entry.meta ?? {}), status: 'discarded' })
      emitUpdatedEntry(aid, entry.id)
      return { ok: true }
    },
    'draft:update': ([agentId, entryId, body]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((x) => x.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'draft') throw new Error('Bozza non trovata')
      if (entry.meta?.status === 'sent' || entry.meta?.status === 'discarded') throw new Error('Bozza già chiusa')
      // D1: il body modificato aggiorna anche via.args (il campo mappato sul corpo)
      applyDraftBody(message, String(body ?? ''))
      store.updateEntryMeta(entry.id, { ...(entry.meta ?? {}), message })
      emitUpdatedEntry(aid, entry.id)
      return { ok: true }
    },

    // ---- quick-ask (domanda effimera, non inquina il transcript) ----
    quickask: async ([agentId, question]) => {
      const agent = store.getAgent(agentId as string)
      if (!agent?.providerId || !agent.model) throw new Error('Configura prima provider e modello.')
      const provider = providers.getProvider(agent.providerId)
      if (!provider) throw new Error('Provider non trovato')
      // fase 3: ciò che il bot ha DETTO all'utente sono le send-message (il
      // testo libero è ragionamento interno e non entra nel contesto)
      const context = store.getEntries(agentId as string)
        .slice(-20)
        .filter((e) => e.kind === 'message' || e.kind === 'send-message')
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

    // ---- memoria (fase 4): sezione nella vista dell'agente ----
    'memory:list': ([agentId]) => listMemories(agentId as string),
    'memory:update': ([agentId, id, content]) => {
      updateMemory(agentId as string, { id: id as string, content: content as string })
    },
    'memory:delete': ([agentId, id]) => {
      deleteMemory(agentId as string, id as string)
    },

    // ---- skill (fase 4): elenco con visualizzazione ed eliminazione ----
    'skills:list': ([agentId]) => listSkills(agentId as string),
    'skills:delete': ([agentId, name]) => {
      deleteSkill(agentId as string, name as string)
    },

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
