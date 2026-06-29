import { lazy, memo, Suspense } from "react";
import { useTranslation } from "react-i18next";

interface RichMessageProps {
  text: string;
  streaming?: boolean;
}

const RichMessageRenderer = lazy(() => import("./RichMessageRenderer"));

// The reasoning trace travels in a ‹‹REASONING››…‹‹/REASONING›› marker (gateway). It is
// rendered COLLAPSED ("Ragionamento", expandable) and kept OUT of the answer body — the
// model's thinking is never shown as the answer itself.
const REASONING_MARKER_RE = /‹‹REASONING››([\s\S]*?)‹‹\/REASONING››/g;
const REASONING_OPEN = "‹‹REASONING››";

/// Split a message into its (collapsed) reasoning trace and the answer body. Handles the
/// streaming case where the ‹‹REASONING›› block is still OPEN (no close yet): everything
/// after the open tag is the in-progress trace, kept out of the answer.
function extractReasoning(text: string): { reasoning: string; body: string } {
  if (!text.includes(REASONING_OPEN)) return { reasoning: "", body: text };
  const completed = [...text.matchAll(REASONING_MARKER_RE)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  let reasoning = completed.join("\n\n");
  let body = text.replace(REASONING_MARKER_RE, "");
  const openIdx = body.indexOf(REASONING_OPEN);
  if (openIdx !== -1) {
    const tail = body.slice(openIdx + REASONING_OPEN.length).trim();
    if (tail) reasoning = reasoning ? `${reasoning}\n\n${tail}` : tail;
    body = body.slice(0, openIdx);
  }
  return { reasoning: reasoning.trim(), body: body.trim() };
}

function ReasoningBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <details className="reasoning-block">
      <summary className="reasoning-summary">
        <span className="reasoning-dot" aria-hidden="true">
          💭
        </span>
        {t("chat.reasoning", { defaultValue: "Ragionamento" })}
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
    text.includes("‹‹PLAN››")
      ? text
          .replace(CONTROL_MARKER_RE, "")
          .replace(ACTIVITY_MARKER_RE, "")
          .replace(ARTIFACT_MARKER_RE, "")
          .replace(PLAN_MARKER_RE, "")
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

// Internal control markers the gateway uses to carry a pending write-confirmation
// action (or its executed state), and the tool-activity trace; both are rendered
// out-of-band (confirmation card / collapsible activity panel) and never shown as
// raw text inside the answer body.
const CONTROL_MARKER_RE =
  /‹‹COMPOSIO_(?:CONFIRM|DONE|RECONNECT)››[\s\S]*?‹‹\/COMPOSIO_(?:CONFIRM|DONE|RECONNECT)››/g;
const ACTIVITY_MARKER_RE = /‹‹ACT››[\s\S]*?‹‹\/ACT››/g;
const ARTIFACT_MARKER_RE = /‹‹ARTIFACT››[\s\S]*?‹‹\/ARTIFACT››/g;
// Operational plan markers: rendered out-of-band in the "Piano" workbench panel.
const PLAN_MARKER_RE = /‹‹PLAN››[\s\S]*?‹‹\/PLAN››/g;
// Plain "[file generato: …]" notes the gateway adds for the model are dropped too.
const ARTIFACT_NOTE_RE = /\n?\[file generato: [^\]]*\]/g;
// The model sometimes invents a markdown image link for a generated file
// (e.g. `![cover](cover.png)`) — a bare filename / non-embeddable src that resolves
// to nothing and renders as a broken-image icon. The real image is surfaced via the
// ‹‹ARTIFACT›› chip + inline preview, so drop any image whose src isn't a genuine
// embeddable URL (http/https/data/blob).
const BROKEN_IMAGE_RE = /!\[[^\]]*\]\(\s*(?!https?:\/\/|data:|blob:)[^)]*\)/g;
// Weak/local models sometimes EMIT a tool call as PROSE instead of a real call
// (e.g. `<tool_call name="run_in_sandbox">{…}</tool_call>`, often unclosed). The
// harness ignores it, but it must not render as text. Strip from `<tool_call` to the
// closing tag, or to end-of-message when the model left it dangling.
const LEAKED_TOOLCALL_RE = /<tool_call\b[\s\S]*?(?:<\/tool_call>|$)/gi;

export const RichMessage = memo(function RichMessage({ text, streaming = false }: RichMessageProps) {
  const { reasoning, body } = extractReasoning(text);
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
