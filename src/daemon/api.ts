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
// fase 18b (H5.1): il catalogo pi-ai per l'unione di models:list (l'adattatore
// resta l'unico file che importa pi-ai; qui si importa l'adattatore)
import { catalogModelInfos, modelCapabilities } from '../main/agent/llm'
import { secondaryPrompts } from '../main/agent/prompts'
import { parseCron } from './cron'
import { MAX_GROUP_MEMBERS } from '../main/agent/group-turns'
import { isValidTimeZone } from './tz'
import { nextScheduleRun, nextPollAt } from './triggers'
import { triggerShapeErrors, manualServerPollError } from '../shared/triggers'
import { avatarValidationError } from '../shared/avatar'
import { generateWebhookToken } from './webhooks'
import { enqueueJob } from '../main/store/jobs'
import { enqueueUserMessage, enqueueWidgetResponse } from './enqueue'
import { noteHumanText, currentUserLanguage } from '../main/agent/user-language'
import { loadTemplates, templateById, buildKickstartMessage } from '../main/templates'
import { deliverHeldForAgent } from './outbox'
import type { JobWorker } from './worker'
import type { ConnectorsManager } from '../main/connectors'
import type { Presence } from './presence'
import type { Onboarding } from './onboarding'
import type { SandbotEvent, SendMessagePayload, McpServerInfo, McpServerSecret, RoutineInfo, RoutineTrigger, AutoReviewSettings, ModelInfo, ModelPriceMap, ThinkingSetting, MainModel, ProviderKind } from '../shared/types'
// fase 18b (K3): la lettura /api/show condivisa col check dei tool e col loop
import { readOllamaCapabilities } from '../main/agent/live-models'
import { DEFAULT_AUTO_REVIEW } from '../shared/types'
// fase 17c (C2/C3): testi del catalogo UI — errori RPC nella lingua
// dell'interfaccia, meta.ui sui messaggi [sistema] (il testo per il modello
// resta inglese) e sulle notice
import { uiLanguage, uiText, formatUi, ui, uiError } from '../main/ui-language'
// K1.8 (fase rilascio — correzioni): l'errore tipizzato delle chiavi master
import { isMasterKeyUnavailableError } from './master-keys'
import { UI } from '../shared/ui-messages'
import { UiError } from '../shared/ui-text'
// fase rilascio (A7): lo stato di docker per la UI (percorso risolto, senza spawn)
import { isToolResolved, resolveTool, invalidateToolCache } from '../main/tool-paths'
// M10 (fase 0.3.1001): prefisso dei nomi del box di prova non valido → riga nella UI
import { INVALID_TEST_BOX_PREFIX } from '../main/sandbox/docker-argv'
// R2 (fase app — ritocchi): l'esito degli invii si ripulisce come gli errori Composio
import { redactComposioSecrets } from '../main/connectors/composio-actions'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dockerToolStatus(): { installed: boolean; running: boolean; path: string; testPrefixInvalid: boolean } {
  const installed = isToolResolved('docker')
  const home = homedir()
  const socket = Boolean(process.env.DOCKER_HOST) ||
    existsSync('/var/run/docker.sock') ||
    existsSync(join(home, '.docker', 'run', 'docker.sock'))
  // M10: il prefisso dei nomi del box di prova, se PRESENTE e non valido,
  // compare come riga nella UI (la sandbox non parte)
  return { installed, running: installed && socket, path: resolveTool('docker'), testPrefixInvalid: INVALID_TEST_BOX_PREFIX !== null }
}
import type { UiText } from '../shared/types'

type Emitter = (e: SandbotEvent) => void

/**
 * R2 (fase app — ritocchi): il nome umano dell'app di uno strumento d'invio —
 * il toolkit per Composio (describeTool), il nome del server per MCP — per i
 * testi delle notice delle bozze. MAI l'id dello strumento: se il nome non si
 * conosce si torna '' e il messaggio dice «l'app collegata».
 */
async function sendAppName(tool: string): Promise<string> {
  try {
    if (tool.startsWith('composio__')) {
      const { describeComposioTool } = await import('../main/connectors/composio')
      return describeComposioTool(tool)?.app ?? tool.split('__')[1] ?? ''
    }
    if (tool.startsWith('mcp__')) {
      const { listServers } = await import('../main/mcp')
      const id = tool.split('__')[1] ?? ''
      return listServers().find((s) => s.id === id)?.name ?? ''
    }
  } catch {
    // elenco non disponibile: il messaggio resta generico
  }
  return ''
}

export function buildApiMethods(
  emit: Emitter,
  worker: JobWorker,
  connectors?: ConnectorsManager,
  presence?: Presence,
  opts: {
    webhookPort?: number
    onboarding?: Onboarding
    marketplaces?: import('../main/connectors/marketplace-manager').MarketplaceManager
    /** fase app: il manager Composio del daemon (niente RPC senza) */
    composio?: import('../main/connectors/composio').ComposioManager
    /** fase Composio OAuth (C5): il gateway delle app dentro il server Composio */
    composioGateway?: import('../main/connectors/composio-gateway').ComposioGatewayManager
  } = {}
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

  // fase 3: notice di sistema e entry aggiornata, emesse alla UI come le altre.
  // Fase 17c (C2): col testo del catalogo UI — content nella lingua
  // dell'interfaccia, meta.ui per la ritraduzione
  const appendLocalNotice = (agentId: string, text: UiText): void => {
    store.appendEntry({ agentId, kind: 'notice', role: 'system', content: formatUi(text, uiLanguage()), meta: { ui: text } })
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
    if (!t || typeof t !== 'object' || typeof t.type !== 'string') throw uiError(UI.rpcTriggerInvalidObject)
    // fase 17c/18a (E0): gli errori di forma sono UiText, si formattano qui
    // nella lingua dell'interfaccia (il result del modello in tools.ts è 'en')
    const lang = uiLanguage()
    const errors = triggerShapeErrors(t).map((e) => formatUi(e, lang))
    if (t.type === 'schedule' && t.kind === 'cron' && !parseCron(t.cron)) {
      errors.unshift(uiText(UI.rpcCronInvalid, { cron: t.cron }))
    }
    if (t.type === 'connector_poll') {
      const mcpMod = await mcp()
      let tools: Awaited<ReturnType<typeof mcpMod.toolsOfServer>> | null = null
      try {
        tools = await mcpMod.toolsOfServer(t.connectorId)
      } catch {
        errors.push(uiText(UI.rpcConnectorUnreachable, { id: t.connectorId }))
      }
      if (tools) {
        const tool = tools.find((x) => x.name === t.tool)
        if (!tool) errors.push(uiText(UI.rpcToolUnavailable, { tool: t.tool, id: t.connectorId }))
        else if (!tool.annotations?.readOnlyHint) {
          errors.push(uiText(UI.rpcToolNotReadOnly, { tool: t.tool }))
        }
      }
      // fase 7 (residuo 0a): poll su un server NON del catalogo → serve la
      // conferma esplicita dell'utente (readOnlyHint lì è autodichiarato)
      const server = mcpMod.listServers().find((s) => s.id === t.connectorId)
      if (server) {
        const manual = manualServerPollError(t, !!server.catalogId)
        if (manual) errors.push(formatUi(manual, lang))
      }
    }
    if (errors.length) throw uiError(UI.rpcTriggerInvalid, { errors: errors.join('; ') })
    return t
  }

  /**
   * Fase 18b (H7): validazione del modello PROPRIo di una routine — il
   * provider deve esistere (e non essere un sottoagente) e il modello non
   * può essere vuoto; altrimenti uiError. providerId nullo = bot del turno.
   */
  function routineModelPatch(m?: { providerId?: string | null; model?: string | null; thinking?: string | null }): {
    providerId: string | null
    model: string | null
    thinking: ThinkingSetting | null
  } {
    if (m === undefined) return { providerId: null, model: null, thinking: null }
    if (m.providerId === null || m.providerId === undefined || m.providerId === '') {
      return { providerId: null, model: null, thinking: null }
    }
    const p = providers.getProvider(String(m.providerId))
    if (!p) throw uiError(UI.rpcRoutineModelProvider, { provider: String(m.providerId) })
    const model = typeof m.model === 'string' ? m.model.trim() : ''
    if (!model) throw uiError(UI.rpcRoutineModelEmpty)
    const levels: ThinkingSetting[] = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const thinking = m.thinking && levels.includes(m.thinking as ThinkingSetting) ? (m.thinking as ThinkingSetting) : null
    return { providerId: p.id, model, thinking }
  }

  // ---- fase catalogo app (P4): lo stato del collegamento «in un passo» ----

  /** L'intenzione di collegare un'app appena il login di Composio riesce (10 minuti, UNA sola). */
  let appConnectIntent: { appId: string; slug: string; name: string; at: number } | null = null
  const APP_INTENT_TTL_MS = 10 * 60_000
  /** il login di Composio in corso (un secondo clic lo RIUSA, non lo doppia) */
  let composioLoginInFlight: Promise<unknown> | null = null

  /**
   * La riga dell'elenco app per id: la stessa fusione PUra di loadAppCatalog,
   * con le curate static «pronte» solo se il client OAuth è davvero salvato.
   */
  const resolveAppRow = async (appId: string) => {
    const { loadAppCatalog } = await import('../shared/app-catalog')
    const staticReady = new Set<string>()
    if (connectors) {
      for (const e of connectors.catalog) {
        if (e.gateway || e.clientRegistration !== 'static') continue
        if (await connectors.hasStaticClient(e.id)) staticReady.add(e.id)
      }
    }
    return loadAppCatalog({ staticClientsReady: staticReady }).find((r) => r.id === appId) ?? null
  }

  /**
   * Il login di Composio con l'intenzione in mano: quando il connettore risulta
   * connesso (e l'intenzione è ancora viva e non scaduta) il daemon prosegue
   * DA SOLO con connectApp per l'app scelta. Un secondo clic mentre il login
   * gira non parte un secondo flusso: sostituisce l'intenzione e aspetta.
   */
  const runComposioLoginWithIntent = async (): Promise<void> => {
    if (composioLoginInFlight || !connectors) return
    const entry = connectors.catalog.find((e) => e.id === 'composio')
    if (!entry) return
    const promise = connectors.runConnect(entry)
    composioLoginInFlight = promise
    try {
      const r = await promise
      if (r.status === 'connected') await notifyConnectorConnected(entry.id, entry.name, emit, worker)
      const intent = appConnectIntent
      if (r.status === 'connected' && intent && Date.now() - intent.at <= APP_INTENT_TTL_MS && opts.composioGateway) {
        appConnectIntent = null
        await opts.composioGateway.connectApp(intent.slug, intent.name)
        return
      }
      appConnectIntent = null
    } catch {
      appConnectIntent = null
    } finally {
      composioLoginInFlight = null
    }
    emit({ type: 'connectors' })
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
        // fase 18a (E0): UiText del catalogo, formato nella lingua dell'interfaccia
        const err = avatarValidationError(p.avatar)
        if (err) throw new Error(formatUi(err, uiLanguage()))
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
    'agents:delete': async ([id]) => {
      loop.interrupt(id as string)
      cancelAgentJobs(db(), id as string)
      const elections = store.deleteAgent(id as string)
      // fase 16b (S1.1): i gruppi che hanno eletto un nuovo coordinatore
      // ricevono la riga di sistema nel gruppo
      if (elections.length) {
        const groups = await import('../main/store/groups')
        const { coordinatorNowText } = await import('../main/agent/group-turns')
        for (const el of elections) {
          const name = store.getAgent(el.coordinatorId)?.name ?? el.coordinatorId
          groups.addGroupMessage({
            groupId: el.groupId, authorKind: 'system', authorId: null, authorName: 'sistema',
            text: coordinatorNowText(name)
          })
        }
        emit({ type: 'groups' })
      }
      emit({ type: 'agents' })
    },
    // fase 7: il bot principale è UNO (setting mainAgentId) — si cambia dalle
    // impostazioni dell'agente ("Rendi principale")
    'agents:set-main': ([id]) => {
      const a = store.getAgent(id as string)
      if (!a) throw uiError(UI.rpcAgentNotFound)
      store.setSetting('mainAgentId', a.id)
      emit({ type: 'agents' })
      return { ok: true }
    },

    // ---- fase 7: template dei bot + kickstart ----
    'templates:list': () => loadTemplates(),
    'agents:create-from-template': async ([templateId]) => {
      const t = templateById(String(templateId))
      if (!t) throw uiError(UI.rpcTemplateUnknown, { id: String(templateId) })
      // fase 17c (C4/C5): nome/descrizione e kickstart nella lingua dell'utente
      const { pickLang } = await import('../shared/localized')
      const kickLang = currentUserLanguage()
      const a = store.createAgent(pickLang(t.name, kickLang), pickLang(t.description, kickLang))
      // fase 16c (C3.3/C7): con models.main il bot da template nasce «Come gli
      // altri» (null/null: seguirà il principale); senza, il turno di sempre —
      // provider attivo e modello PREDEFINITO (capability "tools" verificata)
      const { assignDefaultModel, newAgentModel } = await import('../main/agent/model-defaults')
      type ModelDefaultsMap = import('../main/agent/model-defaults').ModelDefaultsMap
      if (newAgentModel(store.getSetting<MainModel | null>('models.main', null)) === 'assign-default') {
        const assignment = await assignDefaultModel({
          listProviders: () => store.listProviders(),
          getOverrides: () => store.getSetting<ModelDefaultsMap>('providers.modelDefaults', {}),
          supportsTools: (p, model) => {
            const full = providers.getProvider(p.id)
            return full ? providers.modelSupportsTools(full, model) : Promise.resolve({ ok: false, checked: false, error: uiText(UI.rpcProviderNotFoundLower) })
          }
        })
        if (assignment) store.updateAgent(a.id, { providerId: assignment.providerId, model: assignment.model })
      }
      // il kickstart parte come job della coda: un riavvio a metà lo riprende
      // come gli altri turni (payload.entryId, fase 2)
      const now = Date.now()
      enqueueJob(db(), {
        agentId: a.id,
        kind: 'user-message',
        payload: {
          text: buildKickstartMessage(t, kickLang),
          initiator: 'TEMPLATE_IMPORT',
          extraMeta: { templateName: pickLang(t.name, kickLang) }
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

    // ---- fase 19a (V3): lo schermo del bot ----
    'screen:open': async ([agentId, mode]) => {
      const { screenOpen } = await import('../main/agent/screen')
      return screenOpen(String(agentId ?? ''), mode === 'control' ? 'control' : 'view')
    },
    'screen:release': async ([agentId, note]) => {
      const { screenRelease } = await import('../main/agent/screen')
      return screenRelease(String(agentId ?? ''), typeof note === 'string' ? note : undefined)
    },
    'screen:status': async ([agentId]) => {
      const { screenStatus } = await import('../main/agent/screen')
      return screenStatus(String(agentId ?? ''))
    },

    // ---- fase 19b (T2/T3/T4): terminale, file e attività del computer ----
    /** terminal:open — capability monouso per l'endpoint /term/<cap> (solo docker) */
    'terminal:open': async ([agentId]) => {
      const { terminalOpen } = await import('../main/agent/terminal')
      return terminalOpen(String(agentId ?? ''))
    },
    'files:list': async ([agentId, path]) => {
      const { listBotFiles } = await import('../main/agent/computer-files')
      return listBotFiles(String(agentId ?? ''), path)
    },
    'files:read': async ([agentId, path]) => {
      const { readBotFile } = await import('../main/agent/computer-files')
      return readBotFile(String(agentId ?? ''), path)
    },
    // files:export e files:import NON sono canali della UI: li chiama SOLO il
    // main dopo il dialog del Mac (il renderer non vede né sceglie mai un
    // path del Mac se non da quei dialog o dal trascinamento)
    'files:export': async ([agentId, path, macPath]) => {
      const { exportBotFile } = await import('../main/agent/computer-files')
      return exportBotFile(String(agentId ?? ''), path, macPath)
    },
    'files:import': async ([agentId, dirPath, macPath, overwrite]) => {
      const { importMacFile } = await import('../main/agent/computer-files')
      return importMacFile(String(agentId ?? ''), dirPath, macPath, overwrite === true ? true : undefined)
    },
    'activity:list': async ([agentId, limit]) => {
      const { listComputerActivity } = await import('../main/agent/computer-activity')
      return listComputerActivity(String(agentId ?? ''), Number(limit) || undefined)
    },
    'activity:output': async ([agentId, id]) => {
      const { computerActivityOutput } = await import('../main/agent/computer-activity')
      return { text: await computerActivityOutput(String(agentId ?? ''), String(id ?? '')) }
    },

    // ---- fase 16c (C5): l'Attività globale ----
    /**
     * I dati del feed Attività: task di tutti i bot, esecuzioni delle routine
     * (routine_runs) e i bot che aspettano te. L'ordine, i filtri e la ricerca
     * li fa la funzione pura activityRows del renderer — qui solo i dati.
     */
    'activity:global': async ([limit]) => {
      const { listRoutineRuns } = await import('../main/store/routine-runs')
      const cap = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 500) : 200
      const tasks = store.listTasks().slice(0, cap).map((t) => ({
        id: t.id,
        agentId: t.agent_id,
        title: t.title,
        status: t.status as 'working' | 'needs_input' | 'done' | 'failed' | 'cancelled',
        automatic: (t.automatic ?? 0) === 1 ? (1 as const) : (0 as const),
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        summary: t.summary ?? null
      }))
      const runs = listRoutineRuns(db(), Date.now() - 90 * 86_400_000, cap).map((r) => ({
        id: r.id,
        routineId: r.routine_id,
        agentId: r.agent_id,
        title: r.title,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        outcome: r.outcome,
        reason: r.reason
      }))
      // i bot che aspettano te: approvazione o card in sospeso
      const waiting = store.listAgents().filter((a) => a.status === 'paused-for-approval').map((a) => a.id)
      return { tasks, runs, waiting }
    },

    // ---- fase 16c (C4): la ricerca del registro per la finestra Collega app ----
    'connectors:search-registry': async ([query]) => {
      const q = String(query ?? '').trim()
      if (q.length < 2) return []
      const { registrySearchRows } = await import('../main/connectors/apps-search')
      return registrySearchRows(q)
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
          appendLocalNotice(agentId as string, resumed > 0 ? ui(UI.routinesResumed, { count: resumed }) : ui(UI.noRoutinesToResume))
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
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'draft') throw uiError(UI.rpcDraftNotFound)
      const meta = entry.meta ?? {}
      if (meta.status === 'sent' || meta.status === 'discarded') {
        throw uiError(meta.status === 'sent' ? UI.rpcDraftAlreadySent : UI.rpcDraftAlreadyDiscarded)
      }
      // body modificato inline nella card: persistito prima dell'invio
      // D1: aggiorna anche via.args (l'argomento che verrà davvero inviato)
      if (typeof body === 'string' && body.trim() && body !== message.body) applyDraftBody(message, body)
      const via = message.via
      const notice = (text: UiText): void => {
        appendLocalNotice(aid, text)
      }
      if (!via) {
        notice(ui(UI.rpcDraftNoVia))
        return { ok: false }
      }
      // D1 (difesa in profondità): si eseguono SOLO tool di invio esterno,
      // anche per le bozze salvate nel DB prima della correzione — il click su
      // Invia non può mai eseguire un tool arbitrario lasciato dal modello.
      // Fase 0.3.1001 (M1): lo STESSO classificatore del loop (annotazioni +
      // nome, cfg come sovrascrittura), non più il solo elenco fisso — una
      // bozza con via mcp__ufficio__send_email si può davvero inviare
      const externalCfg = store.getSetting<ExternalSendConfig>('externalSendTools', DEFAULT_EXTERNAL_SEND_TOOLS)
      // fase Composio OAuth (C7 punto 3): la via di una bozza estratta dal
      // blocco è il blocco stesso con UNA sola voce d'invio — si passa anche
      // via.args, così il classificatore la riconosce
      if (!isExternalSend(via.tool, permissions.mcpAnnotationsOf(via.tool), externalCfg, via.args)) {
        // R2 (ritocchi): testo umano col nome dell'app, mai l'id dello strumento
        const app = await sendAppName(via.tool)
        notice(ui(UI.rpcDraftViaRejected, { known: app ? 'yes' : 'no', ...(app ? { app } : {}) }))
        return { ok: false }
      }
      // il click su Invia è il consenso esplicito dell'utente (ha visto tutto il
      // contenuto), ma il gate dei permessi resta in mezzo: una regola blocked
      // nega comunque l'invio
      const verdict = await permissions.check(via.tool, via.args, aid)
      if (verdict.kind === 'deny') {
        const app = await sendAppName(via.tool)
        notice(ui(UI.rpcDraftBlocked, { known: app ? 'yes' : 'no', ...(app ? { app } : {}) }))
        return { ok: false }
      }
      try {
        const { output } = await executeTool(aid, via.tool, via.args)
        // R2 (ritocchi): l'esito (troncato a 2 KB, ripulito) vive nel meta della
        // card; NESSUNA notice di conferma — la card è l'unica conferma
        store.updateEntryMeta(entry.id, {
          ...meta, message, status: 'sent',
          sendResult: redactComposioSecrets(output.slice(0, 2048))
        })
        emitUpdatedEntry(aid, entry.id)
        return { ok: true }
      } catch (e) {
        store.updateEntryMeta(entry.id, { ...meta, message, status: 'error' })
        emitUpdatedEntry(aid, entry.id)
        notice(ui(UI.rpcDraftSendError, { error: redactComposioSecrets(e instanceof Error ? e.message : String(e)) }))
        return { ok: false }
      }
    },
    'draft:discard': ([agentId, entryId]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((x) => x.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'draft') throw uiError(UI.rpcDraftNotFound)
      if (entry.meta?.status === 'sent') throw uiError(UI.rpcDraftAlreadySent)
      store.updateEntryMeta(entry.id, { ...(entry.meta ?? {}), status: 'discarded' })
      emitUpdatedEntry(aid, entry.id)
      return { ok: true }
    },
    'draft:update': ([agentId, entryId, body]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((x) => x.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'draft') throw uiError(UI.rpcDraftNotFound)
      if (entry.meta?.status === 'sent' || entry.meta?.status === 'discarded') throw uiError(UI.rpcDraftAlreadyClosed)
      // D1: il body modificato aggiorna anche via.args (il campo mappato sul corpo)
      applyDraftBody(message, String(body ?? ''))
      store.updateEntryMeta(entry.id, { ...(entry.meta ?? {}), message })
      emitUpdatedEntry(aid, entry.id)
      return { ok: true }
    },

    // ---- quick-ask (domanda effimera, non inquina il transcript) ----
    quickask: async ([agentId, question]) => {
      // fase 17b (A2): la domanda della quick ask è testo di una persona
      noteHumanText(String(question ?? ''))
      const agent = store.getAgent(agentId as string)
      // fase 16c (C3.3): il modello risolto («Come gli altri» compreso)
      const { resolveAgentModel } = await import('../main/agent/model-defaults')
      const resolved = agent ? resolveAgentModel(agent, store.getSetting<MainModel | null>('models.main', null)) : null
      if (!resolved) throw uiError(UI.rpcConfigureProvider)
      const provider = providers.getProvider(resolved.providerId)
      if (!provider) throw uiError(UI.rpcProviderNotFound)
      // fase 3: ciò che il bot ha DETTO all'utente sono le send-message (il
      // testo libero è ragionamento interno e non entra nel contesto)
      const context = store.getEntries(agentId as string)
        .slice(-20)
        .filter((e) => e.kind === 'message' || e.kind === 'send-message')
        .map((e) => `${e.role === 'user' ? 'USER' : 'BOT'}: ${e.content.slice(0, 400)}`)
        .join('\n')
      const prompt = secondaryPrompts.quickAsk(context, question as string, currentUserLanguage())
      const controller = new AbortController()
      const stream = llmStream(provider, resolved.model, [{ role: 'user', content: prompt }], [], controller.signal)
      let acc = ''
      let usage: import('../main/agent/llm').LlmChunk['usage'] | undefined
      for await (const ch of stream) {
        if (ch.textDelta) acc += ch.textDelta
        if (ch.usage) usage = ch.usage
      }
      // fase 18a (E4): uso registrato della quick ask
      if (usage) {
        store.recordModelUsage({
          agentId: agentId as string,
          providerId: provider.id,
          providerKind: provider.kind,
          model: resolved.model,
          source: 'quick-ask',
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          costUsd: usage.costUsd ?? null
        })
      }
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
    'routines:create': ([agentId, title, prompt, schedule, model]) => {
      // fase 12 (punto 1): niente routine su un SOTTOAGENTE (non è un bot)
      const refusalUi = store.subagentRefusalUi(String(agentId ?? ''))
      // fase 17c: il rifiuto delle routine è SOLO UI (il modello vede la
      // versione inglese nei result dei tool): testo tradotto subito
      if (refusalUi) throw new Error(formatUi(refusalUi, uiLanguage()))
      if (!parseCron(String(schedule))) throw uiError(UI.rpcScheduleInvalid)
      return store.createRoutine(agentId as string, title as string, prompt as string, schedule as string,
        // fase 18b (H7): modello proprio facoltativo, stessa validazione.
        // fase risposta (sonda): l'ipc serializza undefined → null, e null
        // vale come «nessun modello proprio» (prima: TypeError su .providerId)
        model != null ? routineModelPatch(model as Parameters<typeof routineModelPatch>[0]) : {})
    },
    'routines:create-trigger': async ([agentId, title, prompt, trigger, timezone, model]) => {
      // fase 12 (punto 1): niente routine su un SOTTOAGENTE (non è un bot)
      const refusalUi = store.subagentRefusalUi(String(agentId ?? ''))
      if (refusalUi) throw new Error(formatUi(refusalUi, uiLanguage()))
      let t = trigger as RoutineTrigger
      // il webhook nasce col token generato dal server (prima della validazione:
      // il client non lo manda, la UI lo copia dopo la creazione)
      if (t?.type === 'webhook' && !t.token) t = { ...t, token: generateWebhookToken() }
      t = await validateTrigger(t)
      const tz = timezone ? String(timezone) : ''
      if (tz && !isValidTimeZone(tz)) throw uiError(UI.rpcTzInvalid, { tz })
      const created = store.createRoutine(agentId as string, title as string, prompt as string, cronOfTrigger(t), {
        timezone: tz,
        trigger: t,
        // fase 18b (H7): modello proprio (validato: provider esistente, modello non vuoto)
        ...(model != null ? routineModelPatch(model as Parameters<typeof routineModelPatch>[0]) : {})
      })
      const url = webhookUrl(created)
      return { ...created, ...(url ? { webhook_url: url } : {}) }
    },
    'routines:update-trigger': async ([id, patch]) => {
      const p = (patch ?? {}) as { title?: string; prompt?: string; enabled?: number; paused_for_away?: number; trigger?: RoutineTrigger | null; timezone?: string; providerId?: string | null; model?: string | null; thinking?: string | null }
      const cur = store.getRoutine(id as number)
      if (!cur) throw uiError(UI.rpcRoutineNotFound)
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
        throw uiError(UI.rpcTzInvalid, { tz: p.timezone })
      }
      // fase 18b (H7): il modello proprio si aggiorna SOLO se la patch lo tocca
      const hasModel = p.providerId !== undefined || p.model !== undefined || p.thinking !== undefined
      const modelPatch = hasModel
        ? routineModelPatch({
            providerId: p.providerId !== undefined ? p.providerId : cur.providerId,
            model: p.model !== undefined ? p.model : cur.model,
            thinking: p.thinking !== undefined ? p.thinking : cur.thinking
          })
        : null
      store.updateRoutine(id as number, {
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
        ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
        ...(p.paused_for_away !== undefined ? { paused_for_away: p.paused_for_away } : {}),
        ...(p.timezone !== undefined ? { timezone: p.timezone } : {}),
        ...(final !== undefined ? { trigger: final, schedule: cronOfTrigger(final) } : {}),
        ...(modelPatch ? modelPatch : {})
      })
      const updated = store.getRoutine(id as number)
      const url = updated ? webhookUrl(updated) : undefined
      return updated ? { ...updated, ...(url ? { webhook_url: url } : {}) } : null
    },
    'routines:update': ([id, patch]) => {
      if (patch && typeof patch === 'object' && 'schedule' in (patch as Record<string, unknown>) && !parseCron(String((patch as Record<string, unknown>).schedule))) {
        throw uiError(UI.rpcScheduleInvalid)
      }
      store.updateRoutine(id as number, patch as Parameters<typeof store.updateRoutine>[1])
    },
    'routines:delete': ([id]) => {
      store.deleteRoutine(id as number)
    },
    'routines:suggest': ([agentId]) => suggestRoutines(agentId as string),

    // ---- fase 6: presenza (§3ter T2) e consegna dell'outbox ----
    'presence:signal': ([kind]) => {
      if (!presence) throw uiError(UI.rpcPresenceUnavailable)
      presence.onSignal(kind === 'typing' ? 'typing' : 'active')
    },
    'presence:viewing': ([agentId]) => {
      if (!presence) throw uiError(UI.rpcPresenceUnavailable)
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
      if (!t) throw uiError(UI.rpcTaskNotFound)
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
      if (!row) throw uiError(UI.rpcSubagentNotFound)
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
        authorName: m.author_name, text: m.text, replyTo: m.reply_to, createdAt: m.created_at,
        // fase 16b (S1.2): il riepilogo di chiusura del coordinatore
        summary: m.summary === 1
      }))
    },
    'groups:send-user': async ([groupId, text]) => {
      // l'utente scrive nel gruppo: messaggio depth 0 (apre la catena) e
      // pianificazione dei turni per i membri
      const groups = await import('../main/store/groups')
      const g = groups.getGroup(Number(groupId))
      if (!g) throw uiError(UI.rpcGroupNotFound)
      const t = String(text ?? '').trim()
      if (!t) throw uiError(UI.rpcTextMissing)
      // fase 17b (A2): il post dell'utente nel gruppo è testo di una persona
      noteHumanText(t)
      const msg = groups.addGroupMessage({
        // fase 17c correzioni (D2): authorName inglese — il MODELLO lo legge
        // come "[user] user: …"; la UI non mostra il nome dell'utente (bolla a destra)
        groupId: g.id, authorKind: 'user', authorId: null, authorName: 'user', text: t, depth: 0
      })
      groups.scheduleTurnsForMessage(msg, emit)
      emit({ type: 'groups' })
      worker.poke()
      return { ok: true, id: msg.id }
    },

    // ---- fase 16b (S1.3): squadre create e modificate dalla UI ----

    'groups:create': async ([name, memberIds, coordinatorId, description]) => {
      const groups = await import('../main/store/groups')
      const n = String(name ?? '').trim()
      if (!n) throw uiError(UI.rpcGroupNameMissing)
      const members = [...new Set((Array.isArray(memberIds) ? memberIds : []).map((m) => String(m)))]
      const agents = store.listAgents()
      // fase 12 (punto 1): un id di figlio non è un bot
      for (const id of members) {
        const refusal = store.subagentRefusal(id)
        if (refusal) throw new Error(refusal)
      }
      const missing = members.filter((id) => !agents.some((a) => a.id === id))
      if (missing.length) throw uiError(UI.rpcGroupMemberUnknown, { ids: missing.join(', ') })
      const coord = String(coordinatorId ?? '')
      if (!coord) throw uiError(UI.rpcGroupCoordinatorRequired)
      if (!members.includes(coord)) throw uiError(UI.rpcGroupCoordinatorNotMember)
      if (members.length < 1 || members.length > MAX_GROUP_MEMBERS) throw uiError(UI.rpcGroupMembersRange)
      // created_by 'user': la crea l'utente — niente card di approvazione
      const group = groups.createGroup(n, String(description ?? '').trim(), 'user', members, coord)
      emit({ type: 'groups' })
      return groups.groupWithMembers(group)
    },

    'groups:update': async ([groupId, patch]) => {
      const groups = await import('../main/store/groups')
      const gid = Number(groupId)
      const g = groups.getGroup(gid)
      if (!g) throw uiError(UI.rpcGroupNotFound)
      const p = (patch ?? {}) as { name?: string; description?: string; addMemberIds?: string[]; removeMemberIds?: string[]; coordinatorId?: string }
      const add = [...new Set(Array.isArray(p.addMemberIds) ? p.addMemberIds.map((m) => String(m)) : [])]
      const remove = [...new Set(Array.isArray(p.removeMemberIds) ? p.removeMemberIds.map((m) => String(m)) : [])]
      // fase 16b correzioni (P4): l'ESITO si valida PRIMA di modificare —
      // membri finali = (attuali + aggiunte − rimozioni), 1 ≤ n ≤ 6: una
      // squadra non può restare senza bot né scavalcare il tetto. Rifiuto
      // senza toccare nulla (nome e descrizione compresi).
      const finalMembers = new Set([...groups.groupMemberIds(gid), ...add].filter((id) => !remove.includes(id)))
      if (finalMembers.size < 1 || finalMembers.size > MAX_GROUP_MEMBERS) throw uiError(UI.rpcGroupMembersRange)
      // seconda regola: se la patch porta un coordinatorId, il nuovo
      // coordinatore deve stare fra i membri FINALI
      if (p.coordinatorId !== undefined) {
        const coord = String(p.coordinatorId ?? '')
        if (!coord || !finalMembers.has(coord)) throw uiError(UI.rpcGroupCoordinatorNotMember)
      }
      if (p.name !== undefined && String(p.name).trim()) groups.updateGroup(gid, { name: String(p.name).trim() })
      if (p.description !== undefined) groups.updateGroup(gid, { description: String(p.description ?? '').trim() })
      const agents = store.listAgents()
      for (const id of add) {
        const refusal = store.subagentRefusal(id)
        if (refusal) throw new Error(refusal)
      }
      const missing = add.filter((id) => !agents.some((a) => a.id === id))
      if (missing.length) throw uiError(UI.rpcGroupMemberUnknown, { ids: missing.join(', ') })
      for (const id of add) groups.addGroupMember(gid, id)
      let coordinatorChanged = false
      for (const id of remove) {
        // S1.1: se il coordinatore lascia, il primo membro rimasto prende il
        // posto (removeGroupMember elegge da sé) e la riga di sistema lo dice
        const r = groups.removeGroupMember(gid, id)
        groups.cancelMemberGroupJobs(db(), gid, id)
        if (r.coordinatorChanged) coordinatorChanged = true
      }
      if (p.coordinatorId !== undefined) {
        const coord = String(p.coordinatorId ?? '')
        if (!coord || !groups.isGroupMember(gid, coord)) throw uiError(UI.rpcGroupCoordinatorNotMember)
        if (coord !== groups.getGroup(gid)?.coordinator_id) {
          groups.updateGroup(gid, { coordinator_id: coord })
          coordinatorChanged = true
        }
      }
      const updated = groups.getGroup(gid)
      if (!updated) throw uiError(UI.rpcGroupNotFound)
      if (coordinatorChanged && updated.coordinator_id) {
        const name = store.getAgent(updated.coordinator_id)?.name ?? updated.coordinator_id
        const { coordinatorNowText } = await import('../main/agent/group-turns')
        groups.addGroupMessage({
          groupId: gid, authorKind: 'system', authorId: null, authorName: 'sistema',
          text: coordinatorNowText(name)
        })
      }
      emit({ type: 'groups' })
      return groups.groupWithMembers(updated)
    },

    'groups:delete': async ([groupId]) => {
      const groups = await import('../main/store/groups')
      const gid = Number(groupId)
      if (!groups.getGroup(gid)) throw uiError(UI.rpcGroupNotFound)
      // squadra e messaggi; i bot restano (anche i job in coda se ne vanno)
      groups.deleteGroup(db(), gid)
      emit({ type: 'groups' })
      return { ok: true }
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
      // R1: anche il server manuale ha un toolSlug STABILE (se non ce l'ha già)
      const incoming = s as Parameters<typeof x.saveServers>[0][number]
      if (!incoming.toolSlug) {
        const { toolSlugKeeping } = await import('../main/mcp/slug')
        incoming.toolSlug = toolSlugKeeping(x.listServers(), incoming.id, incoming.name)
      }
      x.saveServers([...x.listServers().filter((y) => y.id !== (s as { id: string }).id), incoming])
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
          // K1.8 (fase rilascio — correzioni): il testo del catalogo di
          // MasterKeyUnavailableError arriva intero, non incapsulato
          if (isMasterKeyUnavailableError(e)) throw e
          throw uiError(UI.rpcSecretSaveFailed, { error: e instanceof Error ? e.message : String(e) })
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
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
      return connectors.list()
    },
    'connectors:connect': async ([id]) => {
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
      const entry = connectors.catalog.find((e) => e.id === id)
      if (!entry) throw uiError(UI.rpcConnectorUnknown, { id: String(id) })
      // fase Composio OAuth (C6): le due strade di Composio non possono essere
      // attive insieme (gli strumenti si doppiano) — attivare il login chiede
      // prima di disattivare la chiave di progetto
      if (entry.id === 'composio' && opts.composio && (await opts.composio.status()).active) {
        return { started: false, conflict: 'composio-key' as const }
      }
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
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
      return connectors.disconnect(String(id))
    },
    'connectors:set-tools': ([id, disabledTools]) => {
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
      connectors.setDisabledTools(String(id), (disabledTools as string[]) ?? [])
    },
    'connectors:set-instructions': ([id, instructions]) => {
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
      connectors.setInstructions(String(id), String(instructions ?? ''))
    },
    'connectors:save-static': ([id, clientId, clientSecret]) => {
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
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
        // fase mcp-setup (M6.1): lo stato dell'ULTIMA PROVA del server — la
        // riga della finestra App dice «Connessa» solo se è davvero partito
        const stateStatus = states[s.id]?.status
        servers.push({ ...s, needsReauth, stateStatus, ...(neverAuthorized !== undefined ? { neverAuthorized } : {}) })
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
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'mcp-server') throw uiError(UI.rpcMcpProposalNotFound)
      const status = entry.meta?.status as string | undefined
      // L8: lo stato 'installing' si segna PRIMA di iniziare — due click ravvicinati
      // non installano due volte
      if (status === 'installed' || status === 'declined') throw uiError(UI.rpcProposalHandled)
      if (status === 'installing') throw uiError(UI.rpcInstalling)
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
      // fase mcp-setup (M5.2): se il server è GIÀ partito (niente da
      // configurare), il bot riceve subito CONNECTOR_CONNECTED; se invece
      // serve il modulo, la notifica arriva dal clic di «Accedi con…»
      if (r.ok) {
        const { serverIdFor, parseMcpServerId } = await import('../main/connectors/install')
        const parsed = parseMcpServerId(message.id)
        const sid = message.serverId
          ?? ('error' in parsed ? null
            : parsed.kind === 'registry' ? serverIdFor({ kind: 'registry', name: parsed.name })
              : serverIdFor({ kind: 'url', url: parsed.url }))
        const cfg = sid ? (await mcp()).listServers().find((s) => s.id === sid) : null
        if (cfg && !cfg.needsAuth) await notifyMcpServerConnected([message.id], cfg, emit, worker)
      }
      // fase 17c (C2, MU): il testo per il modello resta inglese; meta.ui
      // dice alla UI cosa mostrare nella lingua dell'interfaccia
      const text = r.ok ? `[sistema] ${r.message}` : `[sistema] Server "${message.name}" NOT added: ${r.error}`
      enqueueUserMessage(db(), aid, text, undefined, emit, undefined, 'CONNECTOR_INSTALLED', {
        ui: r.ok ? ui(UI.sistemaServerAdded, { name: message.name }) : ui(UI.sistemaServerAddFailed, { name: message.name, error: r.error })
      })
      worker.poke()
      return r
    },
    /** Il click su Installa/No della card "Installa plugin" (codice del daemon). */
    'plugins:resolve': async ([agentId, entryId, decision]) => {
      const aid = agentId as string
      const entry = store.getEntries(aid).find((e) => e.id === (entryId as number))
      const message = entry?.meta?.message as SendMessagePayload | undefined
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'plugin') throw uiError(UI.rpcPluginProposalNotFound)
      const status = entry.meta?.status as string | undefined
      // L8: come la card del server — 'installing' prima di iniziare
      if (status === 'installed' || status === 'declined') throw uiError(UI.rpcProposalHandled)
      if (status === 'installing') throw uiError(UI.rpcInstalling)
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
      // fase 17c (C2, MU): come la card del server — testo inglese al modello, ui alla vista
      const text = r.ok ? `[sistema] ${r.message}` : `[sistema] Plugin "${message.name}" NOT installed: ${r.error}`
      enqueueUserMessage(db(), aid, text, undefined, emit, undefined, 'PLUGIN_INSTALLED', {
        ui: r.ok ? ui(UI.sistemaPluginInstalled, { name: message.name }) : ui(UI.sistemaPluginInstallFailed, { name: message.name, error: r.error })
      })
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
      if (!(kindStr in SECRET_KIND)) throw uiError(UI.rpcInvalidValueType, { kind: String(kind) })
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
    /** Abilitazione per bot: server MCP, plugin (scheda Installati) o toolkit Composio (fase app A5). */
    'connectors:set-enabled-for': async ([kind, id, agentIds]) => {
      const ids = Array.isArray(agentIds) ? agentIds.map(String) : []
      const mcpMod = await mcp()
      if (kind === 'composio') {
        if (!opts.composio) throw uiError(UI.composioNotActive)
        opts.composio.setEnabledFor(String(id ?? ''), ids)
        return { ok: true }
      }
      if (kind === 'server') {
        const servers = mcpMod.listServers()
        const cfg = servers.find((x) => x.id === id)
        if (!cfg) throw uiError(UI.rpcServerNotFound, { id: String(id) })
        cfg.enabledFor = ids.includes('*') ? ['*'] : ids
        mcpMod.saveServers(servers)
        return { ok: true }
      }
      const { installedPlugins, PLUGINS_SETTING } = await import('../main/connectors/install')
      const all = installedPlugins({ getSetting: store.getSetting })
      const idx = all.findIndex((x) => x.name === String(id))
      if (idx < 0) throw uiError(UI.rpcPluginNotFound, { id: String(id) })
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
    /**
     * Fase mcp-setup (M3): lo spec del modulo di configurazione di un server
     * installato (card M4 e foglio M6). Le variabili si rileggono dalla voce
     * del registro; i SEGRETI non tornano mai (solo il flag «salvato»).
     */
    'connectors:server-setup': async ([id]) => {
      const { serverSetupSpec } = await import('../main/connectors/install')
      const spec = await serverSetupSpec(String(id), (await installBridge()).getInstallDeps())
      // M6.1: lo stato dell'ultima prova — la card dice «✓ collegato» solo se
      // il server è partito DAVVERO (prove fatte altrove comprese)
      if (spec) spec.stateStatus = store.getSetting<Record<string, { status?: string }>>('connectors.state', {})[String(id)]?.status
      return spec
    },
    /**
     * Fase mcp-setup (M3): il clic su «Accedi con <Nome>» / «Collega» del
     * modulo — salva i valori (i segreti SOLO nello store cifrato), prova la
     * connessione (OAuth col browser quando serve) e avvisa il bot (M5.2).
     */
    'connectors:server-connect': async ([id, input]) => {
      const { connectServerSetup } = await import('../main/connectors/install')
      const i = (input ?? {}) as { vars?: Record<string, string>; token?: string }
      const r = await connectServerSetup(String(id), i, (await installBridge()).getInstallDeps(), store.getSetting, store.setSetting)
      emit({ type: 'connectors' })
      if (r.ok) {
        // M5.2: il bot che ha proposto il server riceve CONNECTOR_CONNECTED
        const cfg = (await mcp()).listServers().find((s) => s.id === id)
        if (cfg?.source?.kind === 'registry') {
          await notifyMcpServerConnected([`registry:${cfg.source.name}`, `url:${cfg.source.name}`], cfg, emit, worker)
        }
      }
      return r
    },
    /** Disinstallazione di un plugin: cartelle (Mac e box), server, skill. */
    'plugins:uninstall': async ([name, marketplace]) => {
      const { installedPlugins, uninstallPlugin } = await import('../main/connectors/install')
      const { getInstallDeps } = await import('../main/connectors/install-bridge')
      const all = installedPlugins({ getSetting: store.getSetting })
      const rec = all.find((x) => x.name === String(name) && x.marketplace === String(marketplace))
      if (!rec) throw uiError(UI.rpcPluginNotFoundPlain)
      await uninstallPlugin(rec, getInstallDeps(), store.setSetting, store.getSetting)
      emit({ type: 'connectors' })
      return { ok: true }
    },
    /** Marketplace registrati (scheda Marketplace). */
    'marketplace:list': async () => {
      if (!opts.marketplaces) throw uiError(UI.rpcMarketplacesUnavailable)
      return opts.marketplaces.list()
    },
    'marketplace:add': ([source]) => {
      if (!opts.marketplaces) throw uiError(UI.rpcMarketplacesUnavailable)
      return opts.marketplaces.add(String(source ?? ''))
    },
    'marketplace:remove': ([source]) => {
      if (!opts.marketplaces) throw uiError(UI.rpcMarketplacesUnavailable)
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
      // fase 17c (C3): l'avviso del gateway è nel catalogo UI
      const { GATEWAY_PRESETS } = await import('../main/connectors/install')
      return { presets: GATEWAY_PRESETS, warning: uiText(UI.installGatewayWarning) }
    },
    /** Impostazione CIMD (punto 6): l'URL del documento ospitato dall'utente. */
    'connectors:set-client-metadata-url': ([url]) => {
      store.setSetting('connectors.oauth.clientMetadataUrl', String(url ?? ''))
      return { ok: true }
    },

    // ---- fase app: Composio con la chiave dell'utente (A2–A4) ----
    // Tutta la logica sta nel manager del daemon (connectors/composio.ts); la
    // chiave NON torna MAI al renderer (solo hasKey e le ultime 4 cifre)
    'composio:status': () => {
      if (!opts.composio) throw uiError(UI.composioNotActive)
      return opts.composio.status()
    },
    'composio:set-key': ([key]) => {
      if (!opts.composio) throw uiError(UI.composioNotActive)
      const r = opts.composio.setKey(String(key ?? ''))
      if (!r.ok) throw uiError(UI.composioKeyInvalid)
      return r
    },
    'composio:test': async () => {
      if (!opts.composio) throw uiError(UI.composioNotActive)
      // fase Composio OAuth (C6): le due strade non insieme — con il login
      // attivo la prova della chiave chiede prima di disattivarlo
      if (opts.composioGateway && opts.composioGateway.status().active) {
        return { ok: false, reason: 'gateway-active' as const }
      }
      return opts.composio.test()
    },
    'composio:disable': () => {
      if (!opts.composio) throw uiError(UI.composioNotActive)
      return opts.composio.disable()
    },
    // fase catalogo app (P7): niente più 'composio:catalog' per la finestra
    // App — l'elenco è il file CURATO nel repo (shared/app-catalog); il
    // metodo catalog() del manager resta per il bot (offer_connector/search)
    'composio:connect': ([slug]) => {
      if (!opts.composio) throw uiError(UI.composioNotActive)
      const r = opts.composio.connect(String(slug ?? ''))
      if (r.error === 'not-active') throw uiError(UI.composioNotActive)
      return r
    },
    'composio:disconnect': ([slug]) => {
      if (!opts.composio) throw uiError(UI.composioNotActive)
      return opts.composio.disconnect(String(slug ?? ''))
    },

    // ---- fase Composio OAuth (C5): le app dentro il server Composio ----
    'composio-gateway:status': () => {
      if (!opts.composioGateway) throw uiError(UI.composioNotActive)
      return opts.composioGateway.status()
    },
    'composio-gateway:refresh': () => {
      if (!opts.composioGateway) throw uiError(UI.composioNotActive)
      return opts.composioGateway.refreshAccounts().then(() => opts.composioGateway!.status())
    },
    'composio-gateway:connect': ([slug, name]) => {
      if (!opts.composioGateway) throw uiError(UI.composioNotActive)
      return opts.composioGateway.connectApp(String(slug ?? ''), typeof name === 'string' ? name : undefined)
    },
    'composio-gateway:remove': ([slug]) => {
      if (!opts.composioGateway) throw uiError(UI.composioNotActive)
      return opts.composioGateway.removeApp(String(slug ?? ''))
    },
    'composio-gateway:cancel': () => {
      if (!opts.composioGateway) throw uiError(UI.composioNotActive)
      opts.composioGateway.cancelWait()
      return { ok: true }
    },
    'composio-gateway:card-connect': ([key]) => {
      if (!opts.composioGateway) throw uiError(UI.composioNotActive)
      return opts.composioGateway.cardConnect(String(key ?? ''))
    },

    // ---- fase catalogo app (P4): «Connetti» in un passo ----
    // La RIGA dell'elenco decide la strada: la diretta se è pronta senza
    // configurazione (dynamic, o static col client OAuth salvato), altrimenti
    // Composio. Se Composio non è ancora «entrato», parte il login e
    // l'intenzione di collegare l'app scelta sta NEL DEMONTE (il renderer può
    // chiudere la finestra): scade dopo 10 minuti ed è UNA sola alla volta —
    // un secondo clic la sostituisce.
    'apps:connect': async ([appId]) => {
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
      const row = await resolveAppRow(String(appId ?? ''))
      if (!row) return { started: false as const, reason: 'unknown-app' as const }
      if (row.via === 'direct' && row.directId) {
        const entry = connectors.catalog.find((e) => e.id === row.directId)
        if (!entry) return { started: false as const, reason: 'unknown-app' as const }
        void connectors.runConnect(entry).then(async (r) => {
          if (r.status === 'connected') await notifyConnectorConnected(entry.id, entry.name, emit, worker)
        })
        return { started: true as const, phase: 'direct' as const }
      }
      const slug = row.composioSlug
      if (!slug) return { started: false as const, reason: 'unknown-app' as const }
      // C6: con la chiave di progetto attiva le due strade non stanno insieme
      // — la risposta dice «conflict» e la UI propone di disattivarla
      if (opts.composio && (await opts.composio.status()).active) {
        return { started: false as const, conflict: 'composio-key' as const }
      }
      if (opts.composioGateway?.status().active) {
        void opts.composioGateway.connectApp(slug, row.name)
        return { started: true as const, phase: 'app' as const }
      }
      // non ancora entrato: login di Composio ora, l'app appena il login riesce
      appConnectIntent = { appId: row.id, slug, name: row.name, at: Date.now() }
      emit({ type: 'connectors' })
      void runComposioLoginWithIntent()
      return { started: true as const, phase: 'login' as const }
    },

    /** Annulla sempre disponibile durante l'attesa: l'intenzione se ne va, l'attesa dell'app si ferma. */
    'apps:cancel-connect': async ([appId]) => {
      if (!connectors) throw uiError(UI.rpcConnectorsUnavailable)
      const row = await resolveAppRow(String(appId ?? ''))
      const slug = row?.composioSlug ?? null
      const mine = appConnectIntent !== null && (appConnectIntent.appId === String(appId ?? '') || appConnectIntent.slug === slug)
      if (mine) appConnectIntent = null
      if (slug && opts.composioGateway?.status().pending?.slug === slug) opts.composioGateway.cancelWait()
      else if (mine && connectors.stateOf('composio').status !== 'connected') {
        // il login era partito per l'app annullata: si ferma anche quello
        void connectors.disconnect('composio')
      }
      emit({ type: 'connectors' })
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
      // fase 18a (E0): errore RPC della UI dal catalogo
      if (kind !== 'secret' && kind !== 'login' && kind !== 'contact') throw uiError(UI.rpcInvalidKind, { kind: String(kind) })
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
      if (!entry || message?.type !== 'secure-input') throw uiError(UI.rpcFormNotFound)
      const v = (values ?? {}) as Record<string, string>
      let outcome: string
      if (message.kind === 'login') {
        const origin = String(v.origin ?? message.origin ?? '').trim()
        if (!origin || !v.username || !v.password) throw uiError(UI.rpcLoginValuesMissing)
        const label = String(v.label ?? message.label ?? '').trim() || 'Login'
        const id = await vault().then((x) => x.saveLogin({
          label, origins: [origin], username: v.username, password: v.password,
          ...(v.totp ? { totp: v.totp } : {})
        }))
        outcome = `saved: login "${label}" (${id})`
      } else {
        const name = String(v.name ?? message.name ?? '').trim()
        if (!name || !v.value) throw uiError(UI.rpcSecretValuesMissing)
        await vault().then((x) => x.storeSecret(name, v.value))
        outcome = `saved: secret ${name}`
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
      if (!item) throw uiError(UI.rpcItemNotFound)
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
      if (!file) throw uiError(UI.rpcItemInconsistent)
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
      if (!libraryStore.deleteLibraryItem(String(id))) throw uiError(UI.rpcItemNotFound)
      return { ok: true }
    },
    'library:rename': async ([id, title]) => {
      const libraryStore = await import('../main/store/library')
      if (!libraryStore.getLibraryItem(String(id))) throw uiError(UI.rpcItemNotFound)
      libraryStore.updateLibraryItem(String(id), { title: String(title ?? '').trim() || 'Senza titolo', updatedAt: Date.now() })
      return { ok: true }
    },
    'library:pin': async ([id, pinned]) => {
      const libraryStore = await import('../main/store/library')
      if (!libraryStore.getLibraryItem(String(id))) throw uiError(UI.rpcItemNotFound)
      libraryStore.updateLibraryItem(String(id), { pinned: pinned === true, updatedAt: Date.now() })
      return { ok: true }
    },
    /** Fase 14: "ripristina come nuova versione" — la versione vecchia diventa l'ultima (MAI sovrascritta). */
    'library:restore-version': async ([id, version]) => {
      const lib = await import('../main/agent/library')
      const item = lib.getLibraryItemPublic(String(id))
      if (!item || item.kind !== 'document') throw uiError(UI.rpcDocumentNotFound)
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
      const m = mode === 'always' ? 'always' : mode === 'turn' ? 'turn' : 'once'
      // fase 16b (S6): la modalità finisce nel meta dell'entry — la riga dopo
      // la decisione dice «Consentito una volta / per il turno / sempre»
      const aid = String(agentId)
      const entry = store.getEntries(aid).findLast(
        (x) => (x.kind === 'approval' || x.kind === 'send-message') && x.meta?.approvalId === approvalId
      )
      if (entry) {
        store.updateEntryMeta(entry.id, { ...entry.meta, resolutionMode: m })
        const updated = store.getEntries(aid).find((e) => e.id === entry.id)
        if (updated) emit({ type: 'entries', agentId: aid, entries: [updated] })
      }
      loop.resolveApproval(aid, approvalId as string, decision as 'allow' | 'deny', m)
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
      if (!entry || entry.kind !== 'send-message' || message?.type !== 'rule') throw uiError(UI.rpcRuleProposalNotFound)
      if (entry.meta?.ruleStatus) throw uiError(UI.rpcProposalHandled)
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
    // fase 16c (C1): la chiave NON torna mai al renderer — apiKey sempre '',
    // hasKey e keyHint (ultimi 4) al posto
    'providers:list': () => providers.publicProviders(),
    'providers:save': async ([p]) => {
      await providers.saveProvider(p as import('../main/agent/providers').ProviderSaveInput)
      emit({ type: 'agents' })
      // fase 16c (C3.3): il PRIMO provider collegato diventa il modello
      // principale («Come gli altri») se models.main non c'è ancora.
      // Fase impostazioni (I3): insieme al principale si scrivono anche la
      // RISERVA del tipo (prima voce di models.fallbackChain) e il REVISORE
      // del tipo (autoReview), così la pagina mostra la catena vera
      const { assignFirstMainModel } = await import('../main/agent/model-defaults')
      await assignFirstMainModel({
        getMain: () => store.getSetting<MainModel | null>('models.main', null),
        setMain: (m) => store.setSetting('models.main', m),
        savedProvider: () => providers.getProvider((p as { id: string }).id) ?? null,
        getOverrides: () => store.getSetting<import('../main/agent/model-defaults').ModelDefaultsMap>('providers.modelDefaults', {}),
        supportsTools: (prov, model) => {
          const full = providers.getProvider(prov.id)
          return full ? providers.modelSupportsTools(full, model) : Promise.resolve({ ok: false, checked: false })
        },
        getChain: () => store.getSetting<import('../shared/types').FallbackRoute[]>('models.fallbackChain', []),
        setChain: (chain) => store.setSetting('models.fallbackChain', chain),
        getReviewer: () => ({ ...DEFAULT_AUTO_REVIEW, ...store.getSetting<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW) }),
        setReviewer: (cfg) => store.setSetting('autoReview', cfg)
      })
      // fase 7: l'onboarding fermo sul provider riprende appena ce n'è uno
      if (opts.onboarding) void opts.onboarding.resume().catch(() => undefined)
    },
    'providers:delete': ([id]) => {
      // fase 16c (C3.3): se era il provider del modello principale, models.main si azzera
      providers.deleteProvider(id as string)
      emit({ type: 'agents' })
    },
    'providers:discover': () => providers.discoverProviders(),
    'providers:test': ([id]) => {
      const p = providers.getProvider(id as string)
      return p ? providers.testProvider(p) : { ok: false, error: uiText(UI.rpcProviderNotFoundLower) }
    },
    // fase 16c (C3.4): prova una configurazione NON salvata. La chiave va
    // SOLO in questa direzione: non si salva, non si logga, non torna indietro.
    // Fase 16c correzioni (R2.3): accetta anche { providerId } — per provare
    // un provider GIÀ salvato (per esempio dopo averne cambiato l'indirizzo)
    // senza ridigitare la chiave: si usa quella in memoria nel daemon, che
    // non torna mai indietro
    'providers:probe': ([config]) => {
      const c = (config ?? {}) as { kind?: string; baseUrl?: string; apiKey?: string; providerId?: string }
      const kind = (typeof c.kind === 'string' && c.kind ? c.kind : 'openai-compatible') as ProviderKind
      const baseUrl = String(c.baseUrl ?? '').trim()
      if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: 'error' }
      let apiKey = String(c.apiKey ?? '')
      if (!apiKey && typeof c.providerId === 'string') {
        apiKey = providers.getProvider(c.providerId)?.apiKey ?? ''
      }
      return providers.probeProvider({ kind, baseUrl, apiKey })
    },
    'models:list': async ([providerId]) => {
      const p = providers.getProvider(providerId as string)
      if (!p) throw uiError(UI.rpcProviderNotFoundLower)
      // fase 18b (H5.1): l'UNIONE del catalogo pi-ai (per i 7 kind che lo
      // hanno) e dell'elenco vivo del provider; le capacità di ogni voce
      // vengono da modelCapabilities (cache Ollama e prezzi custom inclusi)
      const prices = store.getSetting<ModelPriceMap>('providers.modelPrices', {})
      const catalog = catalogModelInfos(p, prices)
      let live: ModelInfo[] = []
      let liveError: unknown = null
      try {
        live = await providers.listProviderModels(p)
      } catch (e) {
        liveError = e
      }
      // il vivo fallisce ma il catalogo c'è → si restituisce il catalogo,
      // NESSUN errore; si lancia solo se falliscono entrambi (o il kind non
      // ha catalogo e il vivo fallisce)
      if (live.length === 0 && catalog.length === 0) {
        if (liveError) {
          const error = liveError instanceof Error ? liveError.message : String(liveError)
          throw uiError(UI.rpcModelsListFailed, { error })
        }
        return []
      }
      const byId = new Map<string, ModelInfo>()
      for (const c of catalog) byId.set(c.id, c)
      for (const l of live) {
        const cur = byId.get(l.id)
        byId.set(l.id, cur
          ? { ...cur, ...(l.label ? { label: l.label } : {}), source: 'both' }
          : l)
      }
      // le capacità di OGNI voce vengono da modelCapabilities (cache Ollama e
      // prezzi custom inclusi, H1.2/H1.3); la finestra di contesto resta quella
      // del catalogo (del sintetico sarebbe un reload a caso)
      return [...byId.values()].map((m) => {
        const caps = modelCapabilities(p, m.id, prices)
        return {
          ...m,
          vision: caps.vision,
          tools: caps.tools,
          thinkingLevels: caps.thinkingLevels,
          cost: caps.cost,
          costSource: caps.costSource
        }
      })
    },
    // fase 18b (K3): le capacità di UN modello, SENZA l'elenco completo — per
    // i provider di catalogo nessuna rete (solo modelCapabilities); per
    // ollama, con la cache vuota, UNA sola /api/show per quel modello
    // (helper condiviso col check dei tool, 1500 ms; errori ignorati → null)
    'models:capabilities': async ([providerId, model]) => {
      const p = providers.getProvider(providerId as string)
      if (!p) throw uiError(UI.rpcProviderNotFoundLower)
      if (p.kind === 'ollama') await readOllamaCapabilities(p, model as string)
      return modelCapabilities(p, model as string)
    },
    // fase 18a (E4) → 18b (H6.1): uso registrato dei modelli, aggregato per
    // provider+modello (default), bot o origine in una finestra [fromMs, toMs]
    // facoltativa — solo numeri, mai testo dei messaggi
    'usage:summary': ([fromMs, toMs, groupBy]) =>
      store.modelUsageSummary(
        typeof fromMs === 'number' ? fromMs : undefined,
        typeof toMs === 'number' ? toMs : undefined,
        groupBy === 'agent' || groupBy === 'source' ? groupBy : 'model'
      ),
    // fase 11 (punto 2): chiave per la ricerca web del provider Ollama — vive
    // SOLO nel vault sigillato (mai nei settings in chiaro, mai nel contesto
    // del modello, nei log o in argv); la UI riceve solo un booleano
    'providers:set-web-search-key': async ([providerId, key]) => {
      const p = providers.getProvider(providerId as string)
      if (!p || p.kind !== 'ollama') throw uiError(UI.rpcWebKeyOllama)
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
    // M4 (fase 0.3.1001): le standing grant («Consenti sempre» delle card) si
    // vedono e si revocano da Impostazioni → Approvazioni
    'grants:list': () => store.listGrants(),
    'grants:revoke': ([id]) => {
      store.removeGrant(Number(id))
      return { ok: true }
    },
    /**
     * M4: «Consenti sempre le letture di <server>» dalla card di un tool MCP
     * con readOnlyHint true — grant `mcp__<server>__*` scope 'readOnly',
     * ricontrollata sulle annotazioni a OGNI chiamata dal gate.
     */
    'permissions:grant-server-reads': ([slug]) => {
      const serverSlug = String(slug ?? '')
      if (!/^[a-z0-9-]+$/.test(serverSlug)) throw uiError(UI.rpcInvalidServerSlug)
      if (!store.listGrants().some((g) => g.tool === `mcp__${serverSlug}__*` && g.scope === 'readOnly')) {
        store.addGrant(`mcp__${serverSlug}__*`, '*', 'readOnly')
      }
      return { ok: true }
    },
    'settings:get': ([key, fallback]) => store.getSetting(key as string, fallback),
    'settings:set': ([key, value]) => store.setSetting(key as string, value),

    // ---- fase rilascio (A7): docker c'è? si è avviato? ----
    // Lo stato del tool per la UI: installed = trovato su disco (PATH o i
    // posti noti di Docker Desktop); running = c'è un socket/context a cui
    // parlare (NIENTE spawn: il controllo è a costo zero e senza rete).
    'box:docker-status': () => dockerToolStatus(),
    // «Riprova»: la cache dei percorsi si azzera e si rilegge lo stato
    'box:docker-retry': () => {
      invalidateToolCache()
      return dockerToolStatus()
    },

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
 * R1: il prefisso degli strumenti è quello VERO del server installato
 * (toolSlug), non l'id del connettore — un toolSlug rinumerato (-2) direbbe
 * il nome sbagliato altrimenti. Fase prefisso-offerta (P2): se il server non
 * si trova, il ripiego è `toolSlugOf({ name })` (lo slug del NOME come alla
 * registrazione) con un warn, mai l'id.
 */
export async function notifyConnectorConnected(
  connectorId: string,
  name: string,
  emit: Emitter,
  worker: JobWorker
): Promise<void> {
  const mcpMod = await import('../main/mcp')
  const server = mcpMod.listServers().find((s) => s.catalogId === connectorId)
  // fase prefisso-offerta (P2): se il server non si trova (non dovrebbe
  // succedere: la notifica arriva DOPO l'installazione) il ripiego è lo slug
  // del NOME come farebbe la registrazione (toolSlugOf), non l'id — per
  // gcalendar il nome Google Calendar dà mcp__google-calendar__*, quello giusto
  if (!server) console.warn(`[connector] catalog server not found for "${connectorId}"`)
  const prefix = mcpMod.serverToolsPrefix(server ?? { name })
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
      `[sistema] The user connected ${name}: its ${prefix}__* tools are now available (find the exact names with your tools or by asking the user).`,
      undefined,
      emit,
      undefined,
      'CONNECTOR_CONNECTED',
      // fase 17c (C2, MU): la UI mostra la lingua dell'interfaccia
      { ui: ui(UI.sistemaConnectorConnected, { name, connectorId: prefix.slice('mcp__'.length) }) }
    )
    worker.poke()
  }
}

/**
 * Fase mcp-setup (M5.2): l'utente ha completato il collegamento di un server
 * MCP proposto dal bot (add_mcp_server). Ogni agente con la card ancora
 * aperta riceve il messaggio initiator CONNECTOR_CONNECTED col prefisso dei
 * suoi strumenti (mcp__&lt;toolSlug&gt;__*, R1) e le card si marcano meta.connected
 * (una sola notifica per offerta). `cardIds` sono gli id delle card
 * («registry:&lt;nome&gt;» / «url:&lt;url&gt;»).
 */
export async function notifyMcpServerConnected(
  cardIds: string[],
  cfg: { name: string; toolSlug?: string },
  emit: Emitter,
  worker: JobWorker
): Promise<void> {
  const { serverToolsPrefix } = await import('../main/mcp')
  const name = cfg.name
  const prefix = serverToolsPrefix(cfg)
  for (const agent of store.listAgents()) {
    const offers = store.getEntries(agent.id).filter(
      (e) =>
        e.kind === 'send-message' &&
        (e.meta?.message as SendMessagePayload | undefined)?.type === 'mcp-server' &&
        cardIds.includes(String((e.meta?.message as { id?: string }).id ?? '')) &&
        !e.meta?.connected
    )
    if (!offers.length) continue
    for (const e of offers) store.updateEntryMeta(e.id, { ...e.meta, connected: true })
    enqueueUserMessage(
      db(),
      agent.id,
      `[sistema] The user connected ${name}: its ${prefix}__* tools are now available.`,
      undefined,
      emit,
      undefined,
      'CONNECTOR_CONNECTED',
      // fase 17c (C2, MU): la UI mostra la lingua dell'interfaccia
      { ui: ui(UI.sistemaServerConnected, { name, prefix }) }
    )
    worker.poke()
  }
}

/**
 * Fase mcp-setup (M5.3): un'app collegata VIA COMPOSIO dalla card di un
 * connettore DIRETTO dello stesso marchio (composioRouteFor, e926502c). Quando
 * il gateway la vede ACTIVE e c'è un'offerta pendente per la curata diretta,
 * il bot lo sa — con i nomi degli strumenti di Composio (composio__&lt;slug&gt;__*),
 * non mcp__&lt;id&gt;__*. Una volta sola per offerta (meta.connected).
 */
export async function notifyComposioAppConnected(
  slug: string,
  name: string,
  emit: Emitter,
  worker: JobWorker
): Promise<void> {
  const { loadAppCatalog } = await import('../shared/app-catalog')
  // la curata DIRETTA dello stesso marchio (la riga a doppia strada)
  const row = loadAppCatalog({ staticClientsReady: [] }).find((r) => r.composioSlug === slug && r.directId)
  if (!row?.directId) return
  for (const agent of store.listAgents()) {
    const offers = store.getEntries(agent.id).filter(
      (e) =>
        e.kind === 'send-message' &&
        (e.meta?.message as SendMessagePayload | undefined)?.type === 'connector' &&
        ((e.meta?.message as { connectorId?: string }).connectorId === row.directId) &&
        !e.meta?.connected
    )
    if (!offers.length) continue
    for (const e of offers) store.updateEntryMeta(e.id, { ...e.meta, connected: true })
    enqueueUserMessage(
      db(),
      agent.id,
      `[sistema] The user connected ${name} (via Composio): its composio__${slug}__* tools are now available (find the exact names with find_tools).`,
      undefined,
      emit,
      undefined,
      'CONNECTOR_CONNECTED',
      { ui: ui(UI.sistemaComposioAppConnected, { name, slug }) }
    )
    worker.poke()
  }
}
