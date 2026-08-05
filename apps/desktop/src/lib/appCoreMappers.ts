import i18n from "../i18n";
import type {
  ChatAttachmentInput,
  CoreApprovelItem,
  CoreCapabilitySnapshot,
  CoreChatAttachment,
  CoreChatMessage,
  CoreChatThread,
  CoreMemoryDashboard,
  CoreTaskItem,
  CoreThreadAttention,
  CoreUncertainEffect,
} from "./coreBridge";
import type { ThreadAttentionSnapshot } from "./threadAttentionState";
import type {
  ApprovelItem,
  ChatAttachment,
  ChatEventPart,
  ChatMessage,
  ChatThread,
  ConnectionItem,
  MemorySummary,
  Priority,
  TaskItem,
  TaskStatus,
  UncertainEffectItem,
} from "../types";

export function mapCoreChatThread(thread: CoreChatThread): ChatThread {
  return {
    threadId: thread.thread_id,
    workspaceId: thread.workspace_id ?? null,
    title: thread.title,
    subtitle: thread.subtitle,
    status: thread.status === "archived" ? "archived" : "active",
    pinned: thread.pinned,
    computerSessionId: thread.computer_session_id,
    taskId: thread.task_id,
    updatedAt: thread.updated_at,
    messageCount: thread.message_count,
    source: thread.source ?? null,
    channelRecipient: thread.channel_recipient ?? null,
  };
}

export function mapCoreThreadAttention(row: CoreThreadAttention): ThreadAttentionSnapshot {
  return {
    threadId: row.thread_id,
    status: row.status,
    terminalEventId: row.latest_terminal_event_id,
    lastSeenTerminalEventId: row.last_seen_terminal_event_id,
  };
}

export function mapCoreChatMessage(message: CoreChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    metadata: message.metadata ?? undefined,
    metrics: message.metrics
      ? {
          promptTokens: message.metrics.prompt_tokens,
          generationTokens: message.metrics.generation_tokens,
          promptTps: message.metrics.prompt_tps,
          generationTps: message.metrics.generation_tps,
          peakMemoryGb: message.metrics.peak_memory_gb,
          elapsedSeconds: message.metrics.elapsed_seconds,
          maxTokens: message.metrics.max_tokens,
          promptBuildSeconds: message.metrics.prompt_build_seconds ?? undefined,
          timeToFirstTokenSeconds:
            message.metrics.time_to_first_token_seconds ?? undefined,
          totalElapsedSeconds: message.metrics.total_elapsed_seconds ?? undefined,
          runtimeStatusBefore: message.metrics.runtime_status_before ?? undefined,
        }
      : undefined,
    feedback: message.feedback ?? undefined,
    savedMemoryRef: message.saved_memory_ref ?? undefined,
    linkedTaskId: message.linked_task_id ?? undefined,
    linkedAutomationRef: message.linked_automation_ref ?? undefined,
    attachments: (message.attachments ?? []).map(mapCoreChatAttachment),
    eventParts: mapCoreChatEventParts(message.event_parts),
  };
}

function mapCoreChatEventParts(parts: unknown[] | null | undefined): ChatEventPart[] | undefined {
  if (!Array.isArray(parts) || parts.length === 0) {
    return undefined;
  }
  const mapped: ChatEventPart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    const type = record.type;
    if (type === "reasoning") {
      continue;
    }
    if (type === "activity") {
      if (typeof record.text === "string") {
        mapped.push({ type, text: record.text });
      }
      continue;
    }
    if (type === "plan_update") {
      if (typeof record.markdown === "string") {
        mapped.push({ type, markdown: record.markdown });
      }
      continue;
    }
    if (
      type === "choice_prompt" ||
      type === "vault_propose" ||
      type === "vault_reveal" ||
      type === "payment_approval" ||
      type === "tool_result" ||
      type === "recall" ||
      type === "diff"
    ) {
      // Persisted events are validated by downstream structured payload parsers.
      mapped.push({ type, payload: record.payload } as ChatEventPart);
    }
  }
  return mapped.length > 0 ? mapped : undefined;
}

function mapCoreChatAttachment(
  attachment: CoreChatAttachment,
): NonNullable<ChatMessage["attachments"]>[number] {
  return {
    artifactId: attachment.artifact_id,
    title: attachment.title_redacted,
    kind:
      attachment.kind === "image" || attachment.kind === "text"
        ? attachment.kind
        : "file",
    sizeBytes: attachment.size_bytes,
    previewAvailable: attachment.preview_available,
    privacyDomain: attachment.privacy_domain,
    previewUrl: attachment.preview_url,
  };
}

export function pendingChatAttachmentFromInput(attachment: ChatAttachmentInput): ChatAttachment {
  return {
    artifactId: `pending_${attachment.displayName}_${attachment.sizeBytes}`,
    title: attachment.displayName,
    kind: attachment.mimeType.startsWith("image/")
      ? "image"
      : attachment.mimeType.startsWith("text/")
        ? "text"
        : "file",
    sizeBytes: attachment.sizeBytes,
    previewAvailable: attachment.mimeType.startsWith("image/"),
    privacyDomain: "local_files",
  };
}

export function starterMessages(_thread: ChatThread): ChatMessage[] {
  // Empty: the chat empty-state hero welcomes the user now, so no canned greeting is seeded.
  return [];
}

export function summarizeThreadTitle(text: string): string {
  const normalized = text.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  const stop = new Set([
    "a",
    "ad",
    "al",
    "alla",
    "anche",
    "che",
    "ci",
    "con",
    "crea",
    "creare",
    "dai",
    "dammi",
    "del",
    "della",
    "di",
    "dimmi",
    "e",
    "fai",
    "fare",
    "il",
    "in",
    "la",
    "le",
    "lo",
    "mi",
    "per",
    "puoi",
    "se",
    "sono",
    "sto",
    "su",
    "sui",
    "una",
    "usando",
    "usa",
    "using",
    "with",
    "the",
    "for",
    "to",
    "create",
    "make",
    "me",
    "tell",
    "give",
  ]);
  const keywords = normalized.filter((word) => !stop.has(word.toLowerCase()));
  const source = keywords.length > 0 ? keywords : normalized;
  const title = source.slice(0, 5).join(" ");
  return title.length > 44 ? `${title.slice(0, 41).trim()}...` : title;
}

export function updateThreadPreview(
  thread: ChatThread,
  messages: ChatMessage[],
  options: { advanceActivity?: boolean } = {},
): ChatThread {
  const lastMessage = messages.at(-1);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const userTitle = firstUserMessage ? summarizeThreadTitle(firstUserMessage.text) : "";
  const isPlaceholderTitle = thread.title === "New task" || thread.title === "Nuovo compito";
  const hasNewAssistantActivity =
    options.advanceActivity === true && lastMessage?.role === "assistant";
  return {
    ...thread,
    title: isPlaceholderTitle && userTitle ? userTitle : thread.title,
    messageCount: messages.length,
    subtitle: lastMessage?.text.slice(0, 72) || "Local chat ready",
    updatedAt: hasNewAssistantActivity ? lastMessage.timestamp : thread.updatedAt,
  };
}

export function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

function mapCoreTaskStatus(status: string): TaskStatus {
  if (
    status === "queued" ||
    status === "running" ||
    status === "waiting_user_approval" ||
    status === "waiting_resource" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }
  return "queued";
}

function mapCoreTaskPriority(priority: string): Priority {
  if (
    priority === "critical" ||
    priority === "high" ||
    priority === "normal" ||
    priority === "low" ||
    priority === "background"
  ) {
    return priority;
  }
  return "normal";
}

export function mapCoreTask(task: CoreTaskItem): TaskItem {
  return {
    id: task.task_id,
    title: task.goal,
    kind: task.kind,
    status: mapCoreTaskStatus(task.status),
    priority: mapCoreTaskPriority(task.priority),
    resource: "task_runtime",
    risk: "low",
    updated: "ora",
    blockedReason: humanizeTaskBlockedReasonKey(task.blocked_reason)
      ? i18n.t(humanizeTaskBlockedReasonKey(task.blocked_reason)!)
      : task.blocked_reason ?? undefined,
  };
}

export function mapCoreUncertainEffect(effect: CoreUncertainEffect): UncertainEffectItem {
  return {
    id: effect.receipt_ref,
    executionId: effect.execution_id,
    threadId: effect.thread_id,
    scopeLabel: effect.thread_id ? effect.thread_id.slice(-8) : null,
    operationFamily: effect.operation_family,
    uncertainAt: effect.uncertain_at,
    core: effect,
  };
}

export function mapCoreApprovel(approval: CoreApprovelItem): ApprovelItem {
  const isBrowserAction = approval.action === "browser.manual_action";
  const isPromptPlanAction = approval.action === "prompt_plan.approve_step";
  const requestedSession =
    approval.task_id === "task_prompt_session"
      ? "computer_active_prompt"
      : approval.task_id.startsWith("task_thread_")
        ? approval.task_id.replace("task_thread_", "computer_thread_")
        : "";
  return {
    id: approval.approval_id,
    taskId: approval.task_id,
    title: isBrowserAction
      ? i18n.t("approval.browserAction")
      : isPromptPlanAction
        ? i18n.t("approval.confirmPlan")
        : approval.action,
    reason: isBrowserAction
      ? i18n.t(humanizeBrowserApprovelReasonKey(approval.explanation))
      : isPromptPlanAction
        ? i18n.t("approval.confirmPlanReason")
        : approval.explanation,
    action: approval.action,
    boundary: approval.data_boundary,
    risk: approval.risk_level === "high" ? "high" : "medium",
    requestedBy: `${approval.task_id} ${requestedSession}`.trim(),
    scopeOptions: filterApprovelScopes(approval.scope_options),
    browserVisibilityOptions: filterBrowserVisibilityOptions(
      approval.browser_visibility_options,
    ),
    defaultBrowserVisibility: filterBrowserVisibility(approval.default_browser_visibility),
  };
}

function filterApprovelScopes(values?: string[]): Array<"once" | "always"> {
  const options = (values ?? []).filter(
    (value): value is "once" | "always" => value === "once" || value === "always",
  );
  return options.length ? options : ["once"];
}

function filterBrowserVisibilityOptions(
  values?: string[],
): Array<"auto" | "visible" | "headless"> {
  return (values ?? []).filter(
    (value): value is "auto" | "visible" | "headless" =>
      value === "auto" || value === "visible" || value === "headless",
  );
}

function filterBrowserVisibility(value?: string): "auto" | "visible" | "headless" {
  if (value === "visible" || value === "headless") {
    return value;
  }
  return "auto";
}

function humanizeBrowserApprovelReasonKey(reason: string): string {
  const match = reason.match(/before execution: ([a-z_]+)/i);
  const action = match?.[1] ?? "default";
  if (action === "click" || action === "close" || action === "type") {
    return `approval.${action}`;
  }
  return "approval.default";
}

function humanizeTaskBlockedReasonKey(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === "recovered after desktop restart") {
    return "task.blocked.recovered";
  }
  if (reason.startsWith("resource ")) {
    return "task.blocked.resource";
  }
  if (reason.startsWith("approval required:")) {
    return "task.blocked.approval";
  }
  return null;
}

export function mapCoreMemoryDashboard(dashboard: CoreMemoryDashboard): MemorySummary {
  const confirmed =
    dashboard.by_status.find((item) => item.key === "confirmed")?.count ?? 0;
  const candidates =
    dashboard.by_status.find((item) => item.key === "candidate")?.count ?? 0;
  return {
    confirmed,
    candidates,
    domains: dashboard.by_privacy_domain.map((item) => ({
      label: item.key,
      count: item.count,
    })),
  };
}

export function mapCoreCapabilitySnapshot(
  snapshot: CoreCapabilitySnapshot,
): ConnectionItem[] {
  const connected = snapshot.connections.map((connection) => ({
    id: connection.id,
    name: connection.display_name,
    type: capabilityType(connection.provider_id),
    status:
      connection.status === "active"
        ? ("connected" as const)
        : connection.status === "disabled"
          ? ("disabled" as const)
          : ("available" as const),
    description: connectionDescription(connection.provider_id),
  }));
  const connectedProviderIds = new Set(
    snapshot.connections.map((connection) => connection.provider_id),
  );
  const availableProviders = Array.from(
    new Map(
      snapshot.tools
        .filter((tool) => !connectedProviderIds.has(tool.provider_id))
        .map((tool) => [tool.provider_id, tool]),
    ).values(),
  ).map((tool) => ({
    id: tool.provider_id,
    name: providerDisplayName(tool.provider_id),
    type: capabilityType(tool.provider_kind),
    status: "available" as const,
    description: tool.description,
  }));
  return [...connected, ...availableProviders];
}

function capabilityType(value: string): ConnectionItem["type"] {
  if (value === "mcp") return "mcp";
  if (value === "managed") return "managed";
  if (value === "skill") return "skill";
  return "native";
}

function providerDisplayName(providerId: string): string {
  if (providerId === "browser") return "My browser";
  return providerId;
}

function connectionDescription(providerId: string): string {
  if (providerId === "browser") {
    return "Local actions with Playwright/CDP, redacted snapshots and confirmations.";
  }
  return "Local connector registered in the capability registry.";
}
