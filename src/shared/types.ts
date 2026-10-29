// Tipi condivisi tra main, preload e renderer (rispecchiano il modello del Grok Bot originale)

export type AgentStatus = 'offline' | 'idle' | 'thinking' | 'running' | 'paused-for-approval'

export interface Agent {
  id: string
  name: string
  description: string
  providerId: string | null
  model: string | null
  status: AgentStatus
  unread: number
  createdAt: number
  /** fase 10: id dell'agente CREATORE (null = creato dall'utente/onboarding) */
  createdBy?: string | null
  /** fase 10: sezione della sidebar in cui raggruppare il bot (testo libero) */
  section?: string | null
  /** fase 12: il padre, se questa riga è un SOTTOAGENTE (bot figlio nascosto) */
  parentId?: string | null
}

export type EntryKind =
  | 'message'        // messaggio user o assistant (formato pre-fase 3)
  | 'thinking'       // testo libero generato dal modello: NON arriva all'utente, nascosto di default (toggle "mostra ragionamento")
  | 'send-message'   // messaggio del bot all'utente (message.type: text | widget | draft) — nasce SOLO da tool
  | 'tool-call'      // chiamata tool richiesta dal modello
  | 'tool-result'    // esito del tool
  | 'notice'         // nota di sistema (permesso negato, ecc.)
  | 'approval'       // card di approvazione
  | 'event'          // evento (cambio stato, interrupt, fine turno con meta.turnEnd)
  | 'summary'        // fase 4: riepilogo dei turni più vecchi (compaction), visibile solo col toggle ragionamento

/** Esito di fine turno (come GrokBotTaskListTurnEnd + awaiting_user dell'originale). */
export type TurnEnd = 'FINISHED' | 'STOPPED' | 'SUPERSEDED' | 'AWAITING_USER'

// ---- payload dei messaggi del bot (entry kind 'send-message', in meta.message) ----

export interface WidgetOption {
  label: string
  value: string
  description?: string
  style?: 'primary' | 'default'
}

/** Il tool di invio associato a una bozza: eseguito SOLO al click dell'utente. */
export interface DraftVia {
  tool: string
  args: Record<string, unknown>
}

/**
 * Review fase 3 (D1): quali argomenti di via.args alimentano i campi visibili
 * to/subject/body della card (es. { to: 'to', subject: 'subject', body: 'text' }).
 * Unica fonte di verità: via.args, ciò che verrà davvero inviato.
 */
export interface DraftFieldMap {
  to?: string
  subject?: string
  body?: string
}

/** Review fase 3 (D1): argomento di via.args non mappato sui campi visibili, mostrato in "Altri parametri". */
export interface DraftExtraArg {
  key: string
  value: string
}

export type SendMessagePayload =
  | { type: 'text'; text: string; urgent?: boolean }
  | {
      type: 'widget'
      prompt: string
      helpText?: string
      options: WidgetOption[]
      multiSelect?: boolean
      allowCustom?: boolean
      dismissOnMoveOn?: boolean
    }
  | {
      type: 'draft'
      channel: 'email' | 'slack' | 'other'
      to: string
      subject?: string
      body: string
      via?: DraftVia
      /** D1: mappa campo visibile → argomento di via.args (calcolata alla creazione) */
      fieldMap?: DraftFieldMap
      /** D1: argomenti di via.args non coperti dalla fieldMap — sempre visibili in card ("Altri parametri") */
      extraArgs?: DraftExtraArg[]
      /** D1: true se nessun argomento è mappato sul corpo: modifica del testo disabilitata, argomenti grezzi */
      bodyLocked?: true
    }
  | {
      /** fase 5: offerta di connessione (funnel §3ter T2-T3) — il bottone "Connetti" è dell'utente */
      type: 'connector'
      connectorId: string
      name: string
      reason?: string
    }
  | {
      /** fase 8 (§3bis L7): apertura di un task thread — card nella chat principale */
      type: 'task'
      taskId: number
      title: string
    }
  | {
      /** fase 8 (§3bis L5): regola di auto-review proposta dall'agente — si salva SOLO al click dell'utente */
      type: 'rule'
      kind: 'allow' | 'block'
      text: string
      why?: string
    }
  | {
      /**
       * Fase 13 (punto 2): proposta di aggiungere un server MCP del registro
       * (o un URL). Tutto in codice tranne `reason`; l'installazione parte
       * SOLO dal click su Aggiungi (mai "sempre").
       */
      type: 'mcp-server'
      /** registry:<nome> oppure url:https://… */
      id: string
      name: string
      publisher?: string
      trust: string
      trustKind: 'verified-domain' | 'github-account' | 'unverified'
      siteUrl?: string
      runtime: { kind: 'remote'; host: string } | { kind: 'box-npm'; command: string }
      needs:
        | { kind: 'oauth' }
        | { kind: 'key'; header: string }
        | { kind: 'env'; vars: Array<{ name: string; required: boolean; description?: string }> }
      /** fiducia ≠ dominio verificato: l'avviso che il server è di terzi */
      thirdPartyWarning?: true
      /** proposta nata in un turno contaminato: avviso in cima alla card */
      untrusted?: true
      /** modalità host: il server stdio non si installa, bottone disattivato */
      disabledReason?: string
      reason?: string
    }
  | {
      /**
       * Fase 13 (punto 4): proposta di installare un plugin di un marketplace
       * (formato Claude Code). L'installazione parte SOLO dal click su
       * Installa; hook/bin/monitor/LSP non si importano MAI (elenco "ignored").
       */
      type: 'plugin'
      /** plugin:<nome>@<marketplace> */
      id: string
      name: string
      marketplace: string
      trust: string
      repoUrl?: string
      /** i primi 12 caratteri dello sha effettivo */
      sha12: string
      skills: string[]
      servers: Array<{ name: string; runtimeLabel: string }>
      settings: Array<{ key: string; description?: string; sensitive?: boolean }>
      /** componenti presenti ma NON importate (non girano in SandBot) */
      ignored: string[]
      untrusted?: true
      reason?: string
    }
  | {
      /** fase 12 (punto 2): card del sottoagente lanciato — l'unica riga del figlio nella chat del padre */
      type: 'subagent'
      subagentId: string
      title: string
    }

/**
 * meta di una entry 'send-message':
 * - call: la tool-call che l'ha prodotta (per ricostruire la storia del modello)
 * - message: il payload (text | widget | draft)
 * - respondedValue / widgetDismissed: stato del widget dopo l'azione dell'utente
 * - status: per le bozze, 'pending' → 'sent' | 'discarded' | 'error'
 * - fallback: true se il testo è il recupero di un turno senza send_to_user
 */
export interface SendMessageMeta {
  call?: { id: string; name: string; arguments: string }
  message: SendMessagePayload
  respondedValue?: string | string[]
  widgetDismissed?: boolean
  status?: 'pending' | 'sent' | 'discarded' | 'error'
  fallback?: boolean
  /** fase 6: true finché il messaggio è trattenuto nell'outbox (consegna alla finestra) */
  held?: boolean
  /**
   * Fase 7 (correzione A2): delega send_to_agent — entry visibile nella chat
   * del MITTENTE come "A <nome bot>", con destinatario e hop del messaggio.
   */
  toAgentId?: string
  toAgentName?: string
  hop?: number
  agentSend?: boolean
  /**
   * Fase 8 (§3bis L5): l'azione è stata approvata/inviata dall'auto-review
   * con una regola dell'utente (approvazioni e bozze auto-inviate).
   */
  autoApproved?: boolean
  ruleMatched?: string
  reason?: string
  /** fase 8: esito della regola proposta dall'agente (aggiunta o scartata dall'utente) */
  ruleStatus?: 'added' | 'dismissed'
  /** fase 8 (§3bis L7): l'entry appartiene al sotto-transcript di questo task */
  taskId?: number
}

export interface TranscriptEntry {
  id: number
  agentId: string
  kind: EntryKind
  role: 'user' | 'assistant' | 'system'
  content: string
  meta: Record<string, unknown> | null
  createdAt: number
}

// ---- Provider / modelli personalizzati ----
export type ProviderKind =
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'openai'
  | 'anthropic'
  | 'mistral'
  | 'openrouter'
  | 'zai'
  | 'xai'
  | 'deepseek'
  | 'groq'
  | 'custom'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  enabled: boolean
  discovered?: boolean
}

export interface ModelInfo {
  id: string
  label?: string
}

// ---- Permessi (replica del modello originale always_allow | needs_approval | blocked) ----
export type PermissionMode = 'always_allow' | 'needs_approval' | 'blocked'

export interface PermissionRule {
  tool: string          // nome tool o '*'
  pattern: string       // prefisso comando/percorso o '*'
  mode: PermissionMode
}

export interface PermissionsConfig {
  default: PermissionMode
  rules: PermissionRule[]
}

// ---- Approvazioni ----
export interface Approval {
  id: string
  agentId: string
  tool: string
  input: Record<string, unknown>
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  createdAt: number
}

// ---- Eventi main → renderer ----
export type SandbotEvent =
  | { type: 'entries'; agentId: string; entries: TranscriptEntry[] }
  | { type: 'delta'; agentId: string; entryId: number; text: string; reasoning?: boolean }
  | { type: 'status'; agentId: string; status: AgentStatus }
  | { type: 'agents' }
  | { type: 'approval'; agentId: string; approval: Approval }
  | { type: 'open-agent'; agentId: string }
  // residuo fase 4 (0b): il client del daemon si è RICONNESSO dopo una
  // disconnessione — la UI ricarica agenti ed entry (il transcript può essere
  // cambiato mentre eravamo sconnessi)
  | { type: 'reconnected' }
  // fase 5: lo stato di un connettore è cambiato (connesso, needs_auth, …) —
  // la vista "Connetti app" ricarica il catalogo
  | { type: 'connectors' }
  // fase 6 (§3bis L9): il turno è finito con un messaggio visibile (done) o
  // l'agente aspetta l'utente (needs-input: ask_user, approval, bozza) — la
  // decisione se notificare (soppressioni) sta nel daemon
  | { type: 'agent-notify'; agentId: string; kind: 'done' | 'needs-input'; preview: string; at: number }
  // fase 8 (§3bis L7): lo stato di un task è cambiato — la card in chat e la
  // sidebar (task in corso) si aggiornano
  | { type: 'tasks' }
  // fase 8 (§3bis L7): stato live — quale tool sta girando nel turno dell'agente
  | { type: 'activity'; agentId: string; activity: { tool: string; target: string } | null }
  // fase 10: i messaggi o i membri di un gruppo sono cambiati (sidebar + vista gruppo)
  | { type: 'groups' }
  // fase 12: lo stato di un sottoagente di questo padre è cambiato (card + pannello)
  | { type: 'subagents'; parentId: string }

export interface SandbotApi {
  // agenti e transcript
  listAgents(): Promise<Agent[]>
  createAgent(name: string, description?: string): Promise<Agent>
  updateAgent(id: string, patch: Partial<Pick<Agent, 'name' | 'description' | 'providerId' | 'model'>>): Promise<void>
  deleteAgent(id: string): Promise<void>
  /** fase 7: imposta il bot principale (mainAgentId, unico) */
  setMainAgent(id: string): Promise<void>
  /** fase 7: catalogo dei template di bot */
  listTemplates(): Promise<TemplateInfo[]>
  /** fase 7: crea un bot da template e avvia il kickstart (job TEMPLATE_IMPORT) */
  createAgentFromTemplate(templateId: string): Promise<Agent>
  getEntries(agentId: string, afterId?: number): Promise<TranscriptEntry[]>
  sendMessage(agentId: string, text: string, images?: string[]): Promise<void>
  interrupt(agentId: string): Promise<void>
  // risposta a un widget ask_user (click su un'opzione o testo libero se allowCustom)
  widgetRespond(agentId: string, entryId: number, value: string | string[]): Promise<void>
  // azioni sulla bozza: Invia (esegue via.tool passando dal gate), Scarta, Modifica (persiste il body)
  draftSend(agentId: string, entryId: number, body?: string): Promise<void>
  draftDiscard(agentId: string, entryId: number): Promise<void>
  draftUpdate(agentId: string, entryId: number, body: string): Promise<void>
  // approvazioni
  /** fase 8: mode 'once' (una volta), 'always' (standing grant), 'turn' (fino a fine turno, in memoria) */
  resolveApproval(agentId: string, approvalId: string, decision: 'allow' | 'deny', mode: 'once' | 'always' | 'turn'): Promise<void>
  // provider e modelli
  listProviders(): Promise<ProviderConfig[]>
  saveProvider(p: ProviderConfig): Promise<void>
  deleteProvider(id: string): Promise<void>
  discoverProviders(): Promise<ProviderConfig[]>
  testProvider(id: string): Promise<{ ok: boolean; error?: string; models?: ModelInfo[] }>
  listModels(providerId: string): Promise<ModelInfo[]>
  /** fase 11: chiave per la ricerca web del provider Ollama — SOLO nel vault sigillato */
  setWebSearchKey(providerId: string, key: string | null): Promise<void>
  webSearchKeySet(providerId: string): Promise<boolean>
  // permessi
  getPermissions(): Promise<PermissionsConfig>
  setPermissions(cfg: PermissionsConfig): Promise<void>
  // impostazioni generiche (fase 6: fuso orario, finestre di consegna, assenza, notifiche)
  settingsGet<T>(key: string, fallback: T): Promise<T>
  settingsSet(key: string, value: unknown): Promise<void>
  // quick-ask (domanda effimera)
  quickAsk(agentId: string, question: string): Promise<string>
  // allegati
  pickImage(): Promise<string | null>
  // routine
  listRoutines(agentId?: string): Promise<RoutineInfo[]>
  createRoutine(agentId: string, title: string, prompt: string, schedule: string): Promise<RoutineInfo>
  /** fase 6: creazione con trigger esteso (schedule every, email, calendar_event, webhook, connector_poll) */
  createRoutineTrigger(agentId: string, title: string, prompt: string, trigger: RoutineTrigger, timezone?: string): Promise<RoutineInfo>
  /** fase 6: aggiorna trigger/ora/prompt (il trigger sostituisce la schedule) */
  updateRoutineTrigger(id: number, patch: { title?: string; prompt?: string; enabled?: number; paused_for_away?: number; trigger?: RoutineTrigger | null; timezone?: string }): Promise<void>
  updateRoutine(id: number, patch: Partial<Pick<RoutineInfo, 'enabled' | 'schedule' | 'title' | 'prompt'>>): Promise<void>
  deleteRoutine(id: number): Promise<void>
  suggestRoutines(agentId: string): Promise<RoutineSuggestion[]>
  // fase 6: presenza (§3ter T2) — 'active' al massimo uno ogni 30s
  presenceSignal(kind: 'active' | 'typing'): Promise<void>
  presenceViewing(agentId: string | null): Promise<void>
  // fase 6: consegna dell'outbox quando l'utente apre la chat dell'agente
  outboxOpened(agentId: string): Promise<void>
  // fase 8 (§3bis L7): task thread — elenco (tutti gli agenti se undefined) e interruzione
  listTasks(agentId?: string): Promise<TaskInfo[]>
  cancelTask(taskId: number): Promise<void>
  // fase 8 (§3bis L5): decisione dell'utente sulla regola proposta dall'agente
  autoreviewRuleDecision(agentId: string, entryId: number, action: 'add' | 'dismiss'): Promise<void>
  // fase 10: gruppi (sidebar "Gruppi", vista gruppo, scrittura come utente)
  listGroups(): Promise<GroupInfo[]>
  groupMessages(groupId: number): Promise<GroupMessageInfo[]>
  groupSendUser(groupId: number, text: string): Promise<void>
  // fase 12: sottoagenti del padre (card + pannello) e bottone Ferma
  listSubagents(parentId: string): Promise<SubagentInfo[]>
  stopSubagent(id: string): Promise<void>
  // memoria (fase 4): sezione nella vista dell'agente, modifica ed eliminazione
  listMemories(agentId: string): Promise<MemoryInfo[]>
  updateMemory(agentId: string, id: string, content: string): Promise<void>
  deleteMemory(agentId: string, id: string): Promise<void>
  // skill (fase 4): elenco con visualizzazione ed eliminazione
  listSkills(agentId: string): Promise<SkillInfo[]>
  deleteSkill(agentId: string, name: string): Promise<void>
  // MCP
  mcpList(): Promise<McpServerInfo[]>
  mcpSave(s: McpServerInfo, secret?: McpServerSecret): Promise<McpServerInfo[]>
  mcpDelete(id: string): Promise<void>
  mcpTest(id: string): Promise<{ ok: boolean; error?: string; tools?: string[] }>
  // fase 5: connettori del catalogo ("Connetti app")
  connectorsList(): Promise<ConnectorInfo[]>
  connectorsConnect(id: string): Promise<{ started: boolean; status: string; message?: string }>
  connectorsDisconnect(id: string): Promise<void>
  connectorsSetTools(id: string, disabledTools: string[]): Promise<void>
  connectorsSetInstructions(id: string, instructions: string): Promise<void>
  connectorsSaveStaticClient(id: string, clientId: string, clientSecret: string): Promise<void>
  // fase 13: registro, plugin, marketplace, gateway (installazione SOLO dal click)
  connectorsInstalled(): Promise<{ servers: McpServerInfo[]; plugins: unknown[] }>
  connectorsResolveMcpServer(agentId: string, entryId: number, decision: 'add' | 'no'): Promise<{ ok: boolean; installed?: boolean; message?: string; error?: string }>
  connectorsSaveServerValues(serverId: string, kind: SecretKind, values: Record<string, string>): Promise<{ ok: boolean }>
  connectorsSetEnabledFor(kind: 'server' | 'plugin', id: string, agentIds: string[]): Promise<{ ok: boolean }>
  connectorsUninstallServer(id: string): Promise<{ ok: boolean }>
  /** fase 13 (correzione L1): rifà l'OAuth di un server del registro/plugin la cui sessione è scaduta */
  connectorsReconnectServer(id: string): Promise<{ ok: boolean; message?: string; error?: string }>
  connectorsAddGateway(input: { name: string; url: string; auth: 'oauth' | 'bearer' | 'headers'; preset?: string; headerName?: string; token?: string; headers?: Record<string, string> }): Promise<McpServerInfo>
  connectorsGatewayPresets(): Promise<{ presets: Array<{ id: string; name: string; auth: string; headerName?: string; help: string }>; warning: string }>
  connectorsSetClientMetadataUrl(url: string): Promise<{ ok: boolean }>
  pluginsResolve(agentId: string, entryId: number, decision: 'install' | 'no'): Promise<{ ok: boolean; installed?: boolean; message?: string; error?: string }>
  pluginsUninstall(name: string, marketplace: string): Promise<{ ok: boolean }>
  marketplaceList(): Promise<Array<{ name: string; source: string; kind: 'github' | 'git'; official: boolean }>>
  marketplaceAdd(source: string): Promise<{ name: string; source: string }>
  marketplaceRemove(source: string): Promise<{ ok: boolean }>
  // vault
  vaultList(): Promise<string[]>
  vaultStore(name: string, value: string): Promise<void>
  vaultDelete(name: string): Promise<void>
  // daemon all'accesso (LaunchAgent)
  getLaunchAtLogin(): Promise<boolean>
  setLaunchAtLogin(enabled: boolean): Promise<void>
  // evento push
  onEvent(cb: (e: SandbotEvent) => void): () => void
}

export interface RoutineInfo {
  id: number
  agent_id: string
  title: string
  prompt: string
  schedule: string
  enabled: number
  last_run: number | null
  created_at: number
  /** fase 4: provenance 'agent' = creata dal bot via update_state (nasce in pausa); fase 7: 'template' = importata dal kickstart */
  provenance?: 'user' | 'agent' | 'template'
  description?: string
  timezone?: string
  /** fase 6: trigger esteso (null = schedule cron classica nella colonna schedule) */
  trigger?: RoutineTrigger | null
  /** fase 6: la routine è in pausa perché l'utente è via (riattivabile solo al rientro) */
  paused_for_away?: number
  /** fase 6: prossimo run calcolato dal daemon (ms epoch; null se non schedulabile) */
  next_run?: number | null
  /** fase 6: URL del webhook (solo trigger webhook, per copiarlo dalla UI) */
  webhook_url?: string
}

// ---- trigger delle routine (fase 6, §3bis L3) ----

/** Schedule "ogni X alle HH:MM", precisa ('at') o circa ('around', ±15 min deterministici). */
export interface EveryScheduleSpec {
  every: 'day' | 'weekday' | 'week' | 'month' | 'hour'
  /** 'HH:MM'; per every:'hour' conta solo il minuto */
  at?: string
  /** 0-6 (domenica 0) — per every:'week' */
  weekday?: number
  /** 1-31 — per every:'month' */
  monthDay?: number
  mode: 'at' | 'around'
}

export type ScheduleTrigger =
  | { type: 'schedule'; kind: 'cron'; cron: string }
  | ({ type: 'schedule'; kind: 'every' } & EveryScheduleSpec)

/**
 * Poll di un tool MCP in sola lettura di un connettore connesso: estrae gli
 * id (idField = percorso semplice tipo "messages[].id") e produce un evento
 * per ogni id NUOVO. preset email/calendar_event = le due automazioni con UI
 * dedicata (il tool lo sceglie il preset da toolsOfServer, niente nomi cablati).
 */
export interface ConnectorPollTrigger {
  type: 'connector_poll'
  connectorId: string
  tool: string
  args?: Record<string, unknown>
  intervalMin: number
  idField: string
  preset?: 'email' | 'calendar_event'
  /** solo preset calendar_event: il job parte N minuti prima dell'evento */
  offsetMinutes?: number
  /**
   * Fase 7 (residuo 0a): obbligatorio per i poll su server NON del catalogo
   * (aggiunti a mano): l'utente conferma in UI che il tool legge soltanto.
   * L'annotazione readOnlyHint di un server manuale non è verificata.
   */
  userConfirmedReadOnly?: boolean
}

/** Webhook: POST http://127.0.0.1:<porta daemon>/hooks/<routineId> con Bearer <token>. */
export interface WebhookTrigger {
  type: 'webhook'
  token: string
}

/** L'utente è tornato dopo un'assenza lunga (vedi presenza/look-around). */
export interface PresenceReturnTrigger {
  type: 'presence_return'
}

export type RoutineTrigger = ScheduleTrigger | ConnectorPollTrigger | WebhookTrigger | PresenceReturnTrigger

/** L'evento che ha fatto scattare un job routine-run (entra nel prompt come <evento>). */
export interface TriggerEventPayload {
  source: 'connector_poll' | 'webhook' | 'presence_return' | 'calendar_event'
  /** Riga sintetica per l'utente ("Nuova email da x", "Webhook ricevuto") */
  title: string
  /** Evidenza grezza (l'elemento nuovo, il corpo del webhook) */
  data?: unknown
  at?: number
}

// ---- memoria e skill (fase 4) ----

/** Una memoria dell'agente (o condivisa, scope 'user') così come la vede la UI. */
export interface MemoryInfo {
  id: string
  content: string
  tier: 'core' | 'log'
  scope: 'agent' | 'user'
  source: string
  createdAt: number
  updatedAt: number
}

/** Una skill dell'agente (SKILL.md), con le istruzioni complete. */
export interface SkillInfo {
  name: string
  description: string
  content: string
}

export interface RoutineSuggestion {
  title: string
  schedule: string
  description: string
}

// ---- task thread (fase 8, §3bis L7) ----

/** Un task thread: lavoro lungo in un contesto separato (sotto-transcript con meta.taskId). */
export interface TaskInfo {
  id: number
  agentId: string
  title: string
  status: 'working' | 'needs_input' | 'done' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
  summary: string | null
}

// ---- sottoagenti (fase 12, §L7/T5) ----

/** Un sottoagente del padre così come lo vede la UI (tabella subagents + stato live dell'agente figlio). */
export interface SubagentInfo {
  id: string
  parentId: string
  /** se lanciato da dentro un task, i risultati tornano al task */
  parentTaskId: number | null
  /** il lotto: i figli dello stesso turno del padre si svegliano insieme */
  batchId: string
  title: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'expired'
  summary: string | null
  reportPath: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  deadlineAt: number
  /** stato live dell'agente figlio (paused-for-approval = "in attesa di conferma") */
  agentStatus: AgentStatus | null
}

// ---- gruppi (fase 10, T7) ----

/** Chi ha scritto un messaggio di gruppo: l'utente, un bot o una riga di sistema. */
export type GroupAuthorKind = 'user' | 'agent' | 'system'

/**
 * Un gruppo di bot con l'utente (fase 10): stanza di chat con fino a 6 bot;
 * l'utente ne è sempre membro. Il coordinatore (opzionale) è uno dei bot.
 */
export interface GroupInfo {
  id: number
  name: string
  /** scopo e regole del gruppo (la "description" della room di Grok) */
  description: string
  createdBy: string
  coordinatorId: string | null
  /** i membri BOT (l'utente è sempre membro e non compare qui) */
  members: Array<{ agentId: string; name: string; coordinator: boolean }>
  createdAt: number
}

/** Un messaggio di gruppo come lo vede la UI. */
export interface GroupMessageInfo {
  id: number
  groupId: number
  authorKind: GroupAuthorKind
  authorId: string | null
  authorName: string
  text: string
  replyTo: number | null
  createdAt: number
}

// ---- auto-review delle approvazioni (fase 8, §3bis L5) ----

/**
 * Regole di auto-review in linguaggio naturale (due liste, come l'originale):
 * "Continua da solo quando l'azione rispetta queste regole" /
 * "Fermati e chiedimi sempre quando…". Un modello piccolo giudica le azioni
 * che il gate deterministico segna "ask"; può SOLO trasformare ask in allow.
 */
export interface AutoReviewSettings {
  enabled: boolean
  allowRules: string[]
  blockRules: string[]
  providerId: string | null
  model: string | null
}

export const DEFAULT_AUTO_REVIEW: AutoReviewSettings = {
  enabled: false,
  allowRules: [],
  blockRules: [],
  providerId: null,
  model: null
}

// ---- template dei bot (fase 7, §3ter T4 + Appendice A) ----

/**
 * Un template di bot: routine (solo trigger schedule), connettori consigliati,
 * memorie (regole operative atomiche e datate) e skill. Il JSON vive in
 * src/main/templates/<id>.json, validato da validateTemplate all'avvio.
 */
export interface BotTemplate {
  id: string
  name: string
  description: string
  avatar: string
  roles: string[]
  routines: Array<{
    name: string
    slug: string
    description: string
    content: string
    trigger: RoutineTrigger
    /** domande da fare all'utente a fine kickstart (fuso orario, soglie, …) */
    askUserFor: string[]
  }>
  connectors: Array<{ connectorId: string; why: string }>
  memories: Array<{ content: string; created_at: string }>
  skills: Array<{ name: string; description: string; content: string }>
}

/** Un template come lo vede la UI. */
export type TemplateInfo = BotTemplate

/**
 * Fase 13 (correzione L1): UN solo nome per ogni tipo di segreto. La chiave
 * logica (quella che UI e RPC si passano) mappa alla chiave dello store cifrato:
 * prima la scheda Installati scriveva 'headers' e il resolver leggeva
 * 'staticHeaders', e la chiave non arrivava mai al server.
 */
export const SECRET_KIND = {
  headers: 'staticHeaders',
  env: 'env',
  userConfig: 'userConfig',
  bearer: 'bearer'
} as const
export type SecretKind = keyof typeof SECRET_KIND

/** Il needsAuth.kind del server (key/env/settings) → tipo di segreto dello store. */
export const SECRET_KIND_FOR_NEEDS: Record<'key' | 'env' | 'settings', SecretKind> = {
  key: 'headers',
  env: 'env',
  settings: 'userConfig'
}

export interface McpServerInfo {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  /** fase 5: autenticazione http — i valori segreti vivono cifrati, non qui */
  auth?: { kind: 'oauth' | 'bearer' | 'headers' }
  /** fase 5: id del connettore del catalogo che ha creato questo server */
  catalogId?: string
  /** fase 13 (punto 5): per quali bot è abilitato (['*'] = tutti) */
  enabledFor?: string[]
  /** fase 13: da dove arriva il server (registro, plugin, gateway) */
  source?:
    | { kind: 'registry'; name: string; version?: string }
    | { kind: 'plugin'; plugin: string; marketplace: string; sha: string }
    | { kind: 'gateway'; preset?: string }
  /** fase 13: server stdio che gira nel box (docker exec) */
  box?: { workdir: string; command: string; args?: string[]; envKeys?: string[] }
  /**
   * fase 13 (correzione L1): la DICHIARAZIONE del server di plugin (template
   * pubblici del repository, placeholder NON sostituiti — mai valori dell'utente):
   * url, headers ed env si ricalcolano alla connessione con i valori dello store.
   */
  pluginSpec?: { url?: string; headers?: Record<string, string>; env?: Record<string, string> }
  /** fase 13: installato ma in attesa di valori dalle Impostazioni */
  needsAuth?: { kind: 'key' | 'env' | 'settings'; keys: string[] }
  /** fase 13: fiducia della scheda Installati */
  trustLabel?: string
  /** fase 13 (correzione L1): OAuth scaduto/da rifare → bottone "Riconnetti" nella scheda Installati */
  needsReauth?: boolean
}

/**
 * Segreto di un server MCP manuale (fase 5): bearer token o header statici.
 * Viaggia una sola volta dal renderer al daemon e viene conservato CIFRATO
 * (mai nei settings in chiaro).
 */
export interface McpServerSecret {
  bearerToken?: string
  headers?: Record<string, string>
}

// ---- connettori del catalogo (fase 5: "Connetti app") ----

export type ConnectorStatusInfo = 'not_connected' | 'connected' | 'needs_auth' | 'error'

export interface ConnectorToolInfoShared {
  name: string
  description: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
}

/** Un connettore del catalogo come lo vede la UI (catalogo + stato + tool). */
export interface ConnectorInfo {
  id: string
  name: string
  logo: string
  mcpUrl: string
  clientRegistration: 'dynamic' | 'static'
  scopes?: string[]
  docsUrl: string
  notes: string
  state: {
    status: ConnectorStatusInfo
    error?: string
    disabledTools: string[]
    instructions: string
  }
  tools: ConnectorToolInfoShared[]
  hasStaticCredentials?: boolean
}
