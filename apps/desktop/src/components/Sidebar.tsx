import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Bell,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import {
  drawerProjects,
  navItems,
  settingsSections,
} from "../data/mockData";
import type { ChatThread, SettingsSectionId, ViewId } from "../types";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

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
    projects: false,
    tasks: false,
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

      <WorkspaceSwitcher />

      <button
        className="drawer-primary-action"
        type="button"
        onClick={onCreateChatThread}
      >
        <SquarePen size={17} />
        <span>Nuovo compito</span>
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
              <span>{isSearch ? "Cerca" : item.label}</span>
              {item.badge && <em>{item.badge}</em>}
            </button>
          );
        })}
      </nav>

      <div className="drawer-scroll">
        <section className="drawer-section">
          <button
            className="drawer-section-title"
            type="button"
            onClick={() => toggleSection("projects")}
          >
            <span>Progetti</span>
            {collapsedSections.projects ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          {!collapsedSections.projects && (
            <>
              {drawerProjects.map((project) => (
                <button className="drawer-link" type="button" key={project}>
                  <span>{project}</span>
                </button>
              ))}
              <button className="drawer-link drawer-link-muted" type="button">
                <span>Nuovo progetto</span>
                <FolderPlus size={14} />
              </button>
            </>
          )}
        </section>

        <section className="drawer-section">
          <button
            className="drawer-section-title"
            type="button"
            onClick={() => toggleSection("tasks")}
          >
            <span>Tutti i compiti</span>
            {collapsedSections.tasks ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          {!collapsedSections.tasks &&
            activeThreads.map((thread) => (
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
  return (
    <aside className="nav-drawer settings-drawer" aria-label="Impostazioni">
      <header className="drawer-header">
        <div>
          <strong>Impostazioni</strong>
          <small>Privacy, runtime e connettori</small>
        </div>
      </header>

      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft size={16} />
        <span>Torna all'app</span>
      </button>

      <nav className="drawer-nav settings-nav">
        {settingsSections.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`drawer-nav-item ${activeSection === item.id ? "active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
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
      {thread.pinned && <Pin size={12} aria-hidden="true" />}
    </button>
  );
}
