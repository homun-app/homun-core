import { Fragment, useMemo } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { common, createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { diffLines } from "diff";
import "highlight.js/styles/github.css";

// highlight.js (via lowlight) → hAST → real React elements (no innerHTML).
const lowlight = createLowlight(common);

/** Source viewer with a line-number gutter + syntax highlighting — the Claude
 *  Code "read file" look. Word-wrap optional (gutter hidden when wrapping, since
 *  wrapped lines no longer map 1:1 to gutter numbers). */
export function CodeView({
  code,
  language,
  wrap = false,
}: {
  code: string;
  language?: string;
  wrap?: boolean;
}) {
  const highlighted = useMemo(() => {
    const plain = !language || ["text", "plaintext", "txt", "log"].includes(language);
    if (plain) return null;
    try {
      const tree = lowlight.registered(language)
        ? lowlight.highlight(language, code)
        : lowlight.highlightAuto(code);
      return toJsxRuntime(tree, { Fragment, jsx, jsxs });
    } catch {
      return null;
    }
  }, [code, language]);

  const lineCount = useMemo(
    () => Math.max(1, code.replace(/\n$/, "").split("\n").length),
    [code],
  );

  return (
    <div className={`code-view${wrap ? " wrap" : ""}`}>
      {!wrap && (
        <div className="code-view-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
      )}
      <pre className="code-view-body">
        <code className="hljs">{highlighted ?? code}</code>
      </pre>
    </div>
  );
}

/** Added/removed line counts between two texts (for the "+N -M" badge). */
export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.value.replace(/\n$/, "").split("\n").length;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}

/** Unified line diff (added=green, removed=red) — the Claude Code change view. */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => {
    const out: Array<{ type: "add" | "del" | "ctx"; text: string }> = [];
    for (const part of diffLines(oldText, newText)) {
      const type = part.added ? "add" : part.removed ? "del" : "ctx";
      for (const line of part.value.replace(/\n$/, "").split("\n")) {
        out.push({ type, text: line });
      }
    }
    return out;
  }, [oldText, newText]);

  return (
    <div className="diff-view">
      {rows.map((row, index) => (
        <div className={`diff-row ${row.type}`} key={index}>
          <span className="diff-sign">
            {row.type === "add" ? "+" : row.type === "del" ? "−" : " "}
          </span>
          <span className="diff-line">{row.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
