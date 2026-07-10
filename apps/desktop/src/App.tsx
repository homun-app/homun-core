import { useEffect, useMemo, useRef, useState } from "react";
import i18n from "./i18n";
import { useTranslation } from "react-i18next";
import { AutomationsView } from "./components/AutomationsView";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { ChatView } from "./components/ChatView";
import { ContainedComputerView } from "./components/ContainedComputerView";
import { LearningView } from "./components/LearningView";
import { Shell } from "./components/Shell";
import { LoginGate } from "./components/LoginGate";
import { NotificationsView } from "./components/NotificationsView";
import { ShallowView } from "./components/ShallowView";
import { SettingsView } from "./components/SettingsView";
import { TasksView } from "./components/TasksView";
import {
  approvals,
  brainRun,
  chatMessages,
  connections,
  automationProposals,
  learningInsights,
  memorySummary,
  navItems as staticNavItems,
  runtimeHealth,
  tasks,
} from "./data/mockData";
import { pluginRegistry, type PluginHost } from "./plugins/registry";
import {
  coreBridge,
  subscribeAppEvents,
  type AppEvent,
  type AutomationCreateteInput,
  type ChatAttachmentInput,
  type ManagedAutomation,
  type CoreApprovelItem,
  type CoreChatAttachment,
  type CoreChatMessage,
  type CoreChatThread,
  type CoreChatThreadSnapshot,
  type CoreCapabilitySnapshot,
  type CoreMemoryDashboard,
  type CoreTaskDetail,
  type CoreTaskItem,
  type CoreTaskQueueSnapshot,
  type ProactivitySuggestion,
  type PluginState,
  type TemplateCatalogEntry,
} from "./lib/coreBridge";
import { wsSubscription } from "./lib/wsSubscription";
import { useSetting } from "./lib/settingsStore";
import { showSystemNotification, notificationPermission } from "./lib/systemNotifications";
import type {
  ApprovelItem,
  ChatAttachment,
  ChatEventPart,
  ChatMessage,
  ChatThread,
  ConnectionItem,
  MemorySummary,
  NavItem,
  Priority,
  RuntimeHealth,
  SettingsSectionId,
  TaskDetailItem,
  TaskItem,
  TaskResourceUsage,
  TaskStatus,
  ViewId,
} from "./types";

const defaultChatThread: ChatThread = {
  threadId: "thread_active_prompt",
  title: "New task",
  subtitle: "Local session ready",
  status: "active",
  pinned: false,
  computerSessionId: "computer_active_prompt",
  taskId: "task_prompt_session",
  updatedAt: currentTimestampSeconds(),
  messageCount: chatMessages.length,
};

function mapCoreChatThread(thread: CoreChatThread): ChatThread {
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

function mapCoreChatMessage(message: CoreChatMessage): ChatMessage {
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
    if (type === "reasoning" || type === "activity") {
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
      // Ricostruiamo da `unknown` (record persistito). La validazione runtime è
      // nei parser downstream (parseVaultProposalPayload, parseChoicePromptPayload…);
      // qui trasportiamo il payload nel tipo dichiarato della union (B2/A1).
      mapped.push({ type, payload: record.payload } as ChatEventPart);
    }
  }
  return mapped.length > 0 ? mapped : undefined;
}

function mapCoreChatAttachment(attachment: CoreChatAttachment): NonNullable<ChatMessage["attachments"]>[number] {
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
  };
}

function pendingChatAttachmentFromInput(attachment: ChatAttachmentInput): ChatAttachment {
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

function starterMessages(_thread: ChatThread): ChatMessage[] {
  // Empty: the chat empty-state hero ("How can I help you?") welcomes the user now,
  // so we don't seed a canned assistant greeting.
  return [];
}

function summarizeThreadTitle(text: string): string {
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

function updateThreadPreview(
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

function currentTimestampSeconds() {
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

function mapCoreTask(task: CoreTaskItem): TaskItem {
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

function mapCoreApprovel(approval: CoreApprovelItem): ApprovelItem {
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

function summarizeSafeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "No redacted data available";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.toLowerCase().includes("redacted")
      ? "Redacted payload"
      : "Redacted data available";
  }
  if (Array.isArray(value)) {
    return `Redacted list (${value.length})`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const recovery = record.desktop_recovery as Record<string, unknown> | undefined;
    if (recovery?.state === "requeued_after_restart") {
      return "Recovered after restart · resources released";
    }
    const approval = record.approval as Record<string, unknown> | undefined;
    if (approval?.decision) {
      return `Approvel ${String(approval.decision)} · ${String(
        approval.action ?? i18n.t("common.redactedAction"),
      )}`;
    }
    const prompt = record.prompt as Record<string, unknown> | undefined;
    if (prompt?.state) {
      return `Prompt · ${String(prompt.state)}`;
    }
    const step = record.step as Record<string, unknown> | undefined;
    if (step?.title) {
      return `Step · ${String(step.title)}`;
    }
    const visibleKeys = Object.keys(record)
      .filter((key) => !/raw|payload|input|content|secret/i.test(key))
      .slice(0, 4);
    return visibleKeys.length
      ? `Redacted JSON · ${visibleKeys.join(", ")}`
      : "Redacted JSON available";
  }
  return "Redacted data available";
}

function mapCoreTaskDetail(detail: CoreTaskDetail): TaskDetailItem {
  return {
    taskId: detail.task_id,
    kind: detail.kind,
    goal: detail.goal,
    status: mapCoreTaskStatus(detail.status),
    priority: mapCoreTaskPriority(detail.priority),
    blockedReason: humanizeTaskBlockedReasonKey(detail.blocked_reason)
      ? i18n.t(humanizeTaskBlockedReasonKey(detail.blocked_reason)!)
      : detail.blocked_reason ?? undefined,
    checkpointSummary: summarizeSafeValue(detail.latest_checkpoint),
    metadataSummary: summarizeSafeValue(detail.runtime_metadata),
    exposesRawInput: detail.exposes_raw_input,
  };
}

function mapCoreMemoryDashboard(dashboard: CoreMemoryDashboard): MemorySummary {
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

function mapCoreCapabilitySnapshot(
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

function fallbackTaskDetail(task: TaskItem): TaskDetailItem {
  return {
    taskId: task.id,
    kind: task.kind,
    goal: task.title,
    status: task.status,
    priority: task.priority,
    blockedReason: task.blockedReason,
    checkpointSummary: "Local read model not yet connected to the gateway",
    metadataSummary: "Open the desktop app for real core detail",
    exposesRawInput: false,
  };
}

export default function App() {
  const { t } = useTranslation();
  // System notifications opt-in (the SettingsView General pane wires permission).
  const [systemNotifEnabled] = useSetting<boolean>("general.systemNotifications", false);
  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [previousView, setPreviousView] = useState<ViewId>("chat");
  // Onboarding wizard: shown on first launch when no provider is configured.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Addons/plugin enabled-state (ADR 0011 §10-A): drives which registry plugins
  // contribute a nav entry + panel. Default-on until the backend answers.
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("account");
  // Active sub-item within a section that has an inline expandable submenu (e.g.
  // Model & Runtime → routing|decisions|providers). A single free-form string
  // keeps this generic for future sections (Connectors, etc.).
  const [settingsSub, setSettingsSub] = useState<string>("");
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([
    defaultChatThread,
  ]);
  const [activeThreadId, setActiveThreadId] = useState(
    defaultChatThread.threadId,
  );
  const [threadMessages, setThreadMessages] = useState<
    Record<string, ChatMessage[]>
  >({
    [defaultChatThread.threadId]: chatMessages,
  });
  const [taskItems, setTaskItems] = useState<TaskItem[]>(tasks);
  const [approvalItems, setApprovelItems] = useState<ApprovelItem[]>(approvals);
  const [automationItems, setAutomationItems] = useState<ManagedAutomation[]>([]);
  const [runtimeItems] = useState<RuntimeHealth[]>(runtimeHealth);
  const [memoryDashboard, setMemoryDashboard] =
    useState<MemorySummary>(memorySummary);
  const [connectionItems, setConnectionItems] =
    useState<ConnectionItem[]>(connections);
  const [resourceUsage, setResourceUsage] = useState<TaskResourceUsage[]>([]);
  const [selectedTaskDetail, setSelectedTaskDetail] =
    useState<TaskDetailItem | null>(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [approvalBusyId, setApprovelBusyId] = useState<string | null>(null);
  const [pendingTemplateAutoSubmit, setPendingTemplateAutoSubmit] = useState<{
    id: string;
    threadId: string;
    prompt: string;
    visibleText: string;
    attachments: ChatAttachmentInput[];
    visibleAttachments?: ChatAttachment[];
    mode?: string;
  } | null>(null);
  // The thread currently generating a chat answer (real-time signal from ChatView,
  // sub-polling cadence). Used to mark the thread busy in the sidebar immediately,
  // before the 2.5s taskQueue polling catches up.
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  const pendingLocalMessageThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingEventThreadIdsRef = useRef<Set<string>>(new Set());
  const busyThreadIdsRef = useRef<Set<string>>(new Set());
  // Thread ids generating in the BACKGROUND (a chat left mid-answer while another is
  // on screen). Polled from the gateway's resume registry so the sidebar dots light
  // up on every working chat, not only the active one.
  const [backgroundStreamIds, setBackgroundStreamIds] = useState<Set<string>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = useState("task_prompt_session");
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth > 860);
  const activeThread = useMemo(
    () =>
      chatThreads.find((thread) => thread.threadId === activeThreadId) ??
      chatThreads[0] ??
      defaultChatThread,
    [activeThreadId, chatThreads],
  );
  const automationWorkspaceId = activeThread.workspaceId ?? undefined;
  // Threads "busy": a real-time streaming signal (from ChatView, sub-poll) UNION
  // the taskQueue snapshot (running/queued tasks linked to a thread). The union
  // covers both the chat-stream case and the durable-background-task case.
  const busyThreadIds = useMemo(() => {
    const ids = new Set<string>(backgroundStreamIds);
    if (streamingThreadId) ids.add(streamingThreadId);
    for (const thread of chatThreads) {
      const task = taskItems.find((item) => item.id === thread.taskId);
      if (task && (task.status === "running" || task.status === "queued")) {
        ids.add(thread.threadId);
      }
    }
    return ids;
  }, [streamingThreadId, backgroundStreamIds, chatThreads, taskItems]);
  useEffect(() => {
    busyThreadIdsRef.current = busyThreadIds;
  }, [busyThreadIds]);
  const selectedTask = useMemo(
    () =>
      taskItems.find((task) => task.id === selectedTaskId) ?? {
        ...tasks[0],
        id: activeThread.taskId,
        title: activeThread.title,
        kind: "prompt_session",
        status: "queued" as const,
      },
    [activeThread.taskId, activeThread.title, selectedTaskId, taskItems],
  );
  const activeMessages =
    threadMessages[activeThread.threadId] ?? starterMessages(activeThread);
  const isSettings = activeView === "settings";

  function hasPendingLocalMessages(messages: ChatMessage[]): boolean {
    return messages.some((message) => message.id.startsWith("local_"));
  }

  function shouldPreserveLocalMessages(
    threadId: string,
    currentMessages: ChatMessage[] | undefined,
    incomingMessages: ChatMessage[],
  ): boolean {
    if (!currentMessages?.length) return false;
    const isProtected =
      pendingLocalMessageThreadIdsRef.current.has(threadId) ||
      busyThreadIdsRef.current.has(threadId);
    if (!isProtected) return false;
    const incomingIds = new Set(incomingMessages.map((message) => message.id));
    return currentMessages.some(
      (message) => message.id.startsWith("local_") && !incomingIds.has(message.id),
    );
  }

  function setThreadMessagesFromBackend(
    threadId: string,
    incomingMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ) {
    setThreadMessages((current) => {
      const currentMessages = current[threadId];
      if (
        options.force !== true &&
        shouldPreserveLocalMessages(threadId, currentMessages, incomingMessages)
      ) {
        return current;
      }
      pendingLocalMessageThreadIdsRef.current.delete(threadId);
      return {
        ...current,
        [threadId]: incomingMessages,
      };
    });
  }

  function handleNavigate(view: ViewId) {
    if (view === "settings" && activeView !== "settings") {
      setPreviousView(activeView);
    }
    setActiveView(view);
  }

  async function handleSelectThread(threadId: string) {
    const thread = chatThreads.find((item) => item.threadId === threadId);
    if (!thread) return;
    try {
      const snapshot = await coreBridge.selectChatThread(threadId);
      const mappedThreads = snapshot.threads.map(mapCoreChatThread);
      const selectedThread =
        mappedThreads.find((item) => item.threadId === threadId) ?? thread;
      const messages = await coreBridge.chatMessages(threadId);
      setChatThreads(mappedThreads.length ? mappedThreads : chatThreads);
      setThreadMessagesFromBackend(threadId, messages.messages.map(mapCoreChatMessage));
      setActiveThreadId(threadId);
      setSelectedTaskId(selectedThread.taskId);
      setActiveView("chat");
    } catch (error) {
      setActiveThreadId(threadId);
      setSelectedTaskId(thread.taskId);
      setActiveView("chat");
      console.warn("select_chat_thread unavailable", error);
    }
  }

  // Navigate to a thread that may live in ANOTHER workspace (e.g. a channel
  // thread in Personal): select_thread is workspace-aware and returns that
  // workspace's snapshot, so applying it switches context for us.
  async function navigateToThread(
    threadId: string,
    options: { forceMessages?: boolean } = {},
  ) {
    try {
      const snapshot = await coreBridge.selectChatThread(threadId);
      const mappedThreads = snapshot.threads.map(mapCoreChatThread);
      const selectedThread =
        mappedThreads.find((item) => item.threadId === threadId) ??
        mappedThreads[0] ??
        defaultChatThread;
      const messages = await coreBridge.chatMessages(threadId);
      setChatThreads(mappedThreads.length ? mappedThreads : chatThreads);
      setThreadMessagesFromBackend(
        threadId,
        messages.messages.map(mapCoreChatMessage),
        { force: options.forceMessages === true },
      );
      setActiveThreadId(threadId);
      setSelectedTaskId(selectedThread.taskId);
      setActiveView("chat");
    } catch (error) {
      console.warn("navigate_to_thread unavailable", error);
    }
  }

  // Real-time channel events. When an inbound Telegram/WhatsApp message creates a
  // thread, jump to it (create the card + switch). A ref keeps the handler fresh
  // (current state in closure) without re-subscribing on every render.
  const appEventHandlerRef = useRef<(event: AppEvent) => void>(() => {});
  appEventHandlerRef.current = (event: AppEvent) => {
    if (!event.thread_id) return;
    // The "homun" thread is retired as a proactive surface (its curiosities/onboarding
    // now flow as proactivity cards) — ignore its events; it has no nav entry to update.
    if (event.thread_id === "homun") {
      return;
    }
    const eventThreadId = event.thread_id;
    const isVisibleTurn = event.type === "thread.turn_started";
    const isThreadCreated = event.type === "thread.upserted";
    if (isVisibleTurn || isThreadCreated) {
      // Alert the user when something arrived/finished while the app wasn't in
      // front (a channel message, or a scheduled task that produced a result).
      // Skip when focused — the thread list + bell already surface it there.
      if (
        systemNotifEnabled &&
        document.hidden &&
        notificationPermission() === "granted"
      ) {
        const threadId = event.thread_id;
        showSystemNotification({
          title: event.title || t("notifications.newActivity"),
          body:
            event.channel === "scheduled"
              ? t("notifications.scheduledReady")
              : t("notifications.newMessage"),
          tag: threadId,
          onClick: () => void navigateToThread(threadId),
        });
      }
      if (isVisibleTurn) {
        pendingEventThreadIdsRef.current.add(eventThreadId);
      }
      void navigateToThread(eventThreadId, { forceMessages: isVisibleTurn }).finally(() => {
        if (isVisibleTurn) {
          window.setTimeout(() => {
            pendingEventThreadIdsRef.current.delete(eventThreadId);
          }, 1_500);
        }
      });
    } else if (
      event.type === "thread.updated" &&
      (eventThreadId === activeThreadId ||
        pendingEventThreadIdsRef.current.has(eventThreadId))
    ) {
      void refreshChatReadModels(eventThreadId);
    }
  };
  useEffect(() => {
    // Unified WebSocket: persistent channel for ALL server→client events.
    // Replaces subscribeAppEvents (NDJSON /api/events) + listenChatStreamEvent.
    wsSubscription.connect();
    const unsub = wsSubscription.subscribe((msg) => {
      // Dispatch app events (thread.updated, thread.turn_started, project_graph.ready)
      if (msg.type === "app.event") {
        const event = msg.event as Record<string, unknown>;
        appEventHandlerRef.current(event as unknown as Parameters<typeof appEventHandlerRef.current>[0]);
      }
    });
    return () => {
      // Drop only this component's handler. The WS is a process-lifetime
      // singleton ("connect at boot / disconnect at shutdown"): a React unmount
      // is NOT app shutdown. Under StrictMode's mount→unmount→remount, calling
      // disconnect() here closed a still-CONNECTING socket and left the singleton
      // wedged (isConnecting stuck true), permanently dead-locking connect().
      unsub();
    };
  }, []);

  // Onboarding check: if setup isn't complete and no provider is configured,
  // show the wizard overlay on first launch.
  useEffect(() => {
    void (async () => {
      try {
        const status = await coreBridge.setupStatus();
        if (status.needs_setup) setShowOnboarding(true);
      } catch {
        /* gateway not ready — will retry on next interaction */
      }
    })();
  }, []);

  async function handleCreateteChatThread(workspaceId?: string) {
    try {
      const targetWorkspace = workspaceId?.trim();
      if (targetWorkspace) {
        await coreBridge.selectWorkspace(targetWorkspace);
        const created = mapCoreChatThread(
          await coreBridge.createChatThread(targetWorkspace),
        );
        await coreBridge.selectChatThread(created.threadId);
        window.location.reload();
        return;
      }
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      const messages = await coreBridge.chatMessages(created.threadId);
      setChatThreads((current) => [
        created,
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessages((current) => ({
        ...current,
        [created.threadId]: messages.messages.map(mapCoreChatMessage),
      }));
      setActiveThreadId(created.threadId);
      setSelectedTaskId(created.taskId);
      setActiveView("chat");
    } catch (error) {
      const fallback: ChatThread = {
        ...defaultChatThread,
        threadId: `thread_preview_${Date.now()}`,
        computerSessionId: "computer_active_prompt",
        taskId: "task_prompt_session",
        subtitle: "Electron with local gateway in extraction",
        updatedAt: "ora",
        messageCount: 1,
      };
      setChatThreads((current) => [fallback, ...current]);
      setThreadMessages((current) => ({
        ...current,
        [fallback.threadId]: starterMessages(fallback),
      }));
      setActiveThreadId(fallback.threadId);
      setSelectedTaskId(fallback.taskId);
      setActiveView("chat");
      console.warn("create_chat_thread unavailable", error);
    }
  }

  // Engage a proactivity card (ADR 0011 §7): open a fresh chat in the card's scope,
  // pre-seeded with its context. This is what dissolves the proactive-task workspace
  // problem — the supervisor runs centrally and tags scope; the heavy chat
  // materializes on demand in the right place. Personal cards map to the base
  // ("local-workspace") which IS the memory "__personal__" scope; projects pass through.
  async function handleOpenSuggestion(suggestion: ProactivitySuggestion) {
    const workspaceId =
      suggestion.scope === "__personal__" ? "local-workspace" : suggestion.scope;
    // Open the chat with Homun's question already posted as an assistant message,
    // so the conversation starts with the assistant asking (not a composer draft /
    // generic empty-state). The follow-up is grounded by the auto-injected memory.
    const question = (suggestion.body ?? "").trim() || suggestion.title;
    // Question cards carry quick-reply options as structured event parts; marker
    // parsing stays only as historical fallback in ChatView.
    const options = (suggestion.choices ?? []).filter((o) => o.trim().length > 0);
    const seedEventParts: ChatEventPart[] =
      options.length > 0
        ? [{
            type: "choice_prompt",
            payload: {
              question: "",
              multi: false,
              options,
              // Marks this as a PROACTIVITY question (onboarding, follow-up, …). Answering
              // it captures the pick as memory instead of running an agent turn — see the
              // `purpose` branch in ChatView's onChoose. Carries the card kind for context.
              purpose: suggestion.kind,
            },
          }]
        : [];
    try {
      await coreBridge.selectWorkspace(workspaceId);
      const created = mapCoreChatThread(await coreBridge.createChatThread(workspaceId));
      const seeded = await coreBridge.seedAssistantMessage(created.threadId, question, seedEventParts);
      setChatThreads((current) => [
        created,
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessages((current) => ({
        ...current,
        [created.threadId]: seeded.messages.map(mapCoreChatMessage),
      }));
      setActiveThreadId(created.threadId);
      setSelectedTaskId(created.taskId);
      setActiveView("chat");
    } catch (error) {
      console.warn("open_suggestion unavailable", error);
    }
  }

  async function handleStartTemplateWorkflow(input: {
    template: TemplateCatalogEntry;
    attachment?: ChatAttachmentInput;
  }) {
    const visiblePrompt = `Help me create a presentation using the selected template "${input.template.name}".`;
    const operativePrompt = [
      "The user selected a template from the Presentations catalog and wants to use it to create a new presentation.",
      `template_ref=${input.template.id}`,
      `template_name=${input.template.name}`,
      `source_provider=${input.template.source_provider ?? "user_upload"}`,
      input.attachment
        ? `attached_file=${input.attachment.displayName}`
        : "attached_file=none; use the catalog template_ref and metadata as the style constraint.",
      "",
      "Do not generate the deck yet.",
      "Analyze the selected template as a constraint for style, layout and visual tone.",
      "First ask 2-4 essential questions to understand objective, audience, available content, slide count and tone.",
      "Then propose a concise plan and wait for confirmation before using make_deck.",
      `When the user confirms execution, use make_deck with template_ref="${input.template.id}".`,
    ].join("\n");
    try {
      const created = mapCoreChatThread(await coreBridge.createChatThread());
      const messages = await coreBridge.chatMessages(created.threadId);
      const timestamp = currentTimestampSeconds();
      setChatThreads((current) => [
        {
          ...created,
          title: summarizeThreadTitle(visiblePrompt),
          messageCount: Math.max(created.messageCount, messages.messages.length),
          updatedAt: timestamp,
        },
        ...current.filter((thread) => thread.threadId !== created.threadId),
      ]);
      setThreadMessagesFromBackend(created.threadId, messages.messages.map(mapCoreChatMessage));
      setActiveThreadId(created.threadId);
      setSelectedTaskId(created.taskId);
      setActiveView("chat");
      setPendingTemplateAutoSubmit({
        id: `template_auto_submit_${created.threadId}_${Date.now()}`,
        threadId: created.threadId,
        prompt: operativePrompt,
        visibleText: visiblePrompt,
        attachments: input.attachment ? [input.attachment] : [],
        visibleAttachments: input.attachment
          ? [pendingChatAttachmentFromInput(input.attachment)]
          : undefined,
        mode: "plan",
      });
    } catch (error) {
      console.warn("start_template_workflow unavailable", error);
    }
  }

  async function reloadPlugins() {
    setPluginStates(await coreBridge.plugins());
  }
  useEffect(() => {
    void reloadPlugins();
  }, []);

  // A registry plugin is shown unless the backend says it's disabled (default-on).
  const enabledPlugins = pluginRegistry.filter(
    (p) => pluginStates.find((s) => s.id === p.id)?.enabled !== false,
  );
  const composedNavItems: NavItem[] = [
    ...staticNavItems,
    ...enabledPlugins.map((p) => ({
      id: p.id as ViewId,
      label: p.navLabel,
      icon: p.navIcon,
      navSection: p.navSection ?? "more",
      promoted: p.promoted === true,
      order: p.navOrder,
    })),
  ];
  // The host capability surface handed to each plugin panel (ADR 0011 §6).
  const pluginHost: PluginHost = {
    openChat: handleOpenSuggestion,
    startTemplateWorkflow: handleStartTemplateWorkflow,
  };

  async function applyThreadSnapshot(snapshot: CoreChatThreadSnapshot) {
    const mappedThreads = snapshot.threads.map(mapCoreChatThread);
    const selectedThread =
      mappedThreads.find((thread) => thread.threadId === snapshot.active_thread_id) ??
      mappedThreads[0] ??
      defaultChatThread;
    setChatThreads(mappedThreads.length ? mappedThreads : [defaultChatThread]);
    setActiveThreadId(selectedThread.threadId);
    setSelectedTaskId(selectedThread.taskId);
    if (!threadMessages[selectedThread.threadId]) {
      try {
        const messages = await coreBridge.chatMessages(selectedThread.threadId);
        setThreadMessages((current) => ({
          ...current,
          [selectedThread.threadId]: messages.messages.map(mapCoreChatMessage),
        }));
      } catch (error) {
        console.warn("chat_messages unavailable after thread action", error);
      }
    }
  }

  async function handleSetChatThreadPinned(threadId: string, pinned: boolean) {
    try {
      await applyThreadSnapshot(await coreBridge.setChatThreadPinned(threadId, pinned));
    } catch (error) {
      setChatThreads((current) =>
        [...current]
          .map((thread) =>
            thread.threadId === threadId ? { ...thread, pinned } : thread,
          )
          .sort((left, right) => Number(right.pinned) - Number(left.pinned)),
      );
      console.warn("chat_thread_set_pinned unavailable", error);
    }
  }

  async function handleArchiveChatThread(threadId: string) {
    try {
      await applyThreadSnapshot(await coreBridge.archiveChatThread(threadId));
    } catch (error) {
      const nextThreads = chatThreads.map((thread) =>
        thread.threadId === threadId
          ? { ...thread, status: "archived" as const, pinned: false }
          : thread,
      );
      setChatThreads(nextThreads);
      if (activeThreadId === threadId) {
        const nextThread = nextThreads.find((thread) => thread.status === "active");
        if (nextThread) {
          setActiveThreadId(nextThread.threadId);
          setSelectedTaskId(nextThread.taskId);
        }
      }
      console.warn("chat_thread_archive unavailable", error);
    }
  }

  async function handleUnarchiveChatThread(threadId: string) {
    try {
      await applyThreadSnapshot(await coreBridge.unarchiveChatThread(threadId));
    } catch (error) {
      setChatThreads((current) =>
        current.map((thread) =>
          thread.threadId === threadId
            ? { ...thread, status: "active" as const }
            : thread,
        ),
      );
      setActiveThreadId(threadId);
      const restoredThread = chatThreads.find((thread) => thread.threadId === threadId);
      if (restoredThread) {
        setSelectedTaskId(restoredThread.taskId);
      }
      console.warn("chat_thread_unarchive unavailable", error);
    }
  }

  async function handleDeleteChatThread(threadId: string) {
    try {
      await applyThreadSnapshot(await coreBridge.deleteChatThread(threadId));
      setThreadMessages((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    } catch (error) {
      setChatThreads((current) => current.filter((thread) => thread.threadId !== threadId));
      setThreadMessages((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      if (activeThreadId === threadId) {
        const nextThread = chatThreads.find((thread) => thread.threadId !== threadId);
        if (nextThread) {
          setActiveThreadId(nextThread.threadId);
          setSelectedTaskId(nextThread.taskId);
        }
      }
      console.warn("chat_thread_delete unavailable", error);
    }
  }

  function handleMessagesChange(
    threadId: string,
    messages: ChatMessage[],
    options: { advanceActivity?: boolean } = {},
  ) {
    if (options.advanceActivity === true) {
      pendingLocalMessageThreadIdsRef.current.delete(threadId);
    } else if (hasPendingLocalMessages(messages)) {
      pendingLocalMessageThreadIdsRef.current.add(threadId);
    }
    setThreadMessages((current) => ({
      ...current,
      [threadId]: messages,
    }));
    setChatThreads((current) =>
      current.map((thread) =>
        thread.threadId === threadId
          ? updateThreadPreview(thread, messages, options)
          : thread,
      ),
    );
  }

  function applyTaskQueueSnapshot(snapshot: CoreTaskQueueSnapshot) {
    const nextTasks = [
      ...snapshot.active,
      ...snapshot.queued,
      ...snapshot.blocked,
      ...snapshot.recent_failures,
    ].map(mapCoreTask);
    setTaskItems(nextTasks.length ? nextTasks : tasks);
    setApprovelItems(
      snapshot.waiting_approvals.length
        ? snapshot.waiting_approvals.map(mapCoreApprovel)
        : [],
    );
    setResourceUsage(
      snapshot.resource_usage
        .filter((usage) => usage.units > 0)
        .map((usage) => ({
          resourceClass: usage.resource_class,
          units: usage.units,
        })),
    );
  }

  async function loadTaskQueue() {
    try {
      applyTaskQueueSnapshot(await coreBridge.taskQueue());
    } catch (error) {
      console.warn("task_queue_snapshot unavailable", error);
    }
  }

  async function loadAutomations() {
    try {
      setAutomationItems(await coreBridge.automations(automationWorkspaceId));
    } catch (error) {
      console.warn("automations unavailable", error);
    }
  }

  async function handleCreateteAutomation(input: AutomationCreateteInput) {
    try {
      await coreBridge.createAutomation({
        ...input,
        workspace_id: input.workspace_id ?? automationWorkspaceId,
      });
      await loadAutomations();
    } catch (error) {
      console.warn("create automation failed", error);
    }
  }

  async function handleUpdateAutomation(id: string, input: Partial<AutomationCreateteInput>) {
    try {
      await coreBridge.updateAutomation(id, input, automationWorkspaceId);
      await loadAutomations();
    } catch (error) {
      console.warn("update automation failed", error);
    }
  }

  async function handleToggleAutomation(id: string) {
    try {
      await coreBridge.toggleAutomation(id, automationWorkspaceId);
      await loadAutomations();
    } catch (error) {
      console.warn("toggle automation failed", error);
    }
  }

  async function handleDeleteAutomation(id: string) {
    try {
      await coreBridge.deleteAutomation(id, automationWorkspaceId);
      await loadAutomations();
    } catch (error) {
      console.warn("delete automation failed", error);
    }
  }

  async function loadMemoryAndCapabilities() {
    try {
      setMemoryDashboard(
        mapCoreMemoryDashboard(await coreBridge.memoryDashboard()),
      );
    } catch (error) {
      console.warn("memory_dashboard unavailable", error);
    }
    try {
      const nextConnections = mapCoreCapabilitySnapshot(
        await coreBridge.capabilities(),
      );
      setConnectionItems(nextConnections.length ? nextConnections : connections);
    } catch (error) {
      console.warn("capability_snapshot unavailable", error);
    }
  }

  async function refreshRuntimeReadModels(taskId = selectedTaskId) {
    await loadTaskQueue();
    if (taskId) {
      try {
        await refreshSelectedTaskDetail(taskId);
      } catch (error) {
        console.warn("task_detail unavailable after runtime change", error);
      }
    }
  }

  async function refreshChatReadModels(preferredThreadId = activeThreadId) {
    const snapshot = await coreBridge.chatThreads();
    const mappedThreads = snapshot.threads.map(mapCoreChatThread);
    const preferred = mappedThreads.find((thread) => thread.threadId === preferredThreadId);
    const selectedThread =
      preferred ??
      mappedThreads.find((thread) => thread.threadId === snapshot.active_thread_id) ??
      mappedThreads[0] ??
      defaultChatThread;
    const messages = await coreBridge.chatMessages(selectedThread.threadId);
    setChatThreads(mappedThreads.length ? mappedThreads : [defaultChatThread]);
    setActiveThreadId(selectedThread.threadId);
    setSelectedTaskId(selectedThread.taskId);
    setThreadMessagesFromBackend(
      selectedThread.threadId,
      messages.messages.map(mapCoreChatMessage),
    );
  }

  async function refreshSelectedTaskDetail(taskId: string) {
    const detail = await coreBridge.taskDetail(taskId);
    setSelectedTaskDetail(detail ? mapCoreTaskDetail(detail) : null);
  }

  async function handleApproveApprovel(
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) {
    setApprovelBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(await coreBridge.approveApprovel(approvalId, options));
      await refreshSelectedTaskDetail(selectedTaskId);
      await refreshRuntimeReadModels(activeThread.taskId);
      await refreshChatReadModels(activeThread.threadId);
    } catch (error) {
      console.warn("approval_approve unavailable", error);
    } finally {
      setApprovelBusyId(null);
    }
  }

  async function handleRejectApprovel(approvalId: string) {
    setApprovelBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(
        await coreBridge.rejectApprovel(
          approvalId,
          "Rejected by the user from the desktop UI.",
        ),
      );
      await refreshSelectedTaskDetail(selectedTaskId);
    } catch (error) {
      console.warn("approval_reject unavailable", error);
    } finally {
      setApprovelBusyId(null);
    }
  }

  useEffect(() => {
    function syncDrawerWithViewport() {
      setDrawerOpen(window.innerWidth > 860);
    }

    syncDrawerWithViewport();
    window.addEventListener("resize", syncDrawerWithViewport);
    return () => window.removeEventListener("resize", syncDrawerWithViewport);
  }, []);

  useEffect(() => {
    const pollActiveStreams = () =>
      void coreBridge.activeStreams().then((ids) => setBackgroundStreamIds(new Set(ids)));
    void loadMemoryAndCapabilities();
    void loadTaskQueue();
    void loadAutomations();
    pollActiveStreams();
    const interval = window.setInterval(() => {
      void loadTaskQueue();
      pollActiveStreams();
    }, 4_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeView === "automations") void loadAutomations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, automationWorkspaceId]);

  useEffect(() => {
    let cancelled = false;

    async function refreshOperationalReadModels() {
      if (!activeThreadId) return;
      try {
        await loadTaskQueue();
        if (selectedTaskId) {
          await refreshSelectedTaskDetail(selectedTaskId);
        }
        if (!cancelled) {
          await refreshChatReadModels(activeThreadId);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("operational_read_models_poll unavailable", error);
        }
      }
    }

    const interval = window.setInterval(refreshOperationalReadModels, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeThreadId, selectedTaskId]);

  useEffect(() => {
    let cancelled = false;

    async function loadSelectedTaskDetail() {
      if (!selectedTaskId) {
        setSelectedTaskDetail(null);
        return;
      }
      setTaskDetailLoading(true);
      try {
        if (!cancelled) {
          await refreshSelectedTaskDetail(selectedTaskId);
        }
      } catch (error) {
        if (!cancelled) {
          setSelectedTaskDetail(fallbackTaskDetail(selectedTask));
        }
        console.warn("task_detail unavailable", error);
      } finally {
        if (!cancelled) {
          setTaskDetailLoading(false);
        }
      }
    }

    void loadSelectedTaskDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedTask, selectedTaskId]);

  useEffect(() => {
    let cancelled = false;

    async function loadChatThreads() {
      try {
        const snapshot = await coreBridge.chatThreads();
        if (cancelled) return;
        const mapped = snapshot.threads.map(mapCoreChatThread);
        const selectedThread =
          mapped.find((thread) => thread.threadId === snapshot.active_thread_id) ??
          mapped[0] ??
          defaultChatThread;
        let selectedMessages = starterMessages(selectedThread);
        try {
          const messages = await coreBridge.chatMessages(selectedThread.threadId);
          selectedMessages = messages.messages.map(mapCoreChatMessage);
        } catch (error) {
          console.warn("active chat_messages unavailable", error);
        }
        if (cancelled) return;
        setChatThreads(mapped.length ? mapped : [defaultChatThread]);
        setActiveThreadId(selectedThread.threadId);
        setSelectedTaskId(selectedThread.taskId);
        setThreadMessagesFromBackend(selectedThread.threadId, selectedMessages);
      } catch (error) {
        console.warn("chat_thread_snapshot unavailable", error);
      }
    }

    void loadChatThreads();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <LoginGate>
      <Shell
      activeView={activeView}
      activeThreadId={activeThread.threadId}
      busyThreadIds={busyThreadIds}
      chatThreads={chatThreads}
      drawerOpen={drawerOpen}
      onCreateteChatThread={handleCreateteChatThread}
      onArchiveChatThread={handleArchiveChatThread}
      onBackFromSettings={() => setActiveView(previousView)}
      onDeleteChatThread={handleDeleteChatThread}
      navItems={composedNavItems}
      onNavigate={handleNavigate}
      onSelectThread={handleSelectThread}
      onSetChatThreadPinned={handleSetChatThreadPinned}
      onToggleDrawer={() => setDrawerOpen((value) => !value)}
      onUnarchiveChatThread={handleUnarchiveChatThread}
      onSelectSettingsSection={setSettingsSection}
      settingsSection={settingsSection}
      settingsSub={settingsSub}
      onSelectSettingsSub={setSettingsSub}
      hideChrome={showOnboarding}
    >
      <main
        className={`workspace ${isSettings ? "settings-workspace" : ""}`}
        aria-label={t("app.mainWorkspace")}
      >
        {activeView === "chat" && (
          <ChatView
            key={activeThread.threadId}
            approvals={approvalItems}
            approvalBusyId={approvalBusyId}
            computerSessionId={activeThread.computerSessionId}
            messages={activeMessages}
            health={runtimeItems}
            task={selectedTask}
            thread={activeThread}
            onMessagesChange={(messages) =>
              handleMessagesChange(activeThread.threadId, messages)
            }
            autoSubmit={
              pendingTemplateAutoSubmit?.threadId === activeThread.threadId
                ? pendingTemplateAutoSubmit
                : null
            }
            onAutoSubmitConsumed={(id) =>
              setPendingTemplateAutoSubmit((current) =>
                current?.id === id ? null : current,
              )
            }
            onOpenTasks={() => setActiveView("tasks")}
            onApproveApprovel={handleApproveApprovel}
            onRejectApprovel={handleRejectApprovel}
            onRuntimeChanged={() => refreshRuntimeReadModels(activeThread.taskId)}
            onThreadChanged={() => refreshChatReadModels(activeThread.threadId)}
            onStreamingChange={(busy) =>
              setStreamingThreadId(busy ? activeThread.threadId : null)
            }
          />
        )}
        {activeView === "tasks" && (
          <TasksView
            tasks={taskItems}
            approvals={approvalItems}
            resourceUsage={resourceUsage}
            selectedTaskDetail={selectedTaskDetail}
            taskDetailLoading={taskDetailLoading}
            approvalBusyId={approvalBusyId}
            selectedTaskId={selectedTask.id}
            onApproveApprovel={handleApproveApprovel}
            onRejectApprovel={handleRejectApprovel}
            onSelectTask={setSelectedTaskId}
          />
        )}
        {activeView === "learning" && (
          <LearningView
            insights={learningInsights}
            proposals={automationProposals}
          />
        )}
        {/* Memory has no top-level view: it lives in Settings → Memory only
            (SettingsView renders <MemoryView embedded />). */}
        {activeView === "settings" && (
          <SettingsView
            connections={connectionItems}
            section={settingsSection}
            sub={settingsSub}
            onPluginsChanged={reloadPlugins}
          />
        )}
        {activeView === "automations" && (
          <AutomationsView
            automations={automationItems}
            onCreatete={handleCreateteAutomation}
            onUpdate={handleUpdateAutomation}
            onToggle={handleToggleAutomation}
            onDelete={handleDeleteAutomation}
          />
        )}
        {enabledPlugins.map(
          (plugin) =>
            activeView === plugin.id && <plugin.Panel key={plugin.id} host={pluginHost} />,
        )}
        {activeView === "browser" && <ContainedComputerView />}
        {activeView === "notifications" && <NotificationsView />}
        {activeView === "brain" && (
          <ShallowView
            title="Brain Audit"
            eyebrow={t("app.explainablePlans")}
            description={`Route, loaded tools, memory refs and subagent steps are persisted without raw payload. ${contextBudgetSummary(brainRun.contextBudget)}`}
            stats={[
              { label: "Route", value: brainRun.route },
              { label: "Rounds", value: String(brainRun.plannerRounds) },
              { label: "Tools", value: String(brainRun.loadedTools) },
              {
                label: "Context",
                value: `${Math.round(contextBudgetCompressionRatio(brainRun.contextBudget) * 100)}%`,
              },
            ]}
          />
        )}
      </main>
    </Shell>
      {/* Rendered AFTER Shell so the overlay's `-webkit-app-region: no-drag`
          regions are processed last and win over the main app's drag zones
          (e.g. .task-topbar), which otherwise swallow clicks on the onboarding's
          top-placed controls (provider slide-over close). */}
      {showOnboarding && (
        <OnboardingWizard onComplete={() => setShowOnboarding(false)} />
      )}
    </LoginGate>
  );
}

function contextBudgetCompressionRatio(
  budget: Array<{ inputChars: number; outputChars: number }>,
) {
  const input = budget.reduce((total, item) => total + item.inputChars, 0);
  const output = budget.reduce((total, item) => total + item.outputChars, 0);
  if (input === 0) return 100;
  return output / input;
}

function contextBudgetSummary(
  budget: Array<{
    compressed: boolean;
    redacted: boolean;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    redactionCount: number;
  }>,
) {
  const compressed = budget.filter((item) => item.compressed).length;
  const redacted = budget.reduce((total, item) => total + item.redactionCount, 0);
  const inputTokens = budget.reduce(
    (total, item) => total + item.estimatedInputTokens,
    0,
  );
  const outputTokens = budget.reduce(
    (total, item) => total + item.estimatedOutputTokens,
    0,
  );
  if (budget.length === 0) return "No compression applied.";
  return `Compressed ${compressed}/${budget.length} contexts, ${inputTokens} -> ${outputTokens} estimated tokens, ${redacted} redactions.`;
}
