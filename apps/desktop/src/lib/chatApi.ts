import type {
  ChatAttachmentInput,
  CoreChatMessageMetrics,
  CoreChatMessage,
  CoreChatMessagesSnapshot,
  CoreChatStreamDelta,
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

const streamListeners = new Set<(payload: CoreChatStreamDelta) => void>();
let activeThreadId = "thread_active_prompt";
let localThreads: CoreChatThread[] = [
  {
    thread_id: activeThreadId,
    title: "New task",
    subtitle: "Chat locale",
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
        text: "Sono pronto. Scrivimi pure: rispondo in locale.",
        timestamp: currentTimestampSeconds(),
        metadata: "Model locale",
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
  async seedAssistantMessage(threadId: string, text: string) {
    return hydrateMessagesSnapshot(
      await gatewayJson<CoreChatMessagesSnapshot>(
        `/api/chat/threads/${encodeURIComponent(threadId)}/assistant_message`,
        { method: "POST", body: JSON.stringify({ text }) },
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
            }),
          },
        ),
      );
    } catch {
      return snapshot;
    }
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
};

function createLocalChatThread() {
  const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const thread: CoreChatThread = {
    thread_id: threadId,
    title: "New task",
    subtitle: "Chat locale",
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
      text: "Sono pronto. Scrivimi pure: rispondo in locale.",
      timestamp: currentTimestampSeconds(),
      metadata: "Model locale",
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
      throw new Error("Il gateway chat locale non ha aperto lo stream.");
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
          notifyChatStreamDelta({ request_id: requestId, delta: event.text });
        } else if (event.type === "done") {
          result = event.result;
        } else if (event.type === "error") {
          throw new Error(event.message ?? "Errore gateway chat locale");
        }
      }
    }

    if (!result) {
      throw new Error("Il gateway chat locale ha chiuso lo stream senza risultato.");
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
        notifyChatStreamDelta({ request_id: requestId, delta: event.text });
      } else if (event.type === "done") {
        debug("client_received_done");
        settle(resolve, event.result);
      } else if (event.type === "error") {
        debug("client_received_error", event.message);
        fail(new Error(event.message ?? "Errore gateway chat locale"));
      }
    });
    socket.addEventListener("error", () => {
      fail(
        new Error(
          opened
            ? "Stream WebSocket chat interrotto."
            : "Gateway chat WebSocket non disponibile.",
        ),
      );
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        fail(new Error("Il gateway chat locale ha chiuso il WebSocket senza risultato."));
      }
    });
  });
}

async function chatStreamWebSocketUrl(): Promise<string> {
  throw new Error("Gateway chat Rust non ancora estratto come servizio autonomo.");
}

function notifyChatStreamDelta(payload: CoreChatStreamDelta) {
  for (const listener of streamListeners) {
    listener(payload);
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
  return `Gateway chat locale non disponibile: HTTP ${response.status}`;
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
    attachments: [],
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
      subtitle: "Model locale",
      updated_at: currentTimestampSeconds(),
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
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > 44 ? `${normalized.slice(0, 41)}...` : normalized;
}

function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}
