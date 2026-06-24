import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Bell,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { settingsGroupLabels, settingsSections } from "../data/mockData";
import type { ChatThread, NavItem, SettingsSectionId, ViewId } from "../types";
import { useSetting } from "../lib/settingsStore";
import { coreBridge, type CoreChatThread, type WorkspaceRecord } from "../lib/coreBridge";
import { useNotificationCount } from "../lib/useNotificationCount";

// The base personal workspace ("Predefinito"): always present, never a "project".
const PERSONAL_WORKSPACE_ID = "local-workspace";
const NAV_SECTION_LABELS: Record<NonNullable<NavItem["navSection"]>, string> = {
  work: "Work",
  create: "Create",
  workspace: "Workspace",
  more: "More",
};

function navSectionForItem(item: NavItem): NonNullable<NavItem["navSection"]> {
  if (item.navSection) return item.navSection;
  if (item.id === "automations" || item.id === "tasks") return "work";
  if (item.id === "memory" || item.id === "connections" || item.id === "browser") return "workspace";
  return "more";
}

function navOrder(item: NavItem): number {
  if (typeof item.order === "number") return item.order;
  if (item.id === "automations") return 20;
  if (item.id === "tasks") return 10;
  if (item.id === "memory") return 20;
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
  const notifCount = useNotificationCount();
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
          className={`rail-button has-badge ${activeView === "notifications" ? "active" : ""}`}
          type="button"
          aria-label={t("sidebar.notifications")}
          onClick={() => onNavigate("notifications")}
        >
          <Bell size={18} />
          {notifCount > 0 && <span className="nav-badge">{notifCount}</span>}
        </button>
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
  onSelectThread: (threadId: string) => void;
  onCreateteChatThread: () => void;
  onThreadContextMenu: (thread: ChatThread, event: MouseEvent<HTMLButtonElement>) => void;
}

function ProjectsNav({
  activeView,
  activeThreadId,
  activeThreads,
  busyThreadIds,
  onSelectThread,
  onCreateteChatThread,
  onThreadContextMenu,
}: ProjectsNavProps) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(PERSONAL_WORKSPACE_ID);
  const [personalThreads, setPersonalThreads] = useState<ChatThread[]>([]);
  const [projectThreadsById, setProjectThreadsById] = useState<Record<string, ChatThread[]>>({});
  const [busy, setBusy] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({ personal: true, projects: true });
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [creating, setCreateting] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function renameProject(id: string) {
    const name = editName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await coreBridge.renameWorkspace(id, name);
      await reloadWorkspaces();
      setEditingId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function linkProjectFolder(id: string) {
    const folder = await coreBridge.pickFolder();
    if (!folder) return;
    setBusy(true);
    try {
      await coreBridge.setWorkspaceFolder(id, folder);
      await reloadWorkspaces();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteProject(id: string) {
    setBusy(true);
    try {
      await coreBridge.deleteWorkspace(id);
      if (id === activeWorkspaceId) {
        window.location.reload();
        return;
      }
      await reloadWorkspaces();
      setEditingId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pickNewFolder() {
    const folder = await coreBridge.pickFolder();
    if (folder) setNewFolder(folder);
  }
  async function createProject() {
    const name = newName.trim();
    if (!name || !newFolder) return;
    setBusy(true);
    setError(null);
    try {
      const snap = await coreBridge.createWorkspace(name, newFolder);
      const created = snap.workspaces.find((w) => w.name === name);
      if (created) {
        await coreBridge.selectWorkspace(created.id);
        window.location.reload();
      } else {
        setBusy(false);
        setCreateting(false);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function renderThreadList(
    threads: ChatThread[],
    emptyLabel: string,
    onSelect: (thread: ChatThread) => void,
  ) {
    if (threads.length === 0) return <p className="drawer-empty">{emptyLabel}</p>;
    return threads.map((thread) => (
      <ThreadLink
        key={thread.threadId}
        active={thread.threadId === activeThreadId && activeView === "chat"}
        busy={busyThreadIds.has(thread.threadId)}
        thread={thread}
        onContextMenu={(e) => onThreadContextMenu(thread, e)}
        onSelect={() => onSelect(thread)}
      />
    ));
  }

  return (
    <>
      <section className="drawer-section drawer-personal-tree" data-project-tree="personal">
        <div className="drawer-chats-head">
          <button className="drawer-section-toggle" type="button" onClick={togglePersonal}>
            {expandedGroups.personal ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{t("sidebar.personal")}</span>
          </button>
          <button
            className="drawer-eyebrow-add"
            type="button"
            disabled={busy}
            onClick={onCreateteChatThread}
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
            {expandedGroups.projects ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{t("sidebar.projects")}</span>
          </button>
          <button
            className="drawer-eyebrow-add"
            type="button"
            disabled={busy}
            onClick={() => {
              setNewName("");
              setNewFolder(null);
              setError(null);
              setCreateting(true);
            }}
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
                    </button>
                    <button
                      className="drawer-edit-btn"
                      type="button"
                      aria-label={`Edit ${project.name}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingId(project.id);
                        setEditName(project.name);
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                  </div>
                  {editingId === project.id && (
                    <div className="drawer-project-edit">
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void renameProject(project.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                      <div className="drawer-project-edit-actions">
                        <button
                          className="link-button"
                          type="button"
                          disabled={busy}
                          title={project.folder ?? t("sidebar.noFolder")}
                          onClick={() => void linkProjectFolder(project.id)}
                        >
                          {t("sidebar.folder")}
                        </button>
                        <button
                          className="link-button danger"
                          type="button"
                          disabled={busy}
                          onClick={() => void deleteProject(project.id)}
                        >
                          Delete
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={busy || !editName.trim()}
                          onClick={() => void renameProject(project.id)}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
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

      {creating && (
        <div
          className="confirm-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!busy) setCreateting(false);
          }}
        >
          <div
            className="confirm-modal"
            role="dialog"
            aria-label={t("sidebar.newProject")}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <strong>{t("sidebar.newProject")}</strong>
              <button
                className="icon-button"
                type="button"
                aria-label={t("sidebar.close")}
                onClick={() => setCreateting(false)}
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
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              className="workspace-switcher-folder-pick"
              type="button"
              disabled={busy}
              title={newFolder ?? t("sidebar.projectFolderTitle")}
              onClick={() => void pickNewFolder()}
            >
              <FolderPlus size={13} />
              <span>{newFolder ? newFolder.split("/").pop() : t("sidebar.pickFolder")}</span>
            </button>
            <footer>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setCreateting(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy || !newName.trim() || !newFolder}
                onClick={() => void createProject()}
              >
                Create
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
  onCreateteChatThread: () => void;
  onDeleteChatThread: (threadId: string) => void;
  onNavigate: (view: ViewId) => void;
  onSearchChat: () => void;
  onSelectThread: (threadId: string) => void;
  onSetChatThreadPinned: (threadId: string, pinned: boolean) => void;
  onToggleDrawer: () => void;
  onUnarchiveChatThread: (threadId: string) => void;
  presentation?: "pinned" | "floating";
}

export function NavDrawer({
  activeView,
  activeThreadId,
  busyThreadIds,
  chatThreads,
  navItems,
  onArchiveChatThread,
  onCreateteChatThread,
  onDeleteChatThread,
  onNavigate,
  onSearchChat,
  onSelectThread,
  onSetChatThreadPinned,
  onToggleDrawer,
  onUnarchiveChatThread,
  presentation = "pinned",
}: NavDrawerProps) {
  const { t } = useTranslation();
  const notifCount = useNotificationCount();
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
  const [threadMenu, setThreadMenu] = useState<{
    thread: ChatThread;
    x: number;
    y: number;
  } | null>(null);

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
  const groupedNavItems = (["work", "create", "workspace", "more"] as const)
    .map((section) => ({
      section,
      items: navItems
        .filter((item) => item.id !== "chat" && navSectionForItem(item) === section)
        .sort((a, b) => navOrder(a) - navOrder(b)),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <aside className={`nav-drawer ${presentation === "floating" ? "floating-island" : ""}`} aria-label={t("sidebar.mainMenu")}>
      <div className="drawer-topbar">
        <button className="drawer-search-action" type="button" onClick={onSearchChat}>
          <Search size={15} />
          <span>{t("sidebar.search")}</span>
        </button>
        <button
          className="drawer-new-action"
          type="button"
          onClick={onCreateteChatThread}
          aria-label={t("sidebar.newChat")}
          title={t("sidebar.newChat")}
        >
          <Plus size={15} />
        </button>
      </div>

      <nav className="drawer-nav linear-sidebar-nav" aria-label="Workspace navigation">
        {groupedNavItems.map(({ section, items }) => (
          <section className="drawer-nav-group" key={section}>
            <button
              className="drawer-nav-group-label"
              type="button"
              onClick={() => toggleNavGroup(section)}
            >
              {collapsedNavGroups[section] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
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
          onSelectThread={onSelectThread}
          onCreateteChatThread={onCreateteChatThread}
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

      {threadMenu && (
        <div
          className="thread-context-menu"
          role="menu"
          style={{ left: threadMenu.x, top: threadMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {threadMenu.thread.status === "active" && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runThreadAction(() =>
                    onSetChatThreadPinned(
                      threadMenu.thread.threadId,
                      !threadMenu.thread.pinned,
                    ),
                  )
                }
              >
                {threadMenu.thread.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                <span>{threadMenu.thread.pinned ? "Remove pin" : "Pin in alto"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runThreadAction(() => onArchiveChatThread(threadMenu.thread.threadId))
                }
              >
                <Archive size={15} />
                <span>{t("sidebar.archive")}</span>
              </button>
            </>
          )}
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

      <footer className="drawer-footer">
        <div className="drawer-persistent-actions" aria-label={t("sidebar.persistentActions")}>
          <button
            className="drawer-footer-action has-badge"
            type="button"
            aria-label={t("sidebar.notifications")}
            title={t("sidebar.notifications")}
            onClick={() => onNavigate("notifications")}
          >
            <Bell size={16} />
            {notifCount > 0 && <span className="nav-badge">{notifCount}</span>}
          </button>
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
            aria-label={presentation === "floating" ? t("sidebar.expandSidebar") : t("sidebar.collapseSidebar")}
            title={presentation === "floating" ? t("sidebar.expandSidebar") : t("sidebar.collapseSidebar")}
            onClick={onToggleDrawer}
          >
            {presentation === "floating" ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
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
  const groups: Array<"account" | "capabilities"> = ["account", "capabilities"];
  return (
    <aside className="nav-drawer settings-drawer set-nav" aria-label={t("sidebar.settings")}>
      <button className="set-nav-back" type="button" onClick={onBack}>
        <ArrowLeft size={15} />
        <span>{t("sidebar.backToApp")}</span>
      </button>

      <div className="set-nav-profile">
        <span className="set-nav-avatar" aria-hidden />
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

      {/* Persistent footer — mirrors the main drawer's [bell + gear], but in Settings
          the gear becomes a back-to-app arrow (you're already in Settings). */}
      <footer className="drawer-footer">
        <div className="drawer-persistent-actions" aria-label={t("sidebar.persistentActions")}>
          <button
            className="drawer-footer-action"
            type="button"
            aria-label={t("sidebar.backToApp")}
            title={t("sidebar.backToApp")}
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </button>
        </div>
      </footer>
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

function ThreadLink({
  active,
  busy,
  onContextMenu,
  onSelect,
  thread,
}: {
  active: boolean;
  busy?: boolean;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onSelect: () => void;
  thread: ChatThread;
}) {
  const { t } = useTranslation();
  const icon = threadTypeIcon(thread.source, t);
  return (
    <button
      className={`drawer-link ${active ? "active" : ""} ${thread.pinned ? "pinned" : ""}`}
      type="button"
      aria-busy={busy || undefined}
      onContextMenu={onContextMenu}
      onClick={onSelect}
    >
      <span className="drawer-link-icon" title={icon?.label} aria-label={icon?.label}>
        {icon?.node}
      </span>
      <span className="drawer-link-title">
        {busy && <span className="thread-busy-dot" aria-hidden="true" />}
        {thread.title}
      </span>
      {thread.pinned && <Pin size={12} aria-hidden="true" />}
    </button>
  );
}
