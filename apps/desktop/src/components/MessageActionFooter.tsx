import {
  isLikelyIncompleteMessage,
  messageContentKind,
} from "../lib/chatViewMessages";
import type { ChatMessage } from "../types";
import { MessageActionBar } from "./MessageActionBar";
import { MessageMetaCopy } from "./MessageMetaCopy";

type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

interface MessageActionFooterProps {
  message: ChatMessage;
  isStreaming: boolean;
  copied: boolean;
  previousUserMessage: ChatMessage | null | undefined;
  threadIsProject: boolean;
  consumerWorkspaceId: string | null | undefined;
  onCopy: (message: ChatMessage) => void;
  onContinue: (messageId: string) => void;
  onExpand: (messageId: string) => void;
  onAskAboutAssistantResponse: (
    messageId: string,
    label: string,
    prompt: string,
  ) => void;
  onFeedback: (
    message: ChatMessage,
    feedback: MessageFeedback,
  ) => void | Promise<void>;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onRegenerate: (messageId: string) => void;
  onSaveToMemory: (message: ChatMessage) => void | Promise<void>;
  onSaveAsGoal: (text?: string | null) => void;
  onMemoryPublicationApproved: () => void | Promise<void>;
}

export function MessageActionFooter({
  message,
  isStreaming,
  copied,
  previousUserMessage,
  threadIsProject,
  consumerWorkspaceId,
  onCopy,
  onContinue,
  onExpand,
  onAskAboutAssistantResponse,
  onFeedback,
  onReply,
  onEdit,
  onRegenerate,
  onSaveToMemory,
  onSaveAsGoal,
  onMemoryPublicationApproved,
}: MessageActionFooterProps) {
  const contentKind = messageContentKind(message);
  const assistantMessage = message.role === "assistant";
  const assistantTextMessage = assistantMessage && contentKind === "text";
  const assistantOperationalMessage =
    assistantMessage && contentKind !== "system";
  const incompleteMessage = isLikelyIncompleteMessage(message);

  return (
    <footer className="chat-message-meta">
      <MessageMetaCopy
        message={message}
        consumerWorkspaceId={consumerWorkspaceId}
        onMemoryPublicationApproved={onMemoryPublicationApproved}
      />
      <div className="chat-message-actions-slot">
        {message.text && !isStreaming && (
          <MessageActionBar
            contentKind={contentKind}
            copied={copied}
            canContinue={assistantMessage && Boolean(message.text) && incompleteMessage}
            canRegenerate={assistantMessage && Boolean(previousUserMessage)}
            canReply={message.role !== "system" && Boolean(message.text)}
            canEdit={message.role === "user" && Boolean(message.text)}
            canExpand={assistantTextMessage}
            canSaveToMemory={assistantOperationalMessage}
            canSaveAsGoal={assistantOperationalMessage && threadIsProject}
            feedback={message.feedback}
            metrics={message.metrics}
            savedToMemory={Boolean(message.savedMemoryRef)}
            onCopy={() => onCopy(message)}
            onContinue={() => onContinue(message.id)}
            onExpand={() => onExpand(message.id)}
            onExplainCode={() =>
              onAskAboutAssistantResponse(
                message.id,
                "Explain code",
                "Explain the previous code briefly and operationally.",
              )
            }
            onExplainDiagram={() =>
              onAskAboutAssistantResponse(
                message.id,
                "Explain diagram",
                "Explain the previous diagram briefly and operationally.",
              )
            }
            onFeedback={(feedback) => void onFeedback(message, feedback)}
            onImproveCode={() =>
              onAskAboutAssistantResponse(
                message.id,
                "Improve code",
                "Improve the previous code keeping it short and including a fenced markdown block.",
              )
            }
            onReply={() => onReply(message)}
            onEdit={() => onEdit(message)}
            onRegenerate={() => onRegenerate(message.id)}
            onReviseDiagram={() =>
              onAskAboutAssistantResponse(
                message.id,
                "Edit diagram",
                "Propose an improved version of the previous diagram in a fenced mermaid markdown block.",
              )
            }
            onSaveToMemory={() => void onSaveToMemory(message)}
            onSaveAsGoal={() => onSaveAsGoal(message.text)}
          />
        )}
      </div>
    </footer>
  );
}
