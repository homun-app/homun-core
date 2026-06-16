import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  User,
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
  const [busy, setBusy] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showChannels, setShowChannels] = useState(true);
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
  const activeProjectName = projects.find((w) => w.id === activeWorkspaceId)?.name;
  const q = query.trim().toLowerCase();
  const filteredProjects = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects;
  // Chats of the ACTIVE context. Channels (WhatsApp/Telegram) live in the personal
  // scope and are mixed straight into the list — ordered by recency like every other
  // thread (their leading type icon is what tells them apart). The "homun" thread is
  // excluded (retired). Backend order is already `pinned desc, updated_at desc`.
  const personalSource = (inProject ? personalThreads : activeThreads).filter(
    (t) => t.status === "active",
  );
  const contextChats = inProject
    ? activeThreads.filter((t) => t.status === "active" && t.threadId !== "homun")
    : personalSource.filter((t) => t.threadId !== "homun");

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

  return (
    <>
      {/* Context switcher (IDE-style): scales to many projects via search + recents. */}
      <div className="ctx-switcher-wrap">
        <button
          className="ctx-switcher"
          type="button"
          disabled={busy}
          onClick={() => setSwitcherOpen((v) => !v)}
        >
          {inProject ? (
            <FolderOpen size={14} />
          ) : (
            <span className="ctx-switcher-chip" aria-hidden="true" />
          )}
          <span className="ctx-switcher-name">
            {inProject ? (activeProjectName ?? t("sidebar.project")) : t("sidebar.personal")}
          </span>
          <ChevronDown size={14} />
        </button>
        {switcherOpen && (
          <>
            <div
              className="ctx-menu-backdrop"
              role="presentation"
              onClick={() => setSwitcherOpen(false)}
            />
            <div className="ctx-menu" role="menu">
              <input
                className="ctx-menu-search"
                placeholder={t("sidebar.searchProject")}
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                className={`ctx-menu-item ${!inProject ? "active" : ""}`}
                type="button"
                onClick={() => {
                  setSwitcherOpen(false);
                  if (inProject) void selectProject(PERSONAL_WORKSPACE_ID);
                }}
              >
                <User size={14} />
                <span>{t("sidebar.personal")}</span>
                {!inProject && <Check size={14} />}
              </button>
              <div className="ctx-menu-label">{t("sidebar.projects")}</div>
              {filteredProjects.length === 0 && <p className="ctx-menu-empty">{t("sidebar.noProjects")}</p>}
              {filteredProjects.map((project) =>
                editingId === project.id ? (
                  <div key={project.id} className="ctx-menu-edit">
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void renameProject(project.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <div className="ctx-menu-edit-actions">
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
                ) : (
                  <div key={project.id} className="ctx-menu-row">
                    <button
                      className={`ctx-menu-item ${project.id === activeWorkspaceId ? "active" : ""}`}
                      type="button"
                      onClick={() => {
                        setSwitcherOpen(false);
                        if (project.id !== activeWorkspaceId) void selectProject(project.id);
                      }}
                    >
                      <FolderOpen size={14} />
                      <span>{project.name}</span>
                      {project.id === activeWorkspaceId && <Check size={14} />}
                    </button>
                    <button
                      className="ctx-menu-edit-btn"
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
                ),
              )}
              <button
                className="ctx-menu-create"
                type="button"
                onClick={() => {
                  setSwitcherOpen(false);
                  setNewName("");
                  setNewFolder(null);
                  setError(null);
                  setCreateting(true);
                }}
              >
                <FolderPlus size={14} />
                <span>{t("sidebar.newProject")}</span>
              </button>
            </div>
          </>
        )}
      </div>

      <div className="drawer-chats-head">
        <span className="drawer-eyebrow">{t("sidebar.chat")}</span>
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

      <section className="drawer-section drawer-chats">
        {contextChats.length === 0 && <p className="drawer-empty">{t("sidebar.noChatsYet")}</p>}
        {contextChats.map((thread) => (
          <ThreadLink
            key={thread.threadId}
            active={thread.threadId === activeThreadId && activeView === "chat"}
            busy={busyThreadIds.has(thread.threadId)}
            thread={thread}
            onContextMenu={(e) => onThreadContextMenu(thread, e)}
            onSelect={() => {
              if (inProject) onSelectThread(thread.threadId);
              else void openPersonalThread(thread.threadId);
            }}
          />
        ))}
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
}: NavDrawerProps) {
  const { t } = useTranslation();
  const notifCount = useNotificationCount();
  const [collapsedSections, setCollapsedSections] = useState({
    archived: false,
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

  const activeThreads = chatThreads.filter((thread) => thread.status === "active");
  const archivedThreads = chatThreads.filter((thread) => thread.status === "archived");
  return (
    <aside className="nav-drawer" aria-label={t("sidebar.mainMenu")}>
      <button
        className="drawer-collapse"
        type="button"
        aria-label={t("sidebar.collapseSidebar")}
        onClick={onToggleDrawer}
      >
        <PanelLeftClose size={18} />
      </button>

      <nav className="drawer-nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isSearch = item.id === "chat";
          return (
            <button
              className={`drawer-nav-item ${
                !isSearch && activeView === item.id ? "active" : ""
              }`}
              key={item.id}
              type="button"
              onClick={() => (isSearch ? onSearchChat() : onNavigate(item.id))}
            >
              {isSearch ? <Search size={17} /> : <Icon size={17} />}
              <span>{isSearch ? t("sidebar.search") : t(item.label)}</span>
              {item.badge && <em>{item.badge}</em>}
            </button>
          );
        })}
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
      { id: "fs", label: "filesystem" },
      { id: "catalogo", label: "settings.subnavCatalog" },
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
      <button className="set-nav-item" type="button" onClick={onBack}>
        <Info size={16} />
        <span>{t("common.information")}</span>
      </button>

      {/* Persistent footer — mirrors the main drawer's [bell + gear], but in Settings
          the gear becomes a back-to-app arrow (you're already in Settings). */}
      <footer className="drawer-footer">
        <div className="drawer-persistent-actions" aria-label={t("sidebar.persistentActions")}>
          <button
            className="drawer-footer-action"
            type="button"
            aria-label={t("sidebar.notifications")}
            title={t("sidebar.notifications")}
          >
            <Bell size={16} />
          </button>
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
