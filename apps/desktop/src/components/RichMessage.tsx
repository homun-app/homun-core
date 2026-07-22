import { lazy, memo, Suspense } from "react";
import {
  CONTROL_MARKER_RE,
  ACTIVITY_MARKER_RE,
  ARTIFACT_MARKER_RE,
  PLAN_MARKER_RE,
  DIFF_MARKER_RE,
  ARTIFACT_NOTE_RE,
  BROKEN_IMAGE_RE,
  LEAKED_TOOLCALL_RE,
} from "../lib/markers";
import { visibleMessageText } from "../lib/chatVisibleContent";

interface RichMessageProps {
  text: string;
  streaming?: boolean;
}

const RichMessageRenderer = lazy(() => import("./RichMessageRenderer"));

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

export const RichMessage = memo(function RichMessage({ text, streaming = false }: RichMessageProps) {
  return renderAnswer(visibleMessageText(text), streaming);
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
