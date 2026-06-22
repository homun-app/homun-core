import { lazy, Suspense } from "react";

interface RichMessageProps {
  text: string;
  streaming?: boolean;
}

const RichMessageRenderer = lazy(() => import("./RichMessageRenderer"));

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

export function RichMessage({ text, streaming = false }: RichMessageProps) {
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
