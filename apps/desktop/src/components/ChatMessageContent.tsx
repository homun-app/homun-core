import type { ChatMessage } from "../types";
import { AssistantMessageBody } from "./AssistantMessageBody";
import {
  AssistantThinkingState,
  type ChatStreamStatus,
} from "./AssistantThinkingState";
import { MessageActivity } from "./MessageActivity";
import type { ParsedArtifact } from "./MessageArtifacts";
import { MessageEditBox } from "./MessageEditBox";

interface ChatMessageContentProps {
  message: ChatMessage;
  isStreaming: boolean;
  isEditing: boolean;
  editingText: string;
  streamHasVisibleText: boolean;
  hasActiveTurnState: boolean;
  streamStatus: ChatStreamStatus | null;
  threadId: string;
  cancelLabel: string;
  saveLabel: string;
  onEditingTextChange: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onOpenArtifact: (artifact: ParsedArtifact) => void;
  onSubmitChoiceAnswer: (
    answer: string,
    assistantMessageId: string,
  ) => void | Promise<unknown>;
  onHandleProactiveAnswer: (
    question: string,
    answer: string,
  ) => void | Promise<unknown>;
}

export function ChatMessageContent({
  message,
  isStreaming,
  isEditing,
  editingText,
  streamHasVisibleText,
  hasActiveTurnState,
  streamStatus,
  threadId,
  cancelLabel,
  saveLabel,
  onEditingTextChange,
  onCancelEdit,
  onSaveEdit,
  onOpenArtifact,
  onSubmitChoiceAnswer,
  onHandleProactiveAnswer,
}: ChatMessageContentProps) {
  if (isStreaming) {
    return (
      <>
        {!streamHasVisibleText && !hasActiveTurnState && (
          <AssistantThinkingState status={streamStatus} />
        )}
        {message.text && (
          <AssistantMessageBody
            text={message.text}
            eventParts={message.eventParts}
            streaming
            messageId={message.id}
            threadId={threadId}
            onOpenArtifact={onOpenArtifact}
            onChoose={(answer, purpose) =>
              purpose
                ? void onHandleProactiveAnswer(message.text, answer)
                : void onSubmitChoiceAnswer(answer, message.id)
            }
          />
        )}
      </>
    );
  }

  if (isEditing) {
    return (
      <MessageEditBox
        value={editingText}
        cancelLabel={cancelLabel}
        saveLabel={saveLabel}
        onChange={onEditingTextChange}
        onCancel={onCancelEdit}
        onSave={onSaveEdit}
      />
    );
  }

  if (message.text) {
    return (
      <>
        {/* Persisted activity markers must render after reload, not only while streaming. */}
        {message.role === "assistant" && (
          <MessageActivity text={message.text} live={false} />
        )}
        <AssistantMessageBody
          text={message.text}
          eventParts={message.eventParts}
          messageId={message.id}
          threadId={threadId}
          onOpenArtifact={onOpenArtifact}
          onChoose={(answer) => void onSubmitChoiceAnswer(answer, message.id)}
        />
      </>
    );
  }

  return (
    <AssistantThinkingState status={isStreaming ? streamStatus : null} />
  );
}
