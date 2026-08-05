import { fileLocalPathFromBridge } from "./gatewayConfig";
import type { ChatAttachmentInput, CorePromptSubmissionResult } from "./coreBridge";
import type { ChatAttachment, ChatMessage, ComputerSession } from "../types";

export type MessageContentKind = "user" | "system" | "text" | "code" | "diagram";

export function describeBridgeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Local gateway unreachable in this view.";
  }

  if (error.message.includes("Gateway")) {
    return "Local gateway not yet available: using the direct local runtime when possible.";
  }

  return error.message;
}

export function withChatMetrics(
  message: ChatMessage,
  measuredElapsedSeconds: number,
): ChatMessage {
  if (message.role !== "assistant") return message;
  const existing = message.metrics;
  const elapsed =
    existing && existing.elapsedSeconds > 0 ? existing.elapsedSeconds : measuredElapsedSeconds;
  const tokens =
    existing && existing.generationTokens > 0
      ? existing.generationTokens
      : Math.max(1, Math.round((message.text?.length ?? 0) / 4));
  const base = existing ?? {
    promptTokens: 0,
    generationTokens: 0,
    promptTps: 0,
    generationTps: 0,
    peakMemoryGb: 0,
    elapsedSeconds: 0,
    maxTokens: 0,
  };
  return {
    ...message,
    metrics: { ...base, elapsedSeconds: elapsed, generationTokens: tokens },
  };
}

export function formatChatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function chatMessageFromAssistantResult(
  result: CorePromptSubmissionResult,
  fallbackText: string,
  eventParts: ChatMessage["eventParts"],
): ChatMessage {
  return {
    id: result.assistant_message.id,
    role: result.assistant_message.role,
    text: result.assistant_message.text || fallbackText,
    timestamp: result.assistant_message.timestamp,
    metadata: result.assistant_message.metadata ?? undefined,
    metrics: result.assistant_message.metrics
      ? {
          promptTokens: result.assistant_message.metrics.prompt_tokens,
          generationTokens: result.assistant_message.metrics.generation_tokens,
          promptTps: result.assistant_message.metrics.prompt_tps,
          generationTps: result.assistant_message.metrics.generation_tps,
          peakMemoryGb: result.assistant_message.metrics.peak_memory_gb,
          elapsedSeconds: result.assistant_message.metrics.elapsed_seconds,
          maxTokens: result.assistant_message.metrics.max_tokens,
          promptBuildSeconds:
            result.assistant_message.metrics.prompt_build_seconds ?? undefined,
          timeToFirstTokenSeconds:
            result.assistant_message.metrics.time_to_first_token_seconds ?? undefined,
          totalElapsedSeconds:
            result.assistant_message.metrics.total_elapsed_seconds ?? undefined,
          runtimeStatusBefore:
            result.assistant_message.metrics.runtime_status_before ?? undefined,
        }
      : undefined,
    eventParts,
  };
}

export function visibleMessageMetadata(metadata: string | undefined) {
  if (!metadata) return undefined;
  const hidden = new Set([
    "Electron core locale",
    "Sent to the local core",
    "Not saved as raw payload",
  ]);
  return hidden.has(metadata) ? undefined : metadata;
}

export function messageContentKind(message: ChatMessage): MessageContentKind {
  if (message.role === "user") return "user";
  if (message.role === "system") return "system";
  if (hasMermaidContent(message.text)) return "diagram";
  if (hasCodeContent(message.text)) return "code";
  return "text";
}

function hasMermaidContent(text: string) {
  return /```mermaid[\s\S]*?```/i.test(text);
}

function hasCodeContent(text: string) {
  return /```(?!mermaid\b)[\w-]*\n[\s\S]*?```/i.test(text);
}

export function isLikelyIncompleteMessage(message: ChatMessage) {
  const trimmed = message.text.trim();
  if (!trimmed) return false;
  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) return true;
  if (/[({[]$/.test(trimmed)) return true;
  if (/(^|\n)\s*\d+\.\s+\*\*[^*\n]*$/.test(trimmed)) return true;
  const metrics = message.metrics;
  const nearMax = Boolean(
    metrics &&
      metrics.maxTokens > 0 &&
      metrics.generationTokens >= Math.floor(metrics.maxTokens * 0.96),
  );
  if (nearMax) {
    const endsCleanly = /[.!?…»"'”’)\]`|]\s*$/u.test(trimmed);
    return !endsCleanly;
  }
  return false;
}

export function createReplyPreview(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

export function messageRoleLabel(role: ChatMessage["role"]) {
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "user";
}

export function isPlaceholderThreadTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return normalized === "new task" || normalized === "nuovo compito";
}

export function currentTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

export function formatMessageTimestamp(timestamp: string) {
  if (!/^\d+$/.test(timestamp)) {
    return timestamp;
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

export function toMessageAttachment(attachment: ChatAttachmentInput): ChatAttachment {
  return {
    artifactId: `pending_${attachment.displayName}_${attachment.sizeBytes}`,
    title: attachment.displayName,
    kind: attachmentKindFromMime(attachment.mimeType),
    sizeBytes: attachment.sizeBytes,
    previewAvailable: attachment.mimeType.startsWith("image/"),
    privacyDomain: "local_files",
  };
}

export function isUserVisibleComputerEvent(item: ComputerSession["timeline"][number]) {
  return item.title !== "Local session ready" && item.id !== "bridge-unavailable";
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function shortModelName(model: string): string {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return tail.length > 22 ? `${tail.slice(0, 21)}…` : tail;
}

export function formatContextTokens(n: number): string {
  if (!n || n <= 0) return "contesto n/d";
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `~${Number.isInteger(millions) ? millions : millions.toFixed(1)}M ctx`;
  }
  return `~${Math.round(n / 1000)}k ctx`;
}

export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    rb: "ruby",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    md: "markdown",
    markdown: "markdown",
    html: "xml",
    xml: "xml",
    css: "css",
    scss: "scss",
    sql: "sql",
  };
  return map[ext] ?? "text";
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileLocalPath(file: File): string {
  const viaBridge = fileLocalPathFromBridge(file);
  if (viaBridge) return viaBridge;
  const fileWithPath = file as File & { path?: string };
  return fileWithPath.path ?? "";
}

function attachmentKindFromMime(mimeType: string): ChatAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("markdown")
  ) {
    return "text";
  }
  return "file";
}
