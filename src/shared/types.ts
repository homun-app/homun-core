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
  | 'message'        // messaggio user o assistant
  | 'tool-call'      // chiamata tool richiesta dal modello
  | 'tool-result'    // esito del tool
  | 'notice'         // nota di sistema (permesso negato, ecc.)
  | 'approval'       // card di approvazione
  | 'event'          // evento (cambio stato, interrupt)

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

export interface SandbotApi {
  // agenti e transcript
  listAgents(): Promise<Agent[]>
  createAgent(name: string, description?: string): Promise<Agent>
  updateAgent(id: string, patch: Partial<Pick<Agent, 'name' | 'description' | 'providerId' | 'model'>>): Promise<void>
  deleteAgent(id: string): Promise<void>
  getEntries(agentId: string, afterId?: number): Promise<TranscriptEntry[]>
  sendMessage(agentId: string, text: string, images?: string[]): Promise<void>
  interrupt(agentId: string): Promise<void>
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
