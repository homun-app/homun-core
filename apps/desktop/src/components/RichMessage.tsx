import { lazy, memo, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { ChatEventPart } from "../types";
import {
  REASONING_MARKER_RE,
  STRAY_REASONING_MARKER_RE,
  REASONING_OPEN,
  THINK_RE,
  THINK_OPEN_RE,
  CONTROL_MARKER_RE,
  ACTIVITY_MARKER_RE,
  ARTIFACT_MARKER_RE,
  PLAN_MARKER_RE,
  DIFF_MARKER_RE,
  ARTIFACT_NOTE_RE,
  BROKEN_IMAGE_RE,
  LEAKED_TOOLCALL_RE,
} from "../lib/markers";

interface RichMessageProps {
  text: string;
  streaming?: boolean;
  eventParts?: ChatEventPart[];
}

const RichMessageRenderer = lazy(() => import("./RichMessageRenderer"));

/// Split a message into its (collapsed) reasoning trace and the answer body. Handles BOTH
/// the ‹‹REASONING›› marker (final, from the gateway) and inline <think> (live, from the
/// model), including the STREAMING case where the block is still OPEN (no close yet):
/// everything after the open tag is the in-progress trace, kept out of the answer.
function extractReasoning(text: string): { reasoning: string; body: string } {
  if (!text.includes(REASONING_OPEN) && !THINK_OPEN_RE.test(text)) {
    return { reasoning: "", body: text };
  }
  const traces: string[] = [];
  let body = text;
  // Completed blocks (both forms).
  for (const match of body.matchAll(REASONING_MARKER_RE)) {
    const trace = match[1].trim();
    if (trace) traces.push(trace);
  }
  body = body.replace(REASONING_MARKER_RE, "");
  // Streaming/provider leakage can leave empty or malformed fragments such as
  // `‹/REASONING››` after the valid block pass. They are display control tokens,
  // never answer content.
  body = body.replace(STRAY_REASONING_MARKER_RE, "");
  for (const match of body.matchAll(THINK_RE)) {
    const trace = match[1].trim();
    if (trace) traces.push(trace);
  }
  body = body.replace(THINK_RE, "");
  // Streaming: an OPEN block without its close yet → everything after it is in-progress.
  const openMarker = body.indexOf(REASONING_OPEN);
  if (openMarker !== -1) {
    const tail = body.slice(openMarker + REASONING_OPEN.length).trim();
    if (tail) traces.push(tail);
    body = body.slice(0, openMarker);
  }
  const openThink = body.match(THINK_OPEN_RE);
  if (openThink && openThink.index !== undefined) {
    const tail = body.slice(openThink.index + openThink[0].length).trim();
    if (tail) traces.push(tail);
    body = body.slice(0, openThink.index);
  }
  return { reasoning: traces.join("\n\n").trim(), body: body.trim() };
}

function ReasoningBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <details className="reasoning-block">
      <summary className="reasoning-summary">
        <span className="reasoning-dot" aria-hidden="true">
          💭
        </span>
        {t("chat.reasoning", { defaultValue: "Reasoning" })}
      </summary>
      <div className="reasoning-trace">{text}</div>
    </details>
  );
}

function renderAnswer(text: string, streaming: boolean) {
  const withoutMarkers =
    text.includes("‹‹COMPOSIO_") ||
    text.includes("‹‹ACT››") ||
    text.includes("‹‹ARTIFACT››") ||
    text.includes("‹‹PLAN››") ||
    text.includes("‹‹DIFF››")
      ? text
          .replace(CONTROL_MARKER_RE, "")
          .replace(ACTIVITY_MARKER_RE, "")
          .replace(ARTIFACT_MARKER_RE, "")
          .replace(PLAN_MARKER_RE, "")
          .replace(DIFF_MARKER_RE, "")
          .replace(ARTIFACT_NOTE_RE, "")
          .trim()
      : text;
  let clean = withoutMarkers.includes("![")
    ? withoutMarkers.replace(BROKEN_IMAGE_RE, "").trim()
    : withoutMarkers;
  if (clean.includes("<tool_call")) {
    clean = clean.replace(LEAKED_TOOLCALL_RE, "").trim();
  }
  // Render markdown LIVE while streaming (like Claude Code): the renderer is
  // streaming-aware (tolerates an unclosed code fence, defers mermaid until complete),
  // so we no longer fall back to plain text until the end.
  if (!needsRichRendering(clean)) {
    return <PlainTextMessage text={clean} />;
  }
  return (
    <Suspense fallback={<PlainTextMessage text={clean} />}>
      <RichMessageRenderer text={clean} streaming={streaming} />
    </Suspense>
  );
}

export const RichMessage = memo(function RichMessage({ text, streaming = false, eventParts }: RichMessageProps) {
  // Structured path (primary): when eventParts carries a `reasoning` part, use its text
  // directly instead of regex-extracting it from `text`. The body is still stripped of
  // marker wrappers via the regex fallback path below. When eventParts is absent, behavior
  // is identical to before (regex-only extraction).
  const structuredReasoning = eventParts?.find((p) => p.type === "reasoning")?.text;
  const { reasoning: regexReasoning, body } = extractReasoning(text);
  const reasoning = structuredReasoning ?? regexReasoning;
  const answer = renderAnswer(body, streaming);
  if (!reasoning) return answer;
  return (
    <>
      <ReasoningBlock text={reasoning} />
      {answer}
    </>
  );
});

function PlainTextMessage({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/);

  return (
    <div className="rich-message plain-rich-message">
      {paragraphs.map((paragraph, index) => {
        const lines = paragraph.split("\n");
        return (
        <p key={`${index}-${paragraph.slice(0, 18)}`}>
          {lines.map((line, lineIndex) => (
            <span key={`${lineIndex}-${line.slice(0, 18)}`}>
              {line}
              {lineIndex < lines.length - 1 && <br />}
            </span>
          ))}
        </p>
        );
      })}
    </div>
  );
}

function needsRichRendering(text: string) {
  return (
    /```/.test(text) ||
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(text) ||
    /(^|\n)\s*[-*+]\s+\S/.test(text) ||
    /(^|\n)\s*\d+\.\s+\S/.test(text) ||
    /(^|\n)\s*>\s+\S/.test(text) ||
    /\|.+\|/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /(^|\n)\s*fn\s+[a-zA-Z_]\w*\s*\([^)]*\)\s*\{?/.test(text) ||
    /(^|\n)\s*use\s+[\w:]+/.test(text) ||
    /(^|\n)\s*let\s+(mut\s+)?[a-zA-Z_]\w*/.test(text) ||
    /(^|\n)\s*println!\s*\(/.test(text)
  );
}
