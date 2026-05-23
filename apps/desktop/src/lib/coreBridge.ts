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
};
