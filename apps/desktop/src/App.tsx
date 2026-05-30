import { useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import { ConnectionsView } from "./components/ConnectionsView";
import { ContainedComputerView } from "./components/ContainedComputerView";
import { LearningView } from "./components/LearningView";
import { Shell } from "./components/Shell";
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
  runtimeHealth,
  tasks,
} from "./data/mockData";
import {
  coreBridge,
  type CoreApprovalItem,
  type CoreChatAttachment,
  type CoreChatMessage,
  type CoreChatThread,
  type CoreChatThreadSnapshot,
  type CoreCapabilitySnapshot,
  type CoreMemoryDashboard,
  type CoreTaskDetail,
  type CoreTaskItem,
  type CoreTaskQueueSnapshot,
  type RuntimeControlItem,
  type RuntimeLogsSnapshot,
  type RuntimeProcessItem,
} from "./lib/coreBridge";
import type {
  ApprovalItem,
  ChatMessage,
  ChatThread,
  ConnectionItem,
  MemorySummary,
  Priority,
  RuntimeControl,
  RuntimeHealth,
  RuntimeLogs,
  SettingsSectionId,
  TaskDetailItem,
  TaskItem,
  TaskResourceUsage,
  TaskStatus,
  ViewId,
} from "./types";

const defaultChatThread: ChatThread = {
  threadId: "thread_active_prompt",
  title: "Nuovo compito",
  subtitle: "Sessione locale pronta",
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
    title: thread.title,
    subtitle: thread.subtitle,
    status: thread.status === "archived" ? "archived" : "active",
    pinned: thread.pinned,
    computerSessionId: thread.computer_session_id,
    taskId: thread.task_id,
    updatedAt: thread.updated_at,
    messageCount: thread.message_count,
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
  };
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

function starterMessages(thread: ChatThread): ChatMessage[] {
  return [
    {
      id: `${thread.threadId}_ready`,
      role: "assistant",
      text: "Sono pronto. Scrivimi pure: rispondo in locale.",
      timestamp: currentTimestampSeconds(),
      metadata: "Modello locale",
    },
  ];
}

function updateThreadPreview(
  thread: ChatThread,
  messages: ChatMessage[],
): ChatThread {
  const lastMessage = messages.at(-1);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const userTitle = firstUserMessage?.text.trim().slice(0, 44);
  return {
    ...thread,
    title:
      thread.title === "Nuovo compito" && userTitle ? userTitle : thread.title,
    messageCount: messages.length,
    subtitle: lastMessage?.text.slice(0, 72) || "Chat locale pronta",
    updatedAt: currentTimestampSeconds(),
  };
}

function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

function mapRuntimeStatus(status: string): RuntimeHealth["status"] {
  if (status === "healthy" || status === "ready") return "ready";
  if (
    status === "running" ||
    status === "managed_running" ||
    status === "external_running"
  ) {
    return "running";
  }
  return "attention";
}

function mapRuntimeProcess(process: RuntimeProcessItem): RuntimeHealth {
  return {
    label: process.id === "llm-gemma4-mlx" ? "Gemma 4 MLX" : process.id,
    status: mapRuntimeStatus(process.status),
    detail: process.message ?? `${process.command_label} · ${process.status}`,
  };
}

function mapRuntimeControl(control: RuntimeControlItem): RuntimeControl {
  return {
    processId: control.process_id,
    label:
      control.process_id === "llm-gemma4-mlx"
        ? "Gemma 4 MLX"
        : control.process_id,
    status: control.status,
    port: control.port ?? undefined,
    portOwnerPid: control.port_owner_pid ?? undefined,
    duplicateCount: control.duplicate_count,
    totalMemoryMb: control.total_memory_mb ?? undefined,
    availableMemoryMb: control.available_memory_mb ?? undefined,
    memoryMb: control.process_memory_mb ?? undefined,
    cpuPercent: control.process_cpu_percent ?? undefined,
    message: control.message,
  };
}

function mapRuntimeLogs(snapshot: RuntimeLogsSnapshot): RuntimeLogs {
  return {
    processId: snapshot.process_id,
    source: snapshot.source,
    message: snapshot.message,
    entries: snapshot.entries.map((entry) => ({
      stream: entry.stream,
      line: entry.line_redacted,
    })),
  };
}

function upsertGemmaRuntimeHealth(
  items: RuntimeHealth[],
  status: RuntimeHealth["status"],
  detail: string,
) {
  const nextItem: RuntimeHealth = {
    label: "Gemma 4 MLX",
    status,
    detail,
  };
  const hasGemma = items.some((item) => item.label === nextItem.label);
  if (!hasGemma) return [nextItem, ...items];
  return items.map((item) => (item.label === nextItem.label ? nextItem : item));
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
    blockedReason: humanizeTaskBlockedReason(task.blocked_reason),
  };
}

function mapCoreApproval(approval: CoreApprovalItem): ApprovalItem {
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
      ? "Azione browser in attesa"
      : isPromptPlanAction
        ? "Conferma piano operativo"
        : approval.action,
    reason: isBrowserAction
      ? humanizeBrowserApprovalReason(approval.explanation)
      : isPromptPlanAction
        ? "Il piano contiene uno step che richiede conferma prima di procedere. Non autorizza acquisti, login, invii o pagamenti automatici."
        : approval.explanation,
    action: approval.action,
    boundary: approval.data_boundary,
    risk: approval.risk_level === "high" ? "high" : "medium",
    requestedBy: `${approval.task_id} ${requestedSession}`.trim(),
    scopeOptions: filterApprovalScopes(approval.scope_options),
    browserVisibilityOptions: filterBrowserVisibilityOptions(
      approval.browser_visibility_options,
    ),
    defaultBrowserVisibility: filterBrowserVisibility(approval.default_browser_visibility),
  };
}

function filterApprovalScopes(values?: string[]): Array<"once" | "always"> {
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

function humanizeBrowserApprovalReason(reason: string): string {
  const match = reason.match(/before execution: ([a-z_]+)/i);
  const action = match?.[1] ?? "azione";
  if (action === "click") {
    return "Il browser vuole fare click su un elemento della pagina. Conferma solo se vuoi proseguire.";
  }
  if (action === "close") {
    return "Il browser vuole chiudere una pagina o una finestra. Conferma solo se non serve piu'.";
  }
  if (action === "type") {
    return "Il browser vuole inviare testo come submit. Conferma solo se il contenuto e' corretto.";
  }
  return "Il browser richiede una conferma prima di procedere.";
}

function humanizeTaskBlockedReason(reason: string | null): string | undefined {
  if (!reason) return undefined;
  if (reason === "recovered after desktop restart") {
    return "Recuperato dopo riavvio: risorse locali rilasciate, task rimesso in coda.";
  }
  if (reason.startsWith("resource ")) {
    return "In attesa di risorse locali disponibili.";
  }
  if (reason.startsWith("approval required:")) {
    return "In attesa di conferma utente.";
  }
  return reason;
}

function summarizeSafeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Nessun dato redatto disponibile";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.toLowerCase().includes("redacted")
      ? "Payload redatto"
      : "Dato redatto disponibile";
  }
  if (Array.isArray(value)) {
    return `Lista redatta (${value.length})`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const recovery = record.desktop_recovery as Record<string, unknown> | undefined;
    if (recovery?.state === "requeued_after_restart") {
      return "Recuperato dopo riavvio · risorse rilasciate";
    }
    const approval = record.approval as Record<string, unknown> | undefined;
    if (approval?.decision) {
      return `Approval ${String(approval.decision)} · ${String(
        approval.action ?? "azione redatta",
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
      ? `JSON redatto · ${visibleKeys.join(", ")}`
      : "JSON redatto disponibile";
  }
  return "Dato redatto disponibile";
}

function mapCoreTaskDetail(detail: CoreTaskDetail): TaskDetailItem {
  return {
    taskId: detail.task_id,
    kind: detail.kind,
    goal: detail.goal,
    status: mapCoreTaskStatus(detail.status),
    priority: mapCoreTaskPriority(detail.priority),
    blockedReason: humanizeTaskBlockedReason(detail.blocked_reason),
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
  if (providerId === "browser") return "Il mio browser";
  return providerId;
}

function connectionDescription(providerId: string): string {
  if (providerId === "browser") {
    return "Azioni locali con Playwright/CDP, snapshot redatti e conferme.";
  }
  return "Connettore locale registrato nel capability registry.";
}

function fallbackTaskDetail(task: TaskItem): TaskDetailItem {
  return {
    taskId: task.id,
    kind: task.kind,
    goal: task.title,
    status: task.status,
    priority: task.priority,
    blockedReason: task.blockedReason,
    checkpointSummary: "Read model locale non ancora collegato al gateway",
    metadataSummary: "Apri l'app desktop per il dettaglio core reale",
    exposesRawInput: false,
  };
}

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [previousView, setPreviousView] = useState<ViewId>("chat");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("privacy");
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
  const [approvalItems, setApprovalItems] = useState<ApprovalItem[]>(approvals);
  const [runtimeItems, setRuntimeItems] =
    useState<RuntimeHealth[]>(runtimeHealth);
  const [runtimeWarmupStarted, setRuntimeWarmupStarted] = useState(false);
  const [runtimeControls, setRuntimeControls] = useState<RuntimeControl[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogs | null>(null);
  const [memoryDashboard, setMemoryDashboard] =
    useState<MemorySummary>(memorySummary);
  const [connectionItems, setConnectionItems] =
    useState<ConnectionItem[]>(connections);
  const [resourceUsage, setResourceUsage] = useState<TaskResourceUsage[]>([]);
  const [selectedTaskDetail, setSelectedTaskDetail] =
    useState<TaskDetailItem | null>(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("task_prompt_session");
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth > 860);
  const activeThread = useMemo(
    () =>
      chatThreads.find((thread) => thread.threadId === activeThreadId) ??
      chatThreads[0] ??
      defaultChatThread,
    [activeThreadId, chatThreads],
  );
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
      setThreadMessages((current) => ({
        ...current,
        [threadId]: messages.messages.map(mapCoreChatMessage),
      }));
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

  async function handleCreateChatThread() {
    try {
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
        subtitle: "Electron con gateway locale in estrazione",
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

  function handleMessagesChange(threadId: string, messages: ChatMessage[]) {
    setThreadMessages((current) => ({
      ...current,
      [threadId]: messages,
    }));
    setChatThreads((current) =>
      current.map((thread) =>
        thread.threadId === threadId
          ? updateThreadPreview(thread, messages)
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
    setApprovalItems(
      snapshot.waiting_approvals.length
        ? snapshot.waiting_approvals.map(mapCoreApproval)
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

  async function loadRuntimeHealth() {
    try {
      const snapshot = await coreBridge.runtimeHealth();
      setRuntimeItems(
        snapshot.processes.length
          ? snapshot.processes.map(mapRuntimeProcess)
          : runtimeHealth,
      );
      setRuntimeControls(snapshot.controls.map(mapRuntimeControl));
    } catch (error) {
      console.warn("runtime_health_snapshot unavailable", error);
    }
    try {
      setRuntimeLogs(mapRuntimeLogs(await coreBridge.runtimeLogs()));
    } catch (error) {
      console.warn("runtime_logs_snapshot unavailable", error);
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

  async function warmupLocalRuntime() {
    setRuntimeWarmupStarted(true);
    setRuntimeItems((current) =>
      upsertGemmaRuntimeHealth(
        current,
        "running",
        "Caricamento modello locale in corso",
      ),
    );
    try {
      const result = await coreBridge.warmupRuntime("llm-gemma4-mlx");
      const elapsed = result.elapsed_seconds.toFixed(1);
      const loadedIn =
        result.load_seconds === null
          ? `${elapsed}s`
          : `${result.load_seconds.toFixed(1)}s`;
      setRuntimeItems((current) =>
        upsertGemmaRuntimeHealth(
          current,
          "ready",
          `Modello locale pronto, caricato in ${loadedIn}`,
        ),
      );
      await loadRuntimeHealth();
    } catch (error) {
      setRuntimeItems((current) =>
        upsertGemmaRuntimeHealth(
          current,
          "attention",
          "Gemma non pronto: controlla il runtime locale",
        ),
      );
      console.warn("runtime_warmup unavailable", error);
    }
  }

  async function handleRuntimeAction(
    processId: string,
    action: "start" | "stop" | "restart",
  ) {
    try {
      if (action === "start") await coreBridge.startProcess(processId);
      if (action === "stop") await coreBridge.stopProcess(processId);
      if (action === "restart") await coreBridge.restartProcess(processId);
      await loadRuntimeHealth();
    } catch (error) {
      console.warn(`process_${action} unavailable`, error);
    }
  }

  async function refreshRuntimeReadModels(taskId = selectedTaskId) {
    await loadRuntimeHealth();
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
    const selectedThread =
      mappedThreads.find((thread) => thread.threadId === preferredThreadId) ??
      mappedThreads.find((thread) => thread.threadId === snapshot.active_thread_id) ??
      mappedThreads[0] ??
      defaultChatThread;
    const messages = await coreBridge.chatMessages(selectedThread.threadId);
    setChatThreads(mappedThreads.length ? mappedThreads : [defaultChatThread]);
    setActiveThreadId(selectedThread.threadId);
    setSelectedTaskId(selectedThread.taskId);
    setThreadMessages((current) => ({
      ...current,
      [selectedThread.threadId]: messages.messages.map(mapCoreChatMessage),
    }));
  }

  async function refreshSelectedTaskDetail(taskId: string) {
    const detail = await coreBridge.taskDetail(taskId);
    setSelectedTaskDetail(detail ? mapCoreTaskDetail(detail) : null);
  }

  async function handleApproveApproval(
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) {
    setApprovalBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(await coreBridge.approveApproval(approvalId, options));
      await refreshSelectedTaskDetail(selectedTaskId);
      await refreshRuntimeReadModels(activeThread.taskId);
      await refreshChatReadModels(activeThread.threadId);
    } catch (error) {
      console.warn("approval_approve unavailable", error);
    } finally {
      setApprovalBusyId(null);
    }
  }

  async function handleRejectApproval(approvalId: string) {
    setApprovalBusyId(approvalId);
    try {
      applyTaskQueueSnapshot(
        await coreBridge.rejectApproval(
          approvalId,
          "Rifiutato dall'utente dalla UI desktop.",
        ),
      );
      await refreshSelectedTaskDetail(selectedTaskId);
    } catch (error) {
      console.warn("approval_reject unavailable", error);
    } finally {
      setApprovalBusyId(null);
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
    void loadRuntimeHealth();
    void loadMemoryAndCapabilities();
    if (!runtimeWarmupStarted) {
      void warmupLocalRuntime();
    }
    void loadTaskQueue();
    const interval = window.setInterval(() => {
      void loadRuntimeHealth();
      void loadTaskQueue();
    }, 4_000);
    return () => window.clearInterval(interval);
  }, []);

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
        setThreadMessages((current) => {
          const next = { ...current };
          next[selectedThread.threadId] = selectedMessages;
          return next;
        });
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
    <Shell
      activeView={activeView}
      activeThreadId={activeThread.threadId}
      chatThreads={chatThreads}
      drawerOpen={drawerOpen}
      onCreateChatThread={handleCreateChatThread}
      onArchiveChatThread={handleArchiveChatThread}
      onBackFromSettings={() => setActiveView(previousView)}
      onDeleteChatThread={handleDeleteChatThread}
      onNavigate={handleNavigate}
      onSelectThread={handleSelectThread}
      onSetChatThreadPinned={handleSetChatThreadPinned}
      onToggleDrawer={() => setDrawerOpen((value) => !value)}
      onUnarchiveChatThread={handleUnarchiveChatThread}
      onSelectSettingsSection={setSettingsSection}
      settingsSection={settingsSection}
    >
      <main
        className={`workspace ${isSettings ? "settings-workspace" : ""}`}
        aria-label="Area di lavoro principale"
      >
        {activeView === "chat" && (
          <ChatView
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
            onOpenTasks={() => setActiveView("tasks")}
            onApproveApproval={handleApproveApproval}
            onRejectApproval={handleRejectApproval}
            onRuntimeChanged={() => refreshRuntimeReadModels(activeThread.taskId)}
            onThreadChanged={() => refreshChatReadModels(activeThread.threadId)}
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
            onApproveApproval={handleApproveApproval}
            onRejectApproval={handleRejectApproval}
            onSelectTask={setSelectedTaskId}
          />
        )}
        {activeView === "learning" && (
          <LearningView
            insights={learningInsights}
            proposals={automationProposals}
          />
        )}
        {activeView === "settings" && (
          <SettingsView
            health={runtimeItems}
            runtimeControls={runtimeControls}
            runtimeLogs={runtimeLogs}
            connections={connectionItems}
            section={settingsSection}
            onRuntimeAction={handleRuntimeAction}
          />
        )}
        {activeView === "memory" && (
          <ShallowView
            title="Memoria"
            eyebrow="UI-safe read model"
            description="Stato sintetico della memoria locale, pronto per essere collegato al MemoryUiReadModel."
            stats={[
              { label: "Confermate", value: String(memoryDashboard.confirmed) },
              { label: "Candidate", value: String(memoryDashboard.candidates) },
              { label: "Domini", value: String(memoryDashboard.domains.length) },
            ]}
          />
        )}
        {activeView === "connections" && (
          <ConnectionsView connections={connectionItems} />
        )}
        {activeView === "automations" && (
          <ShallowView
            title="Automazioni"
            eyebrow="Proposte e pianificate"
            description="Le routine diventano task durevoli con approvazioni e policy, non job nascosti."
            stats={[
              { label: "Attive", value: "3" },
              { label: "In revisione", value: "1" },
              { label: "Sospese", value: "0" },
            ]}
          />
        )}
        {activeView === "browser" && <ContainedComputerView />}
        {activeView === "brain" && (
          <ShallowView
            title="Brain Audit"
            eyebrow="Piani spiegabili"
            description={`Route, tool caricati, memory refs e step subagent sono persistiti senza raw payload. ${contextBudgetSummary(brainRun.contextBudget)}`}
            stats={[
              { label: "Route", value: brainRun.route },
              { label: "Round", value: String(brainRun.plannerRounds) },
              { label: "Tool", value: String(brainRun.loadedTools) },
              {
                label: "Contesto",
                value: `${Math.round(contextBudgetCompressionRatio(brainRun.contextBudget) * 100)}%`,
              },
            ]}
          />
        )}
      </main>
    </Shell>
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
  if (budget.length === 0) return "Nessuna compressione applicata.";
  return `${compressed}/${budget.length} contesti compressi, ${inputTokens} -> ${outputTokens} token stimati, ${redacted} redazioni.`;
}
