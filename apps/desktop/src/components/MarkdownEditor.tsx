import { useRef, useState } from "react";
import { Bold, Code, Heading, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RichMessage } from "./RichMessage";

// A lightweight markdown editor: formatting toolbar + Scrivi/Preview toggle. The
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
  const { t } = useTranslation();
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
        <button type="button" title={t("mdEditor.bold")} onClick={() => surround("**")}>
          <Bold size={14} />
        </button>
        <button type="button" title={t("mdEditor.italic")} onClick={() => surround("_")}>
          <Italic size={14} />
        </button>
        <button type="button" title={t("mdEditor.heading")} onClick={() => linePrefix("## ")}>
          <Heading size={14} />
        </button>
        <button type="button" title={t("mdEditor.bulletList")} onClick={() => linePrefix("- ")}>
          <List size={14} />
        </button>
        <button type="button" title={t("mdEditor.numberedList")} onClick={() => linePrefix("1. ")}>
          <ListOrdered size={14} />
        </button>
        <button type="button" title={t("mdEditor.quote")} onClick={() => linePrefix("> ")}>
          <Quote size={14} />
        </button>
        <button type="button" title={t("mdEditor.code")} onClick={() => surround("`")}>
          <Code size={14} />
        </button>
        <button type="button" title={t("mdEditor.link")} onClick={() => surround("[", "](https://)")}>
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
          Preview
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
