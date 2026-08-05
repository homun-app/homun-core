import {
  AlertCircle,
  Braces,
  ChevronRight,
  Download,
  FileCode,
  FileCog,
  FileImage,
  FileSpreadsheet,
  FileText,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";
import { ARTIFACT_RE } from "../lib/markers";
import { CodeView, DiffView, diffStats } from "./CodeView";
import { RichMessage } from "./RichMessage";

// Generated-file artifacts surfaced by the gateway (skill outputs in $OUTPUT_DIR).

export interface ParsedArtifact {
  name: string;
  thread: string;
  size: number;
  /** True when this emission overwrote an existing file (a new version). */
  updated?: boolean;
  /** Managed artifacts live in Homun's artifact folder; project artifacts live in the project root. */
  source?: "managed" | "project";
  managed_path?: string;
  projectPath?: string;
  projectRelativePath?: string;
}

export function parseArtifacts(text: string): ParsedArtifact[] {
  if (!text.includes("‹‹ARTIFACT››")) return [];
  const seen = new Set<string>();
  const out: ParsedArtifact[] = [];
  for (const match of text.matchAll(ARTIFACT_RE)) {
    try {
      const parsed = JSON.parse(match[1]) as ParsedArtifact;
      if (parsed?.name && !seen.has(parsed.name)) {
        seen.add(parsed.name);
        out.push(parsed);
      }
    } catch {
      /* malformed marker → skip */
    }
  }
  return out;
}

/** File-type icon (colored) by extension — like Claude Code's file list. */
function artifactTypeIcon(name: string) {
  const ext = artifactExt(name);
  if (["json"].includes(ext)) return <Braces size={16} color="#d19a00" />;
  if (["yml", "yaml"].includes(ext)) return <FileCode size={16} color="#e5484d" />;
  if (["toml", "ini", "conf", "cfg", "env"].includes(ext)) return <FileCog size={16} color="#2f7ed8" />;
  if (["csv", "xlsx", "xls", "tsv"].includes(ext)) return <FileSpreadsheet size={16} color="#1a9b53" />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext))
    return <FileImage size={16} color="#7c5cff" />;
  if (["md", "markdown", "txt", "log"].includes(ext)) return <FileText size={16} color="#6b7280" />;
  if (ARTIFACT_CODE_EXT.has(ext)) return <FileCode size={16} color="#2f7ed8" />;
  return <FileText size={16} color="#6b7280" />;
}

export async function openArtifactFolder(artifact: ParsedArtifact) {
  try {
    if (artifact.source === "project" && artifact.projectPath) {
      await coreBridge.revealPath(artifact.projectPath);
      return;
    }
    const path = await coreBridge.artifactFolder(artifact.thread);
    await coreBridge.revealPath(path);
  } catch {
    /* reveal unavailable → ignore */
  }
}

/** Cards for files generated/authored in the conversation. The NAME opens the
 *  right-side workspace panel; the chevron expands an inline scrollable preview
 *  (Claude Code's two-affordance pattern). */
export function MessageArtifacts({
  text,
  onOpen,
}: {
  text: string;
  onOpen: (artifact: ParsedArtifact) => void;
}) {
  const { t } = useTranslation();
  const artifacts = useMemo(() => parseArtifacts(text), [text]);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (artifacts.length === 0) return null;

  return (
    <details className="chat-operational-row msg-artifacts">
      <summary>
        <FileText size={14} aria-hidden="true" />
        <span>{t("chat.generatedFiles")}</span>
        <small>{artifacts.length}</small>
      </summary>
      <div className="chat-operational-content" aria-label={t("chat.generatedFiles")}>
        {artifacts.map((artifact) => (
          <ArtifactCardRow
            key={artifact.name}
            artifact={artifact}
            expanded={expanded === artifact.name}
            onToggle={() =>
              setExpanded((current) => (current === artifact.name ? null : artifact.name))
            }
            onOpen={() => onOpen(artifact)}
          />
        ))}
      </div>
    </details>
  );
}

/** One artifact card row. For an updated file it loads the "+N −M" diff counts
 *  and shows them on the row (Claude Code's "Modified file +N −M"). */
function ArtifactCardRow({
  artifact,
  expanded,
  onToggle,
  onOpen,
}: {
  artifact: ParsedArtifact;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<{ added: number; removed: number } | null>(null);
  // Images render their preview inline by default — a generated picture should be
  // visible in the chat without the user having to expand the chip.
  const isImage = ARTIFACT_IMAGE_EXT.includes(artifactExt(artifact.name));
  const locationHint =
    artifact.projectPath ??
    artifact.projectRelativePath ??
    artifact.managed_path ??
    null;

  useEffect(() => {
    if (!artifact.updated || artifact.source === "project") return;
    let cancelled = false;
    void (async () => {
      try {
        const versions = await coreBridge.artifactVersions(artifact.thread, artifact.name);
        if (versions <= 0 || cancelled) return;
        const newBlob = await coreBridge.downloadArtifact(artifact.thread, artifact.name);
        const oldBlob = await coreBridge.downloadArtifact(
          artifact.thread,
          artifact.name,
          versions - 1,
        );
        const [newText, oldText] = await Promise.all([newBlob.text(), oldBlob.text()]);
        if (!cancelled) setCounts(diffStats(oldText, newText));
      } catch {
        /* counts unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact]);

  return (
    <div className="artifact-row-wrap">
      <div className="artifact-row">
        <span className="artifact-type-icon" aria-hidden="true">
          {artifactTypeIcon(artifact.name)}
        </span>
        <button type="button" className="artifact-name" onClick={onOpen} title={t("chat.openInPanel")}>
          <span className="artifact-fname">{artifact.name}</span>
          {artifact.updated && <span className="artifact-updated">{t("chat.modified")}</span>}
          {counts && (
            <span className="diff-counts">
              <span className="add">+{counts.added}</span>{" "}
              <span className="del">−{counts.removed}</span>
            </span>
          )}
        </button>
        <button
          type="button"
          className="artifact-quick"
          onClick={() => void triggerArtifactDownload(artifact)}
          aria-label={t("chat.action.download")}
          title={t("chat.action.download")}
        >
          <Download size={14} />
        </button>
        {!isImage && (
          <button
            type="button"
            className="artifact-expand"
            aria-label={expanded ? t("chat.collapsePreview") : t("chat.expandPreview")}
            onClick={onToggle}
          >
            <ChevronRight
              size={15}
              className={expanded ? "artifact-chevron open" : "artifact-chevron"}
            />
          </button>
        )}
      </div>
      {locationHint && (
        <div className="artifact-path-hint" title={locationHint}>
          {locationHint}
        </div>
      )}
      {(expanded || isImage) && <InlineArtifactPreview artifact={artifact} />}
    </div>
  );
}

/** The Artefatti panel, rendered IDENTICALLY to the chat: the same artifact cards
 *  (icon · name · Modified · +N −M diff · download · expand → inline preview), just
 *  as a LIST of all the conversation's artifacts. */
export function ArtifactsList({
  artifacts,
  initialName,
}: {
  artifacts: ParsedArtifact[];
  initialName?: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(
    initialName ?? artifacts[0]?.name ?? null,
  );
  return (
    <div className="workbench-files">
      <div className="msg-artifacts workbench-artifacts-list">
        {artifacts.map((artifact) => (
          <ArtifactCardRow
            key={artifact.name}
            artifact={artifact}
            expanded={expanded === artifact.name}
            onToggle={() =>
              setExpanded((current) => (current === artifact.name ? null : artifact.name))
            }
            onOpen={() => setExpanded(artifact.name)}
          />
        ))}
      </div>
    </div>
  );
}

const ARTIFACT_CODE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "rb", "php", "c", "cpp", "h",
  "cs", "json", "yaml", "yml", "toml", "sh", "bash", "sql", "html", "css", "scss", "xml",
]);
export const ARTIFACT_IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

export function artifactExt(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function isMissingFsError(message?: string) {
  return Boolean(message && /not found|no such file|cannot find|enoent|os error 2/i.test(message));
}

export async function triggerArtifactDownload(artifact: ParsedArtifact, version?: number) {
  try {
    const blob =
      artifact.source === "project"
        ? await projectArtifactBlob(artifact)
        : await coreBridge.downloadArtifact(artifact.thread, artifact.name, version);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch {
    /* ignore */
  }
}

async function projectArtifactBlob(artifact: ParsedArtifact): Promise<Blob> {
  const path = artifact.projectPath || artifact.projectRelativePath || artifact.name;
  const payload = await coreBridge.fsFile(path, artifact.thread);
  if (!payload.authorized || payload.binary || payload.error) {
    throw new Error(payload.error ?? "project artifact unavailable");
  }
  return new Blob([payload.text], { type: "text/plain;charset=utf-8" });
}

export type ArtifactPreview =
  | { kind: "image"; url: string; ext: string }
  | { kind: "html"; url: string; ext: string }
  | { kind: "pdf-images"; pages: string[]; ext: string }
  | { kind: "markdown" | "code" | "csv" | "text"; text: string; ext: string }
  | { kind: "binary" | "missing" | "denied" | "error"; ext: string };

/** Fetches an artifact and builds a renderable preview by type. Image/HTML
 *  previews create an object URL the caller must revoke (preview.url). */
export async function buildArtifactPreview(
  artifact: ParsedArtifact,
  version?: number,
): Promise<ArtifactPreview> {
  const ext = artifactExt(artifact.name);
  if (artifact.source === "project") {
    const path = artifact.projectPath || artifact.projectRelativePath || artifact.name;
    const payload = await coreBridge.fsFile(path, artifact.thread);
    if (!payload.authorized) return { kind: "denied", ext };
    if (payload.error) {
      return { kind: isMissingFsError(payload.error) ? "missing" : "error", ext };
    }
    if (payload.binary) return { kind: "binary", ext };
    if (ext === "md" || ext === "markdown") return { kind: "markdown", text: payload.text, ext };
    if (ext === "csv") return { kind: "csv", text: payload.text, ext };
    if (ARTIFACT_CODE_EXT.has(ext)) return { kind: "code", text: payload.text, ext };
    if (ext === "txt" || ext === "log" || ext === "") return { kind: "text", text: payload.text, ext };
    return { kind: "text", text: payload.text, ext };
  }
  if (ext === "pdf") {
    // Render through the gateway's packaged PDFium runtime. Chromium's native
    // PDF viewer cannot reliably authorize renderer-created blob URLs in an
    // iframe and reports a misleading permission error.
    try {
      const pages = await coreBridge.artifactPdfPages(artifact.thread, artifact.name, version);
      if (pages.length > 0) return { kind: "pdf-images", pages, ext };
    } catch {
      return { kind: "error", ext };
    }
    return { kind: "error", ext };
  }
  const blob = await coreBridge.downloadArtifact(artifact.thread, artifact.name, version);
  if (ARTIFACT_IMAGE_EXT.includes(ext)) return { kind: "image", url: URL.createObjectURL(blob), ext };
  if (ext === "html" || ext === "htm") {
    // Render the deck/page inline (self-contained HTML — decks inline their images).
    // Re-blob as text/html so the iframe renders rather than downloads.
    const html = await blob.text();
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    return { kind: "html", url, ext };
  }
  if (ext === "md" || ext === "markdown") return { kind: "markdown", text: await blob.text(), ext };
  if (ext === "csv") return { kind: "csv", text: await blob.text(), ext };
  if (ARTIFACT_CODE_EXT.has(ext)) return { kind: "code", text: await blob.text(), ext };
  if (ext === "txt" || ext === "log" || ext === "") return { kind: "text", text: await blob.text(), ext };
  return { kind: "binary", ext };
}

/** Inline, scrollable preview of an artifact under its card. For an UPDATED file
 *  it defaults to the DIFF vs the previous version (with a File/Diff toggle), so
 *  a modification shows the change right in the chat. */
function InlineArtifactPreview({ artifact }: { artifact: ParsedArtifact }) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [diff, setDiff] = useState<{ oldText: string; newText: string } | null>(null);
  const [mode, setMode] = useState<"diff" | "file">(artifact.updated ? "diff" : "file");
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let count = 0;
      if (artifact.source !== "project") {
        try {
          count = await coreBridge.artifactVersions(artifact.thread, artifact.name);
        } catch {
          /* no versions */
        }
      }
      try {
        const next = await buildArtifactPreview(artifact);
        if (cancelled) {
          if ("url" in next) URL.revokeObjectURL(next.url);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = "url" in next ? next.url : null;
        setPreview(next);
      } catch {
        if (!cancelled) setPreview({ kind: "error", ext: artifactExt(artifact.name) });
      }
      if (count > 0) {
        try {
          const newBlob = await coreBridge.downloadArtifact(artifact.thread, artifact.name);
          const oldBlob = await coreBridge.downloadArtifact(artifact.thread, artifact.name, count - 1);
          const [newText, oldText] = await Promise.all([newBlob.text(), oldBlob.text()]);
          if (!cancelled) setDiff({ oldText, newText });
        } catch {
          /* no diff */
        }
      } else if (!cancelled) {
        setDiff(null);
        setMode("file");
      }
    })();
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [artifact]);

  const counts = diff ? diffStats(diff.oldText, diff.newText) : null;
  const textLike =
    preview?.kind === "code" ||
    preview?.kind === "text" ||
    preview?.kind === "markdown" ||
    preview?.kind === "csv";

  return (
    <div className="artifact-inline-preview">
      {diff && textLike && (
        <div className="artifact-inline-toolbar">
          <button
            type="button"
            className={mode === "diff" ? "active" : ""}
            onClick={() => setMode("diff")}
          >
            Diff
            {counts && (
              <span className="diff-counts">
                <span className="add">+{counts.added}</span>{" "}
                <span className="del">−{counts.removed}</span>
              </span>
            )}
          </button>
          <button
            type="button"
            className={mode === "file" ? "active" : ""}
            onClick={() => setMode("file")}
          >
            File
          </button>
        </div>
      )}
      {diff && mode === "diff" && textLike ? (
        <DiffView oldText={diff.oldText} newText={diff.newText} />
      ) : preview ? (
        <ArtifactPreviewBody preview={preview} />
      ) : (
        <p className="artifacts-preview-note">Carico…</p>
      )}
    </div>
  );
}

export function ArtifactPreviewBody({
  preview,
  wrap = false,
  onRetry,
  onClose,
}: {
  preview: ArtifactPreview | null;
  wrap?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  if (!preview) return <p className="artifacts-preview-note">{t("chat.selectAFile")}</p>;
  switch (preview.kind) {
    case "image":
      return <img className="artifact-preview-img" src={preview.url} alt="" />;
    case "pdf-images":
      return (
        <div className="artifact-preview-pages">
          {preview.pages.map((src, index) => (
            <img
              key={index}
              className="artifact-preview-page"
              src={src}
              alt={t("chat.pageN", { n: index + 1 })}
            />
          ))}
        </div>
      );
    case "html":
      // Inline render of an HTML deck/page (e.g. an on-brand presentation). Sandboxed:
      // same-origin so a self-contained file (inlined CSS + data-URL images) displays,
      // scripts/forms/navigation stay blocked.
      return (
        <iframe
          className="artifact-preview-html"
          src={preview.url}
          sandbox="allow-same-origin"
          title="Preview"
        />
      );
    case "markdown":
      return (
        <div className="artifact-preview-doc">
          <RichMessage text={preview.text} />
        </div>
      );
    case "code":
      return <CodeView code={preview.text} language={preview.ext} wrap={wrap} />;
    case "text":
      return <CodeView code={preview.text} language="text" wrap={wrap} />;
    case "csv":
      return <ArtifactCsvTable text={preview.text} />;
    case "error":
      return (
        <InspectorFailureState
          message={t("chat.previewUnavailable")}
          onRetry={onRetry}
          onClose={onClose}
        />
      );
    case "missing":
      return (
        <InspectorFailureState
          message={t("chat.inspector.missing")}
          onRetry={onRetry}
          onClose={onClose}
        />
      );
    case "denied":
      return (
        <InspectorFailureState
          message={t("chat.inspector.denied")}
          onRetry={onRetry}
          onClose={onClose}
        />
      );
    default:
      return (
        <p className="artifacts-preview-note">
          {t("chat.previewUnavailableForType")}
        </p>
      );
  }
}

function InspectorFailureState({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="workbench-empty">
      <AlertCircle size={24} />
      <p>{message}</p>
      {(onRetry || onClose) && (
        <span className="workbench-empty-actions">
          {onRetry && <button type="button" onClick={onRetry}>{t("chat.inspector.retry")}</button>}
          {onClose && <button type="button" onClick={onClose}>{t("common.close")}</button>}
        </span>
      )}
    </div>
  );
}

function ArtifactCsvTable({ text }: { text: string }) {
  const { t } = useTranslation();
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 200)
    .map((line) => line.split(","));
  if (rows.length === 0) return <p className="artifacts-preview-note">{t("chat.emptyDot")}</p>;
  const [head, ...body] = rows;
  return (
    <div className="artifact-preview-table-wrap">
      <table className="artifact-preview-table">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
