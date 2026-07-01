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

type StreamEvent =
  | {
      type: "accepted";
      request_id: string;
      thread_id: string;
    }
  | {
      type: "delta";
      request_id: string;
      text: string;
    }
  | {
      type:
        | "reasoning"
        | "activity"
        | "plan_update"
        | "choice_prompt"
        | "vault_propose"
        | "vault_reveal"
        | "payment_approval"
        | "tool_result";
      request_id: string;
      text?: string;
      markdown?: string;
      payload?: unknown;
    }
  | {
      type: "done";
      request_id: string;
      result: CorePromptSubmissionResult;
      metrics?: Partial<CoreChatMessageMetrics>;
    }
  | {
      type: "error";
      request_id: string;
      code?: string;
      message?: string;
      retryable?: boolean;
    };

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

  async commitChatPromptResult(
    threadId: string,
    result: CorePromptSubmissionResult,
    branchFromId?: string | null,
  ) {
    const snapshot = commitLocalPromptResult(threadId, result);
    try {
      return hydrateMessagesSnapshot(
        await gatewayJson<CoreChatMessagesSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/messages/commit_prompt_result`,
          {
            method: "POST",
            body: JSON.stringify({
              user_message: corePromptMessageToChatMessage(result.user_message),
              assistant_message: corePromptMessageToChatMessage(result.assistant_message),
              // Edit-as-branch: the gateway commits the new turn as a sibling of
              // this message, preserving the old branch in the chat tree.
              branch_from_id: branchFromId ?? null,
            }),
          },
        ),
      );
    } catch {
      return snapshot;
    }
  },

  // Regenerated answer → a SIBLING of the previous one under the prompting user
  // message (persisted branch, navigable with the ‹ n/m › switcher).
  async commitChatRegeneratedResult(
    threadId: string,
    userMessageId: string,
    result: CorePromptSubmissionResult,
  ) {
    const snapshot = commitLocalContinuetionResult(threadId, result.assistant_message.id, result);
    try {
      return hydrateMessagesSnapshot(
        await gatewayJson<CoreChatMessagesSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/messages/commit_regenerated_result`,
          {
            method: "POST",
            body: JSON.stringify({
              user_message_id: userMessageId,
              assistant_message: corePromptMessageToChatMessage(result.assistant_message),
            }),
          },
        ),
      );
    } catch {
      return snapshot;
    }
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

  async commitChatContinuetionResult(
    threadId: string,
    messageId: string,
    result: CorePromptSubmissionResult,
  ) {
    const snapshot = commitLocalContinuetionResult(threadId, messageId, result);
    try {
      return hydrateMessagesSnapshot(
        await gatewayJson<CoreChatMessagesSnapshot>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/commit_continuation_result`,
          {
            method: "POST",
            body: JSON.stringify({
              assistant_message: corePromptMessageToChatMessage(result.assistant_message),
            }),
          },
        ),
      );
    } catch {
      return snapshot;
    }
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

  async submitChatPromptStream(
    requestId: string,
    threadId: string,
    prompt: string,
    attachments: ChatAttachmentInput[] = [],
    visiblePrompt?: string,
  ): Promise<CorePromptSubmissionResult> {
    return consumeChatWebSocketStream(requestId, {
      kind: "submit",
      request_id: requestId,
      thread_id: threadId,
      prompt,
      visible_prompt: visiblePrompt,
      attachments: attachments.map(toGatewayAttachmentInput),
    });
  },

  async continueChatMessageStream(
    requestId: string,
    threadId: string,
    messageId: string,
  ): Promise<CorePromptSubmissionResult> {
    return consumeChatWebSocketStream(requestId, {
      kind: "continue",
      request_id: requestId,
      thread_id: threadId,
      message_id: messageId,
    });
  },

  async cancelChatPromptStream(requestId: string) {
    void requestId;
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

async function consumeChatStreamResponse(
  response: Response,
  requestId: string,
): Promise<CorePromptSubmissionResult> {
    if (!response.ok) {
      throw new Error(await gatewayErrorMessage(response));
    }
    if (!response.body) {
      throw new Error("The local chat gateway did not open the stream.");
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> =
      response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: CorePromptSubmissionResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseStreamEvent(line);
        if (!event || event.request_id !== requestId) continue;
        if (event.type === "delta") {
          notifyChatStreamDelta({ type: "delta", request_id: requestId, delta: event.text });
        } else if (event.type === "done") {
          notifyChatStreamEvent({ type: "done", request_id: requestId });
          result = event.result;
        } else if (event.type === "error") {
          notifyChatStreamEvent({
            type: "error",
            request_id: requestId,
            message: event.message,
          });
          throw new Error(event.message ?? "Local chat gateway error");
        } else {
          const payload = streamEventToCoreEvent(event, requestId);
          if (payload) notifyChatStreamEvent(payload);
        }
      }
    }

    if (!result) {
      throw new Error("The local chat gateway closed the stream with no result.");
    }
    return result;
}

async function consumeChatWebSocketStream(
  requestId: string,
  request: Record<string, unknown>,
): Promise<CorePromptSubmissionResult> {
  const url = await chatStreamWebSocketUrl();
  return new Promise<CorePromptSubmissionResult>((resolve, reject) => {
    let settled = false;
    let opened = false;
    let chunks = 0;
    let chars = 0;
    const startedAt = performance.now();
    let lastDebugChunks = 0;
    const socket = new WebSocket(url);

    function debug(stage: string, detail?: string) {
      void chatApi.debugChatStream(requestId, {
        stage,
        chunks,
        chars,
        elapsed_ms: performance.now() - startedAt,
        detail,
      });
    }

    function settle(
      action: (value: CorePromptSubmissionResult) => void,
      value: CorePromptSubmissionResult,
    ) {
      if (settled) return;
      settled = true;
      socket.close();
      action(value);
    }

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      socket.close();
      reject(error);
    }

    socket.addEventListener("open", () => {
      opened = true;
      debug("ws_open");
      socket.send(JSON.stringify(request));
    });
    socket.addEventListener("message", (message) => {
      const event = parseStreamEvent(String(message.data));
      if (!event || event.request_id !== requestId) return;
      if (event.type === "delta") {
        chunks += 1;
        chars += event.text.length;
        if (chunks === 1 || chunks - lastDebugChunks >= 50) {
          lastDebugChunks = chunks;
          debug("client_received_delta");
        }
        notifyChatStreamDelta({ type: "delta", request_id: requestId, delta: event.text });
      } else if (event.type === "done") {
        debug("client_received_done");
        notifyChatStreamEvent({ type: "done", request_id: requestId });
        settle(resolve, event.result);
      } else if (event.type === "error") {
        debug("client_received_error", event.message);
        notifyChatStreamEvent({
          type: "error",
          request_id: requestId,
          message: event.message,
        });
        fail(new Error(event.message ?? "Local chat gateway error"));
      } else {
        const payload = streamEventToCoreEvent(event, requestId);
        if (payload) notifyChatStreamEvent(payload);
      }
    });
    socket.addEventListener("error", () => {
      fail(
        new Error(
          opened
            ? "Chat WebSocket stream interrupted."
            : "Chat WebSocket gateway unavailable.",
        ),
      );
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        fail(new Error("The local chat gateway closed the WebSocket with no result."));
      }
    });
  });
}

async function chatStreamWebSocketUrl(): Promise<string> {
  throw new Error("Rust chat gateway not yet extracted as a standalone service.");
}

function notifyChatStreamDelta(payload: CoreChatStreamDelta) {
  notifyChatStreamEvent(payload);
}

function notifyChatStreamEvent(payload: CoreChatStreamEvent) {
  for (const listener of streamEventListeners) {
    listener(payload);
  }
  if (payload.type !== "delta") return;
  for (const listener of streamListeners) {
    listener(payload);
  }
}

function streamEventToCoreEvent(
  event: StreamEvent,
  requestId: string,
): CoreChatStreamEvent | null {
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
      return { type: event.type, request_id: requestId, payload: event.payload };
    default:
      return null;
  }
}

function parseStreamEvent(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as StreamEvent;
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
