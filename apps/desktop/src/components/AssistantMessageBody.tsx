import { ShieldCheck } from "lucide-react";
import { memo, useMemo } from "react";
import { visibleMessageText } from "../lib/chatVisibleContent";
import type { ChatEventPart } from "../types";
import { parseComposioConfirm } from "./ChatMessageMarkerParser";
import { RichMessage } from "./RichMessage";
import { MessageArtifacts, type ParsedArtifact } from "./MessageArtifacts";
import { ChoicesCard } from "./MessageChoiceCard";
import { PlanProposeCard } from "./MessagePlanProposeCard";
import { DiffCard } from "./MessageDiffCard";
import { StepAdvanceNote } from "./MessageStepAdvance";
import { GoalProposeCard } from "./MessageGoalProposeCard";
import { VaultRevealCard } from "./MessageVaultRevealCard";
import { SandboxReadOnlyCard } from "./MessageSandboxReadOnlyCard";
import { ComposioReconnectCard } from "./MessageComposioReconnectCard";
import { PaymentApprovalCard } from "./MessagePaymentApprovalCard";
import { FsAuthorizeCard } from "./MessageFsAuthorizeCard";
import { SandboxEscalateCard } from "./MessageSandboxEscalateCard";
import {
  ComposioConfirmCard,
  humanizeToolName,
} from "./MessageComposioConfirmCard";
import { ConnectSuggestCard } from "./MessageConnectSuggestCard";
import { VaultProposeCard } from "./MessageVaultProposeCard";

interface AssistantMessageBodyProps {
  text: string;
  eventParts?: ChatEventPart[];
  streaming?: boolean;
  messageId?: string;
  threadId?: string;
  onOpenArtifact?: (artifact: ParsedArtifact) => void;
  onChoose?: (answer: string, purpose?: string) => void;
}

/** Replaces raw tool slugs (GMAIL_SEND_EMAIL) anywhere in assistant text with a
 *  human-readable name. Targets SCREAMING_SNAKE_CASE tokens, which in chat are
 *  practically always tool slugs. */
function humanizeToolSlugs(text: string): string {
  return text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (slug) => humanizeToolName(slug));
}

/** Renders an assistant message body, surfacing write-confirmation cards and
 *  structured action cards only after streaming completes. */
// ADR 0022 (Piano UI C4): memo per stabilizzare l'identity dei messaggi non-
// streaming. Durante lo stream di un messaggio, l'array optimisticMessages è
// fresco ogni frame -> senza memo TUTTI i messaggi re-renderizzano. Questo comparatore
// re-renderizza un messaggio solo se il suo text/eventParts/streaming cambiano;
// i messaggi finalizzati (text stabile) NON re-renderizzano durante lo stream altrui.
export const AssistantMessageBody = memo(
  function AssistantMessageBody({
    text,
    eventParts,
    streaming,
    messageId,
    threadId,
    onOpenArtifact,
    onChoose,
  }: AssistantMessageBodyProps) {
    const {
      visible,
      action,
      doneTool,
      reconnectSlug,
      fsAuthorize,
      sandboxEscalate,
      readOnlyBlocked,
      connectSuggest,
      vaultPropose,
      vaultReveal,
      paymentApproval,
      choices,
      planPropose,
      goalPropose,
    } = useMemo(() => parseComposioConfirm(text, eventParts), [text, eventParts]);
    const readable = useMemo(() => humanizeToolSlugs(visibleMessageText(visible)), [visible]);
    return (
      <>
        {readable && <RichMessage text={readable} streaming={streaming} />}
        {!streaming && onOpenArtifact && <MessageArtifacts text={text} onOpen={onOpenArtifact} />}
        {doneTool && !streaming && (
          <details className="chat-operational-row">
            <summary>
              <ShieldCheck size={14} aria-hidden="true" />
              <span>{humanizeToolName(doneTool)}</span>
            </summary>
            <div className="chat-operational-content cmp-confirm done">
              <ShieldCheck size={15} />
              <span>Action completed: {humanizeToolName(doneTool)}</span>
            </div>
          </details>
        )}
        {action && !streaming && (
          <ComposioConfirmCard action={action} messageId={messageId} threadId={threadId} />
        )}
        {reconnectSlug && !streaming && <ComposioReconnectCard slug={reconnectSlug} />}
        {fsAuthorize && !streaming && (
          <FsAuthorizeCard
            path={fsAuthorize.path}
            op={fsAuthorize.op}
            messageId={messageId}
            threadId={threadId}
          />
        )}
        {sandboxEscalate && !streaming && (
          <SandboxEscalateCard
            command={sandboxEscalate.command}
            cwd={sandboxEscalate.cwd}
            messageId={messageId}
            threadId={threadId}
          />
        )}
        {readOnlyBlocked && !streaming && (
          <SandboxReadOnlyCard target={readOnlyBlocked.target} />
        )}
        {connectSuggest && !streaming && (
          <ConnectSuggestCard
            suggest={connectSuggest}
            messageId={messageId}
            threadId={threadId}
          />
        )}
        {vaultPropose && !streaming && (
          <VaultProposeCard
            proposal={vaultPropose}
            messageId={messageId}
            threadId={threadId}
          />
        )}
        {vaultReveal && !streaming && <VaultRevealCard proposal={vaultReveal} />}
        {paymentApproval && !streaming && (
          <PaymentApprovalCard
            proposal={paymentApproval}
            messageId={messageId}
            threadId={threadId}
          />
        )}
        {choices && onChoose && (
          <ChoicesCard prompt={choices} onChoose={onChoose} />
        )}
        {planPropose && !streaming && onChoose && (
          <PlanProposeCard plan={planPropose} onAnswer={onChoose} />
        )}
        {goalPropose && !streaming && threadId && (
          <GoalProposeCard objectives={goalPropose} threadId={threadId} />
        )}
        {eventParts
          ?.filter((p): p is Extract<ChatEventPart, { type: "diff" }> => p.type === "diff")
          .map((part, index) => (
            <DiffCard key={`diff-${index}`} payload={part.payload} />
          ))}
        {eventParts
          ?.filter(
            (p): p is Extract<ChatEventPart, { type: "step_advance" }> =>
              p.type === "step_advance",
          )
          .map((part, index) => (
            <StepAdvanceNote key={`step-advance-${index}`} payload={part.payload} />
          ))}
      </>
    );
  },
  // Comparatore: re-renderizza solo se il contenuto del messaggio cambia.
  // Le callback (onOpenArtifact/onChoose) sono stabili nel caller - skip.
  (prev, next) =>
    prev.text === next.text &&
    prev.streaming === next.streaming &&
    prev.messageId === next.messageId &&
    prev.threadId === next.threadId &&
    prev.eventParts === next.eventParts,
);
