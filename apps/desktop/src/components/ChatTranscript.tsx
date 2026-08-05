import { ChevronDown } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CoreBranchPoint, CoreUncertainEffectOutcome } from "../lib/coreBridge";
import type {
  ApprovelItem,
  ChatMessage,
  ChatThread,
  ComputerSession,
  UncertainEffectItem,
} from "../types";
import { ChatEmptyHero } from "./ChatEmptyHero";
import { ChatMessageRow } from "./ChatMessageRow";
import { InlineApprovelPanel } from "./InlineApprovelPanel";
import { InlineUncertainEffectPanel } from "./InlineUncertainEffectPanel";
import type { ChatStreamStatus } from "./AssistantThinkingState";
import type { ParsedArtifact } from "./MessageArtifacts";
import { PendingAssistantMessage } from "./PendingAssistantMessage";

type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

interface ChatTranscriptProps {
  conversationRef: RefObject<HTMLDivElement | null>;
  thread: ChatThread;
  threadMessages: ChatMessage[];
  sessionSeed: string;
  promptSubmitting: boolean;
  showPendingAssistant: boolean;
  streamingAssistantId: string | null;
  editingMessageId: string | null;
  editingText: string;
  streamHasVisibleText: boolean;
  hasActiveTurnState: boolean;
  streamStatus: ChatStreamStatus | null;
  autoContinueMessageId: string | null;
  branchIndex: Map<string, CoreBranchPoint>;
  branchBusy: boolean;
  followUps: string[];
  followUpsFor: string | null;
  copiedMessageId: string | null;
  previousUserMessageIndex: Map<string, ChatMessage | null>;
  threadIsProject: boolean;
  activeApprovels: ApprovelItem[];
  approvalBusyId: string | null;
  visibleComputerSession: ComputerSession;
  uncertainEffects: UncertainEffectItem[];
  effectResolutionBusyId: string | null;
  effectResolutionError: string | null;
  showJumpToBottom: boolean;
  onOpenUsageSettings: () => void;
  onUseForTask: (providerId: string, modelId: string) => void;
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
  onApproveApprovel: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void;
  onRejectApprovel: (approvalId: string) => void;
  onResolveEffect: (
    effect: UncertainEffectItem,
    outcome: CoreUncertainEffectOutcome,
  ) => void;
  onJumpToBottom: () => void;
}

export function ChatTranscript({
  conversationRef,
  thread,
  threadMessages,
  sessionSeed,
  promptSubmitting,
  showPendingAssistant,
  streamingAssistantId,
  editingMessageId,
  editingText,
  streamHasVisibleText,
  hasActiveTurnState,
  streamStatus,
  autoContinueMessageId,
  branchIndex,
  branchBusy,
  followUps,
  followUpsFor,
  copiedMessageId,
  previousUserMessageIndex,
  threadIsProject,
  activeApprovels,
  approvalBusyId,
  visibleComputerSession,
  uncertainEffects,
  effectResolutionBusyId,
  effectResolutionError,
  showJumpToBottom,
  onOpenUsageSettings,
  onUseForTask,
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
  onApproveApprovel,
  onRejectApprovel,
  onResolveEffect,
  onJumpToBottom,
}: ChatTranscriptProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="thread-scroll" aria-label={t("chat.activeThread")} ref={conversationRef}>
        <div className="thread-content">
          <div className="thread-message-list">
            {threadMessages.length === 0 && !promptSubmitting && (
              <ChatEmptyHero
                thread={thread}
                sessionSeed={sessionSeed}
                onOpenUsageSettings={onOpenUsageSettings}
                onUseForTask={onUseForTask}
              />
            )}
            {threadMessages.map((message) => (
              <ChatMessageRow
                key={message.id}
                message={message}
                streamingAssistantId={streamingAssistantId}
                editingMessageId={editingMessageId}
                editingText={editingText}
                streamHasVisibleText={streamHasVisibleText}
                hasActiveTurnState={hasActiveTurnState}
                streamStatus={streamStatus}
                threadId={thread.threadId}
                cancelLabel="Cancel"
                saveLabel={t("chat.saveAndSend")}
                autoContinueMessageId={autoContinueMessageId}
                branchIndex={branchIndex}
                branchBusy={branchBusy}
                followUps={followUps}
                followUpsFor={followUpsFor}
                copiedMessageId={copiedMessageId}
                previousUserMessageIndex={previousUserMessageIndex}
                threadIsProject={threadIsProject}
                consumerWorkspaceId={thread.workspaceId}
                onEditingTextChange={onEditingTextChange}
                onCancelEdit={onCancelEdit}
                onSaveEdit={onSaveEdit}
                onOpenArtifact={onOpenArtifact}
                onSubmitChoiceAnswer={onSubmitChoiceAnswer}
                onHandleProactiveAnswer={onHandleProactiveAnswer}
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
            ))}
          </div>

          {showPendingAssistant && (
            <PendingAssistantMessage status={streamStatus} />
          )}

          <InlineApprovelPanel
            approvals={activeApprovels}
            busyId={approvalBusyId}
            session={visibleComputerSession}
            onApprove={onApproveApprovel}
            onReject={onRejectApprovel}
          />
          <InlineUncertainEffectPanel
            effects={uncertainEffects}
            busyId={effectResolutionBusyId}
            hasError={effectResolutionError !== null}
            onResolve={onResolveEffect}
          />
        </div>
      </div>

      {showJumpToBottom && (
        <button
          className="chat-jump-bottom"
          type="button"
          aria-label={t("chat.jumpToLast")}
          title={t("chat.jumpToBottom")}
          onClick={onJumpToBottom}
        >
          <ChevronDown size={18} />
        </button>
      )}
    </>
  );
}
