import { Check, Copy } from "lucide-react";
import { Fragment, memo, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { jsx, jsxs } from "react/jsx-runtime";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { common, createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Components } from "react-markdown";
import type { Mermaid } from "mermaid";

import { copyText } from "../lib/clipboard";
import "highlight.js/styles/github.css";

// highlight.js (via lowlight) → hAST → real React elements (no innerHTML).
// `common` covers ~37 mainstream languages, enough for chat code blocks.
const lowlight = createLowlight(common);

interface RichMessageRendererProps {
  text: string;
  streaming?: boolean;
}

function createMarkdownComponents(streaming: boolean): Components {
  return {
    code({ children, className }) {
      const code = String(children).replace(/\n$/, "");
      const language = /language-([\w-]+)/.exec(className ?? "")?.[1];

      if (language === "mermaid") {
        return <MermaidBlock code={code} streaming={streaming} />;
      }

      if (!language && code.includes("\n")) {
        return <CodeBlock code={code} language="text" />;
      }

      if (!language) {
        return <code className="rich-inline-code">{children}</code>;
      }

      return <CodeBlock code={code} language={language} />;
    },
    a({ children, href }) {
      return (
        <a href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      );
    },
  };
}

let mermaidLoader: Promise<Mermaid> | null = null;

async function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((module) => {
      const instance = module.default;
      instance.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default",
      });
      return instance;
    });
  }

  return mermaidLoader;
}

function RichMessageRenderer({
  text,
  streaming = false,
}: RichMessageRendererProps) {
  const markdownComponents = useMemo(
    () => createMarkdownComponents(streaming),
    [streaming],
  );
  const normalizedText = useMemo(
    () => normalizeMarkdownForRichRendering(text),
    [text],
  );

  return (
    <div className="rich-message">
      <ReactMarkdown
        components={markdownComponents}
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
}

export default memo(RichMessageRenderer);

function normalizeMarkdownForRichRendering(text: string) {
  const lines = repairNestedMarkdownFences(text).split("\n");
  const normalized: string[] = [];
  let inFence = false;
  let pendingCode: string[] = [];

  function flushCode() {
    if (!pendingCode.length) return;
    normalized.push("```rust", ...pendingCode, "```");
    pendingCode = [];
  }

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      flushCode();
      const openingFence = !inFence;
      inFence = !inFence;
      normalized.push(
        openingFence && line.trim() === "```" ? "```text" : line,
      );
      continue;
    }

    if (
      !inFence &&
      (looksLikeStandaloneRustCode(line) ||
        (pendingCode.length > 0 && looksLikeRustCodeContinuetion(line)))
    ) {
      pendingCode.push(line.trim());
      continue;
    }

    flushCode();
    normalized.push(line);
  }

  flushCode();
  return normalized.join("\n");
}

function repairNestedMarkdownFences(text: string) {
  const output: string[] = [];
  let inFence = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const fence = /^```([A-Za-z0-9_-]+)?\s*$/.exec(trimmed);
    if (!fence) {
      output.push(line);
      continue;
    }

    const language = fence[1] ?? "";
    if (!inFence) {
      inFence = true;
      output.push(language ? `\`\`\`${language}` : "```text");
      continue;
    }

    if (language) {
      // A model can sometimes emit a second ```rust while already inside a Rust
      // block. Treat that as a duplicated opener instead of closing the block.
      continue;
    }

    inFence = false;
    output.push("```");
  }

  if (inFence) {
    output.push("```");
  }

  return output.join("\n");
}

function looksLikeStandaloneRustCode(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /^fn\s+[a-zA-Z_]\w*\s*\([^)]*\)\s*\{?/.test(trimmed) ||
    /^use\s+[\w:]+/.test(trimmed) ||
    /^let\s+(mut\s+)?[a-zA-Z_]\w*/.test(trimmed) ||
    /^println!\s*\(/.test(trimmed) ||
    /;\s*}$/.test(trimmed)
  );
}

function looksLikeRustCodeContinuetion(line: string) {
  const trimmed = line.trim();
  return (
    trimmed === "}" ||
    trimmed === "};" ||
    trimmed.startsWith("}") ||
    /^[a-zA-Z_]\w*\s*\([^)]*\);?$/.test(trimmed)
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    const ok = await copyText(code);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  }

  // Highlight to React elements (no innerHTML). Plain blocks ("text"/log/etc. —
  // e.g. command output) are rendered RAW: running `highlightAuto` on non-code
  // prose can yield an empty/near-empty tree (the "missing output" bug). Only
  // genuinely language-tagged code is highlighted (declared lang when registered,
  // else best-effort auto-detect). Any failure falls back to the raw `code`.
  const highlighted = useMemo(() => {
    const plain =
      !language || ["text", "txt", "plaintext", "log"].includes(language);
    if (plain) {
      return null;
    }
    try {
      const tree = lowlight.registered(language)
        ? lowlight.highlight(language, code)
        : lowlight.highlightAuto(code);
      return toJsxRuntime(tree, { Fragment, jsx, jsxs });
    } catch {
      return null;
    }
  }, [code, language]);

  return (
    <figure className="rich-code-block">
      <figcaption>
        <span>{language}</span>
        <button type="button" onClick={copyCode}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? t("common.copied") : t("common.copy")}</span>
        </button>
      </figcaption>
      <pre>
        <code className="hljs">{highlighted ?? code}</code>
      </pre>
    </figure>
  );
}

function MermaidBlock({
  code,
  streaming,
}: {
  code: string;
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (streaming) {
      setSvg(null);
      setError(null);
      return () => {
        cancelled = true;
      };
    }

    async function renderDiagram() {
      try {
        const mermaid = await loadMermaid();
        const result = await mermaid.render(`diagram-${id}`, code);
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (renderError) {
        if (!cancelled) {
          setSvg(null);
          setError(
            renderError instanceof Error
              ? renderError.message
              : "Diagramma Mermaid non valido.",
          );
        }
      }
    }

    if (code.trim()) {
      void renderDiagram();
    }

    return () => {
      cancelled = true;
    };
  }, [code, id, streaming]);

  if (streaming) {
    return (
      <figure className="rich-code-block rich-mermaid-pending">
        <figcaption>
          <span>mermaid</span>
          <small>{t("common.renderedAfterFullReply")}</small>
        </figcaption>
        <pre>
          <code>{code}</code>
        </pre>
      </figure>
    );
  }

  if (error) {
    return (
      <figure className="rich-code-block rich-mermaid-error">
        <figcaption>
          <span>mermaid</span>
          <small>non renderizzabile</small>
        </figcaption>
        <pre>
          <code>{code}</code>
        </pre>
      </figure>
    );
  }

  return (
    <figure className="rich-mermaid-block">
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </figure>
  );
}
