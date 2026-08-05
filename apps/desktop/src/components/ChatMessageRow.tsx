import type { CoreBranchPoint } from "../lib/coreBridge";
import { isLikelyIncompleteMessage } from "../lib/chatViewMessages";
import type { ChatMessage } from "../types";
import { ChatMessageAfterContent } from "./ChatMessageAfterContent";
import { ChatMessageContent } from "./ChatMessageContent";
import { ChatSystemMessageHeader } from "./ChatSystemMessageHeader";
import type { ChatStreamStatus } from "./AssistantThinkingState";
import type { ParsedArtifact } from "./MessageArtifacts";

type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

interface ChatMessageRowProps {
  message: ChatMessage;
  streamingAssistantId: string | null;
  editingMessageId: string | null;
  editingText: string;
  streamHasVisibleText: boolean;
  hasActiveTurnState: boolean;
  streamStatus: ChatStreamStatus | null;
  threadId: string;
  cancelLabel: string;
  saveLabel: string;
  autoContinueMessageId: string | null;
  branchIndex: Map<string, CoreBranchPoint>;
  branchBusy: boolean;
  followUps: string[];
  followUpsFor: string | null;
  copiedMessageId: string | null;
  previousUserMessageIndex: Map<string, ChatMessage | null>;
  threadIsProject: boolean;
  consumerWorkspaceId: string | null | undefined;
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
  onSwitchBranch: (point: CoreBranchPoint, direction: number) => void | Promise<void>;
  onRenameBranch: (messageId: string, label: string | null) => void | Promise<void>;
  onSelectFollowUp: (suggestion: string) => void;
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

export function ChatMessageRow({
  message,
  streamingAssistantId,
  editingMessageId,
  editingText,
  streamHasVisibleText,
  hasActiveTurnState,
  streamStatus,
  threadId,
  cancelLabel,
  saveLabel,
  autoContinueMessageId,
  branchIndex,
  branchBusy,
  followUps,
  followUpsFor,
  copiedMessageId,
  previousUserMessageIndex,
  threadIsProject,
  consumerWorkspaceId,
  onEditingTextChange,
  onCancelEdit,
  onSaveEdit,
  onOpenArtifact,
  onSubmitChoiceAnswer,
  onHandleProactiveAnswer,
  onSwitchBranch,
  onRenameBranch,
  onSelectFollowUp,
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
}: ChatMessageRowProps) {
  const isStreamingMessage = message.id === streamingAssistantId;
  const incompleteMessage = isLikelyIncompleteMessage(message);
  const messageSurfaceClass =
    message.role === "assistant"
      ? "message chat-message-agent"
      : message.role === "user"
        ? "message chat-message-user-band"
        : "message chat-message-system";

  return (
    <div className="thread-message-row">
      <article className={messageSurfaceClass}>
        {message.role === "system" && <ChatSystemMessageHeader />}
        <ChatMessageContent
          message={message}
          isStreaming={isStreamingMessage}
          isEditing={editingMessageId === message.id}
          editingText={editingText}
          streamHasVisibleText={streamHasVisibleText}
          hasActiveTurnState={hasActiveTurnState}
          streamStatus={streamStatus}
          threadId={threadId}
          cancelLabel={cancelLabel}
          saveLabel={saveLabel}
          onEditingTextChange={onEditingTextChange}
          onCancelEdit={onCancelEdit}
          onSaveEdit={onSaveEdit}
          onOpenArtifact={onOpenArtifact}
          onSubmitChoiceAnswer={onSubmitChoiceAnswer}
          onHandleProactiveAnswer={onHandleProactiveAnswer}
        />
        <ChatMessageAfterContent
          message={message}
          isStreaming={isStreamingMessage}
          incomplete={incompleteMessage}
          autoContinuing={autoContinueMessageId === message.id}
          branchPoint={branchIndex.get(message.id)}
          branchBusy={branchBusy}
          followUps={followUps}
          followUpsFor={followUpsFor}
          copied={copiedMessageId === message.id}
          previousUserMessageIndex={previousUserMessageIndex}
          threadIsProject={threadIsProject}
          consumerWorkspaceId={consumerWorkspaceId}
          onSwitchBranch={onSwitchBranch}
          onRenameBranch={onRenameBranch}
          onSelectFollowUp={onSelectFollowUp}
          onCopy={onCopy}
          onContinue={onContinue}
          onExpand={onExpand}
          onAskAboutAssistantResponse={onAskAboutAssistantResponse}
          onFeedback={onFeedback}
          onReply={onReply}
          onEdit={onEdit}
          onRegenerate={onRegenerate}
          onSaveToMemory={onSaveToMemory}
          onSaveAsGoal={onSaveAsGoal}
          onMemoryPublicationApproved={onMemoryPublicationApproved}
        />
      </article>
    </div>
  );
}
