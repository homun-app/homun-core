import { PLAN_RE } from "../lib/markers";
import type { PaymentApprovalSnapshot } from "../lib/coreBridge";
import type { ChatEventPart } from "../types";
import { parseActivitySteps } from "./MessageActivity";
import type { ChoicePrompt } from "./MessageChoiceCard";
import type { PaymentApprovalProposal } from "./MessagePaymentApprovalCard";
import type { VaultProposal } from "./MessageVaultProposeCard";
import type { VaultRevealProposal } from "./MessageVaultRevealCard";

export interface PlanStep {
  status: "todo" | "doing" | "done" | "blocked";
  title: string;
  detail: string;
}

export function eventPayload(parts: ChatEventPart[] | undefined, type: ChatEventPart["type"]) {
  const part = parts?.find((item) => item.type === type);
  return part && "payload" in part ? part.payload : null;
}

export function latestPlanUpdateMarkdown(parts: ChatEventPart[] | undefined) {
  const plans = (parts ?? []).filter(
    (item): item is Extract<ChatEventPart, { type: "plan_update" }> =>
      item.type === "plan_update",
  );
  return plans.length > 0 ? plans[plans.length - 1].markdown : null;
}

export function parseVaultProposalPayload(payload: unknown): VaultProposal | null {
  const parsed = payload as Partial<VaultProposal> | null;
  if (
    parsed &&
    typeof parsed.category === "string" &&
    typeof parsed.label === "string" &&
    typeof parsed.redacted_preview === "string"
  ) {
    return {
      category: parsed.category,
      label: parsed.label,
      redacted_preview: parsed.redacted_preview,
      ...(typeof parsed.pending_id === "string" ? { pending_id: parsed.pending_id } : {}),
    };
  }
  return null;
}

export function parseVaultRevealPayload(payload: unknown): VaultRevealProposal | null {
  const parsed = payload as Partial<VaultRevealProposal> | null;
  if (
    parsed &&
    typeof parsed.record_id === "string" &&
    typeof parsed.category === "string" &&
    typeof parsed.label === "string" &&
    typeof parsed.redacted_preview === "string"
  ) {
    return {
      record_id: parsed.record_id,
      category: parsed.category,
      label: parsed.label,
      redacted_preview: parsed.redacted_preview,
    };
  }
  return null;
}

export function parsePaymentApprovalPayload(payload: unknown): PaymentApprovalProposal | null {
  const parsed = payload as { snapshot?: Partial<PaymentApprovalSnapshot> } | null;
  const snapshot = parsed?.snapshot;
  if (
    snapshot &&
    typeof snapshot.approval_id === "string" &&
    typeof snapshot.merchant === "string" &&
    typeof snapshot.domain === "string" &&
    typeof snapshot.amount_minor === "number" &&
    typeof snapshot.currency === "string" &&
    typeof snapshot.product_summary === "string" &&
    typeof snapshot.payment_method_label === "string" &&
    typeof snapshot.checkout_fingerprint === "string"
  ) {
    return { snapshot: snapshot as PaymentApprovalSnapshot };
  }
  return null;
}

export function parseChoicePromptPayload(payload: unknown): ChoicePrompt | null {
  const parsed = payload as Partial<ChoicePrompt> | null;
  if (!parsed || !Array.isArray(parsed.options) || parsed.options.length === 0) return null;
  return {
    question: typeof parsed.question === "string" ? parsed.question : "",
    multi: parsed.multi === true,
    options: parsed.options.filter((option) => typeof option === "string" && option.trim()),
    purpose: typeof parsed.purpose === "string" ? parsed.purpose : undefined,
  };
}

export function parsePlanSteps(markdown: string): PlanStep[] {
  const out: PlanStep[] = [];
  for (const raw of markdown.split("\n")) {
    const match = raw.match(/^-\s*\[(.)\]\s*\*\*(.+?)\*\*\s*(?:\(`[^`]*`\))?\s*:?\s*(.*)$/);
    if (!match) continue;
    const marker = match[1];
    const status: PlanStep["status"] =
      marker === "x" ? "done" : marker === "-" ? "doing" : marker === "!" ? "blocked" : "todo";
    out.push({ status, title: match[2].trim(), detail: match[3].trim() });
  }
  return out;
}

export function latestPlanMarkdown(
  messages: { text?: string; eventParts?: ChatEventPart[] }[],
): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    const structuredPlan = latestPlanUpdateMarkdown(message.eventParts);
    if (structuredPlan) {
      latest = structuredPlan;
      continue;
    }
    const text = message.text ?? "";
    if (!text.includes("‹‹PLAN››")) continue;
    for (const match of text.matchAll(PLAN_RE)) latest = match[1].trim();
  }
  return latest && latest.length > 0 ? latest : null;
}

export function latestActivitySteps(messages: { text?: string }[]): string[] {
  let latest: string[] = [];
  for (const message of messages) {
    const steps = parseActivitySteps(message.text ?? "");
    if (steps.length > 0) latest = steps;
  }
  return latest;
}
