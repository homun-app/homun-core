import { isValidStepAdvancePayload } from "./chat-runtime/stepAdvanceDisplay.mjs";

const STRUCTURED_MARKER_DELTA_RE =
  /^‹‹(?:ACT|REASONING|PLAN|CHOICES|CLARIFY|AWAIT_USER|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL)››[\s\S]*?‹‹\/(?:ACT|REASONING|PLAN|CHOICES|CLARIFY|AWAIT_USER|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL)››$/;
const LEGACY_HITL_MARKER_RE = /‹‹(?:CHOICES|CLARIFY|AWAIT_USER)››[\s\S]*?‹‹\/(?:CHOICES|CLARIFY|AWAIT_USER)››/;

function parseChoicePromptPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const options = Array.isArray(payload.options)
    ? payload.options.filter((option) => typeof option === "string" && option.trim())
    : [];
  if (options.length === 0) return null;
  return {
    question: typeof payload.question === "string" ? payload.question : "",
    multi: payload.multi === true,
    options,
    purpose: typeof payload.purpose === "string" ? payload.purpose : undefined,
  };
}

export function chatEventPartFromStream(event) {
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
      return { type: event.type, payload: event.payload };
    default:
      return null;
  }
}

export function normalizeChatEventParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    switch (part.type) {
      case "reasoning":
        return [];
      case "activity":
        return typeof part.text === "string" ? [{ type: part.type, text: part.text }] : [];
      case "plan_update":
        return typeof part.markdown === "string"
          ? [{ type: "plan_update", markdown: part.markdown }]
          : [];
      case "step_advance":
        return isValidStepAdvancePayload(part.payload)
          ? [{ type: "step_advance", payload: part.payload }]
          : [];
      case "choice_prompt":
      case "vault_propose":
      case "vault_reveal":
      case "payment_approval":
      case "tool_result":
      case "recall":
      case "diff":
        return [{ type: part.type, payload: part.payload }];
      case "actionable_card":
        if (part.kind === "CHOICES" && part.payload !== undefined) {
          const choices = parseChoicePromptPayload(part.payload);
          return choices ? [{ type: "choice_prompt", payload: choices }] : [];
        }
        if (
          part.kind === "AWAIT_USER"
          && part.payload
          && typeof part.payload === "object"
          && part.payload.kind === "choice"
        ) {
          const { kind: _kind, ...choicePayload } = part.payload;
          const choices = parseChoicePromptPayload(choicePayload);
          return choices ? [{ type: "choice_prompt", payload: choices }] : [];
        }
        return [];
      default:
        return [];
    }
  });
}

export function shouldDropStructuredMarkerDelta(delta) {
  return STRUCTURED_MARKER_DELTA_RE.test(delta.trim());
}

export function replayStatusFromProjection(status) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (["retrying", "retry_waiting"].includes(status)) return "retrying";
  return "running";
}

/** Legacy marker fallback only; kernel projection owns current-turn liveness once loaded. */
export function threadTailAwaitsUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") return false;
    if (message.role !== "assistant") continue;
    if (LEGACY_HITL_MARKER_RE.test(message.text)) {
      return true;
    }
    const rawParts = message.eventParts;
    if (
      rawParts?.some((part) => {
        if (part.type !== "actionable_card") return false;
        if (part.kind === "CHOICES" || part.kind === "CLARIFY") return true;
        if (part.kind !== "AWAIT_USER") return false;
        const payload = part.payload;
        return payload?.kind === "choice" || payload?.kind === "clarify";
      })
    ) {
      return true;
    }
    const parts = normalizeChatEventParts(rawParts);
    return parts.some((part) => part.type === "choice_prompt");
  }
  return false;
}
