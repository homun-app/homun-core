import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Shield,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { settingsGroupLabels, settingsSections } from "../data/mockData";
import type { ChatThread, NavItem, SettingsSectionId, ViewId } from "../types";
import { useSetting } from "../lib/settingsStore";
import {
  coreBridge,
  type CoreChatThread,
  type Tag,
  type WorkspaceRecord,
} from "../lib/coreBridge";
import { UpdatePill } from "./UpdatePill";
import { TagMenu } from "./TagMenu";
import { SidebarFilters } from "./SidebarFilters";
import { useTags, tagsForEntity } from "../lib/useTags";
import {
  type ThreadFilter,
  EMPTY_THREAD_FILTER,
  threadMatchesFilter,
  threadFilterIsActive,
  threadSourceKey,
} from "../lib/threadFilter";
import { ProjectAccessDialog } from "./ProjectAccessDialog";

// The base personal workspace ("Predefinito"): always present, never a "project".
const PERSONAL_WORKSPACE_ID = "local-workspace";
const NEW_CHAT_PROJECT_LIMIT = 8;
const NAV_SECTION_LABELS: Record<NonNullable<NavItem["navSection"]>, string> = {
  work: "Work",
  create: "Create",
  workspace: "Workspace",
  more: "More",
};

function navSectionForItem(item: NavItem): NonNullable<NavItem["navSection"]> {
  if (item.navSection) return item.navSection;
  if (item.id === "automations" || item.id === "tasks") return "work";
  if (item.id === "connections" || item.id === "browser") return "workspace";
  return "more";
}

function navOrder(item: NavItem): number {
  if (typeof item.order === "number") return item.order;
  if (item.id === "automations") return 20;
  if (item.id === "tasks") return 10;
  if (item.id === "connections") return 30;
  if (item.id === "browser") return 90;
  return 50;
}

function toChatThread(thread: CoreChatThread): ChatThread {
  return {
    threadId: thread.thread_id,
    title: thread.title,
    subtitle: thread.subtitle,
    status: thread.status === "archived" ? "archived" : "active",
    pinned: thread.pinned,
    computerSessionId: thread.computer_session_id,
    taskId: thread.task_id,
    updatedAt: thread.updated_at,
    messageCount: thread.message_count,
    source: thread.source ?? null,
    channelRecipient: thread.channel_recipient ?? null,
  };
}

interface NavigationRailProps {
  activeView: ViewId;
  navItems: NavItem[];
  onNavigate: (view: ViewId) => void;
  onSearch: () => void;
  onToggleDrawer: () => void;
}

export function NavigationRail({
  activeView,
  navItems,
  onNavigate,
  onSearch,
  onToggleDrawer,
}: NavigationRailProps) {
  const { t } = useTranslation();
  return (
    <aside className="navigation-rail" aria-label={t("sidebar.railAriaLabel")}>
      <nav className="rail-nav">
        {/* Expand toggle lives INSIDE the rail (a no-drag child of the drag rail, so it
            reliably carves the drag region) instead of floating over the content. */}
        <button
          className="rail-button"
          type="button"
          aria-label={t("sidebar.expandSidebar")}
          title={t("sidebar.expandSidebar")}
          onClick={onToggleDrawer}
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          className="rail-button"
          type="button"
          aria-label={t("sidebar.search")}
          onClick={onSearch}
        >
          <Search size={18} />
        </button>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`rail-button ${activeView === item.id ? "active" : ""}`}
              key={item.id}
              type="button"
              aria-label={t(item.label)}
              title={t(item.label)}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </nav>

      <div className="rail-bottom">
        <button
          className={`rail-button ${activeView === "settings" ? "active" : ""}`}
          type="button"
          aria-label={t("sidebar.settings")}
          onClick={() => onNavigate("settings")}
        >
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}

/* Projects + Personal sections (M9). Self-contained: fetches the workspace list
   and the base ("Personal") threads itself; the active project's chats come from
   the active-context `activeThreads`. Switching context re-scopes the whole app, so
   those actions reload (consistent with the rest of the workspace flow). */
interface ProjectsNavProps {
  activeView: ViewId;
  activeThreadId: string;
  activeThreads: ChatThread[];
  busyThreadIds: Set<string>;
  onArchiveChatThread: (threadId: string) => void;
  onSelectThread: (threadId: string) => void;
  onCreateteChatThread: (workspaceId?: string) => void;
  onSetChatThreadPinned: (threadId: string, pinned: boolean) => void;
  onThreadContextMenu: (thread: ChatThread, event: MouseEvent<HTMLElement>) => void;
}

type ProjectModalState =
  | { mode: "create"; name: string; folder: string | null }
  | {
      mode: "edit";
      id: string;
      originalName: string;
      originalFolder: string | null;
      name: string;
      folder: string | null;
    };

type NewChatProjectModalState = {
  name: string;
  folder: string | null;
};

function folderDisplayName(folder: string): string {
  return folder.split("/").filter(Boolean).at(-1) ?? "Project";
}

function ProjectsNav({
  activeView,
  activeThreadId,
  activeThreads,
  busyThreadIds,
  onArchiveChatThread,
  onSelectThread,
  onCreateteChatThread,
  onSetChatThreadPinned,
  onThreadContextMenu,
}: ProjectsNavProps) {
  const { t } = useTranslation();
  const { assignments: tagAssignments } = useTags();
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>(EMPTY_THREAD_FILTER);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(PERSONAL_WORKSPACE_ID);
  const [personalThreads, setPersonalThreads] = useState<ChatThread[]>([]);
  const [projectThreadsById, setProjectThreadsById] = useState<Record<string, ChatThread[]>>({});
  const [busy, setBusy] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({ personal: true, projects: true });
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const [projectModal, setProjectModal] = useState<ProjectModalState | null>(null);
  const [accessProject, setAccessProject] = useState<WorkspaceRecord | null>(null);
  const [projectMenu, setProjectMenu] = useState<{
    project: WorkspaceRecord;
    x: number;
    y: number;
  } | null>(null);
  const [projectTagMenu, setProjectTagMenu] = useState<{
    entityId: string;
    x: number;
    y: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectMenu) return;
    function closeMenu() {
      setProjectMenu(null);
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [projectMenu]);

  async function reloadWorkspaces() {
    const snap = await coreBridge.workspaces();
    setWorkspaces(snap.workspaces);
    setActiveWorkspaceId(snap.active_workspace_id);
  }
  useEffect(() => {
    void reloadWorkspaces().catch(() => {});
    coreBridge
      .chatThreads(PERSONAL_WORKSPACE_ID)
      .then((snap) => setPersonalThreads(snap.threads.map(toChatThread)))
      .catch(() => {});
  }, []);

  // Homun is project-agnostic: opening it re-scopes the backend to the personal
  // workspace (without a full reload), so keep the switcher in sync — otherwise it
  // would keep showing the previously active project while you're in Homun.
  useEffect(() => {
    if (activeView === "chat" && activeThreadId === "homun") {
      setActiveWorkspaceId(PERSONAL_WORKSPACE_ID);
    }
  }, [activeView, activeThreadId]);

  const inProject = activeWorkspaceId !== PERSONAL_WORKSPACE_ID;
  const projects = workspaces.filter((w) => w.id !== PERSONAL_WORKSPACE_ID);
  // Chats of the ACTIVE context. Channels (WhatsApp/Telegram) live in the personal
  // scope and are mixed straight into the list — ordered by recency like every other
  // thread (their leading type icon is what tells them apart). The "homun" thread is
  // excluded (retired). Backend order is already `pinned desc, updated_at desc`.
  const personalChats = (inProject ? personalThreads : activeThreads).filter(
    (t) => t.status === "active" && t.threadId !== "homun",
  );
  const projectChats = inProject
    ? activeThreads.filter((t) => t.status === "active" && t.threadId !== "homun")
    : [];

  useEffect(() => {
    if (!inProject) return;
    setExpandedProjectIds((current) => new Set([...current, activeWorkspaceId]));
    setProjectThreadsById((current) => ({ ...current, [activeWorkspaceId]: projectChats }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, inProject]);

  // Context switches re-scope memory/capabilities/artifacts-folder → full reload.
  async function selectProject(id: string) {
    setBusy(true);
    try {
      await coreBridge.selectWorkspace(id);
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function openProjectThread(projectId: string, threadId: string) {
    if (projectId === activeWorkspaceId) {
      onSelectThread(threadId);
      return;
    }
    setBusy(true);
    try {
      await coreBridge.selectChatThread(threadId);
      await coreBridge.selectWorkspace(projectId);
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function loadProjectThreads(projectId: string) {
    try {
      const snap = await coreBridge.chatThreads(projectId);
      setProjectThreadsById((current) => ({
        ...current,
        [projectId]: snap.threads
          .map(toChatThread)
          .filter((thread) => thread.status === "active" && thread.threadId !== "homun"),
      }));
    } catch {
      setProjectThreadsById((current) => ({ ...current, [projectId]: [] }));
    }
  }

  function togglePersonal() {
    setExpandedGroups((current) => ({ ...current, personal: !current.personal }));
  }

  function toggleProjects() {
    setExpandedGroups((current) => ({ ...current, projects: !current.projects }));
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
        void loadProjectThreads(projectId);
      }
      return next;
    });
  }
  async function openPersonalThread(threadId: string) {
    if (!inProject) {
      onSelectThread(threadId);
      return;
    }
    setBusy(true);
    try {
      await coreBridge.selectChatThread(threadId);
      await coreBridge.selectWorkspace(PERSONAL_WORKSPACE_ID);
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function openCreateProjectModal() {
    setProjectMenu(null);
    setError(null);
    setProjectModal({ mode: "create", name: "", folder: null });
  }

  function openEditProjectModal(project: WorkspaceRecord) {
    setProjectMenu(null);
    setError(null);
    setProjectModal({
      mode: "edit",
      id: project.id,
      originalName: project.name,
      originalFolder: project.folder ?? null,
      name: project.name,
      folder: project.folder ?? null,
    });
  }

  function openProjectAccess(project: WorkspaceRecord) {
    setProjectMenu(null);
    setAccessProject(project);
  }

  async function createProjectChat(projectId: string) {
    setBusy(true);
    try {
      await coreBridge.selectWorkspace(projectId);
      const created = await coreBridge.createChatThread(projectId);
      await coreBridge.selectChatThread(created.thread_id);
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function pickProjectModalFolder() {
    const folder = await coreBridge.pickFolder();
    if (!folder) return;
    setProjectModal((current) => (current ? { ...current, folder } : current));
  }

  async function saveProjectModal() {
    if (!projectModal) return;
    const name = projectModal.name.trim();
    if (!name) return;
    if (projectModal.mode === "create" && !projectModal.folder) return;
    setBusy(true);
    setError(null);
    try {
      if (projectModal.mode === "create") {
        const folder = projectModal.folder;
        if (!folder) return;
        const snap = await coreBridge.createWorkspace(name, folder);
        const created = snap.workspaces.find((w) => w.name === name);
        if (created) {
          await coreBridge.selectWorkspace(created.id);
          window.location.reload();
          return;
        }
      } else {
        if (name !== projectModal.originalName) {
          await coreBridge.renameWorkspace(projectModal.id, name);
        }
        if (projectModal.folder && projectModal.folder !== projectModal.originalFolder) {
          await coreBridge.setWorkspaceFolder(projectModal.id, projectModal.folder);
        }
        await reloadWorkspaces();
      }
      setProjectModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(id: string) {
    setProjectMenu(null);
    setBusy(true);
    try {
      await coreBridge.deleteWorkspace(id);
      if (id === activeWorkspaceId) {
        window.location.reload();
        return;
      }
      await reloadWorkspaces();
      setProjectModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revealProject(project: WorkspaceRecord) {
    setProjectMenu(null);
    if (!project.folder) return;
    try {
      await coreBridge.revealPath(project.folder);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function renderThreadList(
    threads: ChatThread[],
    emptyLabel: string,
    onSelect: (thread: ChatThread) => void,
  ) {
    const filtered = threads.filter((thread) =>
      threadMatchesFilter(
        thread,
        threadFilter,
        tagsForEntity(tagAssignments, "thread", thread.threadId).map((tag) => tag.id),
      ),
    );
    if (filtered.length === 0) {
      // Distinguish "genuinely empty" from "hidden by the active filter".
      return (
        <p className="drawer-empty">
          {threadFilterIsActive(threadFilter) ? t("filters.noMatches") : emptyLabel}
        </p>
      );
    }
    return filtered.map((thread) => (
      <ThreadLink
        key={thread.threadId}
        active={thread.threadId === activeThreadId && activeView === "chat"}
        busy={busyThreadIds.has(thread.threadId)}
        thread={thread}
        onArchive={() => onArchiveChatThread(thread.threadId)}
        onContextMenu={(e) => onThreadContextMenu(thread, e)}
        onMore={(e) => onThreadContextMenu(thread, e)}
        onPinToggle={() => onSetChatThreadPinned(thread.threadId, !thread.pinned)}
        onSelect={() => onSelect(thread)}
        tags={tagsForEntity(tagAssignments, "thread", thread.threadId)}
      />
    ));
  }

  const availableSources = Array.from(
    new Set(
      [personalChats, ...Object.values(projectThreadsById)]
        .flat()
        .map((thread) => threadSourceKey(thread)),
    ),
  ).sort();

  return (
    <>
      <div className="drawer-filter-bar">
        <SidebarFilters
          filter={threadFilter}
          onChange={setThreadFilter}
          availableSources={availableSources}
        />
      </div>
      <section className="drawer-section drawer-personal-tree" data-project-tree="personal">
        <div className="drawer-chats-head">
          <button className="drawer-section-toggle" type="button" onClick={togglePersonal}>
            <span>{t("sidebar.personal")}</span>
          </button>
          <button
            className="drawer-eyebrow-add"
            type="button"
            disabled={busy}
            onClick={() => onCreateteChatThread(PERSONAL_WORKSPACE_ID)}
            aria-label={t("sidebar.newChat")}
            title={t("sidebar.newChat")}
          >
            <Plus size={16} />
          </button>
        </div>
        {expandedGroups.personal && (
          <div className="drawer-project-chats">
            {renderThreadList(personalChats, t("sidebar.noChatsYet"), (thread) => {
              void openPersonalThread(thread.threadId);
            })}
          </div>
        )}
      </section>

      <section className="drawer-section drawer-projects-tree" data-project-tree="projects">
        <div className="drawer-chats-head">
          <button className="drawer-section-toggle" type="button" onClick={toggleProjects}>
            <span>{t("sidebar.projects")}</span>
          </button>
          <button
            className="drawer-eyebrow-add"
            type="button"
            disabled={busy}
            onClick={openCreateProjectModal}
            aria-label={t("sidebar.newProject")}
            title={t("sidebar.newProject")}
          >
            <Plus size={16} />
          </button>
        </div>
        {expandedGroups.projects && (
          <>
            {projects.length === 0 && <p className="drawer-empty">{t("sidebar.noProjects")}</p>}
            {projects.map((project) => {
              const expanded = expandedProjectIds.has(project.id);
              const projectThreads = project.id === activeWorkspaceId
                ? projectChats
                : projectThreadsById[project.id] ?? [];
              return (
                <div
                  key={project.id}
                  className={`drawer-project ${project.id === activeWorkspaceId ? "active" : ""}`}
                >
                  <div className="drawer-project-row">
                    <button
                      className="drawer-link drawer-project-name"
                      type="button"
                      disabled={busy}
                      onClick={() => toggleProject(project.id)}
                    >
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <FolderOpen size={14} />
                      <span className="drawer-link-title">{project.name}</span>
                      {(() => {
                        const projectTags = tagsForEntity(tagAssignments, "project", project.id);
                        return projectTags.length > 0 ? (
                          <span className="tag-chips" aria-hidden="true">
                            {projectTags.map((tag) => (
                              <span
                                key={tag.id}
                                className="tag-chip-dot"
                                style={{ background: tag.color }}
                                title={tag.name}
                              />
                            ))}
                          </span>
                        ) : null;
                      })()}
                    </button>
                    <button
                      className="drawer-row-action"
                      type="button"
                      aria-label={`New chat in ${project.name}`}
                      title={t("sidebar.newChat")}
                      disabled={busy}
                      onClick={() => void createProjectChat(project.id)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="drawer-row-action"
                      type="button"
                      aria-label={`Project menu for ${project.name}`}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        setProjectMenu({ project, x: event.clientX, y: event.clientY });
                      }}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </div>
                  {expanded && (
                    <div className="drawer-project-chats">
                      {renderThreadList(projectThreads, t("sidebar.noChatsYet"), (thread) => {
                        void openProjectThread(project.id, thread.threadId);
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </section>

      {error && (
        <p className="drawer-empty" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      {projectMenu && (
        <div
          className="thread-context-menu"
          role="menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const { project } = projectMenu;
              setProjectMenu(null);
              void createProjectChat(project.id);
            }}
          >
            <Pencil size={15} />
            <span>{t("sidebar.newChat")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => openEditProjectModal(projectMenu.project)}>
            <Pencil size={15} />
            <span>Project settings</span>
          </button>
          <button type="button" role="menuitem" onClick={() => openProjectAccess(projectMenu.project)}>
            <Shield size={15} />
            <span>Manage access</span>
          </button>
          {projectMenu.project.folder && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void revealProject(projectMenu.project)}
            >
              <FolderOpen size={15} />
              <span>Show in Finder</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectTagMenu({
                entityId: projectMenu.project.id,
                x: projectMenu.x,
                y: projectMenu.y,
              });
              setProjectMenu(null);
            }}
          >
            <TagIcon size={15} />
            <span>{t("tags.menuLabel")}</span>
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => void deleteProject(projectMenu.project.id)}
          >
            <Trash2 size={15} />
            <span>{t("common.delete")}</span>
          </button>
        </div>
      )}

      {projectTagMenu && (
        <TagMenu
          entityType="project"
          entityId={projectTagMenu.entityId}
          x={projectTagMenu.x}
          y={projectTagMenu.y}
          onClose={() => setProjectTagMenu(null)}
        />
      )}

      <ProjectAccessDialog workspace={accessProject} onClose={() => setAccessProject(null)} />

      {projectModal && (
        <div
          className="confirm-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!busy) setProjectModal(null);
          }}
        >
          <div
            className="confirm-modal"
            role="dialog"
            aria-label={projectModal.mode === "create" ? t("sidebar.newProject") : "Project settings"}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <strong>{projectModal.mode === "create" ? t("sidebar.newProject") : "Project settings"}</strong>
              <button
                className="icon-button"
                type="button"
                aria-label={t("sidebar.close")}
                onClick={() => setProjectModal(null)}
              >
                <X size={17} />
              </button>
            </header>
            <p className="drawer-modal-hint">
              {t("sidebar.projectFolderHintPre")}
              <strong>{t("sidebar.projectFolderHintBold")}</strong>
              {t("sidebar.projectFolderHintPost")}
            </p>
            <input
              className="set-input drawer-modal-input"
              autoFocus
              placeholder={t("sidebar.projectNamePlaceholder")}
              value={projectModal.name}
              onChange={(e) =>
                setProjectModal((current) => (current ? { ...current, name: e.target.value } : current))
              }
            />
            <button
              className="workspace-switcher-folder-pick"
              type="button"
              disabled={busy}
              title={projectModal.folder ?? t("sidebar.projectFolderTitle")}
              onClick={() => void pickProjectModalFolder()}
            >
              <FolderPlus size={13} />
              <span>{projectModal.folder ? projectModal.folder.split("/").pop() : t("sidebar.pickFolder")}</span>
            </button>
            <footer>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setProjectModal(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  busy ||
                  !projectModal.name.trim() ||
                  (projectModal.mode === "create" && !projectModal.folder)
                }
                onClick={() => void saveProjectModal()}
              >
                {projectModal.mode === "create" ? "Create" : "Save"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

interface NavDrawerProps {
  activeView: ViewId;
  activeThreadId: string;
  busyThreadIds: Set<string>;
  chatThreads: ChatThread[];
  navItems: NavItem[];
  onArchiveChatThread: (threadId: string) => void;
  onRenameChatThread: (threadId: string, title: string) => void | Promise<void>;
  onCreateteChatThread: (workspaceId?: string) => void;
  onDeleteChatThread: (threadId: string) => void;
  onNavigate: (view: ViewId) => void;
  onSearchChat: () => void;
  onSelectThread: (threadId: string) => void;
  onSetChatThreadPinned: (threadId: string, pinned: boolean) => void;
  onToggleDrawer: () => void;
  onUnarchiveChatThread: (threadId: string) => void;
}

export function NavDrawer({
  activeView,
  activeThreadId,
  busyThreadIds,
  chatThreads,
  navItems,
  onArchiveChatThread,
  onRenameChatThread,
  onCreateteChatThread,
  onDeleteChatThread,
  onNavigate,
  onSearchChat,
  onSelectThread,
  onSetChatThreadPinned,
  onToggleDrawer,
  onUnarchiveChatThread,
}: NavDrawerProps) {
  const { t } = useTranslation();
  const [collapsedSections, setCollapsedSections] = useState({
    archived: false,
  });
  const [collapsedNavGroups, setCollapsedNavGroups] = useState<
    Record<NonNullable<NavItem["navSection"]>, boolean>
  >({
    work: false,
    create: false,
    workspace: false,
    more: false,
  });
  const [deleteCandidate, setDeleteCandidate] = useState<ChatThread | null>(null);
  const [newChatMenu, setNewChatMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [newChatWorkspaces, setNewChatWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [newChatQuery, setNewChatQuery] = useState("");
  const [newChatBusy, setNewChatBusy] = useState(false);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [newChatProjectModal, setNewChatProjectModal] =
    useState<NewChatProjectModalState | null>(null);
  const [threadMenu, setThreadMenu] = useState<{
    thread: ChatThread;
    x: number;
    y: number;
  } | null>(null);
  const [tagMenu, setTagMenu] = useState<{
    entityType: "thread" | "project";
    entityId: string;
    x: number;
    y: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    threadId: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!newChatMenu) return;
    function closeMenu() {
      setNewChatMenu(null);
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [newChatMenu]);

  useEffect(() => {
    if (!threadMenu) return;
    function closeMenu() {
      setThreadMenu(null);
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [threadMenu]);

  function runThreadAction(action: () => void) {
    action();
    setThreadMenu(null);
  }

  async function openNewChatMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setNewChatMenu({ x: event.clientX, y: event.clientY });
    setNewChatQuery("");
    setNewChatError(null);
    try {
      const snap = await coreBridge.workspaces();
      setNewChatWorkspaces(snap.workspaces);
    } catch {
      setNewChatWorkspaces([]);
    }
  }

  async function createProjectFromFolder() {
    setNewChatBusy(true);
    setNewChatError(null);
    try {
      const folder = await coreBridge.pickFolder();
      if (!folder) return;
      const current = await coreBridge.workspaces();
      const existing = current.workspaces.find((workspace) => workspace.folder === folder);
      if (existing) {
        setNewChatMenu(null);
        onCreateteChatThread(existing.id);
        return;
      }
      const name = folderDisplayName(folder);
      const createdSnap = await coreBridge.createWorkspace(name, folder);
      const created =
        createdSnap.workspaces.find((workspace) => workspace.folder === folder) ??
        createdSnap.workspaces.find((workspace) => workspace.name === name);
      if (!created) throw new Error("Project was created but could not be selected.");
      setNewChatMenu(null);
      onCreateteChatThread(created.id);
    } catch (error) {
      setNewChatError((error as Error).message);
    } finally {
      setNewChatBusy(false);
    }
  }

  async function pickNewChatProjectFolder() {
    const folder = await coreBridge.pickFolder();
    if (!folder) return;
    setNewChatProjectModal((current) => {
      if (!current) return current;
      return {
        ...current,
        folder,
        name: current.name.trim() ? current.name : folderDisplayName(folder),
      };
    });
  }

  async function saveNewChatProject() {
    if (!newChatProjectModal) return;
    const name = newChatProjectModal.name.trim();
    const folder = newChatProjectModal.folder;
    if (!name || !folder) return;
    setNewChatBusy(true);
    setNewChatError(null);
    try {
      const createdSnap = await coreBridge.createWorkspace(name, folder);
      const created =
        createdSnap.workspaces.find((workspace) => workspace.folder === folder) ??
        createdSnap.workspaces.find((workspace) => workspace.name === name);
      if (!created) throw new Error("Project was created but could not be selected.");
      setNewChatProjectModal(null);
      onCreateteChatThread(created.id);
    } catch (error) {
      setNewChatError((error as Error).message);
    } finally {
      setNewChatBusy(false);
    }
  }

  function toggleSection(section: keyof typeof collapsedSections) {
    setCollapsedSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  function toggleNavGroup(section: NonNullable<NavItem["navSection"]>) {
    setCollapsedNavGroups((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  const activeThreads = chatThreads.filter((thread) => thread.status === "active");
  const archivedThreads = chatThreads.filter((thread) => thread.status === "archived");
  const newChatProjects = newChatWorkspaces
    .filter((project) => project.id !== PERSONAL_WORKSPACE_ID)
    .filter((project) => {
      const query = newChatQuery.trim().toLowerCase();
      if (!query) return true;
      return `${project.name} ${project.folder ?? ""}`.toLowerCase().includes(query);
    })
    .slice(0, NEW_CHAT_PROJECT_LIMIT);
  const groupedNavItems = (["work", "create", "workspace", "more"] as const)
    .map((section) => ({
      section,
      items: navItems
        .filter((item) => item.id !== "chat" && navSectionForItem(item) === section)
        .sort((a, b) => navOrder(a) - navOrder(b)),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <aside className="nav-drawer" aria-label={t("sidebar.mainMenu")}>
      <div className="drawer-topbar">
        <button className="drawer-new-chat-action" type="button" onClick={openNewChatMenu}>
          <Pencil size={15} />
          <span>{t("sidebar.newChat")}</span>
        </button>
        <button className="drawer-search-action" type="button" onClick={onSearchChat}>
          <Search size={15} />
          <span>{t("sidebar.search")}</span>
        </button>
      </div>

      {/* Discreet "update available" pill — replaces the retired notification bell/page.
          Renders nothing unless an update is actually pending. */}
      <UpdatePill />

      <nav className="drawer-nav linear-sidebar-nav" aria-label="Workspace navigation">
        {groupedNavItems.map(({ section, items }) => (
          <section className="drawer-nav-group" key={section}>
            <button
              className="drawer-nav-group-label"
              type="button"
              onClick={() => toggleNavGroup(section)}
            >
              <span>{NAV_SECTION_LABELS[section]}</span>
            </button>
            {!collapsedNavGroups[section] &&
              items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={`drawer-nav-item ${activeView === item.id ? "active" : ""}`}
                    key={item.id}
                    type="button"
                    data-nav-section={section}
                    data-promoted={item.promoted === true ? "true" : "false"}
                    onClick={() => onNavigate(item.id)}
                  >
                    <Icon size={16} />
                    <span>{t(item.label)}</span>
                    {item.badge && <em>{item.badge}</em>}
                  </button>
                );
              })}
          </section>
        ))}
      </nav>

      <div className="drawer-scroll">
        <ProjectsNav
          activeView={activeView}
          activeThreadId={activeThreadId}
          activeThreads={activeThreads}
          busyThreadIds={busyThreadIds}
          onArchiveChatThread={onArchiveChatThread}
          onSelectThread={onSelectThread}
          onCreateteChatThread={onCreateteChatThread}
          onSetChatThreadPinned={onSetChatThreadPinned}
          onThreadContextMenu={(thread, event) => {
            event.preventDefault();
            setThreadMenu({ thread, x: event.clientX, y: event.clientY });
          }}
        />

        {archivedThreads.length > 0 && (
          <section className="drawer-section">
            <button
              className="drawer-section-title"
              type="button"
              onClick={() => toggleSection("archived")}
            >
              <span>{t("sidebar.archived")}</span>
              {collapsedSections.archived ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            </button>
            {!collapsedSections.archived &&
              archivedThreads.map((thread) => (
                <ThreadLink
                  active={thread.threadId === activeThreadId && activeView === "chat"}
                  busy={busyThreadIds.has(thread.threadId)}
                  key={thread.threadId}
                  thread={thread}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setThreadMenu({
                      thread,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onSelect={() => onSelectThread(thread.threadId)}
                />
              ))}
          </section>
        )}
      </div>

      {deleteCandidate && (
        <div className="confirm-modal-backdrop" role="presentation">
          <div className="confirm-modal" role="dialog" aria-label={t("sidebar.deleteChatTitle")}>
            <header>
              <strong>{t("sidebar.deleteChatTitle")}</strong>
              <button
                className="icon-button"
                type="button"
                aria-label={t("sidebar.closeConfirm")}
                onClick={() => setDeleteCandidate(null)}
              >
                <X size={17} />
              </button>
            </header>
            <p>{deleteCandidate.title}</p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDeleteCandidate(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  onDeleteChatThread(deleteCandidate.threadId);
                  setDeleteCandidate(null);
                }}
              >
                Delete
              </button>
            </footer>
          </div>
        </div>
      )}

      {newChatMenu && (
        <div
          className="thread-context-menu drawer-new-chat-menu"
          role="menu"
          style={{ left: newChatMenu.x, top: newChatMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <label className="drawer-new-chat-search">
            <Search size={14} />
            <input
              autoFocus
              placeholder="Search projects..."
              value={newChatQuery}
              onChange={(event) => setNewChatQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            role="menuitem"
            disabled={newChatBusy}
            onClick={() => {
              setNewChatMenu(null);
              onCreateteChatThread(PERSONAL_WORKSPACE_ID);
            }}
          >
            <Pencil size={15} />
            <span>{t("sidebar.personal")}</span>
          </button>
          {newChatProjects.length > 0 && (
            <div className="drawer-new-chat-projects" role="group" aria-label="Projects">
              {!newChatQuery.trim() && <span className="drawer-new-chat-label">Recent projects</span>}
              {newChatProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  disabled={newChatBusy}
                  title={project.folder ?? project.name}
                  onClick={() => {
                    setNewChatMenu(null);
                    onCreateteChatThread(project.id);
                  }}
                >
                  <FolderOpen size={15} />
                  <span>{project.name}</span>
                </button>
              ))}
            </div>
          )}
          {newChatQuery.trim() && newChatProjects.length === 0 && (
            <p className="drawer-new-chat-empty">No matching projects</p>
          )}
          <div className="drawer-new-chat-actions">
            <button
              type="button"
              role="menuitem"
              disabled={newChatBusy}
              onClick={() => {
                setNewChatMenu(null);
                setNewChatProjectModal({ name: "", folder: null });
              }}
            >
              <FolderPlus size={15} />
              <span>{t("sidebar.newProject")}...</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={newChatBusy}
              onClick={() => void createProjectFromFolder()}
            >
              <FolderOpen size={15} />
              <span>Use existing folder...</span>
            </button>
          </div>
          {newChatError && <p className="drawer-new-chat-error">{newChatError}</p>}
        </div>
      )}

      {newChatProjectModal && (
        <div
          className="confirm-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!newChatBusy) setNewChatProjectModal(null);
          }}
        >
          <div
            className="confirm-modal"
            role="dialog"
            aria-label={t("sidebar.newProject")}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <strong>{t("sidebar.newProject")}</strong>
              <button
                className="icon-button"
                type="button"
                aria-label={t("sidebar.close")}
                disabled={newChatBusy}
                onClick={() => setNewChatProjectModal(null)}
              >
                <X size={17} />
              </button>
            </header>
            <p className="drawer-modal-hint">
              {t("sidebar.projectFolderHintPre")}
              <strong>{t("sidebar.projectFolderHintBold")}</strong>
              {t("sidebar.projectFolderHintPost")}
            </p>
            <input
              className="set-input drawer-modal-input"
              autoFocus
              placeholder={t("sidebar.projectNamePlaceholder")}
              value={newChatProjectModal.name}
              onChange={(event) =>
                setNewChatProjectModal((current) =>
                  current ? { ...current, name: event.target.value } : current,
                )
              }
            />
            <button
              className="workspace-switcher-folder-pick"
              type="button"
              disabled={newChatBusy}
              title={newChatProjectModal.folder ?? t("sidebar.projectFolderTitle")}
              onClick={() => void pickNewChatProjectFolder()}
            >
              <FolderPlus size={13} />
              <span>
                {newChatProjectModal.folder
                  ? folderDisplayName(newChatProjectModal.folder)
                  : t("sidebar.pickFolder")}
              </span>
            </button>
            {newChatError && <p className="drawer-new-chat-error">{newChatError}</p>}
            <footer>
              <button
                className="secondary-button"
                type="button"
                disabled={newChatBusy}
                onClick={() => setNewChatProjectModal(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  newChatBusy ||
                  !newChatProjectModal.name.trim() ||
                  !newChatProjectModal.folder
                }
                onClick={() => void saveNewChatProject()}
              >
                Create
              </button>
            </footer>
          </div>
        </div>
      )}

      {threadMenu && (
        <div
          className="thread-context-menu"
          role="menu"
          style={{ left: threadMenu.x, top: threadMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {threadMenu.thread.status === "archived" && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                runThreadAction(() =>
                  onUnarchiveChatThread(threadMenu.thread.threadId),
                )
              }
            >
              <ArchiveRestore size={15} />
              <span>{t("sidebar.removeFromArchive")}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setRenameTarget({
                threadId: threadMenu.thread.threadId,
                title: threadMenu.thread.title,
                x: threadMenu.x,
                y: threadMenu.y,
              });
              setThreadMenu(null);
            }}
          >
            <Pencil size={15} />
            <span>{t("sidebar.rename")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setTagMenu({
                entityType: "thread",
                entityId: threadMenu.thread.threadId,
                x: threadMenu.x,
                y: threadMenu.y,
              });
              setThreadMenu(null);
            }}
          >
            <TagIcon size={15} />
            <span>{t("tags.menuLabel")}</span>
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => runThreadAction(() => setDeleteCandidate(threadMenu.thread))}
          >
            <Trash2 size={15} />
            <span>{t("common.delete")}</span>
          </button>
        </div>
      )}

      {tagMenu && (
        <TagMenu
          entityType={tagMenu.entityType}
          entityId={tagMenu.entityId}
          x={tagMenu.x}
          y={tagMenu.y}
          onClose={() => setTagMenu(null)}
        />
      )}

      {renameTarget && (
        <RenamePopover
          initial={renameTarget.title}
          x={renameTarget.x}
          y={renameTarget.y}
          onClose={() => setRenameTarget(null)}
          onSubmit={(title) => {
            void onRenameChatThread(renameTarget.threadId, title);
            setRenameTarget(null);
          }}
        />
      )}

      <footer className="drawer-footer">
        <div className="drawer-persistent-actions" aria-label={t("sidebar.persistentActions")}>
          <button
            className="drawer-footer-action drawer-settings-action"
            type="button"
            aria-label={t("sidebar.settings")}
            title={t("sidebar.settings")}
            onClick={() => onNavigate("settings")}
          >
            <Settings size={16} />
          </button>
          <button
            className="drawer-footer-action drawer-toggle-action"
            type="button"
            aria-label={t("sidebar.collapseSidebar")}
            title={t("sidebar.collapseSidebar")}
            onClick={onToggleDrawer}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
      </footer>
    </aside>
  );
}

// Inline expandable submenus, keyed by section id. When a section with an entry
// here is active, its sub-items render as `.set-subnav-item`s under the nav item.
// `defaultSub` is selected when the section is opened from a plain nav click.
const SETTINGS_SUBNAV: Partial<
  Record<SettingsSectionId, { defaultSub: string; items: Array<{ id: string; label: string }> }>
> = {
  runtime: {
    defaultSub: "routing",
    items: [
      { id: "routing", label: "settings.subnavRouting" },
      { id: "decisions", label: "settings.subnavDecisions" },
      { id: "providers", label: "settings.subnavProviders" },
    ],
  },
  connections: {
    defaultSub: "composio",
    items: [
      { id: "composio", label: "Composio" },
      { id: "mcp", label: "MCP" },
      { id: "attivita", label: "settings.subnavActivity" },
    ],
  },
};

interface SettingsDrawerProps {
  activeSection: SettingsSectionId;
  activeSub: string;
  onBack: () => void;
  onSelect: (section: SettingsSectionId) => void;
  onSelectSub: (sub: string) => void;
}

export function SettingsDrawer({
  activeSection,
  activeSub,
  onBack,
  onSelect,
  onSelectSub,
}: SettingsDrawerProps) {
  const { t } = useTranslation();
  const [displayName] = useSetting("displayName", "");
  const [workspaceName] = useSetting("workspaceName", "Personal");
  const [profileImage] = useSetting("profileImage", "");
  const groups: Array<"account" | "capabilities"> = ["account", "capabilities"];
  return (
    <aside className="nav-drawer settings-drawer set-nav" aria-label={t("sidebar.settings")}>
      <button className="set-nav-back" type="button" onClick={onBack}>
        <ArrowLeft size={15} />
        <span>{t("sidebar.backToApp")}</span>
      </button>

      <div className="set-nav-profile">
        {profileImage ? (
          <img className="set-nav-avatar set-nav-avatar-img" src={profileImage} alt="" />
        ) : (
          <span className="set-nav-avatar" aria-hidden />
        )}
        <span className="set-nav-id">
          <span className="n">{displayName || t("sidebar.account")}</span>
          <span className="w">{workspaceName || "Personal"}</span>
        </span>
      </div>

      <nav className="drawer-nav settings-nav">
        {groups.map((group) => (
          <div key={group}>
            <div className="set-nav-group">{t(settingsGroupLabels[group])}</div>
            {settingsSections
              .filter((item) => item.group === group)
              .map((item) => {
                const Icon = item.icon;
                const submenu = SETTINGS_SUBNAV[item.id];
                const isActive = activeSection === item.id;
                return (
                  <div key={item.id}>
                    <button
                      className={`set-nav-item ${isActive ? "active" : ""}`}
                      type="button"
                      onClick={() => {
                        onSelect(item.id);
                        // Entering a section with a submenu lands on its default
                        // sub-item (preserves the current sub if already inside).
                        if (submenu) {
                          onSelectSub(
                            isActive && activeSub ? activeSub : submenu.defaultSub,
                          );
                        }
                      }}
                    >
                      <Icon size={16} />
                      <span>{t(item.label)}</span>
                    </button>
                    {submenu && isActive &&
                      submenu.items.map((sub) => (
                        <button
                          className={`set-subnav-item ${
                            (activeSub || submenu.defaultSub) === sub.id ? "active" : ""
                          }`}
                          key={sub.id}
                          type="button"
                          onClick={() => {
                            onSelect(item.id);
                            onSelectSub(sub.id);
                          }}
                        >
                          <span>{t(sub.label)}</span>
                        </button>
                      ))}
                  </div>
                );
              })}
          </div>
        ))}
      </nav>

      <span className="set-nav-spacer" />
    </aside>
  );
}

interface ChatSearchModalProps {
  chatThreads: ChatThread[];
  onClose: () => void;
  onSelectThread: (threadId: string) => void;
}

export function ChatSearchModal({
  chatThreads,
  onClose,
  onSelectThread,
}: ChatSearchModalProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searchResults = chatThreads
    .filter((thread) => {
      if (!normalizedQuery) return true;
      return `${thread.title} ${thread.subtitle}`
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .slice(0, 9);

  return (
    <div className="search-modal-backdrop" role="presentation">
      <div className="chat-search-modal" role="dialog" aria-label={t("sidebar.searchChat")}>
        <header>
          <strong>{t("sidebar.searchChat")}</strong>
          <button
            className="icon-button"
            type="button"
            aria-label={t("sidebar.closeSearch")}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <label className="chat-search-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder={t("sidebar.searchInChats")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>
        <div className="chat-search-results">
          <small>{normalizedQuery ? t("sidebar.results") : t("sidebar.recentChats")}</small>
          {searchResults.map((thread, index) => (
            <button
              className="chat-search-row"
              type="button"
              key={thread.threadId}
              onClick={() => onSelectThread(thread.threadId)}
            >
              <span>{thread.title}</span>
              <em>homun</em>
              <kbd>⌘{index + 1}</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Leading per-type glyph so chat / scheduled / channel are distinguishable at a
// glance (the design's #1 sidebar fix). Normal chats get an empty slot so titles
// stay aligned. Custom outline icons matching the design language.
function threadTypeIcon(
  source: string | null | undefined,
  t: (key: string) => string,
): { node: ReactNode; label: string } | null {
  if (source === "scheduled") {
    return {
      label: t("sidebar.scheduled"),
      node: (
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8 V12 L15 14" />
        </svg>
      ),
    };
  }
  if (source === "whatsapp") {
    return {
      label: "WhatsApp",
      node: (
        <svg viewBox="0 0 24 24" fill="var(--green)">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.521.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
        </svg>
      ),
    };
  }
  if (source === "telegram") {
    return {
      label: "Telegram",
      node: (
        <svg viewBox="0 0 24 24" fill="#2a7fb8">
          <path d="M21 5 L2.5 12 L8 13.5 L9 19 L12 15.5 L16.5 18.5 Z" />
        </svg>
      ),
    };
  }
  return null;
}

/** Small inline rename field for a chat, opened from the thread context menu. Enter commits,
 *  Escape / outside-click cancels — no modal, keeps the sidebar interaction lightweight. */
function RenamePopover({
  initial,
  x,
  y,
  onClose,
  onSubmit,
}: {
  initial: string;
  x: number;
  y: number;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onClose();
  };

  return (
    <div
      ref={ref}
      className="rename-popover"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        className="rename-popover-input"
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") onClose();
        }}
      />
    </div>
  );
}

function ThreadLink({
  active,
  busy,
  onArchive,
  onContextMenu,
  onMore,
  onPinToggle,
  onSelect,
  thread,
  tags,
}: {
  active: boolean;
  busy?: boolean;
  onArchive?: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onMore?: (event: MouseEvent<HTMLButtonElement>) => void;
  onPinToggle?: () => void;
  onSelect: () => void;
  thread: ChatThread;
  tags?: Tag[];
}) {
  const { t } = useTranslation();
  const icon = threadTypeIcon(thread.source, t);
  return (
    <div
      className={`drawer-thread-row ${active ? "active" : ""} ${thread.pinned ? "pinned" : ""}`}
      onContextMenu={onContextMenu}
    >
      <button
        className="drawer-link drawer-thread-main"
        type="button"
        aria-busy={busy || undefined}
        onClick={onSelect}
      >
        <span className="drawer-link-icon" title={icon?.label} aria-label={icon?.label}>
          {icon?.node}
        </span>
        <span className="drawer-link-title">
          {busy && <span className="thread-busy-dot" aria-hidden="true" />}
          {thread.title}
        </span>
        {tags && tags.length > 0 && (
          <span className="tag-chips" aria-hidden="true">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className="tag-chip-dot"
                style={{ background: tag.color }}
                title={tag.name}
              />
            ))}
          </span>
        )}
        <span className="drawer-thread-time">{formatThreadRelativeTime(thread.updatedAt)}</span>
      </button>
      {(onPinToggle || onArchive || onMore) && (
        <span className="drawer-thread-actions" aria-label="Thread actions">
          {onPinToggle && (
            <button
              className="drawer-thread-action"
              type="button"
              aria-label={thread.pinned ? "Unpin chat" : "Pin chat"}
              onClick={(event) => {
                event.stopPropagation();
                onPinToggle();
              }}
            >
              {thread.pinned ? <PinOff size={12} /> : <Pin size={12} />}
            </button>
          )}
          {onArchive && (
            <button
              className="drawer-thread-action"
              type="button"
              aria-label={t("sidebar.archive")}
              onClick={(event) => {
                event.stopPropagation();
                onArchive();
              }}
            >
              <Archive size={12} />
            </button>
          )}
          {onMore && (
            <button
              className="drawer-thread-action"
              type="button"
              aria-label={t("chat.moreActions")}
              onClick={(event) => {
                event.stopPropagation();
                onMore(event);
              }}
            >
              <MoreHorizontal size={13} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function formatThreadRelativeTime(updatedAt: string): string {
  if (!updatedAt) return "";
  const numeric = Number(updatedAt);
  const timestamp = Number.isFinite(numeric)
    ? numeric > 1_000_000_000_000
      ? numeric
      : numeric * 1000
    : Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) return updatedAt;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "ora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} g`;
}
