import {
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";
import { DiffView, diffStats } from "./CodeView";
import {
  ArtifactPreviewBody,
  buildArtifactPreview,
  openArtifactFolder,
  triggerArtifactDownload,
  artifactExt,
  type ArtifactPreview,
  type ParsedArtifact,
} from "./MessageArtifacts";

export function ArtifactsPanel({
  artifacts,
  initialName,
  onClose,
  embedded = false,
}: {
  artifacts: ParsedArtifact[];
  initialName?: string | null;
  onClose: () => void;
  /** Rendered inside the Workbench tab: drop the standalone panel chrome. */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const selectedName = initialName ?? artifacts[0]?.name ?? null;
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState(0);
  const [slot, setSlot] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [diffData, setDiffData] = useState<{ oldText: string; newText: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);
  const artifactActionsRef = useRef<HTMLDetailsElement>(null);

  const selected = artifacts.find((a) => a.name === selectedName) ?? artifacts[0] ?? null;
  const selectedResourceRevision = selected
    ? [
        selected.thread,
        selected.name,
        selected.source ?? "",
        selected.managed_path ?? "",
        selected.projectPath ?? "",
        selected.projectRelativePath ?? "",
        String(selected.size),
        selected.updated ? "1" : "0",
      ].join("\u001f")
    : "";

  function applyPreview(next: ArtifactPreview) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "url" in next ? next.url : null;
    setPreview(next);
  }

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPreview(null);
    setLoading(true);
    setEditing(false);
    setShowDiff(false);
    setDiffData(null);
    const ext = artifactExt(selected.name);
    void (async () => {
      let count = 0;
      if (selected.source !== "project") {
        try {
          count = await coreBridge.artifactVersions(selected.thread, selected.name);
        } catch {
          /* no versions */
        }
      }
      if (cancelled) return;
      setVersions(count);
      setSlot(count);
      try {
        const next = await buildArtifactPreview(selected);
        if (cancelled) {
          if ("url" in next) URL.revokeObjectURL(next.url);
          return;
        }
        applyPreview(next);
      } catch {
        if (!cancelled) setPreview({ kind: "error", ext });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedResourceRevision, reloadKey]);

  useEffect(() => {
    if (!selected) return undefined;
    const revalidate = () => setReloadKey((key) => key + 1);
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [selectedResourceRevision]);

  const editableKind =
    selected?.source !== "project" &&
    (preview?.kind === "markdown" ||
      preview?.kind === "code" ||
      preview?.kind === "text" ||
      preview?.kind === "csv");
  const textKind = preview?.kind === "code" || preview?.kind === "text";
  const canDiff = textKind && versions > 0 && slot > 0;
  const actionsAvailable = Boolean(
    preview && !["denied", "missing", "error"].includes(preview.kind),
  );
  const closeArtifactActions = (restoreFocus = true) => {
    artifactActionsRef.current?.removeAttribute("open");
    if (restoreFocus) {
      window.requestAnimationFrame(() =>
        artifactActionsRef.current?.querySelector<HTMLElement>("summary")?.focus(),
      );
    }
  };

  useEffect(() => {
    if (!showDiff || !selected || selected.source === "project" || slot <= 0) {
      setDiffData(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const newBlob = await coreBridge.downloadArtifact(
          selected.thread,
          selected.name,
          slot < versions ? slot : undefined,
        );
        const oldBlob = await coreBridge.downloadArtifact(selected.thread, selected.name, slot - 1);
        const [newText, oldText] = await Promise.all([newBlob.text(), oldBlob.text()]);
        if (!cancelled) setDiffData({ oldText, newText });
      } catch {
        if (!cancelled) setDiffData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiff, slot, selectedResourceRevision, versions]);

  const diffCounts = diffData ? diffStats(diffData.oldText, diffData.newText) : null;

  async function saveEdit() {
    if (!selected) return;
    setSaving(true);
    try {
      await coreBridge.saveArtifactContent(selected.thread, selected.name, editText);
      setEditing(false);
      setReloadKey((key) => key + 1);
    } catch {
      /* keep editing on failure */
    } finally {
      setSaving(false);
    }
  }

  function goToVersion(target: number) {
    if (!selected) return;
    const clamped = Math.max(0, Math.min(versions, target));
    setSlot(clamped);
    setLoading(true);
    const ext = artifactExt(selected.name);
    void (async () => {
      try {
        const next = await buildArtifactPreview(selected, clamped < versions ? clamped : undefined);
        applyPreview(next);
      } catch {
        setPreview({ kind: "error", ext });
      } finally {
        setLoading(false);
      }
    })();
  }

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return (
    <aside
      className={`artifacts-panel${expanded ? " expanded" : ""}${embedded ? " embedded" : ""}`}
      aria-label={t("chat.projectFiles")}
    >
      {!embedded && (
        <header className="artifacts-panel-head">
          <strong>{t("chat.projectFiles")}</strong>
          <button
            type="button"
            aria-label={expanded ? "Riduci" : "Schermo intero"}
            title={expanded ? "Riduci" : "Schermo intero"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
      )}
      <div className="artifacts-panel-body no-list">
        <div className="artifacts-preview">
          {selected && (
            <div className="artifacts-preview-bar">
              <span title={selected.name}>{selected.name}</span>
              {versions > 0 && (
                <div className="artifact-version-switch" aria-label={t("chat.versions")}>
                  <button
                    type="button"
                    aria-label={t("chat.prevVersion")}
                    disabled={slot === 0}
                    onClick={() => goToVersion(slot - 1)}
                  >
                    <ChevronLeft size={13} />
                  </button>
                  <span>
                    v{slot + 1}/{versions + 1}
                  </span>
                  <button
                    type="button"
                    aria-label={t("chat.nextVersion")}
                    disabled={slot === versions}
                    onClick={() => goToVersion(slot + 1)}
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
              )}
              {actionsAvailable && (
                <details
                  ref={artifactActionsRef}
                  className="artifact-actions-menu"
                  onToggle={(event) => {
                    const details = event.currentTarget;
                    if (details.open) {
                      window.requestAnimationFrame(() =>
                        details.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(),
                      );
                    }
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      closeArtifactActions(false);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      closeArtifactActions();
                      return;
                    }
                    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                    const items = [
                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitem"]',
                      ),
                    ];
                    if (items.length === 0) return;
                    const current = items.indexOf(document.activeElement as HTMLButtonElement);
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                            items.length;
                    event.preventDefault();
                    items[next]?.focus();
                  }}
                >
                  <summary aria-label={t("chat.actions")} title={t("chat.actions")}>
                    <MoreHorizontal size={16} />
                  </summary>
                  <div className="artifact-actions-popover" role="menu">
                    {canDiff && (
                      <button
                        type="button"
                        role="menuitem"
                        className={showDiff ? "active" : ""}
                        onClick={() => {
                          setShowDiff((value) => !value);
                          closeArtifactActions();
                        }}
                      >
                        Diff
                        {showDiff && diffCounts && (
                          <span className="diff-counts">
                            <span className="add">+{diffCounts.added}</span>{" "}
                            <span className="del">−{diffCounts.removed}</span>
                          </span>
                        )}
                      </button>
                    )}
                    {textKind && !showDiff && (
                      <button
                        type="button"
                        role="menuitem"
                        className={wrap ? "active" : ""}
                        onClick={() => {
                          setWrap((value) => !value);
                          closeArtifactActions();
                        }}
                      >
                        {t("chat.wordWrap")}
                      </button>
                    )}
                    {editableKind && !editing && slot === versions && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setEditText(preview && "text" in preview ? preview.text : "");
                          setEditing(true);
                          closeArtifactActions();
                        }}
                      >
                        <Pencil size={14} />
                        <span>{t("common.edit")}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        void triggerArtifactDownload(selected, slot < versions ? slot : undefined);
                        closeArtifactActions();
                      }}
                    >
                      <Download size={14} />
                      <span>{t("chat.action.download")}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        void openArtifactFolder(selected);
                        closeArtifactActions();
                      }}
                    >
                      <FolderOpen size={14} />
                      <span>{t("chat.openFolder")}</span>
                    </button>
                  </div>
                </details>
              )}
            </div>
          )}
          <div className="artifacts-preview-body">
            {editing ? (
              <div className="artifact-edit">
                <textarea
                  className="artifact-edit-area"
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  spellCheck={false}
                />
                <div className="artifact-edit-actions">
                  <button type="button" onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveEdit()}
                    disabled={saving}
                  >
                    {saving ? "Salvo…" : "Save versione"}
                  </button>
                </div>
              </div>
            ) : loading ? (
              <p className="artifacts-preview-note">Carico…</p>
            ) : showDiff && diffData ? (
              <DiffView oldText={diffData.oldText} newText={diffData.newText} />
            ) : (
              <ArtifactPreviewBody
                preview={preview}
                wrap={wrap}
                onRetry={() => setReloadKey((key) => key + 1)}
                onClose={onClose}
              />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
