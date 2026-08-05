import {
  AlertCircle,
  BookMarked,
  Bot,
  ChevronLeft,
  Clock3,
  ClipboardList,
  FileImage,
  FileText,
  FolderOpen,
  ListTodo,
  Loader2,
  Monitor,
  ScanSearch,
  Share2,
  Target,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type CoreTaskQueueSnapshot,
  type FsEntry,
  type FsFilePayload,
  type ProjectGoalsData,
} from "../lib/coreBridge";
import type { SubagentInfo } from "../lib/chatApi";
import {
  formatFileSize,
  formatMessageTimestamp,
  languageForPath,
} from "../lib/chatViewMessages";
import type {
  ChatAttachment,
  ComputerSession,
  ComputerSurfaceKind,
} from "../types";
import type { InspectorTab, InspectorTabKind } from "../lib/inspectorWorkspace";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { CodeView, DiffView } from "./CodeView";
import { ComputerDetailPanel } from "./ComputerDetailPanel";
import { ExecutionInspector } from "./ExecutionInspector";
import { GoalsPanel } from "./GoalsPanel";
import { MemoryGraphPanel } from "./MemoryGraphPanel";
import {
  isMissingFsError,
  type ParsedArtifact,
} from "./MessageArtifacts";
import {
  OperationalPlanPreview,
  parseOperationalPlanItems,
} from "./OperationalPlanPreview";

type LegacyWorkbenchTab = "files" | "artifacts" | "memoria" | "goals" | "activity" | "plan" | "execution";
type InspectorResourceStatus =
  | "loading"
  | "ready"
  | "missing"
  | "denied"
  | "unsupported"
  | "error";

/** A generated artifact or uploaded file, projected into the island's "Sources" section.
 *  `kind` only selects the (monochrome) glyph; `meta` is a one-word provenance hint. */
export interface IslandSource {
  name: string;
  kind: "artifact" | "file" | "image";
  meta?: string;
  action: "artifact" | "files";
  artifactThread?: string;
  artifactName?: string;
}

// Shared view metadata for the panel: the header dropdown (chat top-right) and the
// in-panel title both read from here, so labels/icons never drift. Mock interaction:
// toggle -> dropdown menu -> docked panel with that view + a clean title header.
export const PANEL_VIEWS: { key: InspectorTabKind; icon: typeof FileText }[] = [
  { key: "artifact", icon: ClipboardList },
  { key: "file", icon: FolderOpen },
  { key: "activity", icon: Clock3 },
  { key: "plan", icon: ListTodo },
  { key: "execution", icon: ScanSearch },
  { key: "graph", icon: Share2 },
  { key: "goals", icon: Target },
  { key: "sources", icon: BookMarked },
  { key: "subagents", icon: Bot },
  { key: "computer", icon: Monitor },
];

export const INSPECTOR_VIEW_LABEL_KEY: Record<InspectorTabKind, string> = {
  file: "chat.inspector.views.files",
  artifact: "chat.inspector.views.review",
  memory: "chat.inspector.views.memory",
  graph: "chat.inspector.views.memory",
  sources: "chat.inspector.views.sources",
  goals: "chat.inspector.views.goals",
  activity: "chat.inspector.views.activity",
  plan: "chat.inspector.views.plan",
  execution: "chat.inspector.views.execution",
  subagents: "chat.inspector.views.subagents",
  computer: "chat.inspector.views.computer",
};

function legacyTabForInspector(kind: InspectorTabKind): LegacyWorkbenchTab | null {
  if (kind === "file") return "files";
  if (kind === "artifact") return "artifacts";
  if (kind === "memory" || kind === "graph") return "memoria";
  if (kind === "goals" || kind === "activity" || kind === "plan" || kind === "execution") {
    return kind;
  }
  return null;
}

export function isRestorableInspectorTab(
  tab: InspectorTab,
  threadId: string,
  workspaceId?: string | null,
) {
  return (
    tab.payload.threadId === threadId &&
    (tab.workspaceId ?? null) === (workspaceId ?? null)
  );
}

export function InspectorView({
  descriptor,
  artifacts,
  artifactCatalogError,
  uploadedFiles,
  threadId,
  goalSeed,
  onGoalSeedConsumed,
  operationalPlanMarkdown,
  layoutSignal,
  onOpenFile,
  onOpenFilesIndex,
  onOpenArtifact,
  onRetryArtifactCatalog,
  sources,
  subagents,
  activeSurface,
  controlBusy,
  controlError,
  onPauseComputer,
  onResumeComputer,
  onSelectSurface,
  onTakeoverComputer,
  previewDataUrl,
  computerSession,
  onCloseTab,
}: {
  descriptor: InspectorTab;
  artifacts: ParsedArtifact[];
  artifactCatalogError: boolean;
  uploadedFiles: ChatAttachment[];
  threadId: string;
  goalSeed?: string | null;
  onGoalSeedConsumed?: () => void;
  operationalPlanMarkdown?: string;
  layoutSignal: string;
  onOpenFile: (path: string) => void;
  onOpenFilesIndex: () => void;
  onOpenArtifact: (artifact: ParsedArtifact) => void;
  onRetryArtifactCatalog: () => void;
  sources: IslandSource[];
  subagents: SubagentInfo[];
  activeSurface: ComputerSurfaceKind;
  controlBusy: boolean;
  controlError: string | null;
  onPauseComputer: () => void;
  onResumeComputer: () => void;
  onSelectSurface: (surface: ComputerSurfaceKind) => void;
  onTakeoverComputer: () => void;
  previewDataUrl: string | null;
  computerSession: ComputerSession;
  onCloseTab: () => void;
}) {
  const { t } = useTranslation();
  const open = true;
  const tab = legacyTabForInspector(descriptor.kind);
  const resourceFilePath = descriptor.kind === "file" ? descriptor.payload.path : undefined;
  const resourceArtifact =
    descriptor.kind === "artifact" && descriptor.payload.name
      ? artifacts.find(
          (artifact) =>
            artifact.name === descriptor.payload.name &&
            artifact.thread === descriptor.payload.artifactThread,
        ) ?? null
      : null;
  // Project-folder browser state (File tab): the thread's linked folder, navigable.
  const [fsRoot, setFsRoot] = useState<string | null>(null);
  const [fsCwd, setFsCwd] = useState<string | null>(null);
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsError, setFsError] = useState<string | null>(null);
  // Background/scheduled tasks (Activity tab), fetched lazily when the tab opens.
  const [tasks, setTasks] = useState<CoreTaskQueueSnapshot | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  // Project goals (Obiettivi tab): goals + promotable decisions, resolved from the thread.
  const [goalsData, setGoalsData] = useState<ProjectGoalsData | null>(null);
  // Open file viewer (File tab): content + git diff toggle.
  const [openFile, setOpenFile] = useState<FsFilePayload | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [diffOn, setDiffOn] = useState(false);
  const fileLoadGenerationRef = useRef(0);

  useEffect(() => () => {
    fileLoadGenerationRef.current += 1;
  }, []);

  const loadFileAt = useCallback(
    async (path: string) => {
      const generation = ++fileLoadGenerationRef.current;
      setFileLoading(true);
      setDiffOn(false);
      setOpenFile({ authorized: true, path, text: "", old_text: "", in_git: false, modified: false, binary: false });
      try {
        const payload = await coreBridge.fsFile(path, threadId);
        if (generation === fileLoadGenerationRef.current) setOpenFile(payload);
      } catch (error) {
        if (generation === fileLoadGenerationRef.current) {
          setOpenFile({
            authorized: true,
            path,
            text: "",
            old_text: "",
            in_git: false,
            modified: false,
            binary: false,
            error: (error as Error).message,
          });
        }
      } finally {
        if (generation === fileLoadGenerationRef.current) setFileLoading(false);
      }
    },
    [threadId],
  );

  const cancelTaskItem = useCallback(async (taskId: string) => {
    try {
      setTasks(await coreBridge.cancelTask(taskId));
    } catch {
      /* best-effort; the next tab open refetches */
    }
  }, []);

  const loadFs = useCallback(
    async (path: string | null) => {
      setFsLoading(true);
      setFsError(null);
      setOpenFile(null);
      try {
        const result = await coreBridge.fsList(path, threadId);
        setFsRoot(result.root);
        setFsCwd(result.path);
        setFsEntries(result.authorized ? result.entries : []);
        if (!result.authorized) setFsError("Folder not authorized.");
      } catch (error) {
        setFsError((error as Error).message);
        setFsEntries([]);
      } finally {
        setFsLoading(false);
      }
    },
    [threadId],
  );

  // Reset when the thread changes; (lazy) load when the File tab is shown.
  useEffect(() => {
    setFsRoot(null);
    setFsCwd(null);
    setFsEntries([]);
    setOpenFile(null);
  }, [threadId]);
  // Probe the filesystem when the panel opens (not only on the File tab) so we know
  // upfront whether this thread has a project folder -> drives File-tab visibility.
  useEffect(() => {
    if (open && tab === "files" && !resourceFilePath && fsCwd === null) void loadFs(null);
  }, [open, tab, resourceFilePath, fsCwd, loadFs]);
  useEffect(() => {
    if (tab !== "files" || !resourceFilePath) return;
    void loadFileAt(resourceFilePath);
    const revalidate = () => void loadFileAt(resourceFilePath);
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [loadFileAt, resourceFilePath, tab]);
  // No auto-redirect: every panel-open path picks a view explicitly (dropdown pick,
  // save-goal -> "goals", open-artifact -> "artifacts"), and every view has its own
  // empty state - so an explicitly chosen empty view stays put instead of bouncing.
  // Load project goals (Obiettivi tab) when the panel opens - resolves scope from thread.
  useEffect(() => {
    if (!open || tab !== "goals") return;
    let cancelled = false;
    void coreBridge.projectGoals(threadId).then((d) => {
      if (!cancelled) setGoalsData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [open, tab, threadId]);
  // Load the task queue when the Activity tab is shown (and refresh on re-open).
  useEffect(() => {
    if (!open || tab !== "activity") return;
    let cancelled = false;
    setTasksLoading(true);
    void coreBridge
      .taskQueue(threadId)
      .then((snapshot) => {
        if (!cancelled) setTasks(snapshot);
      })
      .catch(() => {
        if (!cancelled) setTasks(null);
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, threadId]);

  const fileStatus: InspectorResourceStatus = fileLoading
    ? "loading"
    : !resourceFilePath
      ? "ready"
      : !openFile
        ? "loading"
        : !openFile.authorized
          ? "denied"
          : openFile.error
            ? isMissingFsError(openFile.error)
              ? "missing"
              : "error"
            : openFile.binary
              ? "unsupported"
              : "ready";

  if (descriptor.kind === "sources") {
    return (
      <div className="workbench-files inspector-source-view">
        {sources.length > 0 ? (
          <ul className="workbench-file-list">
            {sources.map((source, index) => {
              const sourceArtifact = artifacts.find(
                (artifact) =>
                  source.action === "artifact" &&
                  artifact.thread === source.artifactThread &&
                  artifact.name === source.artifactName,
              );
              return (
                <li key={`${index}:${source.kind}:${source.name}`}>
                  {source.kind === "image" ? <FileImage size={15} /> : <FileText size={15} />}
                  {sourceArtifact ? (
                    <button
                      type="button"
                      className="wf-name wf-file"
                      title={source.name}
                      onClick={() => onOpenArtifact(sourceArtifact)}
                    >
                      {source.name}
                    </button>
                  ) : source.action === "files" ? (
                    <button
                      type="button"
                      className="wf-name wf-file"
                      title={source.name}
                      onClick={onOpenFilesIndex}
                    >
                      {source.name}
                    </button>
                  ) : (
                    <span className="wf-name" title={source.name}>{source.name}</span>
                  )}
                  {source.meta && <small>{source.meta}</small>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="workbench-empty"><BookMarked size={28} /><p>No sources yet.</p></div>
        )}
      </div>
    );
  }

  if (descriptor.kind === "subagents") {
    return (
      <div className="workbench-files inspector-subagent-view">
        {subagents.length > 0 ? (
          <ul className="workbench-file-list">
            {subagents.map((subagent, index) => (
              <li key={`${index}:${subagent.name}`}>
                <Bot size={15} />
                <span className="wf-name inspector-subagent-copy" title={subagent.name}>
                  <strong>{subagent.name}</strong>
                  {subagent.summary && <small>{subagent.summary}</small>}
                </span>
                <small>
                  {subagent.status}
                  {subagent.updated_at ? ` · ${formatMessageTimestamp(String(subagent.updated_at))}` : ""}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <div className="workbench-empty"><Bot size={28} /><p>No subagents in this activity.</p></div>
        )}
      </div>
    );
  }

  if (descriptor.kind === "computer") {
    return (
      <ComputerDetailPanel
        activeSurface={activeSurface}
        controlBusy={controlBusy}
        controlError={controlError}
        onPause={onPauseComputer}
        onResume={onResumeComputer}
        onSelectSurface={onSelectSurface}
        onTakeover={onTakeoverComputer}
        previewDataUrl={previewDataUrl}
        session={computerSession}
      />
    );
  }

  if (!tab) {
    return (
      <div className="workbench-empty">
        <p>{descriptor.title}</p>
      </div>
    );
  }
  const refreshGoals = () => {
    void coreBridge.projectGoals(threadId).then(setGoalsData);
  };
  const planItems = parseOperationalPlanItems(operationalPlanMarkdown);
  const activeTasks = tasks
    ? [...tasks.active, ...tasks.queued, ...tasks.blocked]
    : [];
  const atRoot = !fsRoot || fsCwd === fsRoot;
  const cwdLabel = fsCwd ? fsCwd.replace(/\/+$/, "").split("/").pop() || fsCwd : "";
  const parentOf = (path: string) => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return (
    <div className="workbench-body inspector-view-body" aria-label={descriptor.title}>
        {tab === "files" && resourceFilePath && openFile && (
          <div className="workbench-fileview">
            <div className="workbench-breadcrumb">
              <span className="wf-name" title={openFile.path}>
                {openFile.path.split("/").pop()}
              </span>
              {fileLoading && <Loader2 size={13} className="spin" />}
              {openFile.modified && !fileLoading && (
                <button
                  type="button"
                  className={`workbench-diff-toggle${diffOn ? " active" : ""}`}
                  title={t("chat.showGitDiff")}
                  onClick={() => setDiffOn((value) => !value)}
                >
                  ± Diff
                </button>
              )}
            </div>
            <div className="workbench-fileview-body">
              {fileStatus === "denied" ? (
                <div className="workbench-empty">
                  <AlertCircle size={24} />
                  <p>{t("chat.inspector.denied")}</p>
                  <button type="button" onClick={onCloseTab}>
                    {t("chat.inspector.closeTab", { title: descriptor.title })}
                  </button>
                </div>
              ) : fileStatus === "missing" ? (
                <div className="workbench-empty">
                  <AlertCircle size={24} />
                  <p>{t("chat.inspector.missing")}</p>
                  <span className="workbench-empty-actions">
                    <button type="button" onClick={() => void loadFileAt(resourceFilePath)}>
                      {t("chat.inspector.retry")}
                    </button>
                    <button type="button" onClick={onCloseTab}>
                      {t("chat.inspector.closeTab", { title: descriptor.title })}
                    </button>
                  </span>
                </div>
              ) : fileStatus === "error" ? (
                <div className="workbench-empty">
                  <AlertCircle size={24} />
                  <p>{openFile.error}</p>
                  <span className="workbench-empty-actions">
                    <button type="button" onClick={() => void loadFileAt(resourceFilePath)}>
                      {t("chat.inspector.retry")}
                    </button>
                    <button type="button" onClick={onCloseTab}>
                      {t("chat.inspector.closeTab", { title: descriptor.title })}
                    </button>
                  </span>
                </div>
              ) : fileStatus === "unsupported" ? (
                <div className="workbench-empty">
                  <FileText size={24} />
                  <p>{t("chat.inspector.unsupported")}</p>
                  <small>{openFile.path}</small>
                  <button type="button" onClick={onCloseTab}>
                    {t("chat.inspector.closeTab", { title: descriptor.title })}
                  </button>
                </div>
              ) : diffOn && openFile.modified ? (
                <DiffView oldText={openFile.old_text} newText={openFile.text} />
              ) : (
                <CodeView code={openFile.text} language={languageForPath(openFile.path)} />
              )}
            </div>
          </div>
        )}
        {tab === "files" && resourceFilePath && !openFile && (
          <div className="workbench-empty">
            <Loader2 size={22} className="spin" />
            <p>{t("chat.loadingActivity")}</p>
          </div>
        )}
        {tab === "files" && !resourceFilePath && (
          <div className="workbench-files">
            {uploadedFiles.length > 0 && (
              <>
                <div className="workbench-section-label">{t("chat.uploadedInChat")}</div>
                <ul className="workbench-file-list">
                  {uploadedFiles.map((file) => (
                    <li key={file.artifactId}>
                      {file.kind === "image" ? <FileImage size={15} /> : <FileText size={15} />}
                      <span className="wf-name" title={file.title}>
                        {file.title}
                      </span>
                      <small>{formatFileSize(file.sizeBytes)}</small>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {fsRoot ? (
              <>
                <div
                  className="workbench-section-label"
                  style={{ marginTop: uploadedFiles.length ? 14 : 4 }}
                >
                  {t("chat.projectFolder")}
                </div>
                <div className="workbench-breadcrumb">
                  <button
                    type="button"
                    aria-label={t("chat.parentFolder")}
                    disabled={atRoot || fsLoading}
                    onClick={() => fsCwd && void loadFs(parentOf(fsCwd))}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span title={fsCwd ?? ""}>{cwdLabel}</span>
                  {fsLoading && <Loader2 size={13} className="spin" />}
                </div>
                <ul className="workbench-file-list">
                  {fsEntries.map((entry) => (
                    <li key={entry.path}>
                      {entry.is_dir ? <FolderOpen size={15} /> : <FileText size={15} />}
                      {entry.is_dir ? (
                        <button
                          type="button"
                          className="wf-name wf-dir"
                          title={entry.name}
                          onClick={() => void loadFs(entry.path)}
                        >
                          {entry.name}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="wf-name wf-file"
                          title={entry.name}
                          onClick={() => onOpenFile(entry.path)}
                        >
                          {entry.name}
                        </button>
                      )}
                      {!entry.is_dir && <small>{formatFileSize(entry.size)}</small>}
                    </li>
                  ))}
                  {fsEntries.length === 0 && !fsLoading && (
                    <li className="wf-muted">{t("chat.emptyFolder")}</li>
                  )}
                </ul>
              </>
            ) : (
              uploadedFiles.length === 0 && (
                <div className="workbench-empty">
                  <FolderOpen size={28} />
                  <p>
                    {fsError ??
                      "No files in this chat and no project folder linked. Attach a file (📎) or link a folder to the project."}
                  </p>
                </div>
              )
            )}
          </div>
        )}
        {tab === "artifacts" && descriptor.payload.name &&
          (resourceArtifact ? (
            <ArtifactsPanel
              artifacts={[resourceArtifact]}
              initialName={resourceArtifact.name}
              onClose={onCloseTab}
              embedded
            />
          ) : (
            <div className="workbench-empty">
              <FileText size={28} />
              <p>
                {artifactCatalogError ? t("chat.previewUnavailable") : t("chat.inspector.missing")}
              </p>
              <span className="workbench-empty-actions">
                <button type="button" onClick={onRetryArtifactCatalog}>
                  {t("chat.inspector.retry")}
                </button>
                <button type="button" onClick={onCloseTab}>
                  {t("chat.inspector.closeTab", { title: descriptor.title })}
                </button>
              </span>
            </div>
          ))}
        {tab === "artifacts" && !descriptor.payload.name && (
          <div className="workbench-files">
            {artifacts.length > 0 ? (
              <ul className="workbench-file-list">
                {artifacts.map((artifact) => (
                  <li key={`${artifact.thread}:${artifact.name}`}>
                    <FileText size={15} />
                    <button
                      type="button"
                      className="wf-name wf-file"
                      title={artifact.name}
                      onClick={() => onOpenArtifact(artifact)}
                    >
                      {artifact.name}
                    </button>
                    <small>{artifact.source === "project" ? "project" : "artifact"}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="workbench-empty">
                <FileText size={28} />
                <p>No artifacts yet. Files generated or created by the assistant appear here.</p>
              </div>
            )}
          </div>
        )}
        {tab === "memoria" && <MemoryGraphPanel threadId={threadId} layoutSignal={layoutSignal} />}
        {tab === "goals" && goalsData && (
          <GoalsPanel
            data={goalsData}
            threadId={threadId}
            seed={goalSeed}
            onSeedConsumed={onGoalSeedConsumed}
            onRefresh={refreshGoals}
          />
        )}
        {tab === "activity" && (
          <div className="workbench-files">
            {tasksLoading && activeTasks.length === 0 ? (
              <div className="workbench-empty">
                <Loader2 size={22} className="spin" />
                <p>{t("chat.loadingActivity")}</p>
              </div>
            ) : activeTasks.length > 0 ? (
              <>
                <div className="workbench-section-label">{t("chat.ongoingAndPlanned")}</div>
                <ul className="workbench-file-list">
                  {activeTasks.map((item) => (
                    <li key={item.task_id}>
                      <Clock3 size={15} />
                      <span className="wf-name" title={item.goal}>
                        {item.goal || item.kind}
                      </span>
                      <small>{item.blocked_reason ? "blocked" : item.status}</small>
                      <button
                        type="button"
                        className="wf-cancel"
                        title={t("chat.cancelTask")}
                        aria-label={t("chat.cancelTask")}
                        onClick={() => void cancelTaskItem(item.task_id)}
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="workbench-empty">
                <Clock3 size={28} />
                <p>No background activity. Scheduled and recurring tasks appear here.</p>
              </div>
            )}
          </div>
        )}
        {tab === "plan" &&
          (planItems.length > 0 ? (
            <div className="workbench-files">
              <OperationalPlanPreview collapsed={false} markdown={operationalPlanMarkdown} />
            </div>
          ) : (
            <div className="workbench-empty">
              <ListTodo size={28} />
              <p>No active operational plan. When the assistant plans a multi-step task, steps appear here.</p>
            </div>
          ))}
        {tab === "execution" && <ExecutionInspector threadId={threadId} />}
    </div>
  );
}
