/**
 * Marker regexes — the single source of truth for every `‹‹…››` structured marker
 * (REASONING, PLAN, ACT, CHOICES, VAULT_*, PAYMENT_APPROVAL, COMPOSIO_*, ARTIFACT, …)
 * plus the auxiliary cleanup regexes (broken images, leaked tool calls, …).
 *
 * These were previously duplicated verbatim across `components/RichMessage.tsx` and
 * `components/ChatView.tsx`. They are consolidated here WITHOUT altering any pattern,
 * flag, or capture group, so behavior stays byte-identical.
 *
 * NOTE: some names differ only in capture grouping between the two former call sites
 * (e.g. `ACTIVITY_MARKER_RE` is non-capturing, used to STRIP; `ACTIVITY_RE` captures,
 * used to PARSE). Both are kept as distinct exports — do not collapse them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning / think trace (RichMessage.tsx)
// ─────────────────────────────────────────────────────────────────────────────
// The reasoning trace travels in a ‹‹REASONING››…‹‹/REASONING›› marker (gateway). It is
// rendered COLLAPSED ("Ragionamento", expandable) and kept OUT of the answer body — the
// model's thinking is never shown as the answer itself.
export const REASONING_MARKER_RE = /‹‹REASONING››([\s\S]*?)‹‹\/REASONING››/g;
export const STRAY_REASONING_MARKER_RE = /‹{1,2}\/?REASONING››/g;
export const REASONING_OPEN = "‹‹REASONING››";
// Reasoning models (e.g. deepseek) emit their trace inline as <think>…</think> in the
// CONTENT, which streams live — so the trace must be collapsed DURING streaming, not only
// after the gateway rewrites it to a ‹‹REASONING›› marker at the end. Handle both forms.
export const THINK_RE = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
export const THINK_OPEN_RE = /<think(?:ing)?>/i;

// ─────────────────────────────────────────────────────────────────────────────
// Body cleanup regexes (RichMessage.tsx) — STRIP variants (non-capturing)
// ─────────────────────────────────────────────────────────────────────────────
// Internal control markers the gateway uses to carry a pending write-confirmation
// action (or its executed state), and the tool-activity trace; both are rendered
// out-of-band (confirmation card / collapsible activity panel) and never shown as
// raw text inside the answer body.
export const CONTROL_MARKER_RE =
  /‹‹COMPOSIO_(?:CONFIRM|DONE|RECONNECT)››[\s\S]*?‹‹\/COMPOSIO_(?:CONFIRM|DONE|RECONNECT)››/g;
export const ACTIVITY_MARKER_RE = /‹‹ACT››[\s\S]*?‹‹\/ACT››/g;
export const ARTIFACT_MARKER_RE = /‹‹ARTIFACT››[\s\S]*?‹‹\/ARTIFACT››/g;
// Operational plan markers: rendered out-of-band in the "Piano" workbench panel.
export const PLAN_MARKER_RE = /‹‹PLAN››[\s\S]*?‹‹\/PLAN››/g;
// Plain "[file generato: …]" notes the gateway adds for the model are dropped too.
export const ARTIFACT_NOTE_RE = /\n?\[file generato: [^\]]*\]/g;
// The model sometimes invents a markdown image link for a generated file
// (e.g. `![cover](cover.png)`) — a bare filename / non-embeddable src that resolves
// to nothing and renders as a broken-image icon. The real image is surfaced via the
// ‹‹ARTIFACT›› chip + inline preview, so drop any image whose src isn't a genuine
// embeddable URL (http/https/data/blob).
export const BROKEN_IMAGE_RE = /!\[[^\]]*\]\(\s*(?!https?:\/\/|data:|blob:)[^)]*\)/g;
// Weak/local models sometimes EMIT a tool call as PROSE instead of a real call
// (e.g. `<tool_call name="run_in_sandbox">{…}</tool_call>`, often unclosed). The
// harness ignores it, but it must not render as text. Strip from `<tool_call` to the
// closing tag, or to end-of-message when the model left it dangling.
export const LEAKED_TOOLCALL_RE = /<tool_call\b[\s\S]*?(?:<\/tool_call>|$)/gi;

// ─────────────────────────────────────────────────────────────────────────────
// Pending-action / proposal markers (ChatView.tsx) — PARSE variants (capturing)
// ─────────────────────────────────────────────────────────────────────────────
export const COMPOSIO_CONFIRM_RE = /‹‹COMPOSIO_CONFIRM››([\s\S]*?)‹‹\/COMPOSIO_CONFIRM››/;
export const MCP_CONFIRM_RE = /‹‹MCP_CONFIRM››([\s\S]*?)‹‹\/MCP_CONFIRM››/;
export const FS_AUTHORIZE_RE = /‹‹FS_AUTHORIZE››([\s\S]*?)‹‹\/FS_AUTHORIZE››/;
export const CONNECT_SUGGEST_RE = /‹‹CONNECT_SUGGEST››([\s\S]*?)‹‹\/CONNECT_SUGGEST››/;
export const COMPOSIO_DONE_RE = /‹‹COMPOSIO_DONE››([\s\S]*?)‹‹\/COMPOSIO_DONE››/;
export const COMPOSIO_RECONNECT_RE = /‹‹COMPOSIO_RECONNECT››([\s\S]*?)‹‹\/COMPOSIO_RECONNECT››/;
export const VAULT_PROPOSE_RE = /‹‹VAULT_PROPOSE››([\s\S]*?)‹‹\/VAULT_PROPOSE››/;
export const VAULT_REVEAL_RE = /‹‹VAULT_REVEAL››([\s\S]*?)‹‹\/VAULT_REVEAL››/;
export const PAYMENT_APPROVAL_RE = /‹‹PAYMENT_APPROVAL››([\s\S]*?)‹‹\/PAYMENT_APPROVAL››/;
// Single/multi-choice question card (Claude-Code style): the model emits the choices
// instead of listing them in prose, and the click sends the answer back.
export const CHOICES_RE = /‹‹CHOICES››([\s\S]*?)‹‹\/CHOICES››/;
// Plan-mode: the model proposes a plan and STOPS; the card gates execution behind
// Accetta / Edit (the answer becomes the next user message).
// Require a closed marker before rendering an actionable plan card. During streaming an
// incomplete marker is hidden from prose below, but it is not accepted as a proposal.
export const PLAN_PROPOSE_RE = /‹‹PLAN_PROPOSE››([\s\S]*?)‹‹\/PLAN_PROPOSE››/;
// Goal-propose: the model proposes the project's objective(s); the card lets the user save.
export const GOAL_PROPOSE_RE = /‹‹GOAL_PROPOSE››([\s\S]*?)‹‹\/GOAL_PROPOSE››/;
// Strips an UNCLOSED plan/goal marker (open present, no close) from the visible prose.
export const UNCLOSED_PROPOSE_RE = /‹‹(?:PLAN_PROPOSE|GOAL_PROPOSE)››[\s\S]*$/;
export const COMPOSIO_MARKERS_RE =
  /‹‹(?:COMPOSIO_(?:CONFIRM|DONE|RECONNECT)|MCP_CONFIRM|FS_AUTHORIZE|CONNECT_SUGGEST|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL|CHOICES|PLAN_PROPOSE|GOAL_PROPOSE|PLAN)››[\s\S]*?‹‹\/(?:COMPOSIO_(?:CONFIRM|DONE|RECONNECT)|MCP_CONFIRM|FS_AUTHORIZE|CONNECT_SUGGEST|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL|CHOICES|PLAN_PROPOSE|GOAL_PROPOSE|PLAN)››/g;
export const PROPOSE_MARKERS_VISIBLE_RE =
  /‹‹(?:PLAN_PROPOSE|GOAL_PROPOSE)››[\s\S]*?‹‹\/(?:PLAN_PROPOSE|GOAL_PROPOSE)››/g;

// ─────────────────────────────────────────────────────────────────────────────
// ChatView.tsx parse variants (capturing)
// ─────────────────────────────────────────────────────────────────────────────
// Tool-activity trace markers (browser / skill / sandbox / connected-tool steps).
// They are extracted into a compact collapsible panel so the answer body stays
// clean — the pattern Claude/assistant-ui use for "tool activity".
export const ACTIVITY_RE = /‹‹ACT››([\s\S]*?)‹‹\/ACT››/g;
// Generated-file artifacts surfaced by the gateway (skill outputs in $OUTPUT_DIR).
export const ARTIFACT_RE = /‹‹ARTIFACT››([\s\S]*?)‹‹\/ARTIFACT››/g;
// Operational plan emitted by the agent via the update_plan tool (‹‹PLAN›› markers).
// The latest one in the conversation drives the Workbench "Piano" panel.
export const PLAN_RE = /‹‹PLAN››([\s\S]*?)‹‹\/PLAN››/g;

// ─────────────────────────────────────────────────────────────────────────────
// Streaming delta guard (ChatView.tsx)
// ─────────────────────────────────────────────────────────────────────────────
export const STRUCTURED_MARKER_DELTA_RE =
  /^‹‹(?:ACT|REASONING|PLAN|CHOICES|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL)››[\s\S]*?‹‹\/(?:ACT|REASONING|PLAN|CHOICES|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL)››$/;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes ALL structured marker wrappers (`‹‹NAME››…‹‹/NAME››`, plus stray reasoning
 * fragments) from `text`, returning clean prose. This consolidates the piecemeal
 * stripping `renderAnswer` in `RichMessage.tsx` used to perform, so the same logic is
 * reusable from structured (eventParts) and regex paths alike.
 *
 * Note: this strips the wrapper and its inner payload entirely (markers carry their
 * content out-of-band, rendered as cards/panels), exactly as the original code did.
 */
export function stripAllMarkers(text: string): string {
  let clean = text;
  clean = clean.replace(CONTROL_MARKER_RE, "");
  clean = clean.replace(COMPOSIO_MARKERS_RE, "");
  clean = clean.replace(ACTIVITY_MARKER_RE, "");
  clean = clean.replace(ARTIFACT_MARKER_RE, "");
  clean = clean.replace(PLAN_MARKER_RE, "");
  clean = clean.replace(STRAY_REASONING_MARKER_RE, "");
  clean = clean.replace(ARTIFACT_NOTE_RE, "");
  return clean.trim();
}

/**
 * Returns true if `text` contains any `‹‹` structured marker — used to decide between
 * RichMessage (marker-aware) and plain-text rendering.
 */
export function containsStructuredMarker(text: string): boolean {
  return text.includes("‹‹");
}
