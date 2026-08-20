import { ActiveTurnStatus, type ActiveTurnStatusProps } from "./ActiveTurnStatus";
import { ComposerContainer, type ReplyContext } from "./ComposerContainer";
import { PendingSteeringQueue } from "./PendingSteeringQueue";
import type { TurnSteeringRecord } from "../lib/chatApi";
import type { ChatTurnState } from "../lib/chat-runtime/chatTurnStatus";
import type {
  ChatAttachmentInput,
  RuntimeContextResponse,
} from "../lib/coreBridge";

interface ChatComposerDockProps {
  activeWork: boolean;
  chatTurnState: ChatTurnState | null;
  effectiveModelLabel: string;
  error: string | null;
  replyContext: ReplyContext | null;
  runtimeContext: RuntimeContextResponse | null;
  runtimeContextError: boolean;
  runtimeContextLoading: boolean;
  seed: { text: string; nonce: number } | null;
  streaming: boolean;
  suggestedModel: { value: string; nonce: number } | null;
  threadId: string;
  visiblePendingSteeringRows: TurnSteeringRecord[];
  onCancelStreaming: () => void;
  onClearReply: () => void;
  onDeletePendingSteering: (
    row: TurnSteeringRecord,
    expectedRevision: number,
  ) => Promise<void>;
  onEditPendingSteering: (
    row: TurnSteeringRecord,
    visiblePrompt: string,
    expectedRevision: number,
  ) => Promise<void>;
  onManualModelSelection: () => void;
  onOpenActivity: ActiveTurnStatusProps["onOpenActivity"];
  onRefreshRuntimeContext: () => void | Promise<void>;
  onSendPendingSteeringNow: (
    row: TurnSteeringRecord,
    expectedRevision: number,
  ) => Promise<void>;
  onStopActiveTurn: ActiveTurnStatusProps["onStop"];
  onSuggestedModelConsumed: () => void;
  onSubmit: (
    prompt: string,
    attachments: ChatAttachmentInput[],
    options?: {
      model?: string;
      mode?: string;
      forcedSkillsId?: string;
      contextText?: string;
      images?: string[];
    },
  ) => Promise<boolean>;
}

export function ChatComposerDock({
  activeWork,
  chatTurnState,
  effectiveModelLabel,
  error,
  replyContext,
  runtimeContext,
  runtimeContextError,
  runtimeContextLoading,
  seed,
  streaming,
  suggestedModel,
  threadId,
  visiblePendingSteeringRows,
  onCancelStreaming,
  onClearReply,
  onDeletePendingSteering,
  onEditPendingSteering,
  onManualModelSelection,
  onOpenActivity,
  onRefreshRuntimeContext,
  onSendPendingSteeringNow,
  onStopActiveTurn,
  onSuggestedModelConsumed,
  onSubmit,
}: ChatComposerDockProps) {
  return (
    <div className="composer-stack">
      {chatTurnState && (
        <div className="active-turn-band">
          <ActiveTurnStatus
            {...chatTurnState}
            onOpenActivity={onOpenActivity}
            onStop={onStopActiveTurn}
          />
        </div>
      )}
      <PendingSteeringQueue
        rows={visiblePendingSteeringRows}
        onEdit={onEditPendingSteering}
        onDelete={onDeletePendingSteering}
        onSendNow={onSendPendingSteeringNow}
      />
      <ComposerContainer
        activeWork={activeWork}
        disabled={false}
        effectiveModelLabel={effectiveModelLabel}
        runtimeContext={runtimeContext}
        runtimeContextLoading={runtimeContextLoading}
        runtimeContextError={runtimeContextError}
        error={error}
        replyContext={replyContext}
        seed={seed}
        suggestedModel={suggestedModel}
        streaming={streaming}
        threadId={threadId}
        onCancelStreaming={onCancelStreaming}
        onClearReply={onClearReply}
        onManualModelSelection={onManualModelSelection}
        onRefreshRuntimeContext={onRefreshRuntimeContext}
        onSuggestedModelConsumed={onSuggestedModelConsumed}
        onSubmit={onSubmit}
      />
    </div>
  );
}
