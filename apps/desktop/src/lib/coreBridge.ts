import { chatApi } from "./chatApi";
import { DESKTOP_GATEWAY_URL, gatewayHeaders } from "./gatewayConfig";

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

export interface RuntimeProcessItem {
  id: string;
  kind: string;
  status: string;
  pid: number | null;
  message: string | null;
  health_check: unknown;
  command_label: string;
}

export interface RuntimeControlItem {
  process_id: string;
  status: string;
  port: number | null;
  port_owner_pid: number | null;
  duplicate_count: number;
  total_memory_mb: number | null;
  available_memory_mb: number | null;
  process_memory_mb: number | null;
  process_cpu_percent: number | null;
  message: string;
}

export interface RuntimeHealthSnapshot {
  processes: RuntimeProcessItem[];
  controls: RuntimeControlItem[];
}

export interface RuntimeLogEntryItem {
  stream: string;
  line_redacted: string;
}

export interface RuntimeLogsSnapshot {
  process_id: string;
  source: string;
  entries: RuntimeLogEntryItem[];
  message: string;
}

export interface RuntimeWarmupResponse {
  ok: boolean;
  model: string;
  loaded: boolean;
  load_seconds: number | null;
  elapsed_seconds: number;
  local_first: boolean;
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

async function electronSystemStatus(): Promise<SystemStatus> {
  return gatewayGetJson<SystemStatus>("/api/system/status");
}

async function electronCloseAllBrowsers(): Promise<CloseAllBrowsersResult> {
  return gatewayPostJson<CloseAllBrowsersResult>("/api/system/browser/close-all", {});
}

async function electronWorkspaces(): Promise<WorkspacesSnapshot> {
  return gatewayGetJson<WorkspacesSnapshot>("/api/workspaces");
}

async function electronCreateWorkspace(name: string): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>("/api/workspaces", { name });
}

async function electronSelectWorkspace(id: string): Promise<WorkspacesSnapshot> {
  return gatewayPostJson<WorkspacesSnapshot>(
    `/api/workspaces/${encodeURIComponent(id)}/select`,
    {},
  );
}

async function electronMcpConnect(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<McpConnectResult> {
  return gatewayPostJson<McpConnectResult>("/api/capabilities/mcp/connect", {
    name: input.name,
    command: input.command,
    args: input.args ?? [],
    env: input.env ?? {},
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

async function electronComposioLink(toolkitSlug: string): Promise<ComposioLinkResult> {
  return gatewayPostJson<ComposioLinkResult>(
    "/api/capabilities/composio/link",
    { toolkit_slug: toolkitSlug },
  );
}

async function electronComposioConnections(): Promise<ComposioConnection[]> {
  const payload = await gatewayGetJson<{ connections: ComposioConnection[] }>(
    "/api/capabilities/composio/connections",
  );
  return payload.connections ?? [];
}

export const coreBridge = {
  status: () => Promise.resolve(electronCoreStatus()),
  runtimeModel: () => electronRuntimeModel(),
  runtimeModels: () => electronRuntimeModels(),
  setRuntimeModel: (model: string) => electronSetRuntimeModel(model),
  runtimeProvider: () => electronRuntimeProvider(),
  setRuntimeProvider: (input: { base_url?: string; model?: string; api_key?: string }) =>
    electronSetRuntimeProvider(input),
  containedComputerLive: () => electronContainedComputerLive(),
  systemStatus: () => electronSystemStatus(),
  closeAllBrowsers: () => electronCloseAllBrowsers(),
  workspaces: () => electronWorkspaces(),
  createWorkspace: (name: string) => electronCreateWorkspace(name),
  selectWorkspace: (id: string) => electronSelectWorkspace(id),
  mcpConnect: (input: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }) => electronMcpConnect(input),
  composioConnect: (apiKey: string) => electronComposioConnect(apiKey),
  composioToolkits: () => electronComposioToolkits(),
  composioLink: (toolkitSlug: string) => electronComposioLink(toolkitSlug),
  composioConnections: () => electronComposioConnections(),
  chatThreads: () => chatApi.chatThreads(),
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
  createChatThread: () => chatApi.createChatThread(),
  setChatThreadPinned: (threadId: string, pinned: boolean) =>
    chatApi.setChatThreadPinned(threadId, pinned),
  archiveChatThread: (threadId: string) =>
    chatApi.archiveChatThread(threadId),
  unarchiveChatThread: (threadId: string) =>
    chatApi.unarchiveChatThread(threadId),
  deleteChatThread: (threadId: string) => chatApi.deleteChatThread(threadId),
  runtimeHealth: () => electronRuntimeHealth(),
  runtimeLogs: () => electronRuntimeLogs(),
  warmupRuntime: (_processId: string) => warmupBrowserRuntime(),
  checkProcessHealth: (processId: string) =>
    Promise.resolve(electronRuntimeProcess(processId, "ready")),
  startProcess: (processId: string) => startElectronRuntimeProcess(processId),
  stopProcess: (processId: string) => stopElectronRuntimeProcess(processId),
  restartProcess: (processId: string) => restartElectronRuntimeProcess(processId),
  taskQueue: () => electronTaskQueue(),
  taskExecutorStatus: () => electronTaskExecutorStatus(),
  taskDetail: (taskId: string) => electronTaskDetail(taskId),
  approveApproval: (approvalId: string, options?: ApprovalDecisionOptions) =>
    electronApproveApproval(approvalId, options),
  rejectApproval: (approvalId: string, reason: string) =>
    electronRejectApproval(approvalId, reason),
  memoryDashboard: () => electronMemoryDashboard(),
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
  ) =>
    submitBrowserRuntimeChatPromptStream(
      requestId,
      threadId,
      sessionId,
      prompt,
      visiblePrompt,
    ),
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
  await Promise.allSettled([
    fetch(`${DESKTOP_GATEWAY_URL}/api/chat/cancel_generation`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({ request_id: requestId }),
    }),
    chatApi.cancelChatPromptStream(requestId),
  ]);
}

function electronCoreStatus(): CoreBridgeStatus {
  return {
    user_id: "local-user",
    workspace_id: "local-workspace",
    local_first: true,
    cloud_api_enabled: false,
    components: [
      { id: "desktop-shell", label: "Electron", status: "ready" },
      { id: "llm-gemma4-mlx", label: "Gemma 4 MLX", status: "local" },
    ],
  };
}

async function electronRuntimeHealth(): Promise<RuntimeHealthSnapshot> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/runtime/health`, {
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Desktop Gateway runtime health HTTP ${response.status}`);
  }
  return response.json() as Promise<RuntimeHealthSnapshot>;
}

async function electronRuntimeLogs(): Promise<RuntimeLogsSnapshot> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/runtime/logs`, {
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Desktop Gateway runtime logs HTTP ${response.status}`);
  }
  return response.json() as Promise<RuntimeLogsSnapshot>;
}

async function warmupBrowserRuntime(): Promise<RuntimeWarmupResponse> {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/runtime/warmup`, {
      method: "POST",
      headers: gatewayHeaders(),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as Partial<RuntimeWarmupResponse>;
    return {
      ok: payload.ok ?? true,
      model: payload.model ?? "mlx-community/gemma-4-e4b-it-4bit",
      loaded: payload.loaded ?? true,
      load_seconds: payload.load_seconds ?? null,
      elapsed_seconds:
        payload.elapsed_seconds ?? roundedSeconds((performance.now() - startedAt) / 1000),
      local_first: true,
    };
  } catch {
    return {
      ok: false,
      model: "mlx-community/gemma-4-e4b-it-4bit",
      loaded: false,
      load_seconds: null,
      elapsed_seconds: roundedSeconds((performance.now() - startedAt) / 1000),
      local_first: true,
    };
  }
}

async function shutdownBrowserRuntime(): Promise<unknown> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/runtime/shutdown`, {
    method: "POST",
    headers: gatewayHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Desktop Gateway runtime shutdown HTTP ${response.status}`);
  }
  return response.json();
}

async function startElectronRuntimeProcess(
  processId: string,
): Promise<RuntimeProcessItem> {
  const result = await warmupBrowserRuntime();
  return electronRuntimeProcess(
    processId,
    result.ok && result.loaded ? "ready" : "attention",
    result.ok && result.loaded
      ? "Runtime Gemma locale pronto"
      : "Runtime Gemma locale non raggiungibile",
  );
}

async function stopElectronRuntimeProcess(
  processId: string,
): Promise<RuntimeProcessItem> {
  await shutdownBrowserRuntime();
  return electronRuntimeProcess(processId, "stopped", "Runtime Gemma locale fermato");
}

async function restartElectronRuntimeProcess(
  processId: string,
): Promise<RuntimeProcessItem> {
  try {
    await shutdownBrowserRuntime();
  } catch {
    // Some runtime builds keep shutdown disabled; warmup is still the useful recovery path.
  }
  return startElectronRuntimeProcess(processId);
}

function electronRuntimeProcess(
  processId: string,
  status: string,
  message = "Runtime locale gestito fuori dalla shell desktop",
): RuntimeProcessItem {
  return {
    id: processId,
    kind: "local_runtime",
    status,
    pid: null,
    message,
    health_check: null,
    command_label: "Gemma 4 MLX",
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

async function electronTaskQueue(): Promise<CoreTaskQueueSnapshot> {
  try {
    const response = await fetch(`${DESKTOP_GATEWAY_URL}/api/tasks/queue`, {
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
  );
  const promptBuildSeconds = roundedSeconds(
    (performance.now() - promptBuildStartedAt) / 1000,
  );
  const response = stream.response;
  if (!response.ok) {
    throw new Error(`Runtime Gemma non disponibile: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Runtime Gemma non ha aperto lo stream locale.");
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
        if (!text && event.text) text = String(event.text);
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
      metadata: "Gemma locale",
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
        detail_redacted: "Fallback browser verso runtime Gemma locale",
      },
    ],
    activity_title: "Chat Gemma locale",
    activity_subtitle: "Runtime locale tramite browser preview",
    progress_current: 1,
    progress_total: 1,
    elapsed_seconds: elapsedSeconds,
    preview_frame_ref: null,
    current_url_redacted: null,
    terminal_excerpt_redacted: ["Browser preview collegata al runtime Gemma locale."],
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
