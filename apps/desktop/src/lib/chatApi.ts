import type {
  ChatAttachmentInput,
  CoreChatMessageMetrics,
  CoreChatMessage,
  CoreChatMessagesSnapshot,
  CoreChatStreamDelta,
  CoreChatStreamEvent,
  CoreChatThread,
  CoreChatThreadSnapshot,
  CorePromptSubmissionResult,
} from "./coreBridge";
import { buildJuicePromptChatContext } from "./contextBudget";
import { DESKTOP_GATEWAY_URL, gatewayHeaders } from "./gatewayConfig";
import { createStreamSequenceGate } from "./streamSequenceGate";

// One alternative at a branch point: the sibling node and the leaf to activate to
// display its branch, plus an optional name (Phase 4).
export interface CoreBranchOption {
  child_id: string;
  leaf_id: string;
  label: string | null;
}
// A node on the active path that has alternative siblings (drives ‹ n/m ›).
export interface CoreBranchPoint {
  node_id: string;
  active_index: number;
  options: CoreBranchOption[];
}

const streamEventListeners = new Set<(payload: CoreChatStreamEvent) => void>();
const streamListeners = new Set<(payload: CoreChatStreamDelta) => void>();
const publishedStreamSequences = createStreamSequenceGate();
let activeThreadId = "thread_active_prompt";
let localThreads: CoreChatThread[] = [
  {
    thread_id: activeThreadId,
    title: "New task",
    subtitle: "Local chat",
    status: "active",
    pinned: false,
    computer_session_id: "computer_active_prompt",
    task_id: "task_prompt_session",
    updated_at: currentTimestampSeconds(),
    message_count: 1,
  },
];
const localMessages = new Map<string, CoreChatMessage[]>([
  [
    activeThreadId,
    [
      {
        id: "electron_ready",
        role: "assistant",
        text: "I'm ready. Just write to me — I reply locally.",
        timestamp: currentTimestampSeconds(),
        metadata: "Local model",
        metrics: null,
        feedback: null,
        saved_memory_ref: null,
        linked_task_id: null,
        linked_automation_ref: null,
        attachments: [],
      },
    ],
  ],
]);

export const chatApi = {
  // `workspace` targets a SPECIFIC project/base instead of the active one. A
  // specific fetch must NOT hydrate the module cache (that mirrors the ACTIVE
  // workspace) — e.g. loading Personal's threads while a project is active.
  async chatThreads(workspace?: string) {
    const url = workspace
      ? `/api/chat/threads?workspace=${encodeURIComponent(workspace)}`
      : "/api/chat/threads";
    try {
      const snapshot = await gatewayJson<CoreChatThreadSnapshot>(url);
      return workspace ? snapshot : hydrateThreadSnapshot(snapshot);
    } catch {
      return chatThreadSnapshot();
    }
  },

  async createChatThread(workspace?: string) {
    const url = workspace
      ? `/api/chat/threads?workspace=${encodeURIComponent(workspace)}`
      : "/api/chat/threads";
    try {
      const thread = await gatewayJson<CoreChatThread>(url, { method: "POST" });
      // Cache only when created in the active context; a project/base-targeted
      // create is placed into state by the caller (App.tsx).
      if (!workspace) {
        activeThreadId = thread.thread_id;
        localThreads = [
          thread,
          ...localThreads.filter((item) => item.thread_id !== thread.thread_id),
        ];
        try {
          hydrateMessagesSnapshot(
            await gatewayJson<CoreChatMessagesSnapshot>(
              `/api/chat/threads/${encodeURIComponent(thread.thread_id)}/messages`,
            ),
          );
        } catch {
          // Thread creation succeeded; messages load on the next view refresh.
        }
      }
      return thread;
    } catch {
      return createLocalChatThread();
    }
  },

  async chatMessages(threadId: string) {
    try {
      return hydrateMessagesSnapshot(
        await gatewayJson<CoreChatMessagesSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/messages`,
        ),
      );
    } catch {
      return chatMessagesSnapshot(threadId);
    }
  },

  /** Append a literal assistant message (e.g. a proactivity card's question) so a
   *  chat opens with Homun already asking, instead of a composer draft. */
  async seedAssistantMessage(threadId: string, text: string, eventParts?: unknown[]) {
    return hydrateMessagesSnapshot(
      await gatewayJson<CoreChatMessagesSnapshot>(
        `/api/chat/threads/${encodeURIComponent(threadId)}/assistant_message`,
        { method: "POST", body: JSON.stringify({ text, event_parts: eventParts ?? [] }) },
      ),
    );
  },

  /** Answer a PROACTIVITY question (onboarding, follow-up, …): captures the pick as memory
   *  and posts a canned acknowledgment WITHOUT running the agent loop. */
  async captureProactiveAnswer(
    threadId: string,
    body: { answer: string; question: string; ack: string },
  ) {
    return hydrateMessagesSnapshot(
      await gatewayJson<CoreChatMessagesSnapshot>(
        `/api/chat/threads/${encodeURIComponent(threadId)}/proactive_answer`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    );
  },

  recentChatContext(threadId: string, limit = 8) {
    return recentChatContext(threadId, limit);
  },

  rawRecentChatContext(threadId: string, limit = 12) {
    return rawRecentChatContext(threadId, limit);
  },

  async selectChatThread(threadId: string) {
    try {
      return hydrateThreadSnapshot(
        await gatewayJson<CoreChatThreadSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/select`,
          { method: "POST" },
        ),
      );
    } catch {
      activeThreadId = threadId;
      return chatThreadSnapshot();
    }
  },

  async setChatThreadPinned(threadId: string, pinned: boolean) {
    try {
      return hydrateThreadSnapshot(
        await gatewayJson<CoreChatThreadSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/pin`,
          {
            method: "POST",
            body: JSON.stringify({ pinned }),
          },
        ),
      );
    } catch {
      localThreads = localThreads.map((thread) =>
        thread.thread_id === threadId ? { ...thread, pinned } : thread,
      );
      return chatThreadSnapshot();
    }
  },

  async renameChatThread(threadId: string, title: string) {
    try {
      return hydrateThreadSnapshot(
        await gatewayJson<CoreChatThreadSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/rename`,
          {
            method: "POST",
            body: JSON.stringify({ title }),
          },
        ),
      );
    } catch {
      localThreads = localThreads.map((thread) =>
        thread.thread_id === threadId ? { ...thread, title } : thread,
      );
      return chatThreadSnapshot();
    }
  },

  async archiveChatThread(threadId: string) {
    try {
      return hydrateThreadSnapshot(
        await gatewayJson<CoreChatThreadSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/archive`,
          { method: "POST" },
        ),
      );
    } catch {
      localThreads = localThreads.map((thread) =>
        thread.thread_id === threadId ? { ...thread, status: "archived" } : thread,
      );
      return chatThreadSnapshot();
    }
  },

  async unarchiveChatThread(threadId: string) {
    try {
      return hydrateThreadSnapshot(
        await gatewayJson<CoreChatThreadSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/unarchive`,
          { method: "POST" },
        ),
      );
    } catch {
      localThreads = localThreads.map((thread) =>
        thread.thread_id === threadId ? { ...thread, status: "active" } : thread,
      );
      return chatThreadSnapshot();
    }
  },

  async deleteChatThread(threadId: string) {
    try {
      const snapshot = hydrateThreadSnapshot(
        await gatewayJson<CoreChatThreadSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}`,
          { method: "DELETE" },
        ),
      );
      localMessages.delete(threadId);
      return snapshot;
    } catch {
      localThreads = localThreads.filter((thread) => thread.thread_id !== threadId);
      localMessages.delete(threadId);
      if (activeThreadId === threadId) {
        activeThreadId = localThreads[0]?.thread_id ?? "";
      }
      return chatThreadSnapshot();
    }
  },

  setChatMessageFeedback(
    threadId: string,
    messageId: string,
    feedback: "useful" | "not_useful" | null,
  ) {
    updateMessage(threadId, messageId, (message) => ({ ...message, feedback }));
    return Promise.resolve(chatMessagesSnapshot(threadId));
  },

  async saveChatMessageToMemory(threadId: string, messageId: string) {
    try {
      return hydrateMessagesSnapshot(
        await gatewayJson<CoreChatMessagesSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/save_to_memory`,
          { method: "POST" },
        ),
      );
    } catch {
      updateMessage(threadId, messageId, (message) => ({
        ...message,
        saved_memory_ref: message.saved_memory_ref ?? `memory:${messageId}`,
      }));
      return Promise.resolve(chatMessagesSnapshot(threadId));
    }
  },

  async createTaskFromChatMessage(threadId: string, messageId: string) {
    try {
      return hydrateMessagesSnapshot(
        await gatewayJson<CoreChatMessagesSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/create_task`,
          { method: "POST" },
        ),
      );
    } catch {
    updateMessage(threadId, messageId, (message) => ({
      ...message,
      linked_task_id: message.linked_task_id ?? `task:${messageId}`,
    }));
    return Promise.resolve(chatMessagesSnapshot(threadId));
    }
  },

  createAutomationFromChatMessage(threadId: string, messageId: string) {
    updateMessage(threadId, messageId, (message) => ({
      ...message,
      linked_automation_ref:
        message.linked_automation_ref ?? `automation:${messageId}`,
    }));
    return Promise.resolve(chatMessagesSnapshot(threadId));
  },


  // Branch switcher data: every node on the active path that has alternatives.
  async chatBranches(threadId: string): Promise<CoreBranchPoint[]> {
    try {
      return await gatewayJson<CoreBranchPoint[]>(
        `/api/chat/threads/${encodeURIComponent(threadId)}/branches`,
      );
    } catch {
      return [];
    }
  },

  // Select a branch: point the displayed conversation at a leaf, get the new path.
  async setActiveLeaf(threadId: string, leafId: string | null) {
    return hydrateMessagesSnapshot(
      await gatewayJson<CoreChatMessagesSnapshot>(
        `/api/chat/threads/${encodeURIComponent(threadId)}/active_leaf`,
        { method: "POST", body: JSON.stringify({ leaf_id: leafId }) },
      ),
    );
  },

  // Name (or clear) a branch — Phase 4.
  async setBranchLabel(
    threadId: string,
    messageId: string,
    label: string | null,
  ): Promise<CoreBranchPoint[]> {
    return gatewayJson<CoreBranchPoint[]>(
      `/api/chat/threads/${encodeURIComponent(threadId)}/branch_label`,
      { method: "POST", body: JSON.stringify({ message_id: messageId, label }) },
    );
  },

  async submitOperationalPrompt(
    threadId: string,
    message: {
      id: string;
      role: "user";
      text: string;
      timestamp: string;
      metadata?: string | null;
      attachments?: ChatAttachmentInput[];
    },
  ) {
    const userMessage: CoreChatMessage = {
      id: message.id,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
      metadata: message.metadata ?? null,
      metrics: null,
      feedback: null,
      saved_memory_ref: null,
      linked_task_id: null,
      linked_automation_ref: null,
      attachments: [],
    };
    const response = await fetch(
      `${DESKTOP_GATEWAY_URL}/api/chat/threads/${encodeURIComponent(threadId)}/messages/submit_operational_prompt`,
      {
        method: "POST",
        headers: gatewayHeaders(),
        body: JSON.stringify({
          user_message: userMessage,
        }),
      },
    );
    if (response.status === 409) {
      try {
        const body = await response.clone().json();
        if (body?.error?.code === "not_operational_prompt") {
          return null;
        }
      } catch {
        return null;
      }
    }
    if (!response.ok) {
      throw new Error(await gatewayErrorMessage(response));
    }
    return hydrateMessagesSnapshot(
      (await response.json()) as CoreChatMessagesSnapshot,
    );
  },


  listenChatStreamDelta(handler: (payload: CoreChatStreamDelta) => void) {
    streamListeners.add(handler);
    return Promise.resolve(() => {
      streamListeners.delete(handler);
    });
  },

  listenChatStreamEvent(handler: (payload: CoreChatStreamEvent) => void) {
    streamEventListeners.add(handler);
    return Promise.resolve(() => {
      streamEventListeners.delete(handler);
    });
  },

  debugChatStream(
    requestId: string,
    payload: {
      stage: string;
      chunks?: number;
      chars?: number;
      elapsed_ms?: number;
      detail?: string;
    },
  ) {
    void requestId;
    void payload;
    return Promise.resolve();
  },

  notifyChatStreamDelta,
  notifyChatStreamEvent,
};

function createLocalChatThread() {
  const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const thread: CoreChatThread = {
    thread_id: threadId,
    title: "New task",
    subtitle: "Local chat",
    status: "active",
    pinned: false,
    computer_session_id: `computer_${threadId}`,
    task_id: `task_${threadId}`,
    updated_at: currentTimestampSeconds(),
    message_count: 1,
  };
  activeThreadId = threadId;
  localThreads = [thread, ...localThreads];
  localMessages.set(threadId, [
    {
      id: `${threadId}_ready`,
      role: "assistant",
      text: "I'm ready. Just write to me — I reply locally.",
      timestamp: currentTimestampSeconds(),
      metadata: "Local model",
      metrics: null,
      feedback: null,
      saved_memory_ref: null,
      linked_task_id: null,
      linked_automation_ref: null,
      attachments: [],
    },
  ]);
  return thread;
}

async function gatewayJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    ...init,
    headers: gatewayHeaders(init.headers),
  });
  if (!response.ok) {
    throw new Error(await gatewayErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

function hydrateThreadSnapshot(snapshot: CoreChatThreadSnapshot) {
  activeThreadId = snapshot.active_thread_id;
  localThreads = snapshot.threads;
  return snapshot;
}

function hydrateMessagesSnapshot(snapshot: CoreChatMessagesSnapshot) {
  localMessages.set(snapshot.thread_id, snapshot.messages);
  return snapshot;
}

function commitLocalPromptResult(
  threadId: string,
  result: CorePromptSubmissionResult,
) {
  const currentMessages = localMessages.get(threadId) ?? [];
  const nextMessages = [
    ...currentMessages,
    corePromptMessageToChatMessage(result.user_message),
    corePromptMessageToChatMessage(result.assistant_message),
  ];
  localMessages.set(threadId, dedupeMessages(nextMessages));
  updateThreadAfterMessages(
    threadId,
    result.user_message.text,
    nextMessages.length,
  );
  return chatMessagesSnapshot(threadId);
}

function commitLocalContinuetionResult(
  threadId: string,
  messageId: string,
  result: CorePromptSubmissionResult,
) {
  const currentMessages = localMessages.get(threadId) ?? [];
  const replacement = corePromptMessageToChatMessage(result.assistant_message);
  const nextMessages = currentMessages.map((message) =>
    message.id === messageId ? replacement : message,
  );
  localMessages.set(threadId, dedupeMessages(nextMessages));
  updateThreadAfterMessages(threadId, undefined, nextMessages.length);
  return chatMessagesSnapshot(threadId);
}


function notifyChatStreamDelta(payload: CoreChatStreamDelta) {
  notifyChatStreamEvent(payload);
}

function notifyChatStreamEvent(payload: CoreChatStreamEvent) {
  if (!publishedStreamSequences.accept(payload)) return;
  for (const listener of streamEventListeners) {
    listener(payload);
  }
  if (payload.type !== "delta") return;
  for (const listener of streamListeners) {
    listener(payload);
  }
}


async function gatewayErrorMessage(response: Response) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  } catch {
    // Fall through to the HTTP status below.
  }
  return `Local chat gateway unavailable: HTTP ${response.status}`;
}

function toGatewayAttachmentInput(attachment: ChatAttachmentInput) {
  return {
    local_path: attachment.localPath,
    display_name: attachment.displayName,
    mime_type: attachment.mimeType,
    size_bytes: attachment.sizeBytes,
  };
}

function chatThreadSnapshot(): CoreChatThreadSnapshot {
  if (!activeThreadId && localThreads[0]) {
    activeThreadId = localThreads[0].thread_id;
  }
  return {
    active_thread_id: activeThreadId,
    threads: [...localThreads],
  };
}

function chatMessagesSnapshot(threadId: string): CoreChatMessagesSnapshot {
  return {
    thread_id: threadId,
    messages: [...(localMessages.get(threadId) ?? [])],
  };
}

function updateMessage(
  threadId: string,
  messageId: string,
  update: (message: CoreChatMessage) => CoreChatMessage,
) {
  localMessages.set(
    threadId,
    (localMessages.get(threadId) ?? []).map((message) =>
      message.id === messageId ? update(message) : message,
    ),
  );
}

function corePromptMessageToChatMessage(
  message: CorePromptSubmissionResult["assistant_message"],
): CoreChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    metadata: message.metadata,
    metrics: message.metrics,
    feedback: null,
    saved_memory_ref: null,
    linked_task_id: null,
    linked_automation_ref: null,
    attachments: message.attachments ?? [],
  };
}

function dedupeMessages(messages: CoreChatMessage[]) {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function updateThreadAfterMessages(
  threadId: string,
  userPrompt: string | undefined,
  messageCount: number,
) {
  localThreads = localThreads.map((thread) => {
    if (thread.thread_id !== threadId) return thread;
    const title =
      thread.title === "New task" && userPrompt?.trim()
        ? compactTitle(userPrompt)
        : thread.title;
    return {
      ...thread,
      title,
      subtitle: "Local model",
      updated_at: localMessages.get(threadId)?.at(-1)?.timestamp ?? thread.updated_at,
      message_count: messageCount,
    };
  });
}

function recentChatContext(threadId: string, limit: number) {
  // Preview/local fallback only. The gateway ignores client history for a
  // persisted thread and reconstructs the model context from the ChatStore.
  return buildJuicePromptChatContext(rawRecentChatContext(threadId, limit), {
    maxContextChars: 3_600,
    maxMessageChars: 900,
    preserveRecentMessages: limit,
  });
}

function rawRecentChatContext(threadId: string, limit: number) {
  return (localMessages.get(threadId) ?? [])
    .filter(isConversationMessage)
    .filter((message) => message.id !== "electron_ready" && message.text.trim())
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      text: message.text,
    }));
}

function isConversationMessage(
  message: CoreChatMessage,
): message is CoreChatMessage & { role: "user" | "assistant" } {
  return message.role === "user" || message.role === "assistant";
}

function compactTitle(text: string) {
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

function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

// ── Broker turn API (POST /api/chat/turns, GET /turns/{id}/stream, DELETE /turns/{id}) ──
// These helpers talk to the persistent turn broker (the only chat path). The broker is
// the server-owned source of truth: it persists the user message atomically with
// the enqueue, runs the turn, persists the assistant message on done, and emits
// durable turn_events (delivered live over the unified WebSocket /api/ws).

/** S2 (plugin-owned deterministic routing): a routing binding attached to the FIRST
 *  auto-submitted turn of a plugin workflow (e.g. "Use template"). Mirrors the Rust
 *  `RoutingBinding` (crates/desktop-gateway/src/lib.rs) — the gateway persists it
 *  thread-scoped on that first turn, so intake follow-ups don't need to re-send it. */
export interface RoutingBindingInput {
  plugin_id: string;
  route_id: string;
  args: Record<string, unknown>;
}

/** Response body for POST /api/chat/turns. */
export interface QueuedTurnResponse {
  turn_id: string;
  thread_id: string;
  request_id: string;
  status: "queued";
  position_in_queue: number;
}

export interface SteeringQueuedResponse {
  thread_id: string;
  active_turn_id: string;
  request_id: string;
  source_message_id: string;
  objective_revision: number;
  status: "steering_queued";
}

export type EnqueueTurnResponse = QueuedTurnResponse | SteeringQueuedResponse;

export type TurnSteeringStatus =
  | "pending"
  | "claimed"
  | "interpreted"
  | "applied"
  | "completed"
  | "held"
  | "cancelled"
  | "promoted";

export interface TurnSteeringRecord {
  steering_id: number;
  user_id: string;
  workspace_id: string;
  thread_id: string;
  active_turn_id: string;
  source_message_id: string;
  prompt: string;
  visible_prompt: string;
  images: string[];
  attachments: unknown;
  mode: string | null;
  model: string | null;
  objective_revision: number;
  status: TurnSteeringStatus;
  revision: number;
  created_at: number;
  updated_at: number;
  claimed_run_id: string | null;
  claimed_round: number | null;
  claimed_at: number | null;
  applied_at: number | null;
  cancelled_at: number | null;
  consumed_at: number | null;
  semantic_decision_json: unknown | null;
  interpreted_at: number | null;
  completed_at: number | null;
  last_interpretation_error: string | null;
  next_retry_at: number | null;
  interpretation_attempts: number;
}

export interface SteeringMutation {
  expected_revision: number;
  prompt: string;
  visible_prompt: string;
  images: string[];
  attachments: unknown;
  mode: string | null;
  model: string | null;
}

export class SteeringConflictError extends Error {
  constructor(public readonly steering: TurnSteeringRecord) {
    super(`steering instruction ${steering.steering_id} changed at revision ${steering.revision}`);
    this.name = "SteeringConflictError";
  }
}

async function steeringJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, {
    ...init,
    headers: gatewayHeaders(init.headers),
  });
  if (response.status === 409) {
    try {
      const conflict = (await response.clone().json()) as {
        code?: string;
        steering?: TurnSteeringRecord;
      };
      if (conflict.code === "steering_revision_conflict" && conflict.steering) {
        throw new SteeringConflictError(conflict.steering);
      }
    } catch (error) {
      if (error instanceof SteeringConflictError) throw error;
      // Malformed and non-JSON conflicts fall through to the normal gateway
      // error parser, which still owns the unconsumed original response body.
    }
  }
  if (!response.ok) {
    throw new Error(await gatewayErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

export function fetchThreadSteering(threadId: string): Promise<TurnSteeringRecord[]> {
  return steeringJson<TurnSteeringRecord[]>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/steering`,
  );
}

export function updateSteering(
  steeringId: number,
  mutation: SteeringMutation,
): Promise<TurnSteeringRecord> {
  return steeringJson<TurnSteeringRecord>(
    `/api/chat/steering/${encodeURIComponent(steeringId)}`,
    { method: "PATCH", body: JSON.stringify(mutation) },
  );
}

export function deleteSteering(
  steeringId: number,
  expectedRevision: number,
): Promise<TurnSteeringRecord> {
  return steeringJson<TurnSteeringRecord>(
    `/api/chat/steering/${encodeURIComponent(steeringId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  );
}

export function sendSteeringNow(
  steeringId: number,
  expectedRevision: number,
): Promise<QueuedTurnResponse> {
  return steeringJson<QueuedTurnResponse>(
    `/api/chat/steering/${encodeURIComponent(steeringId)}/send-now`,
    {
      method: "POST",
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  );
}

export interface AgentRunView {
  run_id: string;
  turn_id: string;
  thread_id: string;
  attempt: number;
  status: "running" | "completed" | "failed" | "aborted";
  model: string | null;
  provider: string | null;
  prompt_fingerprint: string | null;
  started_at: number;
  completed_at: number | null;
  terminal_reason: string | null;
}

export interface AgentRunEventView {
  event_id: number;
  run_id: string;
  seq: number;
  round: number | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface PromptPacketView {
  id: string;
  source: string;
  priority: number;
  chars: number;
  sha256: string;
}

export interface AgentPromptView {
  fingerprint?: string;
  model?: string;
  provider?: string;
  packets?: PromptPacketView[];
  messages?: Array<{ role: string; chars: number; sha256: string; redacted: boolean }>;
  tools?: Array<{ name: string | null; chars: number; sha256: string }>;
}

async function executionJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DESKTOP_GATEWAY_URL}${path}`, { headers: gatewayHeaders() });
  if (!response.ok) throw new Error(`Execution Inspector request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export const fetchThreadAgentRuns = (threadId: string) =>
  executionJson<AgentRunView[]>(`/api/chat/threads/${encodeURIComponent(threadId)}/runs`);
export const fetchAgentRunEvents = (runId: string) =>
  executionJson<AgentRunEventView[]>(`/api/chat/runs/${encodeURIComponent(runId)}/events`);
export const fetchLatestAgentPrompt = (runId: string) =>
  executionJson<AgentPromptView>(`/api/chat/runs/${encodeURIComponent(runId)}/prompt/latest`);
export const fetchLatestAgentCheckpoint = (runId: string) =>
  executionJson<Record<string, unknown>>(`/api/chat/runs/${encodeURIComponent(runId)}/checkpoint/latest`);
export const fetchThreadWorkingLedger = (threadId: string) =>
  executionJson<{ thread_id: string; markdown: string }>(`/api/chat/threads/${encodeURIComponent(threadId)}/ledger`);

/** Thrown by enqueueTurn when the thread already has an active turn (HTTP 409). */
export class TurnBusyError extends Error {
  constructor(public readonly activeTurnId: string) {
    super(`thread is busy with another turn: ${activeTurnId}`);
    this.name = "TurnBusyError";
  }
}

/**
 * Enqueue a chat turn via the broker. The client passes its own `requestId`
 * so the resulting turn_id is prevedibile (`turn_{requestId}`). Throws
 * TurnBusyError on 409 (thread already active), or Error on other failures.
 */
export async function enqueueTurn(
  threadId: string,
  requestId: string,
  prompt: string,
  options?: {
    visiblePrompt?: string;
    images?: string[];
    attachments?: ChatAttachmentInput[];
    mode?: string;
    model?: string;
    source?: string;
    routingBinding?: RoutingBindingInput;
  },
): Promise<EnqueueTurnResponse> {
  const res = await fetch(`${DESKTOP_GATEWAY_URL}/api/chat/turns`, {
    method: "POST",
    headers: gatewayHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      thread_id: threadId,
      request_id: requestId,
      prompt,
      visible_prompt: options?.visiblePrompt,
      images: options?.images,
      attachments: options?.attachments?.map(toGatewayAttachmentInput),
      mode: options?.mode,
      model: options?.model,
      source: options?.source ?? "interactive",
      // S2: absent/undefined serializes to a missing key → Rust's
      // `#[serde(default)] Option<RoutingBinding>` reads None (fail-open) for every
      // turn that isn't a plugin-workflow launch.
      routing_binding: options?.routingBinding,
    }),
  });
  if (res.status === 201 || res.status === 202) {
    return (await res.json()) as EnqueueTurnResponse;
  }
  if (res.status === 409) {
    const body = (await res.json()) as { active_turn_id: string };
    throw new TurnBusyError(body.active_turn_id);
  }
  throw new Error(`enqueueTurn: unexpected status ${res.status}: ${await gatewayErrorMessage(res)}`);
}

/**
 * Subscribe to a turn's event stream (NDJSON). Replays buffered events with
 * seq > since, then streams live events. Returns the raw Response; the caller
 * reads the body with getReader() and parses each line as { seq, kind, payload }.
 * Closing the connection does NOT cancel the turn (subscribe is non-possessive).
 */
export async function openTurnStream(turnId: string, since: number = 0): Promise<Response> {
  const url = `${DESKTOP_GATEWAY_URL}/api/chat/turns/${encodeURIComponent(turnId)}/stream?since=${since}`;
  const res = await fetch(url, { headers: gatewayHeaders() });
  if (!res.ok) {
    throw new Error(`openTurnStream: HTTP ${res.status}: ${await gatewayErrorMessage(res)}`);
  }
  return res;
}

export interface TurnStatusResponse {
  turn_id: string;
  thread_id: string | null;
  request_id: string | null;
  status: string;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export async function fetchTurnStatus(turnId: string): Promise<TurnStatusResponse> {
  return gatewayJson<TurnStatusResponse>(
    `/api/chat/turns/${encodeURIComponent(turnId)}`,
  );
}

/** Durable cockpit projection for the working island (mirrors the Rust
 *  `ThreadActivityProjection`): the latest plan across the thread, activity
 *  accumulated cross-turn, and the latest turn's status. Read at rest so the
 *  island survives turn-end/reload/thread-switch instead of parsing lossy
 *  message-text markers. */
export interface SubagentInfo {
  name: string;
  status: string;
  summary?: string;
  created_at?: number;
  updated_at?: number;
}
export interface ThreadActivityProjection {
  plan_markdown: string | null;
  activity: string[];
  latest_turn_status: string | null;
  turn_count: number;
  subagents: SubagentInfo[];
  active_turn?: {
    turn_id: string;
    last_event_seq: number;
    status: string;
    attempt: number;
    max_attempts: number;
    not_before: number | null;
    blocked_reason: string | null;
    updated_at: number;
  } | null;
}

export async function fetchThreadActivity(
  threadId: string,
): Promise<ThreadActivityProjection> {
  return gatewayJson<ThreadActivityProjection>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/activity`,
  );
}

/**
 * Cancel a running turn: DELETE /api/chat/turns/{id}. The broker marks the turn
 * cancelled and notifies the executor. 202 = accepted, 404 = no active turn
 * (already finished) — both are fine for a best-effort Stop, so we don't throw.
 */
export async function cancelTurn(turnId: string): Promise<void> {
  await fetch(`${DESKTOP_GATEWAY_URL}/api/chat/turns/${encodeURIComponent(turnId)}`, {
    method: "DELETE",
    headers: gatewayHeaders(),
  });
}
