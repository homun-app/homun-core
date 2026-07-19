export interface ChatContextMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChatContextBudgetOptions {
  maxContextChars?: number;
  maxMessageChars?: number;
  preserveRecentMessages?: number;
}

const DEFAULT_MAX_CONTEXT_CHARS = 3_600;
const DEFAULT_MAX_MESSAGE_CHARS = 900;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 6;

export function buildJuicePromptChatContext(
  messages: ChatContextMessage[],
  options: ChatContextBudgetOptions = {},
): ChatContextMessage[] {
  // This helper only applies a display/local-fallback size budget. Persisted
  // thread context is rebuilt and authorization-filtered by the gateway; this
  // client projection must never be treated as memory provenance authority.
  const maxContextChars = options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const preserveRecentMessages =
    options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
  const sanitized = messages
    .map((message) => ({
      role: message.role,
      text: trimToChars(redactSensitiveText(message.text), maxMessageChars),
    }))
    .filter((message) => message.text.trim().length > 0);

  if (sanitized.length <= preserveRecentMessages) {
    return fitContextBudget(sanitized, maxContextChars);
  }

  const recent = sanitized.slice(-preserveRecentMessages);
  const older = sanitized.slice(0, -preserveRecentMessages);
  const compressedOlder = compressOlderMessages(older, maxContextChars);
  return fitContextBudget([...compressedOlder, ...recent], maxContextChars);
}

function compressOlderMessages(
  messages: ChatContextMessage[],
  maxContextChars: number,
): ChatContextMessage[] {
  if (messages.length === 0) return [];
  const snippets = messages
    .map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      return `${label}: ${firstUsefulLine(message.text)}`;
    })
    .filter(Boolean);
  const summaryBudget = Math.min(900, Math.max(360, Math.floor(maxContextChars * 0.25)));
  return [
    {
      role: "assistant",
      text: [
        "[context compressed: earlier chat]",
        trimToChars(snippets.join("\n"), summaryBudget),
      ].join("\n"),
    },
  ];
}

function fitContextBudget(
  messages: ChatContextMessage[],
  maxContextChars: number,
): ChatContextMessage[] {
  let total = 0;
  const reversed: ChatContextMessage[] = [];
  for (const message of [...messages].reverse()) {
    const nextSize = message.text.length + 24;
    if (total + nextSize > maxContextChars && reversed.length > 0) break;
    reversed.push(message);
    total += nextSize;
  }
  return reversed.reverse();
}

function firstUsefulLine(text: string) {
  const line =
    text
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? "";
  return trimToChars(line, 180);
}

function trimToChars(text: string, maxChars: number) {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 38)).trimEnd()}\n[context truncated]`;
}

function redactSensitiveText(input: string) {
  return stripSensitiveQueryParams(input)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xoxb|xoxp)-[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}\b/gi, "Bearer [REDACTED]");
}

function stripSensitiveQueryParams(input: string) {
  return input.replace(/https?:\/\/[^\s)]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      for (const key of [...url.searchParams.keys()]) {
        if (/token|key|secret|password|session|auth|code/i.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      return url.toString();
    } catch {
      return rawUrl;
    }
  });
}
