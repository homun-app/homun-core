import type { CoreBranchPoint } from "../lib/coreBridge";
import type { ChatMessage } from "../types";
import { ChatBranchPicker } from "./ChatBranchPicker";
import { ChatFollowUps } from "./ChatFollowUps";
import { MessageActionFooter } from "./MessageActionFooter";
import { MessageAttachmentList } from "./MessageAttachmentList";
import { MessageStatusBadges } from "./MessageStatusBadges";

type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

interface ChatMessageAfterContentProps {
  message: ChatMessage;
  isStreaming: boolean;
  incomplete: boolean;
  autoContinuing: boolean;
  branchPoint: CoreBranchPoint | undefined;
  branchBusy: boolean;
  followUps: string[];
  followUpsFor: string | null;
  copied: boolean;
  previousUserMessageIndex: Map<string, ChatMessage | null>;
  threadIsProject: boolean;
  consumerWorkspaceId: string | null | undefined;
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

export function ChatMessageAfterContent({
  message,
  isStreaming,
  incomplete,
  autoContinuing,
  branchPoint,
  branchBusy,
  followUps,
  followUpsFor,
  copied,
  previousUserMessageIndex,
  threadIsProject,
  consumerWorkspaceId,
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
}: ChatMessageAfterContentProps) {
  const assistantMessage = message.role === "assistant";
  const showFollowUps = followUpsFor === message.id;
  const showBranchPicker =
    !isStreaming && branchPoint && branchPoint.options.length >= 2;

  return (
    <>
      {message.text && !isStreaming && (
        <MessageStatusBadges
          incomplete={assistantMessage && incomplete}
          autoContinuing={autoContinuing}
        />
      )}
      {showBranchPicker && (
        <ChatBranchPicker
          point={branchPoint}
          busy={branchBusy}
          onSwitch={(direction) => void onSwitchBranch(branchPoint, direction)}
          onRename={(label) => void onRenameBranch(message.id, label)}
        />
      )}
      {!isStreaming && showFollowUps && followUps.length > 0 && (
        <ChatFollowUps
          suggestions={followUps}
          onSelect={(suggestion) => {
            onSelectFollowUp(suggestion);
          }}
        />
      )}
      {message.attachments && message.attachments.length > 0 && (
        <MessageAttachmentList attachments={message.attachments} />
      )}
      <MessageActionFooter
        message={message}
        isStreaming={isStreaming}
        copied={copied}
        previousUserMessage={previousUserMessageIndex.get(message.id)}
        threadIsProject={threadIsProject}
        consumerWorkspaceId={consumerWorkspaceId}
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
    </>
  );
}
