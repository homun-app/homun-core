import { useTranslation } from "react-i18next";
import {
  formatChatDuration,
  formatMessageTimestamp,
  visibleMessageMetadata,
} from "../lib/chatViewMessages";
import type { ChatMessage } from "../types";
import { MemoryUsagePopover } from "./MemoryUsagePopover";

interface MessageMetaCopyProps {
  message: ChatMessage;
  consumerWorkspaceId: string | null | undefined;
  onMemoryPublicationApproved: () => void | Promise<void>;
}

export function MessageMetaCopy({
  message,
  consumerWorkspaceId,
  onMemoryPublicationApproved,
}: MessageMetaCopyProps) {
  const { t } = useTranslation();
  const recallHits =
    message.eventParts?.flatMap((part) => (part.type === "recall" ? part.payload.hits : [])) ?? [];

  return (
    <div className="chat-message-meta-copy">
      <span>{formatMessageTimestamp(message.timestamp)}</span>
      {message.model && <span>{message.model}</span>}
      {message.role === "assistant" ? (
        <>
          {message.metrics && (
            <MessageMetricsSummary message={message} />
          )}
          {recallHits.length > 0 && (
            <MemoryUsagePopover
              hits={recallHits}
              buttonLabel={t("chat.memoryBadge", { count: recallHits.length })}
              consumerWorkspaceId={consumerWorkspaceId}
              onPublicationApproved={onMemoryPublicationApproved}
            />
          )}
        </>
      ) : (
        visibleMessageMetadata(message.metadata) && (
          <span>{visibleMessageMetadata(message.metadata)}</span>
        )
      )}
    </div>
  );
}

function MessageMetricsSummary({ message }: { message: ChatMessage }) {
  const metrics = message.metrics;
  if (!metrics) return null;

  const seconds = metrics.elapsedSeconds > 0 ? metrics.elapsedSeconds : metrics.totalElapsedSeconds ?? 0;
  if (seconds <= 0) return null;

  const tokens =
    metrics.generationTokens > 0
      ? metrics.generationTokens
      : Math.max(1, Math.round((message.text?.length ?? 0) / 4));

  return (
    <span>
      {formatChatDuration(seconds)} · {tokens} token
    </span>
  );
}
