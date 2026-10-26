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

export interface SandbotApi {
  // agenti e transcript
  listAgents(): Promise<Agent[]>
  createAgent(name: string, description?: string): Promise<Agent>
  updateAgent(id: string, patch: Partial<Pick<Agent, 'name' | 'description' | 'providerId' | 'model'>>): Promise<void>
  deleteAgent(id: string): Promise<void>
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
  resolveApproval(agentId: string, approvalId: string, decision: 'allow' | 'deny', always: boolean): Promise<void>
  // provider e modelli
  listProviders(): Promise<ProviderConfig[]>
  saveProvider(p: ProviderConfig): Promise<void>
  deleteProvider(id: string): Promise<void>
  discoverProviders(): Promise<ProviderConfig[]>
  testProvider(id: string): Promise<{ ok: boolean; error?: string; models?: ModelInfo[] }>
  listModels(providerId: string): Promise<ModelInfo[]>
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
  /** fase 4: provenance 'agent' = creata dal bot via update_state (nasce in pausa) */
  provenance?: 'user' | 'agent'
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
