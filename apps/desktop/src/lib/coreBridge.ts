import { chatApi } from "./chatApi";
import {
  DESKTOP_GATEWAY_URL,
  gatewayHeaders,
  pickWorkspaceFolder,
  revealWorkspacePath,
} from "./gatewayConfig";

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
  title: string;
  subtitle: string;
  status: string;
  pinned: boolean;
  computer_session_id: string;
  task_id: string;
  updated_at: string;
  message_count: number;
  source?: string | null;
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

export interface CoreApprovalItem {
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

export type ApprovalDecisionOptions = {
  scope?: "once" | "always";
  browser_visibility?: "auto" | "visible" | "headless";
};

export interface CoreTaskQueueSnapshot {
  queued: CoreTaskItem[];
  active: CoreTaskItem[];
  blocked: CoreTaskItem[];
  waiting_approvals: CoreApprovalItem[];
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
}

export interface CorePromptSubmissionResult {
  user_message: CorePromptMessage;
  assistant_message: CorePromptMessage;
  computer_session: CoreComputerSessionSnapshot;
  plan: CorePromptExecutionPlan | null;
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
  request_id: string;
  delta: string;
}

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
}

export interface WorkspacesSnapshot {
  active_workspace_id: string;
  workspaces: WorkspaceRecord[];
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
  novnc_url: string | null;
  /** True only while a browse_web is actually running right now. */
  active: boolean;
  /** Current activity (goal) when active. */
  activity: string | null;
  /** Steps executed so far — the live "Avanzamento attività" checklist. */
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

// Desktop Gateway errors serialize as { error: { code, message } }.
async function gatewayErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string } | string;
    };
    if (typeof payload?.error === "string") return payload.error;
    if (payload?.error?.message) return payload.error.message;
  } catch {
    // fall through to status-code detail
  }
  return `HTTP ${response.status}`;
}

/** A real-time UI event pushed by the gateway over /api/events. */
export interface AppEvent {
  type: string;
  thread_id?: string;
  workspace?: string;
  channel?: string;
  title?: string;
}

/**
 * Subscribes to the gateway's real-time event stream (NDJSON over HTTP, the same
 * push idiom the chat stream uses). Invokes `onEvent` for each event — e.g.
 * `thread.upserted` when an inbound Telegram/WhatsApp message creates a thread,
 * so the app can show the card and jump to it without a manual refresh.
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

async function gatewayPostJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { ...gatewayHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await gatewayErrorDetail(response));
  }
  return response.json() as Promise<T>;
}

async function gatewayGetJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function electronRuntimeModel(): Promise<ActiveModelInfo> {
  return gatewayGetJson<ActiveModelInfo>("/api/runtime/model");
}

async function electronContainedComputerLive(): Promise<ContainedComputerLive> {
  return gatewayGetJson<ContainedComputerLive>("/api/local-computer/live");
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

export interface RuntimeModelsList {
  active: string | null;
  backend: string;
  available: string[];
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

async function electronRuntimeModels(): Promise<RuntimeModelsList> {
  return gatewayGetJson<RuntimeModelsList>("/api/runtime/models");
}

async function electronSetRuntimeModel(model: string): Promise<{ active: string }> {
  return gatewayPostJson<{ active: string }>("/api/runtime/model", { model });
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

export type MemoryWikiPage = { path: string; title: string; body: string };

async function electronMemoryWiki(thread?: string, workspace?: string): Promise<MemoryWikiPage[]> {
  return gatewayGetJson<MemoryWikiPage[]>(`/api/memory/wiki${scopeQuery(thread, workspace)}`);
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
}
export interface ArtifactThreadView {
  thread: string;
  bytes: number;
  files: ArtifactFileView[];
}
export interface ArtifactsUsage {
  base_path: string;
  total_bytes: number;
  threads: ArtifactThreadView[];
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

async function electronDeleteArtifactFile(thread: string, name: string): Promise<void> {
  await fetch(
    `${DESKTOP_GATEWAY_URL}/api/artifacts/file?thread=${encodeURIComponent(thread)}&name=${encodeURIComponent(name)}`,
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

async function gatewayDeleteJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    method: "DELETE",
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(await gatewayErrorDetail(response));
  }
  return response.json() as Promise<T>;
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

async function electronActivateProvider(id: string): Promise<ProvidersResponse> {
  return gatewayPostJson<ProvidersResponse>(
    `/api/providers/${encodeURIComponent(id)}/activate`,
    {},
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

async function electronCreateWorkspace(
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

async function electronComposioConnect(apiKey: string): Promise<ComposioConnectResult> {
  return gatewayPostJson<ComposioConnectResult>(
    "/api/capabilities/composio/connect",
    { api_key: apiKey },
  );
}

async function electronComposioToolkits(): Promise<ComposioToolkit[]> {
  const payload = await gatewayGetJson<{ toolkits: ComposioToolkit[] }>(
    "/api/capabilities/composio/toolkits",
  );
  return payload.toolkits ?? [];
}

async function electronComposioLink(
  toolkitSlug: string,
  apiKey?: string,
): Promise<ComposioLinkResult> {
  return gatewayPostJson<ComposioLinkResult>("/api/capabilities/composio/link", {
    toolkit_slug: toolkitSlug,
    ...(apiKey ? { api_key: apiKey } : {}),
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

/** Executes an MCP server tool on user confirmation (no "always allow" in v1). */
async function electronMcpExecute(
  tool: string,
  args: unknown,
  ctx?: { threadId?: string; messageId?: string },
): Promise<ComposioExecuteResult> {
  return gatewayPostJson<ComposioExecuteResult>("/api/capabilities/mcp/execute", {
    tool,
    arguments: args ?? {},
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

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  version?: string;
  license?: string;
  allowed_tools?: string[];
}

export interface SkillsResponse {
  skills: SkillSummary[];
  dir: string;
}

export interface SkillFileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: SkillFileNode[];
}

export interface SkillSecurityWarning {
  severity: "critical" | "warning";
  category: string;
  description: string;
  file?: string;
  line?: number;
}

export interface SkillSecurityReport {
  risk_score: number;
  blocked: boolean;
  scanned_files: number;
  warnings: SkillSecurityWarning[];
}

export interface SkillDetail extends SkillSummary {
  body: string;
  files: SkillFileNode[];
  security?: SkillSecurityReport;
}

async function electronSkills(): Promise<SkillsResponse> {
  return gatewayGetJson<SkillsResponse>("/api/skills");
}

async function electronSkillDetail(id: string): Promise<SkillDetail> {
  return gatewayGetJson<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`);
}

async function electronSetSkillEnabled(
  id: string,
  enabled: boolean,
): Promise<SkillsResponse> {
  return gatewayPostJson<SkillsResponse>(
    `/api/skills/${encodeURIComponent(id)}/enabled`,
    { enabled },
  );
}

export interface CatalogSkill {
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

export interface SkillCatalogResponse {
  skills: CatalogSkill[];
  categories: CatalogCategory[];
  repo: string;
  total: number;
  fetched_at: number;
}

async function electronSkillCatalog(
  query?: string,
  category?: string,
): Promise<SkillCatalogResponse> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  const qs = params.toString();
  return gatewayGetJson<SkillCatalogResponse>(`/api/skills/catalog${qs ? `?${qs}` : ""}`);
}

export interface CatalogPreview {
  slug: string;
  name: string;
  description: string;
  body: string;
  files: string[];
  security: SkillSecurityReport;
}

async function electronCatalogPreview(slug: string): Promise<CatalogPreview> {
  return gatewayGetJson<CatalogPreview>(
    `/api/skills/catalog/preview?slug=${encodeURIComponent(slug)}`,
  );
}

async function electronCatalogInstall(slug: string): Promise<SkillsResponse> {
  return gatewayPostJson<SkillsResponse>("/api/skills/catalog/install", { slug });
}

export interface RegistrySkill {
  id: string;
  path: string;
  name: string;
  description: string;
  installed: boolean;
}

export interface RegistryResponse {
  repo: string;
  skills: RegistrySkill[];
  suggested: string[];
}

async function electronSkillRegistry(repo?: string): Promise<RegistryResponse> {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  return gatewayGetJson<RegistryResponse>(`/api/skills/registry${qs}`);
}

async function electronInstallRegistrySkill(
  repo: string,
  path: string,
): Promise<SkillsResponse> {
  return gatewayPostJson<SkillsResponse>("/api/skills/registry/install", {
    repo,
    path,
  });
}

export const coreBridge = {
  status: () => Promise.resolve(electronCoreStatus()),
  runtimeModel: () => electronRuntimeModel(),
  runtimeModels: () => electronRuntimeModels(),
  setRuntimeModel: (model: string) => electronSetRuntimeModel(model),
  runtimeProvider: () => electronRuntimeProvider(),
  setRuntimeProvider: (input: { base_url?: string; model?: string; api_key?: string }) =>
    electronSetRuntimeProvider(input),
  providers: () => electronProviders(),
  upsertProvider: (input: UpsertProviderInput) => electronUpsertProvider(input),
  removeProvider: (id: string) => electronRemoveProvider(id),
  activateProvider: (id: string) => electronActivateProvider(id),
  refreshProviderModels: (id: string) => electronRefreshProviderModels(id),
  setModelProfile: (input: SetModelProfileInput) => electronSetModelProfile(input),
  generateProviderProfiles: (id: string) => electronGenerateProviderProfiles(id),
  routingDecisions: () => electronRoutingDecisions(),
  roles: () => electronRoles(),
  setRole: (input: { role: string; provider_id?: string; model?: string }) =>
    electronSetRole(input),
  containedComputerLive: () => electronContainedComputerLive(),
  systemStatus: () => electronSystemStatus(),
  closeAllBrowsers: () => electronCloseAllBrowsers(),
  workspaces: () => electronWorkspaces(),
  createWorkspace: (name: string, folder: string) => electronCreateWorkspace(name, folder),
  setWorkspaceFolder: (id: string, folder: string) => electronSetWorkspaceFolder(id, folder),
  selectWorkspace: (id: string) => electronSelectWorkspace(id),
  renameWorkspace: (id: string, name: string) => electronRenameWorkspace(id, name),
  deleteWorkspace: (id: string) => electronDeleteWorkspace(id),
  mcpConnect: (input: {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }) => electronMcpConnect(input),
  mcpRegistry: (q?: string) => electronMcpRegistry(q),
  mcpDisconnect: (providerId: string) => electronMcpDisconnect(providerId),
  composioConnect: (apiKey: string) => electronComposioConnect(apiKey),
  composioToolkits: () => electronComposioToolkits(),
  composioLink: (toolkitSlug: string, apiKey?: string) =>
    electronComposioLink(toolkitSlug, apiKey),
  composioConnections: () => electronComposioConnections(),
  composioExecute: (
    tool: string,
    args: unknown,
    scope: "once" | "always",
    ctx?: { threadId?: string; messageId?: string },
  ) => electronComposioExecute(tool, args, scope, ctx),
  mcpExecute: (
    tool: string,
    args: unknown,
    ctx?: { threadId?: string; messageId?: string },
  ) => electronMcpExecute(tool, args, ctx),
  fsAuthorize: (
    path: string,
    op: string,
    ctx?: { threadId?: string; messageId?: string },
  ) => electronFsAuthorize(path, op, ctx),
  connectMark: (input: {
    kind: string;
    ref: string;
    ctx?: { threadId?: string; messageId?: string };
  }) => electronConnectMark(input),
  composioAllowedTools: () => electronComposioAllowedTools(),
  composioRevokeTool: (slug: string) => electronComposioRevokeTool(slug),
  skills: () => electronSkills(),
  skillDetail: (id: string) => electronSkillDetail(id),
  setSkillEnabled: (id: string, enabled: boolean) => electronSetSkillEnabled(id, enabled),
  skillRegistry: (repo?: string) => electronSkillRegistry(repo),
  installRegistrySkill: (repo: string, path: string) =>
    electronInstallRegistrySkill(repo, path),
  skillCatalog: (query?: string, category?: string) => electronSkillCatalog(query, category),
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
  setChatThreadPinned: (threadId: string, pinned: boolean) =>
    chatApi.setChatThreadPinned(threadId, pinned),
  archiveChatThread: (threadId: string) =>
    chatApi.archiveChatThread(threadId),
  unarchiveChatThread: (threadId: string) =>
    chatApi.unarchiveChatThread(threadId),
  deleteChatThread: (threadId: string) => chatApi.deleteChatThread(threadId),
  taskQueue: (threadId?: string) => electronTaskQueue(threadId),
  taskExecutorStatus: () => electronTaskExecutorStatus(),
  taskDetail: (taskId: string) => electronTaskDetail(taskId),
  approveApproval: (approvalId: string, options?: ApprovalDecisionOptions) =>
    electronApproveApproval(approvalId, options),
  rejectApproval: (approvalId: string, reason: string) =>
    electronRejectApproval(approvalId, reason),
  memoryDashboard: () => electronMemoryDashboard(),
  memoryItems: () => electronMemoryItems(),
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
  }) => electronUpdateContact(update),
  mergeContacts: (from: string, into: string) => electronMergeContacts(from, into),
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
    ),
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
  ) =>
    resumeBrowserRuntimeChatPromptStream(
      requestId,
      threadId,
      sessionId,
      userText,
      assistantMessageId,
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
  memoryWiki: (thread?: string, workspace?: string) => electronMemoryWiki(thread, workspace),
  saveMemoryWiki: (scope: { thread?: string; workspace?: string }, path: string, body: string) =>
    electronSaveMemoryWiki(scope, path, body),
  artifactFolder: (thread: string) => electronArtifactFolder(thread),
  artifactsUsage: () => electronArtifactsUsage(),
  artifactDestinations: () => electronArtifactDestinations(),
  addArtifactDestination: (label: string, path: string) =>
    electronAddArtifactDestination(label, path),
  removeArtifactDestination: (path: string) => electronRemoveArtifactDestination(path),
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
  ) =>
    submitBrowserRuntimeChatPromptStream(
      requestId,
      threadId,
      sessionId,
      continuationPromptForMessage(previousText),
      "Continua",
      messageId,
      previousText,
    ),
  listenChatStreamDelta: (handler: (payload: CoreChatStreamDelta) => void) =>
    chatApi.listenChatStreamDelta(handler),
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
      message: "Planner operativo non ancora estratto nel gateway Electron.",
    }),
  runPromptPlanReadySteps: (_sessionId: string, _maxSteps = 4) =>
    electronRunNextTask(),
};

async function cancelChatPromptStream(requestId: string) {
  // Cancellation = stop reading the SSE stream client-side. There is no
  // server-side "cancel" endpoint: the provider stream is aborted when the
  // gateway connection closes.
  await chatApi.cancelChatPromptStream(requestId);
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
      last_message: "Executor locale non raggiungibile.",
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

async function electronApproveApproval(
  approvalId: string,
  options?: ApprovalDecisionOptions,
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

async function electronRejectApproval(
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
      stopped_reason: "Executor locale non raggiungibile.",
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
};

async function electronMemoryItems(): Promise<CoreMemoryItem[]> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/memory/items`, {
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Desktop Gateway memory items HTTP ${response.status}`);
    }
    return response.json() as Promise<CoreMemoryItem[]>;
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

export type CoreContactFact = {
  text: string;
  /** "durable" | "transient" | "event" */
  temporality: string;
  /** Period the fact refers to (YYYY-MM-DD / YYYY-MM), "" if durable/undatable. */
  date: string;
};
export type CoreContactProfile = {
  facts: CoreContactFact[];
  stale: boolean;
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
    return { facts: [], stale: false, episode_count: 0 };
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
): Promise<CorePromptSubmissionResult> {
  const startedAt = performance.now();
  const maxTokens = browserChatMaxTokens(prompt);
  const promptBuildStartedAt = performance.now();
  const rawContext = assistantMessageId
    ? []
    : chatApi.rawRecentChatContext(threadId, 12);
  const stream = await openChatStreamWithGateway(
    requestId,
    prompt,
    maxTokens,
    rawContext,
    threadId,
    model,
    images,
    attachments,
  );
  const promptBuildSeconds = roundedSeconds(
    (performance.now() - promptBuildStartedAt) / 1000,
  );
  const response = stream.response;
  if (!response.ok) {
    throw new Error(`Provider di inferenza non disponibile: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Il provider di inferenza non ha aperto lo stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let metrics: Partial<CoreChatMessageMetrics> = {};
  let firstTokenSeconds: number | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseBrowserStreamEvent(line);
      if (!event) continue;
      if (event.type === "delta") {
        if (firstTokenSeconds === undefined) {
          firstTokenSeconds = roundedSeconds((performance.now() - startedAt) / 1000);
        }
        text += String(event.text ?? "");
        chatApi.notifyChatStreamDelta({ request_id: requestId, delta: String(event.text ?? "") });
      } else if (event.type === "done") {
        // Done carries the AUTHORITATIVE final text (gateway-sanitized, markers/cards
        // resolved). Use it to replace the raw live-streamed preview, so token
        // streaming stays a preview and the committed message is the clean version.
        if (event.text) text = String(event.text);
        metrics = event.metrics ?? {};
      } else if (event.type === "error") {
        throw new Error(String(event.message ?? "Errore runtime locale"));
      }
    }
  }

  const timestamp = currentTimestampSeconds();
  const totalElapsedSeconds = roundedSeconds((performance.now() - startedAt) / 1000);
  const assistantText = previousAssistantText
    ? joinContinuationText(previousAssistantText, text)
    : text.trim();
  const result: CorePromptSubmissionResult = {
    user_message: {
      id: `browser_user_${Date.now()}`,
      role: "user",
      text: visiblePrompt ?? prompt,
      timestamp,
      metadata: null,
      metrics: null,
    },
    assistant_message: {
      id: assistantMessageId ?? `browser_assistant_${Date.now()}`,
      role: "assistant",
      text: assistantText,
      timestamp,
      metadata: "Modello locale",
      metrics: {
        prompt_tokens: metrics.prompt_tokens ?? 0,
        generation_tokens: metrics.generation_tokens ?? 0,
        prompt_tps: metrics.prompt_tps ?? 0,
        generation_tps: metrics.generation_tps ?? 0,
        peak_memory_gb: metrics.peak_memory_gb ?? 0,
        elapsed_seconds: metrics.elapsed_seconds ?? totalElapsedSeconds,
        max_tokens: maxTokens,
        prompt_build_seconds: promptBuildSeconds,
        time_to_first_token_seconds: firstTokenSeconds ?? null,
        total_elapsed_seconds: totalElapsedSeconds,
        runtime_status_before: stream.runtimeStatusBefore,
      },
    },
    computer_session: browserComputerSession(sessionId, totalElapsedSeconds),
    plan: null,
  };
  if (assistantMessageId) {
    await chatApi.commitChatContinuationResult(threadId, assistantMessageId, result);
  } else {
    await chatApi.commitChatPromptResult(threadId, result);
  }
  result.computer_session = await electronLocalComputerSession(sessionId);
  return result;
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
): Promise<CorePromptSubmissionResult> {
  const startedAt = performance.now();
  const response = await fetch(
    `${DESKTOP_GATEWAY_URL}/api/chat/stream_resume/${encodeURIComponent(requestId)}`,
    { headers: gatewayHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Stream non più disponibile: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Lo stream da riprendere non ha un corpo.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseBrowserStreamEvent(line);
      if (!event) continue;
      if (event.type === "delta") {
        text += String(event.text ?? "");
        chatApi.notifyChatStreamDelta({ request_id: requestId, delta: String(event.text ?? "") });
      } else if (event.type === "done") {
        // Done is authoritative (sanitized final text) → replace the live preview.
        if (event.text) text = String(event.text);
      } else if (event.type === "error") {
        throw new Error(String(event.message ?? "Errore runtime locale"));
      }
    }
  }
  const timestamp = currentTimestampSeconds();
  const totalElapsedSeconds = roundedSeconds((performance.now() - startedAt) / 1000);
  const result: CorePromptSubmissionResult = {
    user_message: {
      id: `browser_user_${Date.now()}`,
      role: "user",
      text: userText,
      timestamp,
      metadata: null,
      metrics: null,
    },
    assistant_message: {
      id: assistantMessageId,
      role: "assistant",
      text: text.trim(),
      timestamp,
      metadata: "Modello locale",
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
  await chatApi.commitChatPromptResult(threadId, result);
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

async function openChatStreamWithGateway(
  requestId: string,
  prompt: string,
  maxTokens: number,
  rawContext: Array<{ role: "user" | "assistant"; text: string }>,
  threadId?: string,
  model?: string,
  images?: string[],
  attachments?: ChatAttachmentInput[],
) {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/chat/generate_stream`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({
        request_id: requestId,
        prompt,
        // Scope browser work to this chat thread (persistent per-thread session).
        thread_id: threadId,
        context: rawContext,
        max_context_chars: 3_600,
        max_tokens: maxTokens,
        temperature: 0.0,
        wait_if_busy: true,
        request_timeout_seconds: 120,
        // Per-message model override (inline composer selector); omitted → default.
        ...(model ? { model } : {}),
        // Vision: base64 data-URL images for multimodal models.
        ...(images && images.length > 0 ? { images } : {}),
        // Attachments: the gateway reads each by local_path (same host) and turns
        // PDFs/text/images into model-visible content. snake_case wire shape.
        ...(attachments && attachments.length > 0
          ? {
              attachments: attachments
                .filter((a) => a.localPath)
                .map((a) => ({
                  local_path: a.localPath,
                  display_name: a.displayName,
                  mime_type: a.mimeType,
                  size_bytes: a.sizeBytes,
                })),
            }
          : {}),
      }),
    });
    if (response.ok) {
      return { response, runtimeStatusBefore: "desktop_gateway" };
    }
    if (response.status !== 404) {
      return { response, runtimeStatusBefore: "desktop_gateway" };
    }
  } catch {
    // Keep the chat usable when the Rust desktop gateway is not running yet.
  }

  throw new Error("Desktop Gateway locale non raggiungibile. Riavvia l'app desktop.");
}

function continuationPromptForMessage(previousText: string) {
  return [
    "Continua il testo seguente esattamente dal punto in cui si e' interrotto.",
    "Non ripetere parti gia' scritte. Se il testo e' codice, restituisci solo la prosecuzione del codice e mantieni lo stesso formato markdown.",
    "",
    "Testo gia' scritto:",
    previousText.trim(),
  ].join("\n");
}

function joinContinuationText(previousText: string, continuationText: string) {
  const previous = previousText.trimEnd();
  const continuation = trimRepeatedContinuationPrefix(
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

function trimRepeatedContinuationPrefix(previousText: string, continuationText: string) {
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
    type: "delta" | "done" | "error";
    text?: string;
    message?: string;
    metrics?: Partial<CoreChatMessageMetrics>;
  };
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
        label: "Chat locale",
        status: "running",
        detail_redacted: "Chat tramite provider di inferenza",
      },
    ],
    activity_title: "Chat locale",
    activity_subtitle: "Inferenza tramite provider configurato",
    progress_current: 1,
    progress_total: 1,
    elapsed_seconds: elapsedSeconds,
    preview_frame_ref: null,
    current_url_redacted: null,
    terminal_excerpt_redacted: ["Chat collegata al provider di inferenza."],
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
