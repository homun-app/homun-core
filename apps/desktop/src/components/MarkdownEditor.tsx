import { useRef, useState } from "react";
import { Bold, Code, Heading, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";

import { RichMessage } from "./RichMessage";

// A lightweight markdown editor: formatting toolbar + Scrivi/Anteprima toggle. The
// preview reuses the app's RichMessage renderer, so what you see here is exactly how
// the markdown renders everywhere else — no extra dependency, consistent output.
export function MarkdownEditor({
  value,
  onChange,
  rows = 18,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");

  const surround = (before: string, after = before) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);
    onChange(value.slice(0, start) + before + selected + after + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start + before.length;
      el.selectionEnd = end + before.length;
    });
  };

  const linePrefix = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    onChange(value.slice(0, lineStart) + prefix + value.slice(lineStart));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + prefix.length;
    });
  };

  return (
    <div className="md-editor">
      <div className="md-editor-toolbar">
        <button type="button" title="Grassetto" onClick={() => surround("**")}>
          <Bold size={14} />
        </button>
        <button type="button" title="Corsivo" onClick={() => surround("_")}>
          <Italic size={14} />
        </button>
        <button type="button" title="Titolo" onClick={() => linePrefix("## ")}>
          <Heading size={14} />
        </button>
        <button type="button" title="Elenco puntato" onClick={() => linePrefix("- ")}>
          <List size={14} />
        </button>
        <button type="button" title="Elenco numerato" onClick={() => linePrefix("1. ")}>
          <ListOrdered size={14} />
        </button>
        <button type="button" title="Citazione" onClick={() => linePrefix("> ")}>
          <Quote size={14} />
        </button>
        <button type="button" title="Codice" onClick={() => surround("`")}>
          <Code size={14} />
        </button>
        <button type="button" title="Link" onClick={() => surround("[", "](https://)")}>
          <Link2 size={14} />
        </button>
        <span className="md-editor-spacer" />
        <button
          type="button"
          className={tab === "write" ? "active" : ""}
          onClick={() => setTab("write")}
        >
          Scrivi
        </button>
        <button
          type="button"
          className={tab === "preview" ? "active" : ""}
          onClick={() => setTab("preview")}
        >
          Anteprima
        </button>
      </div>
      {tab === "write" ? (
        <textarea
          ref={ref}
          className="md-editor-textarea"
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <div className="md-editor-preview">
          <RichMessage text={value || "_(vuoto)_"} />
        </div>
      )}
    </div>
  );
}
