import { lazy, Suspense } from "react";

interface RichMessageProps {
  text: string;
  streaming?: boolean;
}

const RichMessageRenderer = lazy(() => import("./RichMessageRenderer"));

// Internal control markers the gateway uses to carry a pending write-confirmation
// action (or its executed state); rendered as a card/note elsewhere and never
// shown as raw text.
const CONTROL_MARKER_RE = /‹‹COMPOSIO_(?:CONFIRM|DONE)››[\s\S]*?‹‹\/COMPOSIO_(?:CONFIRM|DONE)››/g;

export function RichMessage({ text, streaming = false }: RichMessageProps) {
  const clean = text.includes("‹‹COMPOSIO_")
    ? text.replace(CONTROL_MARKER_RE, "").trimEnd()
    : text;

  if (streaming) {
    return <StreamingTextMessage text={clean} />;
  }

  if (!needsRichRendering(clean)) {
    return <PlainTextMessage text={clean} />;
  }

  return (
    <Suspense fallback={<PlainTextMessage text={clean} />}>
      <RichMessageRenderer text={clean} streaming={streaming} />
    </Suspense>
  );
}

function StreamingTextMessage({ text }: { text: string }) {
  return (
    <div className="rich-message streaming-rich-message" aria-live="polite">
      {text}
    </div>
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
