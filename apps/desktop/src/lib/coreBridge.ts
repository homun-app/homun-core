import { invoke } from "@tauri-apps/api/core";

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

export interface RuntimeProcessItem {
  id: string;
  kind: string;
  status: string;
  pid: number | null;
  message: string | null;
  health_check: unknown;
  command_label: string;
}

export interface RuntimeHealthSnapshot {
  processes: RuntimeProcessItem[];
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
}

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

export interface CorePromptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  metadata: string | null;
}

export interface CorePromptSubmissionResult {
  user_message: CorePromptMessage;
  assistant_message: CorePromptMessage;
  computer_session: CoreComputerSessionSnapshot;
  plan: CorePromptExecutionPlan | null;
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
}

export const coreBridge = {
  status: () => invoke<CoreBridgeStatus>("core_bridge_status"),
  runtimeHealth: () =>
    invoke<RuntimeHealthSnapshot>("runtime_health_snapshot"),
  checkProcessHealth: (processId: string) =>
    invoke<RuntimeProcessItem>("process_check_health", {
      processId,
    }),
  startProcess: (processId: string) =>
    invoke<RuntimeProcessItem>("process_start", { processId }),
  stopProcess: (processId: string) =>
    invoke<RuntimeProcessItem>("process_stop", { processId }),
  taskQueue: () => invoke<CoreTaskQueueSnapshot>("task_queue_snapshot"),
  taskDetail: (taskId: string) =>
    invoke<CoreTaskDetail | null>("task_detail", { taskId }),
  memoryDashboard: () =>
    invoke<CoreMemoryDashboard>("memory_dashboard_snapshot"),
  capabilities: () =>
    invoke<CoreCapabilitySnapshot>("capability_snapshot"),
  localComputerSession: (sessionId: string) =>
    invoke<CoreComputerSessionSnapshot | null>(
      "local_computer_session_snapshot",
      { sessionId },
    ),
  runLocalComputerSmokeTest: (sessionId: string) =>
    invoke<CoreComputerSessionSnapshot>("local_computer_run_smoke_test", {
      sessionId,
    }),
  submitUserPrompt: (sessionId: string, prompt: string) =>
    invoke<CorePromptSubmissionResult>("submit_user_prompt", {
      sessionId,
      prompt,
    }),
};
