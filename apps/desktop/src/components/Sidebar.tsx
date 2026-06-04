import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Bell,
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
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { navItems, settingsGroupLabels, settingsSections } from "../data/mockData";
import type { ChatThread, SettingsSectionId, ViewId } from "../types";
import { useSetting } from "../lib/settingsStore";
import { coreBridge, type CoreChatThread, type WorkspaceRecord } from "../lib/coreBridge";

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
  onNavigate: (view: ViewId) => void;
  onSearch: () => void;
  onToggleDrawer: () => void;
}

export function NavigationRail({
  activeView,
  onNavigate,
  onSearch,
  onToggleDrawer,
}: NavigationRailProps) {
  return (
    <aside className="navigation-rail" aria-label="Navigazione rapida">
      <button
        className="rail-logo"
        type="button"
        aria-label="Apri menu"
        onClick={onToggleDrawer}
      >
        <PanelLeftOpen size={18} />
      </button>

      <nav className="rail-nav">
        <button
          className="rail-button"
          type="button"
          aria-label="Cerca"
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
              aria-label={item.label}
              title={item.label}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </nav>

      <div className="rail-bottom">
        <button className="rail-button" type="button" aria-label="Notifiche">
          <Bell size={18} />
        </button>
        <button
          className={`rail-button ${activeView === "settings" ? "active" : ""}`}
          type="button"
          aria-label="Impostazioni"
          onClick={() => onNavigate("settings")}
        >
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}

/* Projects + Personale sections (M9). Self-contained: fetches the workspace list
   and the base ("Personale") threads itself; the active project's chats come from
   the active-context `activeThreads`. Switching context re-scopes the whole app, so
   those actions reload (consistent with the rest of the workspace flow). */
interface ProjectsNavProps {
  activeView: ViewId;
  activeThreadId: string;
  activeThreads: ChatThread[];
  onSelectThread: (threadId: string) => void;
  onCreateChatThread: () => void;
  onThreadContextMenu: (thread: ChatThread, event: MouseEvent<HTMLButtonElement>) => void;
}

function ProjectsNav({
  activeView,
  activeThreadId,
  activeThreads,
  onSelectThread,
  onCreateChatThread,
  onThreadContextMenu,
}: ProjectsNavProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(PERSONAL_WORKSPACE_ID);
  const [personalThreads, setPersonalThreads] = useState<ChatThread[]>([]);
  const [busy, setBusy] = useState(false);
  const [showProjects, setShowProjects] = useState(true);
  const [showPersonal, setShowPersonal] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [creating, setCreating] = useState(false);
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

  const inProject = activeWorkspaceId !== PERSONAL_WORKSPACE_ID;
  const projects = workspaces.filter((w) => w.id !== PERSONAL_WORKSPACE_ID);
  const activeProjectName = projects.find((w) => w.id === activeWorkspaceId)?.name;
  const personalList = (inProject ? personalThreads : activeThreads).filter(
    (t) => t.status === "active",
  );

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
  async function createFreeTask() {
    if (!inProject) {
      onCreateChatThread();
      return;
    }
    setBusy(true);
    try {
      await coreBridge.createChatThread(PERSONAL_WORKSPACE_ID);
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
        setCreating(false);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      {inProject && (
        <div className="drawer-context-chip" role="status">
          <FolderOpen size={13} />
          <span>
            Sei in: <strong>{activeProjectName ?? "progetto"}</strong>
          </span>
        </div>
      )}

      <section className="drawer-section">
        <button
          className="drawer-section-title"
          type="button"
          onClick={() => setShowProjects((v) => !v)}
        >
          <span>Progetti</span>
          {showProjects ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {showProjects && (
          <>
            {projects.length === 0 && (
              <p className="drawer-empty">Nessun progetto: creane uno per lavorare in una cartella.</p>
            )}
            {projects.map((project) => {
              const isActive = project.id === activeWorkspaceId;
              if (editingId === project.id) {
                return (
                  <div key={project.id} className="drawer-project-edit">
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
                        title={project.folder ?? "Nessuna cartella"}
                        onClick={() => void linkProjectFolder(project.id)}
                      >
                        Cartella
                      </button>
                      <button
                        className="link-button danger"
                        type="button"
                        disabled={busy}
                        onClick={() => void deleteProject(project.id)}
                      >
                        Elimina
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busy || !editName.trim()}
                        onClick={() => void renameProject(project.id)}
                      >
                        Salva
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={project.id} className={`drawer-project ${isActive ? "active" : ""}`}>
                  <div className="drawer-project-row">
                    <button
                      className="drawer-link drawer-project-name"
                      type="button"
                      onClick={() => {
                        if (!isActive) void selectProject(project.id);
                      }}
                    >
                      <FolderOpen size={14} />
                      <span>{project.name}</span>
                    </button>
                    <button
                      className="drawer-edit-btn"
                      type="button"
                      aria-label={`Modifica ${project.name}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingId(project.id);
                        setEditName(project.name);
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                  </div>
                  {isActive && (
                    <div className="drawer-project-chats">
                      {activeThreads.filter((t) => t.status === "active").length === 0 && (
                        <p className="drawer-empty">Nessuna chat ancora.</p>
                      )}
                      {activeThreads
                        .filter((t) => t.status === "active")
                        .map((thread) => (
                          <ThreadLink
                            key={thread.threadId}
                            active={thread.threadId === activeThreadId && activeView === "chat"}
                            thread={thread}
                            onContextMenu={(e) => onThreadContextMenu(thread, e)}
                            onSelect={() => onSelectThread(thread.threadId)}
                          />
                        ))}
                      <button className="drawer-add-task" type="button" onClick={onCreateChatThread}>
                        <Plus size={13} />
                        <span>compito in questo progetto</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <button
              className="drawer-new-project"
              type="button"
              onClick={() => {
                setNewName("");
                setNewFolder(null);
                setError(null);
                setCreating(true);
              }}
            >
              <FolderPlus size={14} />
              <span>Nuovo progetto</span>
            </button>
          </>
        )}
      </section>

      <section className="drawer-section">
        <button
          className="drawer-section-title"
          type="button"
          onClick={() => setShowPersonal((v) => !v)}
        >
          <span>Personale{inProject ? "" : " · attivo"}</span>
          {showPersonal ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {showPersonal && (
          <>
            {personalList.length === 0 && <p className="drawer-empty">Nessun compito libero.</p>}
            {personalList.map((thread) => (
              <ThreadLink
                key={thread.threadId}
                active={!inProject && thread.threadId === activeThreadId && activeView === "chat"}
                thread={thread}
                onContextMenu={(e) => onThreadContextMenu(thread, e)}
                onSelect={() => void openPersonalThread(thread.threadId)}
              />
            ))}
            <button className="drawer-add-task" type="button" onClick={() => void createFreeTask()}>
              <Plus size={13} />
              <span>compito libero</span>
            </button>
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
            if (!busy) setCreating(false);
          }}
        >
          <div
            className="confirm-modal"
            role="dialog"
            aria-label="Nuovo progetto"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <strong>Nuovo progetto</strong>
              <button
                className="icon-button"
                type="button"
                aria-label="Chiudi"
                onClick={() => setCreating(false)}
              >
                <X size={17} />
              </button>
            </header>
            <p className="drawer-modal-hint">
              Un progetto lavora <strong>dentro una cartella</strong>: i file generati e gli
              artefatti finiscono lì.
            </p>
            <input
              className="set-input drawer-modal-input"
              autoFocus
              placeholder="Nome progetto"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              className="workspace-switcher-folder-pick"
              type="button"
              disabled={busy}
              title={newFolder ?? "Cartella del progetto"}
              onClick={() => void pickNewFolder()}
            >
              <FolderPlus size={13} />
              <span>{newFolder ? newFolder.split("/").pop() : "Scegli cartella…"}</span>
            </button>
            <footer>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Annulla
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy || !newName.trim() || !newFolder}
                onClick={() => void createProject()}
              >
                Crea
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
  chatThreads: ChatThread[];
  onArchiveChatThread: (threadId: string) => void;
  onCreateChatThread: () => void;
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
  chatThreads,
  onArchiveChatThread,
  onCreateChatThread,
  onDeleteChatThread,
  onNavigate,
  onSearchChat,
  onSelectThread,
  onSetChatThreadPinned,
  onToggleDrawer,
  onUnarchiveChatThread,
}: NavDrawerProps) {
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
    <aside className="nav-drawer" aria-label="Menu principale">
      <header className="drawer-header">
        <div>
          <strong>Assistant locale</strong>
          <small>local-first · multi-modello</small>
        </div>
        <button className="icon-button" type="button" aria-label="Chiudi menu" onClick={onToggleDrawer}>
          <PanelLeftClose size={18} />
        </button>
      </header>

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
              <span>{isSearch ? "Cerca" : item.label}</span>
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
          onSelectThread={onSelectThread}
          onCreateChatThread={onCreateChatThread}
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
              <span>Archiviati</span>
              {collapsedSections.archived ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            </button>
            {!collapsedSections.archived &&
              archivedThreads.map((thread) => (
                <ThreadLink
                  active={thread.threadId === activeThreadId && activeView === "chat"}
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
          <div className="confirm-modal" role="dialog" aria-label="Conferma eliminazione">
            <header>
              <strong>Eliminare questa chat?</strong>
              <button
                className="icon-button"
                type="button"
                aria-label="Chiudi conferma"
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
                Annulla
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  onDeleteChatThread(deleteCandidate.threadId);
                  setDeleteCandidate(null);
                }}
              >
                Elimina
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
                <span>{threadMenu.thread.pinned ? "Rimuovi pin" : "Pin in alto"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runThreadAction(() => onArchiveChatThread(threadMenu.thread.threadId))
                }
              >
                <Archive size={15} />
                <span>Archivia</span>
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
              <span>Rimuovi dall'archivio</span>
            </button>
          )}
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => runThreadAction(() => setDeleteCandidate(threadMenu.thread))}
          >
            <Trash2 size={15} />
            <span>Elimina</span>
          </button>
        </div>
      )}

      <footer className="drawer-footer">
        <div className="drawer-persistent-actions" aria-label="Azioni persistenti">
          <button className="drawer-footer-action" type="button" aria-label="Notifiche" title="Notifiche">
            <Bell size={16} />
          </button>
          <button
            className="drawer-footer-action drawer-settings-action"
            type="button"
            aria-label="Impostazioni"
            title="Impostazioni"
            onClick={() => onNavigate("settings")}
          >
            <Settings size={16} />
          </button>
        </div>
      </footer>
    </aside>
  );
}

interface SettingsDrawerProps {
  activeSection: SettingsSectionId;
  onBack: () => void;
  onSelect: (section: SettingsSectionId) => void;
}

export function SettingsDrawer({
  activeSection,
  onBack,
  onSelect,
}: SettingsDrawerProps) {
  const [displayName] = useSetting("displayName", "Fabio Cantone");
  const [workspaceName] = useSetting("workspaceName", "Personale");
  const groups: Array<"account" | "capabilities"> = ["account", "capabilities"];
  return (
    <aside className="nav-drawer settings-drawer set-nav" aria-label="Impostazioni">
      <button className="set-nav-back" type="button" onClick={onBack}>
        <ArrowLeft size={15} />
        <span>Torna all'app</span>
      </button>

      <div className="set-nav-profile">
        <span className="set-nav-avatar" aria-hidden />
        <span className="set-nav-id">
          <span className="n">{displayName || "Account"}</span>
          <span className="w">{workspaceName || "Personale"}</span>
        </span>
      </div>

      <nav className="drawer-nav settings-nav">
        {groups.map((group) => (
          <div key={group}>
            <div className="set-nav-group">{settingsGroupLabels[group]}</div>
            {settingsSections
              .filter((item) => item.group === group)
              .map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={`set-nav-item ${activeSection === item.id ? "active" : ""}`}
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
          </div>
        ))}
      </nav>

      <span className="set-nav-spacer" />
      <button
        className={`set-nav-item ${activeSection === "audit" ? "" : ""}`}
        type="button"
        onClick={onBack}
      >
        <Info size={16} />
        <span>Informazioni</span>
      </button>
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
      <div className="chat-search-modal" role="dialog" aria-label="Cerca chat">
        <header>
          <strong>Cerca chat</strong>
          <button
            className="icon-button"
            type="button"
            aria-label="Chiudi ricerca"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <label className="chat-search-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder="Cerca nelle chat"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>
        <div className="chat-search-results">
          <small>{normalizedQuery ? "Risultati" : "Chat recenti"}</small>
          {searchResults.map((thread, index) => (
            <button
              className="chat-search-row"
              type="button"
              key={thread.threadId}
              onClick={() => onSelectThread(thread.threadId)}
            >
              <span>{thread.title}</span>
              <em>local-first-personal-assistant</em>
              <kbd>⌘{index + 1}</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadLink({
  active,
  onContextMenu,
  onSelect,
  thread,
}: {
  active: boolean;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onSelect: () => void;
  thread: ChatThread;
}) {
  return (
    <button
      className={`drawer-link ${active ? "active" : ""} ${thread.pinned ? "pinned" : ""}`}
      type="button"
      onContextMenu={onContextMenu}
      onClick={onSelect}
    >
      <span>{thread.title}</span>
      {thread.source && (
        <span className={`thread-channel-badge ${thread.source}`}>
          {thread.source === "whatsapp"
            ? "WhatsApp"
            : thread.source === "telegram"
              ? "Telegram"
              : thread.source}
        </span>
      )}
      {thread.pinned && <Pin size={12} aria-hidden="true" />}
    </button>
  );
}
