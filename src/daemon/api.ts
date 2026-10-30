// Metodi RPC del daemon: gli handler che in fase 1 vivevano in ipc.ts, ora
// raggiungibili dalla UI via WebSocket. I parametri viaggiano come array
// posizionale (stessa firma degli ipcMain.handle), così preload e renderer
// non cambiano. chat:send accoda un job invece di girare il turno in linea.
import { cancelAgentJobs, cancelTaskJobs } from '../main/store/jobs'
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
import { isValidTimeZone } from './tz'
import { nextScheduleRun, nextPollAt } from './triggers'
import { triggerShapeErrors, manualServerPollError } from '../shared/triggers'
import { avatarValidationError } from '../shared/avatar'
import { generateWebhookToken } from './webhooks'
import { enqueueJob } from '../main/store/jobs'
import { enqueueUserMessage, enqueueWidgetResponse } from './enqueue'
import { loadTemplates, templateById, buildKickstartMessage } from '../main/templates'
import { deliverHeldForAgent } from './outbox'
import type { JobWorker } from './worker'
import type { ConnectorsManager } from '../main/connectors'
import type { Presence } from './presence'
import type { Onboarding } from './onboarding'
import type { SandbotEvent, SendMessagePayload, McpServerInfo, McpServerSecret, RoutineInfo, RoutineTrigger, AutoReviewSettings } from '../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../shared/types'

type Emitter = (e: SandbotEvent) => void

export function buildApiMethods(
  emit: Emitter,
  worker: JobWorker,
  connectors?: ConnectorsManager,
  presence?: Presence,
  opts: { webhookPort?: number; onboarding?: Onboarding; marketplaces?: import('../main/connectors/marketplace-manager').MarketplaceManager } = {}
): Record<string, (params: unknown[]) => unknown> {
  const mcp = () => import('../main/mcp')
  const vault = () => import('../main/vault')
  /** fase 13: il wiring del daemon registra qui i deps d'installazione */
  const installBridge = () => import('../main/connectors/install-bridge')

  /** URL del webhook di una routine (per copiarlo dalla UI). */
  const webhookUrl = (r: { id: number; trigger?: RoutineTrigger | null }): string | undefined =>
    r.trigger?.type === 'webhook' && opts.webhookPort
      ? `http://127.0.0.1:${opts.webhookPort}/hooks/${r.id}`
      : undefined

  // fase 3: notice di sistema e entry aggiornata, emesse alla UI come le altre
  const appendLocalNotice = (agentId: string, content: string): void => {
    store.appendEntry({ agentId, kind: 'notice', role: 'system', content })
    emit({ type: 'entries', agentId, entries: store.getEntries(agentId).slice(-1) })
  }
  const emitUpdatedEntry = (agentId: string, entryId: number): void => {
    const updated = store.getEntries(agentId).find((e) => e.id === entryId)
    if (updated) emit({ type: 'entries', agentId, entries: [updated] })
  }

  /** Il cron della colonna schedule per un trigger (i non-cron non ne hanno: stringa vuota). */
  const cronOfTrigger = (t: RoutineTrigger | null): string =>
    t?.type === 'schedule' && t.kind === 'cron' ? t.cron : ''

  /**
   * Validazione completa di un trigger: forma (triggerShapeErrors), cron,
   * orari HH:MM e — per i connector_poll — il tool deve esistere sul server
   * del connettore ed essere in SOLA LETTURA (readOnlyHint), altrimenti il
   * trigger viene rifiutato (spec §fase 6 punto 1).
   */
  async function validateTrigger(t: RoutineTrigger): Promise<RoutineTrigger> {
    if (!t || typeof t !== 'object' || typeof t.type !== 'string') throw new Error('Trigger non valido: oggetto mancante')
    const errors = triggerShapeErrors(t)
    if (t.type === 'schedule' && t.kind === 'cron' && !parseCron(t.cron)) {
      errors.unshift(`cron non valido: "${t.cron}" (5 campi, es. "0 9 * * *")`)
    }
    if (t.type === 'connector_poll') {
      const mcpMod = await mcp()
      let tools: Awaited<ReturnType<typeof mcpMod.toolsOfServer>> | null = null
      try {
        tools = await mcpMod.toolsOfServer(t.connectorId)
      } catch {
        errors.push(`connettore "${t.connectorId}" non raggiungibile (va connesso prima di creare il trigger)`)
      }
      if (tools) {
        const tool = tools.find((x) => x.name === t.tool)
        if (!tool) errors.push(`tool "${t.tool}" non disponibile sul connettore ${t.connectorId}`)
        else if (!tool.annotations?.readOnlyHint) {
          errors.push(`il tool "${t.tool}" non è in sola lettura (readOnlyHint): il trigger viene rifiutato`)
        }
      }
      // fase 7 (residuo 0a): poll su un server NON del catalogo → serve la
      // conferma esplicita dell'utente (readOnlyHint lì è autodichiarato)
      const server = mcpMod.listServers().find((s) => s.id === t.connectorId)
      if (server) {
        const manual = manualServerPollError(t, !!server.catalogId)
        if (manual) errors.push(manual)
      }
    }
    if (errors.length) throw new Error(`Trigger non valido: ${errors.join('; ')}`)
    return t
  }

  return {
    // ---- agenti ----
    'agents:list': () => store.listAgents(),
    'agents:create': ([name, description]) => {
      const a = store.createAgent(name as string, (description as string) ?? '')
      emit({ type: 'agents' })
      return a
    },
    'agents:update': async ([id, patch]) => {
      const p = patch as { providerId?: string | null; model?: string | null; avatar?: unknown }
      // fase 16 (U2): l'aspetto si valida qui (famiglia tra le 5, colore
      // c1–c7, null = predefinito) — la UI non è fonte di verità
      if (p.avatar !== undefined) {
        const err = avatarValidationError(p.avatar)
        if (err) throw new Error(err)
      }
      // fase 9 (punto 1): prima di assegnare provider+modello verifica che il
      // modello supporti i tool (Ollama: /api/show → capabilities "tools");
      // senza → errore leggibile e nessuna assegnazione
      if (p.model !== undefined || p.providerId !== undefined) {
        const a = store.getAgent(id as string)
        const providerId = p.providerId !== undefined ? p.providerId : a?.providerId ?? null
        const model = p.model !== undefined ? p.model : a?.model ?? null
        const provider = providerId ? providers.getProvider(providerId) : undefined
        if (providerId && model && provider) {
          const check = await providers.modelSupportsTools(provider, model)
          if (!check.ok) throw new Error(check.error)
        }
      }
      store.updateAgent(id as string, patch as Parameters<typeof store.updateAgent>[1])
      emit({ type: 'agents' })
    },
    'agents:delete': ([id]) => {
      loop.interrupt(id as string)
      cancelAgentJobs(db(), id as string)
      store.deleteAgent(id as string)
      emit({ type: 'agents' })
    },
    // fase 7: il bot principale è UNO (setting mainAgentId) — si cambia dalle
    // impostazioni dell'agente ("Rendi principale")
    'agents:set-main': ([id]) => {
      const a = store.getAgent(id as string)
      if (!a) throw new Error('Agente non trovato')
      store.setSetting('mainAgentId', a.id)
      emit({ type: 'agents' })
      return { ok: true }
    },

    // ---- fase 7: template dei bot + kickstart ----
    'templates:list': () => loadTemplates(),
    'agents:create-from-template': async ([templateId]) => {
      const t = templateById(String(templateId))
      if (!t) throw new Error(`template sconosciuto: ${String(templateId)}`)
      const a = store.createAgent(t.name, t.description)
      // fase 9 (punto 1): al bot da template vanno il provider attivo e il suo
      // modello PREDEFINITO (con capability "tools" verificata)
      const { assignDefaultModel } = await import('../main/agent/model-defaults')
      type ModelDefaultsMap = import('../main/agent/model-defaults').ModelDefaultsMap
      const assignment = await assignDefaultModel({
        listProviders: () => store.listProviders(),
        getOverrides: () => store.getSetting<ModelDefaultsMap>('providers.modelDefaults', {}),
        supportsTools: (p, model) => {
          const full = providers.getProvider(p.id)
          return full ? providers.modelSupportsTools(full, model) : Promise.resolve({ ok: false, checked: false, error: 'provider non trovato' })
        }
      })
      if (assignment) store.updateAgent(a.id, { providerId: assignment.providerId, model: assignment.model })
      // il kickstart parte come job della coda: un riavvio a metà lo riprende
      // come gli altri turni (payload.entryId, fase 2)
      const now = Date.now()
      enqueueJob(db(), {
        agentId: a.id,
        kind: 'user-message',
        payload: {
          text: buildKickstartMessage(t),
          initiator: 'TEMPLATE_IMPORT',
          extraMeta: { templateName: t.name }
        },
        runAt: now,
        now
      })
      worker.poke()
      emit({ type: 'agents' })
      return a
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
      const widget = store.getEntries(agentId as string).find((e) => e.id === (entryId as number))
      // fase 6: risposta alla domanda sulle routine in pausa per assenza —
      // "Riattiva tutte" riprende SOLO quelle con pausedForAway, in modo
      // deterministico (non quelle fermate a mano dall'utente)
      if (widget?.meta?.awayResume && presence) {
        const chosen = Array.isArray(value) ? value : [value]
        if (chosen.includes('resume-away')) {
          const resumed = presence.resumeAwayPaused()
          appendLocalNotice(agentId as string, resumed > 0 ? `Routine riattivate: ${resumed}.` : 'Nessuna routine da riattivare.')
        }
      }
      // fase 7: i widget di sistema dell'onboarding sono deterministici —
      // niente turno del modello: il ruolo prepara i bot (o parcheggia sul
      // provider), il bottone del provider apre le impostazioni (UI)
      if (widget?.meta?.onboardingRole && opts.onboarding) {
        opts.onboarding.answerRole(entryId as number, value as string | string[])
        return { ok: true }
      }
      if (widget?.meta?.onboardingProvider) {
        const meta = widget.meta ?? {}
        store.updateEntryMeta(widget.id, { ...meta, respondedValue: value as string | string[] })
        emitUpdatedEntry(agentId as string, widget.id)
        return { ok: true }
      }
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
    'routines:list': ([agentId]) => {
      // fase 6: prossima esecuzione calcolata dal daemon (trigger e fuso orario)
      const now = Date.now()
      return store.listRoutines(agentId as string | undefined).map((r): RoutineInfo => {
        const next = r.trigger?.type === 'connector_poll'
          ? nextPollAt(r.last_poll ?? null, r.created_at, r.trigger.intervalMin)
          : r.trigger?.type === 'webhook' || r.trigger?.type === 'presence_return'
            ? null
            : nextScheduleRun(r, now)
        const url = webhookUrl(r)
        return { ...r, next_run: next, ...(url ? { webhook_url: url } : {}) }
      })
    },
    'routines:create': ([agentId, title, prompt, schedule]) => {
      // fase 12 (punto 1): niente routine su un SOTTOAGENTE (non è un bot)
      const refusal = store.subagentRefusal(String(agentId ?? ''))
      if (refusal) throw new Error(refusal)
      if (!parseCron(String(schedule))) throw new Error('Schedule non valida: usare un cron a 5 campi, es. "0 9 * * *"')
      return store.createRoutine(agentId as string, title as string, prompt as string, schedule as string)
    },
    'routines:create-trigger': async ([agentId, title, prompt, trigger, timezone]) => {
      // fase 12 (punto 1): niente routine su un SOTTOAGENTE (non è un bot)
      const refusal = store.subagentRefusal(String(agentId ?? ''))
      if (refusal) throw new Error(refusal)
      let t = trigger as RoutineTrigger
      // il webhook nasce col token generato dal server (prima della validazione:
      // il client non lo manda, la UI lo copia dopo la creazione)
      if (t?.type === 'webhook' && !t.token) t = { ...t, token: generateWebhookToken() }
      t = await validateTrigger(t)
      const tz = timezone ? String(timezone) : ''
      if (tz && !isValidTimeZone(tz)) throw new Error(`Fuso orario non valido: "${tz}"`)
      const created = store.createRoutine(agentId as string, title as string, prompt as string, cronOfTrigger(t), {
        timezone: tz,
        trigger: t
      })
      const url = webhookUrl(created)
      return { ...created, ...(url ? { webhook_url: url } : {}) }
    },
    'routines:update-trigger': async ([id, patch]) => {
      const p = (patch ?? {}) as { title?: string; prompt?: string; enabled?: number; paused_for_away?: number; trigger?: RoutineTrigger | null; timezone?: string }
      const cur = store.getRoutine(id as number)
      if (!cur) throw new Error('Routine non trovata')
      let final: RoutineTrigger | null | undefined
      if (p.trigger !== undefined) {
        if (!p.trigger) {
          final = null // il trigger si toglie: la routine torna al cron della colonna schedule
        } else {
          let incoming = p.trigger
          // il webhook senza token in arrivo mantiene il suo (non si rigenera a ogni modifica)
          if (incoming.type === 'webhook' && !incoming.token) {
            const old = cur.trigger?.type === 'webhook' ? cur.trigger.token : ''
            incoming = { ...incoming, token: old || generateWebhookToken() }
          }
          final = await validateTrigger(incoming)
        }
      }
      if (p.timezone !== undefined && p.timezone && !isValidTimeZone(p.timezone)) {
        throw new Error(`Fuso orario non valido: "${p.timezone}"`)
      }
      store.updateRoutine(id as number, {
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
        ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
        ...(p.paused_for_away !== undefined ? { paused_for_away: p.paused_for_away } : {}),
        ...(p.timezone !== undefined ? { timezone: p.timezone } : {}),
        ...(final !== undefined ? { trigger: final, schedule: cronOfTrigger(final) } : {})
      })
      const updated = store.getRoutine(id as number)
      const url = updated ? webhookUrl(updated) : undefined
      return updated ? { ...updated, ...(url ? { webhook_url: url } : {}) } : null
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

    // ---- fase 6: presenza (§3ter T2) e consegna dell'outbox ----
    'presence:signal': ([kind]) => {
      if (!presence) throw new Error('presenza non disponibile')
      presence.onSignal(kind === 'typing' ? 'typing' : 'active')
    },
    'presence:viewing': ([agentId]) => {
      if (!presence) throw new Error('presenza non disponibile')
      presence.onViewing(typeof agentId === 'string' && agentId ? agentId : null)
    },
    'outbox:opened': ([agentId]) => {
      // l'utente ha aperto la chat di questo agente: la sua outbox si consegna subito
      const delivered = deliverHeldForAgent(agentId as string, emit, {
        now: Date.now(),
        lastSeen: store.getSetting<number>('presence.lastSeen', 0)
      })
      return { delivered: delivered.length }
    },

    // ---- fase 8 (§3bis L7): task thread ----
    'tasks:list': ([agentId]) => {
      const rows = store.listTasks(typeof agentId === 'string' && agentId ? agentId : undefined)
      return rows.map((t): import('../shared/types').TaskInfo => ({
        id: t.id, agentId: t.agent_id, title: t.title, status: t.status,
        createdAt: t.created_at, updatedAt: t.updated_at, summary: t.summary
      }))
    },
    'tasks:cancel': ([taskId]) => {
      const t = store.getTask(taskId as number)
      if (!t) throw new Error('Task non trovato')
      if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') return { ok: true }
      // prima si ferma il turno (se è quello del task), poi si tolgono i job
      // in coda e infine lo stato: le transizioni dai task chiusi sono bloccate
      loop.interruptTask(t.agent_id, taskId as number)
      cancelTaskJobs(db(), taskId as number)
      store.updateTask(taskId as number, { status: 'cancelled' })
      emit({ type: 'tasks' })
      return { ok: true }
    },

    // ---- fase 12: sottoagenti (card in chat, pannello del figlio, Ferma) ----
    'subagents:list': async ([parentId]) => {
      const { listSubagentsOf } = await import('../main/store/subagents')
      return listSubagentsOf(db(), String(parentId ?? '')).map((r): import('../shared/types').SubagentInfo => ({
        id: r.id, parentId: r.parent_id, parentTaskId: r.parent_task_id, batchId: r.batch_id, title: r.title, status: r.status,
        summary: r.summary, reportPath: r.report_path,
        createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, deadlineAt: r.deadline_at,
        // stato live dell'agente figlio (paused-for-approval = card in attesa)
        agentStatus: store.getAgent(r.id)?.status ?? null
      }))
    },
    'subagents:stop': async ([id]) => {
      // lo stesso di stop_subagent: interrompe il turno, cancella i job in
      // coda, chiude stopped e controlla il lotto
      const { getSubagent, closeSubagent } = await import('../main/store/subagents')
      const { onSubagentTerminal } = await import('./subagent-ops')
      const row = getSubagent(db(), String(id ?? ''))
      if (!row) throw new Error('Sottoagente non trovato')
      loop.interrupt(row.id)
      cancelAgentJobs(db(), row.id)
      const closed = closeSubagent(db(), row.id, { status: 'stopped', finishedAt: Date.now() })
      if (closed) onSubagentTerminal(db(), row.id, emit)
      emit({ type: 'subagents', parentId: row.parent_id })
      return { ok: true }
    },

    // ---- fase 10: gruppi di bot (sidebar "Gruppi", vista gruppo) ----
    'groups:list': async () => {
      const { listGroups, groupWithMembers } = await import('../main/store/groups')
      return listGroups().map(groupWithMembers)
    },
    'groups:messages': async ([groupId]) => {
      const { groupMessages } = await import('../main/store/groups')
      return groupMessages(Number(groupId)).map((m) => ({
        id: m.id, groupId: m.group_id, authorKind: m.author_kind, authorId: m.author_id,
        authorName: m.author_name, text: m.text, replyTo: m.reply_to, createdAt: m.created_at
      }))
    },
    'groups:send-user': async ([groupId, text]) => {
      // l'utente scrive nel gruppo: messaggio depth 0 (apre la catena) e
      // pianificazione dei turni per i membri
      const groups = await import('../main/store/groups')
      const g = groups.getGroup(Number(groupId))
      if (!g) throw new Error('Gruppo non trovato')
      const t = String(text ?? '').trim()
      if (!t) throw new Error('Testo mancante')
      const msg = groups.addGroupMessage({
        groupId: g.id, authorKind: 'user', authorId: null, authorName: 'utente', text: t, depth: 0
      })
      groups.scheduleTurnsForMessage(msg, emit)
      emit({ type: 'groups' })
      worker.poke()
      return { ok: true, id: msg.id }
    },

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
    'mcp:save': async ([s, secret]) => {
      const x = await mcp()
      x.saveServers([...x.listServers().filter((y) => y.id !== (s as { id: string }).id), s as Parameters<typeof x.saveServers>[0][number]])
      // fase 5: bearer/header statici del server manuale → store CIFRATO (mai nei settings)
      const cfg = s as McpServerInfo
      const sec = secret as McpServerSecret | undefined
      if (sec) {
        const storeMod = await import('../main/connectors/sealed-store')
        // il daemon reale ha il wiring con la chiave Keychain; nei test senza
        // chiave il salvataggio segreto fallisce e il server resta senza auth
        try {
          const { createConnectorsSecretStore } = storeMod
          const { getConnectorsKey } = await import('./keychain')
          const sealed = createConnectorsSecretStore({
            getKey: () => getConnectorsKey(),
            getSetting: store.getSetting,
            setSetting: store.setSetting
          })
          if (sec.bearerToken) {
            const { SECRET_KIND } = await import('../main/connectors/install')
            await sealed.write(cfg.id, SECRET_KIND.bearer, sec.bearerToken)
            cfg.auth = { kind: 'bearer' }
            x.saveServers(x.listServers())
          } else if (sec.headers) {
            const { SECRET_KIND } = await import('../main/connectors/install')
            await sealed.write(cfg.id, SECRET_KIND.headers, sec.headers)
            cfg.auth = { kind: 'headers' }
            x.saveServers(x.listServers())
          }
        } catch (e) {
          throw new Error(`impossibile salvare il segreto del server (Keychain non disponibile): ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return x.listServers()
    },
    'mcp:delete': async ([id]) => {
      const x = await mcp()
      x.saveServers(x.listServers().filter((y) => y.id !== id))
    },
    'mcp:test': ([id]) => mcp().then((x) => x.testServer(id as string)),

    // ---- fase 5: connettori del catalogo ("Connetti app") ----
    'connectors:list': () => {
      if (!connectors) throw new Error('connettori non disponibili')
      return connectors.list()
    },
    'connectors:connect': ([id]) => {
      if (!connectors) throw new Error('connettori non disponibili')
      const entry = connectors.catalog.find((e) => e.id === id)
      if (!entry) throw new Error(`connettore sconosciuto: ${String(id)}`)
      // il flusso OAuth dura fino a 10 minuti (browser): parte in parallelo e
      // la UI segue gli eventi {type:'connectors'}
      void connectors.runConnect(entry).then(async (r) => {
        // il connettore è attivo: gli agenti con offerte pendenti ricevono un
        // messaggio di sistema (meta.initiator CONNECTOR_CONNECTED)
        if (r.status === 'connected') await notifyConnectorConnected(entry.id, entry.name, emit, worker)
      })
      return { started: true }
    },
    'connectors:disconnect': ([id]) => {
      if (!connectors) throw new Error('connettori non disponibili')
      return connectors.disconnect(String(id))
    },
    'connectors:set-tools': ([id, disabledTools]) => {
      if (!connectors) throw new Error('connettori non disponibili')
      connectors.setDisabledTools(String(id), (disabledTools as string[]) ?? [])
    },
    'connectors:set-instructions': ([id, instructions]) => {
      if (!connectors) throw new Error('connettori non disponibili')
      connectors.setInstructions(String(id), String(instructions ?? ''))
    },
    'connectors:save-static': ([id, clientId, clientSecret]) => {
      if (!connectors) throw new Error('connettori non disponibili')
      return connectors.saveStaticClient(String(id), String(clientId ?? ''), String(clientSecret ?? ''))
    },

    // ---- fase 13: connettori su larga scala (registro, plugin, gateway) ----

    /** I server del registro/plugin/gateway e i plugin installati (scheda Installati). */
    'connectors:installed': async () => {
      const mcpMod = await mcp()
      const { installedPlugins } = await import('../main/connectors/install')
      const { getSetting } = store
      const states = getSetting<Record<string, { status?: string }>>('connectors.state', {})
      // M2: il bottone di un server OAuth in needs_auth dice "Connetti" se non
      // ha MAI avuto token (plugin appena installato) e "Riconnetti" se la
      // sessione è scaduta — i token, quando ci sono, stanno nello store cifrato
      let storeRead: ((id: string, key: string) => Promise<unknown>) | null = null
      try { storeRead = (await installBridge()).getInstallDeps().store.read } catch { storeRead = null }
      const servers = []
      for (const s of mcpMod.listServers().filter((x) => x.source || x.needsAuth)) {
        // L1: needsReauth dice alla scheda Installati quando mostrare il bottone
        const needsReauth = s.auth?.kind === 'oauth' && !s.catalogId && states[s.id]?.status === 'needs_auth'
        let neverAuthorized: boolean | undefined
        if (needsReauth && storeRead) neverAuthorized = !(await storeRead(s.id, 'oauth.tokens'))
        servers.push({ ...s, needsReauth, ...(neverAuthorized !== undefined ? { neverAuthorized } : {}) })
      }
      // punto 4: "nuova versione disponibile" se lo sha del marketplace è
      // cambiato rispetto a quello installato (aggiornare = nuova card)
      const plugins = installedPlugins({ getSetting }).map((p) => ({ ...p, updateAvailable: false }))
      if (opts.marketplaces) {
        const { ok } = await opts.marketplaces.catalogs().catch(() => ({ ok: [], failed: [] }))
        for (const p of plugins) {
          const inMarketplace = ok
            .find((c) => c.parsed.name === p.marketplace)?.parsed.plugins.find((x) => x.name === p.name)
          const sha = inMarketplace && 'sha' in inMarketplace.source ? (inMarketplace.source as { sha?: string }).sha : undefined
          if (sha && sha !== p.sha) p.updateAvailable = true
        }
      }
      return {
        servers: servers.map((s) => ({ ...s, tools: undefined, toolsCount: null })),
        plugins
      }
    },
    /** Il click su Aggiungi/No della card "Aggiungi server MCP" (codice del daemon). */
    'connectors:resolve-mcp-server': async ([agentId, entryId, decision]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((e) => e.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'mcp-server') throw new Error('Proposta di server non trovata')
      const status = entry.meta?.status as string | undefined
      // L8: lo stato 'installing' si segna PRIMA di iniziare — due click ravvicinati
      // non installano due volte
      if (status === 'installed' || status === 'declined') throw new Error('Proposta già gestita')
      if (status === 'installing') throw new Error('installazione in corso')
      if (decision !== 'add') {
        store.updateEntryMeta(entry.id, { ...entry.meta, status: 'declined' })
        emitUpdatedEntry(aid, entry.id)
        return { ok: true, installed: false }
      }
      store.updateEntryMeta(entry.id, { ...entry.meta, status: 'installing' })
      emitUpdatedEntry(aid, entry.id)
      // M5: l'installazione è protetta — un'eccezione (cpSync/mkdirSync col
      // disco pieno, errore inatteso del registro) NON lascia la card in
      // 'installing' per sempre (ogni click dopo risponderebbe "in corso")
      let r: { ok: true; message: string } | { ok: false; error: string }
      try {
        const { installMcpServer } = await import('../main/connectors/install')
        r = await installMcpServer(message, aid, (await installBridge()).getInstallDeps())
      } catch (e) {
        r = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      store.updateEntryMeta(entry.id, { ...entry.meta, status: r.ok ? 'installed' : 'error', ...(r.ok ? {} : { error: r.error }) })
      emitUpdatedEntry(aid, entry.id)
      const text = r.ok ? `[sistema] ${r.message}` : `[sistema] Server "${message.name}" NON aggiunto: ${r.error}`
      enqueueUserMessage(db(), aid, text, undefined, emit, undefined, 'CONNECTOR_INSTALLED')
      worker.poke()
      return r
    },
    /** Il click su Installa/No della card "Installa plugin" (codice del daemon). */
    'plugins:resolve': async ([agentId, entryId, decision]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((e) => e.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'plugin') throw new Error('Proposta di plugin non trovata')
      const status = entry.meta?.status as string | undefined
      // L8: come la card del server — 'installing' prima di iniziare
      if (status === 'installed' || status === 'declined') throw new Error('Proposta già gestita')
      if (status === 'installing') throw new Error('installazione in corso')
      if (decision !== 'install') {
        // L7: il "No" cancella lo staging che la card teneva in attesa
        const { discardPluginProposal } = await import('../main/connectors/install')
        discardPluginProposal(String(message.id))
        store.updateEntryMeta(entry.id, { ...entry.meta, status: 'declined' })
        emitUpdatedEntry(aid, entry.id)
        return { ok: true, installed: false }
      }
      store.updateEntryMeta(entry.id, { ...entry.meta, status: 'installing' })
      emitUpdatedEntry(aid, entry.id)
      // M5: come la card del server — l'eccezione diventa status 'error' col
      // messaggio, e il bot riceve comunque il [sistema]
      let r: { ok: true; message: string } | { ok: false; error: string }
      try {
        const { installPlugin } = await import('../main/connectors/install')
        r = await installPlugin(message, aid, (await installBridge()).getInstallDeps(), store.setSetting, store.getSetting)
      } catch (e) {
        r = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      store.updateEntryMeta(entry.id, { ...entry.meta, status: r.ok ? 'installed' : 'error', ...(r.ok ? {} : { error: r.error }) })
      emitUpdatedEntry(aid, entry.id)
      const text = r.ok ? `[sistema] ${r.message}` : `[sistema] Plugin "${message.name}" NON installato: ${r.error}`
      enqueueUserMessage(db(), aid, text, undefined, emit, undefined, 'PLUGIN_INSTALLED')
      worker.poke()
      return r
    },
    /** Valori di chiavi/header/variabili/userConfig di un server: SOLO nello store cifrato. */
    'connectors:save-server-values': async ([serverId, kind, values]) => {
      const { getInstallDeps } = await import('../main/connectors/install-bridge')
      const { SECRET_KIND } = await import('../main/connectors/install')
      const deps = getInstallDeps()
      const v = (values ?? {}) as Record<string, string>
      // L1: la UI passa uno dei kind di SECRET_KIND; un kind sconosciuto si rifiuta
      const kindStr = String(kind) as keyof typeof SECRET_KIND
      if (!(kindStr in SECRET_KIND)) throw new Error(`tipo di valore non valido: ${String(kind)}`)
      const storeKey = SECRET_KIND[kindStr]
      if (kindStr === 'bearer') await deps.store.write(String(serverId), storeKey, v.token ?? '')
      else await deps.store.write(String(serverId), storeKey, v)
      // needsAuth si pulisce solo quando TUTTE le chiavi attese sono arrivate
      const mcpMod = await mcp()
      const servers = mcpMod.listServers()
      const cfg = servers.find((x) => x.id === serverId)
      if (cfg?.needsAuth) {
        const saved = (await deps.store.read<Record<string, string>>(String(serverId), storeKey)) ?? {}
        if (cfg.needsAuth.keys.every((k) => saved[k])) {
          cfg.needsAuth = undefined
          mcpMod.saveServers(servers)
        }
      }
      deps.onChange()
      return { ok: true }
    },
    /** Abilitazione per bot: server MCP o plugin (scheda Installati). */
    'connectors:set-enabled-for': async ([kind, id, agentIds]) => {
      const ids = Array.isArray(agentIds) ? agentIds.map(String) : []
      const mcpMod = await mcp()
      if (kind === 'server') {
        const servers = mcpMod.listServers()
        const cfg = servers.find((x) => x.id === id)
        if (!cfg) throw new Error(`server ${String(id)} non trovato`)
        cfg.enabledFor = ids.includes('*') ? ['*'] : ids
        mcpMod.saveServers(servers)
        return { ok: true }
      }
      const { installedPlugins, PLUGINS_SETTING } = await import('../main/connectors/install')
      const all = installedPlugins({ getSetting: store.getSetting })
      const idx = all.findIndex((x) => x.name === String(id))
      if (idx < 0) throw new Error(`plugin ${String(id)} non trovato`)
      all[idx]!.enabledFor = ids.includes('*') ? ['*'] : ids
      store.setSetting(PLUGINS_SETTING, all)
      return { ok: true }
    },
    /** Disinstallazione di un server del registro/plugin/gateway (solo dalle Impostazioni). */
    'connectors:uninstall-server': async ([id]) => {
      const mcpMod = await mcp()
      const { getInstallDeps } = await import('../main/connectors/install-bridge')
      // L2: i segreti seguono il server (store cifrato) e il client vivo si chiude
      await getInstallDeps().store.removeAll(String(id)).catch(() => undefined)
      mcpMod.disconnectServer(String(id))
      mcpMod.saveServers(mcpMod.listServers().filter((s) => s.id !== id))
      emit({ type: 'connectors' })
      return { ok: true }
    },
    /** L1: la card "Riconnetti" della scheda Installati rifà l'OAuth del server scaduto. */
    'connectors:reconnect-server': async ([id]) => {
      const { reconnectServer } = await import('../main/connectors/install')
      const r = await reconnectServer(String(id), (await installBridge()).getInstallDeps(), store.getSetting, store.setSetting)
      emit({ type: 'connectors' })
      return r
    },
    /** Disinstallazione di un plugin: cartelle (Mac e box), server, skill. */
    'plugins:uninstall': async ([name, marketplace]) => {
      const { installedPlugins, uninstallPlugin } = await import('../main/connectors/install')
      const { getInstallDeps } = await import('../main/connectors/install-bridge')
      const all = installedPlugins({ getSetting: store.getSetting })
      const rec = all.find((x) => x.name === String(name) && x.marketplace === String(marketplace))
      if (!rec) throw new Error('plugin non trovato')
      await uninstallPlugin(rec, getInstallDeps(), store.setSetting, store.getSetting)
      emit({ type: 'connectors' })
      return { ok: true }
    },
    /** Marketplace registrati (scheda Marketplace). */
    'marketplace:list': async () => {
      if (!opts.marketplaces) throw new Error('marketplace non disponibili')
      return opts.marketplaces.list()
    },
    'marketplace:add': ([source]) => {
      if (!opts.marketplaces) throw new Error('marketplace non disponibili')
      return opts.marketplaces.add(String(source ?? ''))
    },
    'marketplace:remove': ([source]) => {
      if (!opts.marketplaces) throw new Error('marketplace non disponibili')
      opts.marketplaces.remove(String(source ?? ''))
      return { ok: true }
    },
    /** Il modulo Gateway (punto 7): il bot NON può creare gateway, solo l'utente da qui. */
    'connectors:add-gateway': async ([input]) => {
      const { addGateway } = await import('../main/connectors/install')
      const i = input as { name: string; url: string; auth: 'oauth' | 'bearer' | 'headers'; preset?: string; headerName?: string; token?: string; headers?: Record<string, string> }
      const cfg = await addGateway(
        {
          name: i.name, url: i.url, auth: i.auth,
          ...(i.preset ? { preset: i.preset } : {}),
          ...(i.headerName ? { headerName: i.headerName } : {}),
          ...(i.token ? { bearerToken: i.token } : {}),
          ...(i.headers ? { headers: i.headers } : {})
        },
        (await installBridge()).getInstallDeps()
      )
      emit({ type: 'connectors' })
      return cfg
    },
    /** Preset dei gateway e avviso fisso (dati, nessuna chiamata ai fornitori). */
    'connectors:gateway-presets': async () => {
      const { GATEWAY_PRESETS, GATEWAY_WARNING } = await import('../main/connectors/install')
      return { presets: GATEWAY_PRESETS, warning: GATEWAY_WARNING }
    },
    /** Impostazione CIMD (punto 6): l'URL del documento ospitato dall'utente. */
    'connectors:set-client-metadata-url': ([url]) => {
      store.setSetting('connectors.oauth.clientMetadataUrl', String(url ?? ''))
      return { ok: true }
    },

    // ---- vault credenziali ----
    'vault:list': () => vault().then((x) => x.listSecretNames()),
    'vault:store': ([name, value]) => vault().then((x) => x.storeSecret(name as string, value as string)),
    'vault:delete': ([name]) => vault().then((x) => x.deleteSecret(name as string)),

    // ---- fase 14 (punto 7b): vault esteso (login, contatti, concessioni) ----
    'vault:items': () => vault().then((x) => x.listVaultItems()),
    'vault:save-login': async ([input]) => {
      const i = input as { id?: string; label: string; origins: string[]; username: string; password: string; totp?: string }
      const id = await vault().then((x) => x.saveLogin(i))
      return { id }
    },
    'vault:save-contact': async ([input]) => {
      const i = input as { id?: string; name: string; emails?: string[]; phones?: string[]; address?: string; notes?: string }
      const id = await vault().then((x) => x.saveContact(i))
      return { id }
    },
    'vault:delete-item': ([kind, key]) => {
      if (kind !== 'secret' && kind !== 'login' && kind !== 'contact') throw new Error(`tipo non valido: ${String(kind)}`)
      return vault().then((x) => x.deleteVaultItem(kind, String(key)))
    },
    'vault:get-contact': ([id]) => vault().then((x) => x.getContact(String(id))),
    /** Le concessioni "Sempre per questo sito" di fill_credential (Settings → Vault). */
    'fills:grants': async () => {
      const grants = store.listGrants().filter((g) => g.tool === 'fill_credential')
      const logins = await vault().then((x) => x.listLogins())
      return grants.map((g) => {
        const [loginId, origin] = g.target.split('|')
        return {
          id: g.id,
          loginId: loginId ?? g.target,
          label: logins.find((l) => l.id === loginId)?.label ?? loginId ?? '',
          origin: origin ?? '',
          createdAt: g.createdAt
        }
      })
    },
    'fills:revoke': ([id]) => {
      store.removeGrant(Number(id))
      return { ok: true }
    },
    /**
     * Fase 14 (punto 7e): l'utente ha compilato il modulo sicuro. I valori
     * salvano nel vault QUI (mai in chat) e l'esito torna al modello tramite
     * l'approval risolta: solo "salvato: login «label» (id)" / "salvato:
     * secret NOME".
     */
    'secureinput:submit': async ([agentId, approvalId, values]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).findLast(
        (e) => e.kind === 'send-message' && e.meta?.approvalId === approvalId && e.meta?.status === 'pending'
      )
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || message?.type !== 'secure-input') throw new Error('Modulo non trovato o già chiuso')
      const v = (values ?? {}) as Record<string, string>
      let outcome: string
      if (message.kind === 'login') {
        const origin = String(v.origin ?? message.origin ?? '').trim()
        if (!origin || !v.username || !v.password) throw new Error('Servono origine, utente e password')
        const label = String(v.label ?? message.label ?? '').trim() || 'Login'
        const id = await vault().then((x) => x.saveLogin({
          label, origins: [origin], username: v.username, password: v.password,
          ...(v.totp ? { totp: v.totp } : {})
        }))
        outcome = `salvato: login «${label}» (${id})`
      } else {
        const name = String(v.name ?? message.name ?? '').trim()
        if (!name || !v.value) throw new Error('Servono il nome e il valore del secret')
        await vault().then((x) => x.storeSecret(name, v.value))
        outcome = `salvato: secret ${name}`
      }
      store.updateEntryMeta(entry.id, { ...entry.meta, status: 'allowed', savedOutcome: outcome })
      emitUpdatedEntry(aid, entry.id)
      loop.resolveApproval(aid, String(approvalId), 'allow', 'once')
      return { ok: true }
    },

    // ---- fase 14 (punti 1-5): la libreria ----
    'library:list': async ([query, kind]) => {
      const libraryStore = await import('../main/store/library')
      return libraryStore.listLibraryItems({
        ...(typeof query === 'string' && query.trim() ? { query } : {}),
        ...(kind === 'document' || kind === 'chart' || kind === 'file' ? { kind } : {})
      }).map((i): import('../shared/types').LibraryItemInfo => ({
        id: i.id, kind: i.kind, title: i.title, authorAgentId: i.authorAgentId,
        createdAt: i.createdAt, updatedAt: i.updatedAt, pinned: i.pinned, tainted: i.tainted,
        currentVersion: i.currentVersion, chartKind: i.chartKind ?? null,
        fileName: i.fileName ?? null, fileSize: i.fileSize ?? null, fileMime: i.fileMime ?? null
      }))
    },
    'library:get': async ([id, version]) => {
      const lib = await import('../main/agent/library')
      const item = lib.getLibraryItemPublic(String(id))
      if (!item) throw new Error('voce non trovata')
      if (item.kind === 'document') {
        const r = lib.readDocument({ id: String(id), ...(version !== undefined && version !== null ? { version } : {}) })
        if (!r.ok) throw new Error(r.error)
        return {
          kind: 'document', content: r.value.content, svg: null, fileBase64: null, fileMime: null,
          versions: r.value.versions, authorName: r.value.authorName
        }
      }
      if (item.kind === 'chart') {
        const src = lib.chartSourceOf(String(id))
        return {
          kind: 'chart', content: src, svg: item.chartKind === 'vega-lite' ? lib.chartSvgOf(String(id)) : null,
          fileBase64: null, fileMime: item.chartKind === 'vega-lite' ? 'image/svg+xml' : 'text/plain',
          versions: [1], authorName: store.getAgent(item.authorAgentId)?.name ?? item.authorAgentId
        }
      }
      const file = lib.fileOfItem(item)
      if (!file) throw new Error('voce incoerente')
      const { readFileSync } = await import('node:fs')
      const isImage = /^image\/(png|jpeg|svg\+xml)$/.test(item.fileMime ?? '')
      return {
        kind: 'file', content: null, svg: null,
        fileBase64: isImage ? readFileSync(file).toString('base64') : null,
        fileMime: item.fileMime ?? 'application/octet-stream',
        versions: [1], authorName: store.getAgent(item.authorAgentId)?.name ?? item.authorAgentId
      }
    },
    'library:delete': async ([id]) => {
      const libraryStore = await import('../main/store/library')
      if (!libraryStore.deleteLibraryItem(String(id))) throw new Error('voce non trovata')
      return { ok: true }
    },
    'library:rename': async ([id, title]) => {
      const libraryStore = await import('../main/store/library')
      if (!libraryStore.getLibraryItem(String(id))) throw new Error('voce non trovata')
      libraryStore.updateLibraryItem(String(id), { title: String(title ?? '').trim() || 'Senza titolo', updatedAt: Date.now() })
      return { ok: true }
    },
    'library:pin': async ([id, pinned]) => {
      const libraryStore = await import('../main/store/library')
      if (!libraryStore.getLibraryItem(String(id))) throw new Error('voce non trovata')
      libraryStore.updateLibraryItem(String(id), { pinned: pinned === true, updatedAt: Date.now() })
      return { ok: true }
    },
    /** Fase 14: "ripristina come nuova versione" — la versione vecchia diventa l'ultima (MAI sovrascritta). */
    'library:restore-version': async ([id, version]) => {
      const lib = await import('../main/agent/library')
      const item = lib.getLibraryItemPublic(String(id))
      if (!item || item.kind !== 'document') throw new Error('documento non trovato')
      const read = lib.readDocument({ id: String(id), version: Number(version) })
      if (!read.ok) throw new Error(read.error)
      const r = lib.writeDocument(item.authorAgentId, { id: String(id), title: item.title, content: read.value.content }, { userTurn: true })
      if (!r.ok) throw new Error(r.error)
      return { ok: true, version: r.value.version }
    },
    'library:export': async ([id, format]) => {
      // il bottone Esporta della UI: stessa strada dell'export del bot, SENZA
      // la card (l'ha già cliccata l'utente qui); l'esito torna alla UI
      const lib = await import('../main/agent/library')
      const pre = lib.prepareLibraryExport({ id, format })
      if (!pre.ok) throw new Error(pre.error)
      const { getPrintToPdf } = await import('./host-bridge')
      const fn = getPrintToPdf()
      const r = await lib.runLibraryExport(pre.value, fn ? { printToPdf: fn } : {})
      return { ok: true, path: r.finalPath, output: r.output }
    },
    'library:stats': async () => {
      const lib = await import('../main/agent/library')
      const bytes = lib.libraryTotalBytes()
      return { bytes, warn: bytes > lib.LIBRARY_TOTAL_WARN_BYTES, warnBytes: lib.LIBRARY_TOTAL_WARN_BYTES }
    },

    // ---- approvazioni ----
    // fase 8 (punto 2): mode 'once' | 'always' (standing grant) | 'turn' (fino a fine turno)
    'approvals:resolve': ([agentId, approvalId, decision, mode]) => {
      loop.resolveApproval(
        agentId as string, approvalId as string, decision as 'allow' | 'deny',
        mode === 'always' ? 'always' : mode === 'turn' ? 'turn' : 'once'
      )
    },
    // debug/test: risolve l'approval pending più recente di un agente
    'approvals:resolve-latest': ([agentId, decision]) => {
      const pending = store.getEntries(agentId as string).findLast((x) => x.kind === 'approval' && x.meta?.status === 'pending')
      if (!pending) return null
      loop.resolveApproval(agentId as string, String(pending.meta?.approvalId), decision as 'allow' | 'deny', 'once')
      return String(pending.meta?.approvalId)
    },

    // ---- fase 8 (§3bis L5): regola di auto-review proposta dall'agente ----
    // la regola si salva SOLO qui, al click dell'utente sulla card
    'autoreview:rule-decision': ([agentId, entryId, action]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((e) => e.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'rule') throw new Error('Proposta di regola non trovata')
      if (entry.meta?.ruleStatus) throw new Error('Proposta già gestita')
      if (action === 'add') {
        // copia difensiva: getSetting restituisce il DEFAULT per riferimento e
        // il DEFAULT non si muta mai (è il fallback di ogni lettura)
        const cur = store.getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW)
        const cfg: AutoReviewSettings = { ...cur, allowRules: [...cur.allowRules], blockRules: [...cur.blockRules] }
        const list = message.kind === 'block' ? cfg.blockRules : cfg.allowRules
        if (!list.includes(message.text)) list.push(message.text)
        store.setSetting('autoReview', cfg)
        store.updateEntryMeta(entry.id, { ...entry.meta, ruleStatus: 'added' })
      } else {
        store.updateEntryMeta(entry.id, { ...entry.meta, ruleStatus: 'dismissed' })
      }
      emitUpdatedEntry(aid, entry.id)
      return { ok: true }
    },

    // ---- provider ----
    'providers:list': () => store.listProviders(),
    'providers:save': ([p]) => {
      const ps = store.listProviders().filter((x) => x.id !== (p as { id: string }).id)
      ps.push(p as Parameters<typeof store.saveProviders>[0][number])
      store.saveProviders(ps)
      emit({ type: 'agents' })
      // fase 7: l'onboarding fermo sul provider riprende appena ce n'è uno
      if (opts.onboarding) void opts.onboarding.resume().catch(() => undefined)
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
    // fase 11 (punto 2): chiave per la ricerca web del provider Ollama — vive
    // SOLO nel vault sigillato (mai nei settings in chiaro, mai nel contesto
    // del modello, nei log o in argv); la UI riceve solo un booleano
    'providers:set-web-search-key': async ([providerId, key]) => {
      const p = providers.getProvider(providerId as string)
      if (!p || p.kind !== 'ollama') throw new Error('la chiave per la ricerca web si imposta sul provider Ollama')
      const { setWebSearchKey, clearWebSearchKey } = await import('../main/agent/web-tools')
      const { getConnectorsKey } = await import('./keychain')
      const deps = { getKey: () => getConnectorsKey() }
      if (key === null || key === '') await clearWebSearchKey(deps)
      else await setWebSearchKey(String(key), deps)
    },
    'providers:web-search-key-set': async ([providerId]) => {
      const p = providers.getProvider(providerId as string)
      if (!p || p.kind !== 'ollama') return false
      const { isWebSearchKeySet } = await import('../main/agent/web-tools')
      const { getConnectorsKey } = await import('./keychain')
      return isWebSearchKeySet({ getKey: () => getConnectorsKey() })
    },
    // fase 15 (S5): stato di sola lettura dei provider di ricerca per la UI —
    // disponibile, in raffreddamento fino a quando, ultimo errore (tipo e
    // status, MAI la query)
    'websearch:status': async () => {
      const { webSearchStatus } = await import('../main/agent/web-tools')
      return webSearchStatus()
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

/**
 * Fase 5: un connettore offerto dal bot è stato connesso dall'utente. Ogni
 * agente con un'offerta ancora pendente per quel connettore riceve un job
 * 'user-message' con meta.initiator 'CONNECTOR_CONNECTED' (specifica §3ter
 * T2-T3) così può proseguire ("Fatto, ora posso…"). Le offerte soddisfatte
 * vengono marcate meta.connected per non ri-notificare.
 */
export async function notifyConnectorConnected(
  connectorId: string,
  name: string,
  emit: Emitter,
  worker: JobWorker
): Promise<void> {
  for (const agent of store.listAgents()) {
    const offers = store.getEntries(agent.id).filter(
      (e) =>
        e.kind === 'send-message' &&
        (e.meta?.message as SendMessagePayload | undefined)?.type === 'connector' &&
        ((e.meta?.message as { connectorId?: string }).connectorId === connectorId) &&
        !e.meta?.connected
    )
    if (!offers.length) continue
    for (const e of offers) store.updateEntryMeta(e.id, { ...e.meta, connected: true })
    enqueueUserMessage(
      db(),
      agent.id,
      `[sistema] L'utente ha connesso ${name}: i suoi tool mcp__${connectorId}__* sono ora disponibili (cerca i nomi esatti con i tuoi tool o chiedendo all'utente).`,
      undefined,
      emit,
      undefined,
      'CONNECTOR_CONNECTED'
    )
    worker.poke()
  }
}
