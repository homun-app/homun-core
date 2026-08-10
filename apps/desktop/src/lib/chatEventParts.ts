import type { CoreChatStreamEvent } from "./coreBridge";
import type { TurnReplayStatus } from "./turnReplayState";
import type { ChatEventPart, ChatMessage } from "../types";
import { STRUCTURED_MARKER_DELTA_RE } from "./markers";
import { isValidStepAdvancePayload } from "./chat-runtime/stepAdvanceDisplay";
import { parseChoicePromptPayload } from "../components/ChatPayloadParsers";

export function chatEventPartFromStream(event: CoreChatStreamEvent): ChatEventPart | null {
  switch (event.type) {
    case "reasoning":
      return null;
    case "activity":
      return { type: "activity", text: event.text };
    case "plan_update":
      return { type: "plan_update", markdown: event.markdown };
    case "step_advance":
      return { type: "step_advance", payload: event.payload };
    case "choice_prompt":
    case "vault_propose":
    case "vault_reveal":
    case "payment_approval":
    case "tool_result":
    case "recall":
    case "diff":
      return { type: event.type, payload: event.payload } as ChatEventPart;
    default:
      return null;
  }
}

export function normalizeChatEventParts(parts: unknown[] | undefined): ChatEventPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part): ChatEventPart[] => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    switch (item.type) {
      case "reasoning":
        return [];
      case "activity":
        return typeof item.text === "string" ? [{ type: item.type, text: item.text }] : [];
      case "plan_update":
        return typeof item.markdown === "string"
          ? [{ type: "plan_update", markdown: item.markdown }]
          : [];
      case "step_advance":
        // Persisted kernel events: keep only payloads matching the wire contract.
        return isValidStepAdvancePayload(item.payload)
          ? [{ type: "step_advance", payload: item.payload } as ChatEventPart]
          : [];
      case "choice_prompt":
      case "vault_propose":
      case "vault_reveal":
      case "payment_approval":
      case "tool_result":
      case "recall":
      case "diff":
        return [{ type: item.type, payload: item.payload } as ChatEventPart];
      case "actionable_card":
        // Gateway persists Free HITL as actionable_card; map Choice shapes to choice_prompt
        // so ChoicesCard still renders when the marker was stripped from message text.
        // Clarify stays machine-owned (prose is the UI); awaiting-user is detected from
        // the marker text / raw actionable_card kind, not a second card widget.
        if (item.kind === "CHOICES" && item.payload !== undefined) {
          const choices = parseChoicePromptPayload(item.payload);
          return choices ? [{ type: "choice_prompt", payload: choices }] : [];
        }
        if (
          item.kind === "AWAIT_USER" &&
          item.payload &&
          typeof item.payload === "object" &&
          (item.payload as { kind?: string }).kind === "choice"
        ) {
          const { kind: _k, ...choicePayload } = item.payload as Record<string, unknown>;
          const choices = parseChoicePromptPayload(choicePayload);
          return choices ? [{ type: "choice_prompt", payload: choices }] : [];
        }
        return [];
      default:
        return [];
    }
  });
}

export function shouldDropStructuredMarkerDelta(delta: string) {
  return STRUCTURED_MARKER_DELTA_RE.test(delta.trim());
}

// UI-local until the durable activity projection lands in the generated client type.
// Missing backend fields stay absent; the view never invents retry/backoff metadata.
export interface ActiveTurnProjection {
  turn_id: string;
  last_event_seq: number;
  status: string;
  attempt: number;
  max_attempts: number;
  not_before: number | null;
  blocked_reason: string | null;
  updated_at: number;
}

export function replayStatusFromProjection(status: string): TurnReplayStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (["retrying", "retry_waiting"].includes(status)) return "retrying";
  return "running";
}

/** True when the chat frontier awaits the user (Free HITL), not a later user reply. */
export function threadTailAwaitsUser(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") return false;
    if (message.role !== "assistant") continue;
    if (
      message.text.includes("‹‹CHOICES››") ||
      message.text.includes("‹‹CLARIFY››") ||
      message.text.includes("‹‹AWAIT_USER››")
    ) {
      return true;
    }
    const rawParts = message.eventParts as Array<Record<string, unknown>> | undefined;
    if (
      rawParts?.some((part) => {
        if (part.type !== "actionable_card") return false;
        if (part.kind === "CHOICES" || part.kind === "CLARIFY") return true;
        if (part.kind !== "AWAIT_USER") return false;
        const payload = part.payload as { kind?: string } | undefined;
        return payload?.kind === "choice" || payload?.kind === "clarify";
      })
    ) {
      return true;
    }
    const parts = normalizeChatEventParts(rawParts as unknown[] | undefined);
    return parts.some((part) => part.type === "choice_prompt");
  }
  return false;
}
