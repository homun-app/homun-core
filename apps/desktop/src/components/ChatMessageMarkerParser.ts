import type { ChatEventPart } from "../types";
import {
  AWAIT_USER_RE,
  CHOICES_RE,
  COMPOSIO_CONFIRM_RE,
  COMPOSIO_DONE_RE,
  COMPOSIO_MARKERS_RE,
  COMPOSIO_RECONNECT_RE,
  CONNECT_SUGGEST_RE,
  FS_AUTHORIZE_RE,
  GOAL_PROPOSE_RE,
  MCP_CONFIRM_RE,
  PAYMENT_APPROVAL_RE,
  PLAN_PROPOSE_RE,
  PLAN_RE,
  PROPOSE_MARKERS_VISIBLE_RE,
  SANDBOX_ESCALATE_RE,
  SANDBOX_READONLY_RE,
  UNCLOSED_PROPOSE_RE,
  VAULT_PROPOSE_RE,
  VAULT_REVEAL_RE,
} from "../lib/markers";
import {
  eventPayload,
  latestPlanUpdateMarkdown,
  parseChoicePromptPayload,
  parsePaymentApprovalPayload,
  parsePlanSteps,
  parseVaultProposalPayload,
  parseVaultRevealPayload,
  type PlanStep,
} from "./ChatPayloadParsers";
import type { ChoicePrompt } from "./MessageChoiceCard";
import type { ComposioPendingAction } from "./MessageComposioConfirmCard";
import type { ConnectSuggest } from "./MessageConnectSuggestCard";
import type { PaymentApprovalProposal } from "./MessagePaymentApprovalCard";
import type { PlanProposal } from "./MessagePlanProposeCard";
import type { VaultProposal } from "./MessageVaultProposeCard";
import type { VaultRevealProposal } from "./MessageVaultRevealCard";

export interface ParsedAssistantMarkers {
  visible: string;
  action: ComposioPendingAction | null;
  doneTool: string | null;
  reconnectSlug: string | null;
  fsAuthorize: { path: string; op: string } | null;
  sandboxEscalate: { command: string; cwd: string } | null;
  readOnlyBlocked: { target: string } | null;
  connectSuggest: ConnectSuggest | null;
  vaultPropose: VaultProposal | null;
  vaultReveal: VaultRevealProposal | null;
  paymentApproval: PaymentApprovalProposal | null;
  choices: ChoicePrompt | null;
  planPropose: PlanProposal | null;
  goalPropose: string[] | null;
  planSteps: PlanStep[];
}

export function parseComposioConfirm(
  text: string,
  eventParts?: ChatEventPart[],
): ParsedAssistantMarkers {
  // Some models (GLM/Zhipu) leak their NATIVE tool-call delimiter tokens as text - they
  // use a fullwidth bar (U+FF5C), e.g. `<｜tool▁calls▁begin｜>` or `</｜DSML｜tool_calls>`.
  // Strip them before anything else so they never render and don't break marker matching
  // (a leaked end-token replaces a marker's proper close -> the marker would leak whole).
  text = text.replace(/<\/?[^<>]*｜[^<>]*>/g, "");
  let action: ComposioPendingAction | null = null;
  const confirm = text.match(COMPOSIO_CONFIRM_RE);
  if (confirm) {
    try {
      const parsed = JSON.parse(confirm[1]) as ComposioPendingAction;
      if (parsed && typeof parsed.tool === "string") action = { ...parsed, kind: "composio" };
    } catch {
      /* malformed -> just hide it */
    }
  }
  // MCP server tools use a dedicated marker -> routed to /mcp/execute, not Composio.
  const mcpConfirm = text.match(MCP_CONFIRM_RE);
  if (!action && mcpConfirm) {
    try {
      const parsed = JSON.parse(mcpConfirm[1]) as ComposioPendingAction;
      if (parsed && typeof parsed.tool === "string") action = { ...parsed, kind: "mcp" };
    } catch {
      /* malformed -> just hide it */
    }
  }
  // Native filesystem: in-chat "authorize this folder" card (no Settings trip).
  let fsAuthorize: { path: string; op: string } | null = null;
  const fsMatch = text.match(FS_AUTHORIZE_RE);
  if (fsMatch) {
    try {
      const parsed = JSON.parse(fsMatch[1]) as { path?: string; op?: string };
      if (parsed && typeof parsed.path === "string") {
        fsAuthorize = { path: parsed.path, op: parsed.op === "read" ? "read" : "list" };
      }
    } catch {
      /* malformed -> just hide it */
    }
  }
  // ADR 0023: shell command blocked by the Seatbelt sandbox -> in-chat "run without
  // sandbox" card. Payload is a tool call: {arguments:{command,cwd}}.
  let sandboxEscalate: { command: string; cwd: string } | null = null;
  const escMatch = text.match(SANDBOX_ESCALATE_RE);
  if (escMatch) {
    try {
      const parsed = JSON.parse(escMatch[1]) as {
        arguments?: { command?: string; cwd?: string };
      };
      const command = parsed?.arguments?.command;
      if (typeof command === "string") {
        sandboxEscalate = { command, cwd: parsed.arguments?.cwd ?? "" };
      }
    } catch {
      /* malformed -> just hide it */
    }
  }
  // ADR 0023: a file write blocked by read-only sandbox mode -> informational read-only card.
  // Parsed from the PERSISTED assistant text (mirrors sandboxEscalate above). It used to ride
  // a `tool_result` event that was never persisted into `event_parts_json`, so the card
  // vanished on commit/reload; the gateway now appends a `‹‹SANDBOX_READONLY››{"target":...}`
  // marker to the message text (stripped from visible prose by COMPOSIO_MARKERS_RE).
  let readOnlyBlocked: { target: string } | null = null;
  const roMatch = text.match(SANDBOX_READONLY_RE);
  if (roMatch) {
    try {
      const p = JSON.parse(roMatch[1]) as { target?: string };
      readOnlyBlocked = { target: typeof p.target === "string" ? p.target : "" };
    } catch {
      /* malformed -> hide */
    }
  }
  // Clickable connect-cards from suggest_capabilities (install skill / connect MCP
  // / link Composio in-chat, no Settings trip).
  let connectSuggest: ConnectSuggest | null = null;
  const csMatch = text.match(CONNECT_SUGGEST_RE);
  if (csMatch) {
    try {
      const parsed = JSON.parse(csMatch[1]) as ConnectSuggest;
      if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
        connectSuggest = parsed;
      }
    } catch {
      /* malformed -> just hide it */
    }
  }
  let vaultPropose: VaultProposal | null = parseVaultProposalPayload(
    eventPayload(eventParts, "vault_propose"),
  );
  const vaultMatch = text.match(VAULT_PROPOSE_RE);
  if (!vaultPropose && vaultMatch) {
    try {
      vaultPropose = parseVaultProposalPayload(JSON.parse(vaultMatch[1]));
    } catch {
      /* malformed -> just hide it */
    }
  }
  let vaultReveal: VaultRevealProposal | null = parseVaultRevealPayload(
    eventPayload(eventParts, "vault_reveal"),
  );
  const vaultRevealMatch = text.match(VAULT_REVEAL_RE);
  if (!vaultReveal && vaultRevealMatch) {
    try {
      vaultReveal = parseVaultRevealPayload(JSON.parse(vaultRevealMatch[1]));
    } catch {
      /* malformed -> just hide it */
    }
  }
  let paymentApproval: PaymentApprovalProposal | null = parsePaymentApprovalPayload(
    eventPayload(eventParts, "payment_approval"),
  );
  const paymentMatch = text.match(PAYMENT_APPROVAL_RE);
  if (!paymentApproval && paymentMatch) {
    try {
      paymentApproval = parsePaymentApprovalPayload(JSON.parse(paymentMatch[1]));
    } catch {
      /* malformed -> just hide it */
    }
  }
  // Single/multi-choice question card.
  let choices: ChoicePrompt | null = parseChoicePromptPayload(
    eventPayload(eventParts, "choice_prompt"),
  );
  const chMatch = text.match(CHOICES_RE);
  if (!choices && chMatch) {
    try {
      choices = parseChoicePromptPayload(JSON.parse(chMatch[1]));
    } catch {
      /* malformed -> just hide it */
    }
  }
  if (!choices) {
    const awaitMatch = text.match(AWAIT_USER_RE);
    if (awaitMatch) {
      try {
        const parsed = JSON.parse(awaitMatch[1]) as Record<string, unknown>;
        if (parsed.kind === "choice") {
          const { kind: _k, ...rest } = parsed;
          choices = parseChoicePromptPayload(rest);
        }
      } catch {
        /* malformed -> just hide it */
      }
    }
  }
  // Plan proposal (plan-mode): steps + Accetta/Edit gate.
  let planPropose: PlanProposal | null = null;
  const ppMatch = text.match(PLAN_PROPOSE_RE);
  if (ppMatch) {
    try {
      const parsed = JSON.parse(ppMatch[1]) as { summary?: unknown; steps?: unknown };
      // Tolerant parsing (caposaldo): the model may emit steps as plain strings OR as
      // richer objects ({title, detail, ...}) - e.g. gemma proposes object-steps. Accept
      // both, extracting a label from objects, instead of dropping them (which left the
      // card empty -> "the plan doesn't activate").
      const rawSteps: unknown[] = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const steps = rawSteps
        .map((s) => {
          if (typeof s === "string") return s;
          if (s && typeof s === "object") {
            const o = s as Record<string, unknown>;
            const label = o.title ?? o.step ?? o.name ?? o.detail ?? o.summary ?? "";
            return typeof label === "string" ? label : "";
          }
          return "";
        })
        .filter((s) => s.trim().length > 0);
      if (steps.length > 0) {
        planPropose = {
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          steps,
        };
      }
    } catch {
      /* malformed -> just hide it */
    }
  }
  // Goal proposal (projects): forward-looking objectives the model proposed -> card to save.
  let goalPropose: string[] | null = null;
  const gpoMatch = text.match(GOAL_PROPOSE_RE);
  if (gpoMatch) {
    try {
      const parsed = JSON.parse(gpoMatch[1]) as { objectives?: unknown };
      const objectives = Array.isArray(parsed?.objectives)
        ? parsed.objectives.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
        : [];
      if (objectives.length > 0) goalPropose = objectives;
    } catch {
      /* malformed -> just hide it */
    }
  }
  // Live operational plan (update_plan): take the LATEST ‹‹PLAN›› in the message and
  // render it inline with per-step status. PLAN_RE is global -> matchAll gives all.
  let planSteps: PlanStep[] = [];
  const structuredPlan = latestPlanUpdateMarkdown(eventParts);
  if (structuredPlan) {
    planSteps = parsePlanSteps(structuredPlan);
  } else {
    const planMatches = [...text.matchAll(PLAN_RE)];
    if (planMatches.length > 0) {
      planSteps = parsePlanSteps(planMatches[planMatches.length - 1][1]);
    }
  }
  const done = text.match(COMPOSIO_DONE_RE);
  const doneTool = done ? done[1].trim() : null;
  const reconnectMatch = text.match(COMPOSIO_RECONNECT_RE);
  const reconnectSlug = reconnectMatch ? reconnectMatch[1].trim() : null;
  const visible = text
    .replace(COMPOSIO_MARKERS_RE, "")
    // Proposal markers are parsed into cards above. Strip them from prose even when a
    // provider leaves a malformed/unterminated close after an error path.
    .replace(PROPOSE_MARKERS_VISIBLE_RE, "")
    // Also drop an UNCLOSED plan/goal marker (model didn't emit its proper close): its
    // JSON payload is for a card, never prose.
    .replace(UNCLOSED_PROPOSE_RE, "")
    .trim();
  // A persisted "done" marker wins: never reopen the editable card.
  return {
    visible,
    action: doneTool ? null : action,
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
    planSteps,
  };
}
