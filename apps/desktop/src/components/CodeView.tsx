import { Fragment, useMemo } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { common, createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
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
