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
  // quick-ask (domanda effimera)
  quickAsk(agentId: string, question: string): Promise<string>
  // allegati
  pickImage(): Promise<string | null>
  // routine
  listRoutines(agentId?: string): Promise<RoutineInfo[]>
  createRoutine(agentId: string, title: string, prompt: string, schedule: string): Promise<RoutineInfo>
  updateRoutine(id: number, patch: Partial<Pick<RoutineInfo, 'enabled' | 'schedule' | 'title' | 'prompt'>>): Promise<void>
  deleteRoutine(id: number): Promise<void>
  suggestRoutines(agentId: string): Promise<RoutineSuggestion[]>
  // MCP
  mcpList(): Promise<McpServerInfo[]>
  mcpSave(s: McpServerInfo): Promise<McpServerInfo[]>
  mcpDelete(id: string): Promise<void>
  mcpTest(id: string): Promise<{ ok: boolean; error?: string; tools?: string[] }>
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
}
