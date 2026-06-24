import { PanelLeftOpen } from "lucide-react";
import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChatSearchModal,
  NavDrawer,
  SettingsDrawer,
} from "./Sidebar";
import type { ChatThread, NavItem, SettingsSectionId, ViewId } from "../types";

interface ShellProps {
  activeView: ViewId;
  activeThreadId: string;
  busyThreadIds: Set<string>;
  chatThreads: ChatThread[];
  drawerOpen: boolean;
  // Composed at runtime in App: static core + enabled addon entries (ADR 0011 §10-A).
  navItems: NavItem[];
  onArchiveChatThread: (threadId: string) => void;
  onBackFromSettings: () => void;
  onCreateteChatThread: () => void;
  onDeleteChatThread: (threadId: string) => void;
  onNavigate: (view: ViewId) => void;
  onSelectThread: (threadId: string) => void;
  onSetChatThreadPinned: (threadId: string, pinned: boolean) => void;
  onSelectSettingsSection: (section: SettingsSectionId) => void;
  // Sub-item within a section that has an inline expandable submenu (generic string).
  onSelectSettingsSub: (sub: string) => void;
  onToggleDrawer: () => void;
  onUnarchiveChatThread: (threadId: string) => void;
  settingsSection: SettingsSectionId;
  settingsSub: string;
  children: ReactNode;
}

export function Shell({
  activeView,
  activeThreadId,
  busyThreadIds,
  chatThreads,
  children,
  drawerOpen,
  navItems,
  onArchiveChatThread,
  onBackFromSettings,
  onCreateteChatThread,
  onDeleteChatThread,
  onNavigate,
  onSelectThread,
  onSetChatThreadPinned,
  onSelectSettingsSection,
  onSelectSettingsSub,
  onToggleDrawer,
  onUnarchiveChatThread,
  settingsSection,
  settingsSub,
}: ShellProps) {
  const { t } = useTranslation();
  const isSettings = activeView === "settings";
  const [searchOpen, setSearchOpen] = useState(false);
  const [transientDrawerOpen, setTransientDrawerOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const [drawerWidth, setDrawerWidth] = useState(readStoredDrawerWidth);

  function handleSelectSearchThread(threadId: string) {
    setSearchOpen(false);
    onSelectThread(threadId);
  }

  function closeTransientDrawer() {
    setTransientDrawerOpen(false);
  }

  function handleTransientNavigate(view: ViewId) {
    closeTransientDrawer();
    onNavigate(view);
  }

  function handleTransientSelectThread(threadId: string) {
    closeTransientDrawer();
    onSelectThread(threadId);
  }

  function handleTransientSearch() {
    closeTransientDrawer();
    setSearchOpen(true);
  }

  function handleTransientCreateThread() {
    closeTransientDrawer();
    onCreateteChatThread();
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    const clamp = (value: number) =>
      Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, value));
    const apply = (clientX: number) => {
      const next = clamp(startWidth + (clientX - startX));
      shellRef.current?.style.setProperty("--drawer-width", `${next}px`);
      return next;
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => apply(moveEvent.clientX);
    const onUp = (upEvent: globalThis.PointerEvent) => {
      const next = apply(upEvent.clientX);
      setDrawerWidth(next);
      try {
        localStorage.setItem(DRAWER_WIDTH_KEY, String(next));
      } catch {
        // Storage unavailable (private mode); width still applies for the session.
      }
      document.body.classList.remove("resizing-drawer");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    document.body.classList.add("resizing-drawer");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={shellRef}
      style={{ "--drawer-width": `${drawerWidth}px` } as CSSProperties}
      className={[
        "app-shell",
        // Settings is always shown with its full sidebar open, so force the open
        // grid column when in settings.
        drawerOpen || isSettings ? "drawer-open" : "drawer-closed",
        isSettings ? "settings-mode" : "",
        transientDrawerOpen && !drawerOpen && !isSettings ? "drawer-transient-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {!drawerOpen && !isSettings && (
        <>
          <button
            className="drawer-edge-hotspot"
            type="button"
            aria-label={t("sidebar.expandSidebar")}
            title={t("sidebar.expandSidebar")}
            onMouseEnter={() => setTransientDrawerOpen(true)}
            onFocus={() => setTransientDrawerOpen(true)}
            onClick={() => setTransientDrawerOpen(true)}
          />
          <button
            className="drawer-floating-trigger"
            type="button"
            aria-label={t("sidebar.expandSidebar")}
            title={t("sidebar.expandSidebar")}
            onClick={() => setTransientDrawerOpen(true)}
          >
            <PanelLeftOpen size={16} />
          </button>
          {transientDrawerOpen && (
            <div
              className="drawer-floating-host"
              onMouseLeave={closeTransientDrawer}
            >
              <NavDrawer
                activeView={activeView}
                activeThreadId={activeThreadId}
                busyThreadIds={busyThreadIds}
                chatThreads={chatThreads}
                navItems={navItems}
                onArchiveChatThread={onArchiveChatThread}
                onCreateteChatThread={handleTransientCreateThread}
                onDeleteChatThread={onDeleteChatThread}
                onNavigate={handleTransientNavigate}
                onSearchChat={handleTransientSearch}
                onSelectThread={handleTransientSelectThread}
                onSetChatThreadPinned={onSetChatThreadPinned}
                onToggleDrawer={() => {
                  closeTransientDrawer();
                  onToggleDrawer();
                }}
                onUnarchiveChatThread={onUnarchiveChatThread}
                presentation="floating"
              />
            </div>
          )}
        </>
      )}
      {drawerOpen && !isSettings && (
        <NavDrawer
          activeView={activeView}
          activeThreadId={activeThreadId}
          busyThreadIds={busyThreadIds}
          chatThreads={chatThreads}
          navItems={navItems}
          onArchiveChatThread={onArchiveChatThread}
          onCreateteChatThread={onCreateteChatThread}
          onDeleteChatThread={onDeleteChatThread}
          onNavigate={onNavigate}
          onSearchChat={() => setSearchOpen(true)}
          onSelectThread={onSelectThread}
          onSetChatThreadPinned={onSetChatThreadPinned}
          onToggleDrawer={onToggleDrawer}
          onUnarchiveChatThread={onUnarchiveChatThread}
        />
      )}
      {isSettings && (
        <SettingsDrawer
          activeSection={settingsSection}
          activeSub={settingsSub}
          onBack={onBackFromSettings}
          onSelect={onSelectSettingsSection}
          onSelectSub={onSelectSettingsSub}
        />
      )}
      {(drawerOpen || isSettings) && (
        <div
          className="drawer-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("shell.resizeSidebarAria")}
          onPointerDown={startResize}
          onDoubleClick={() => {
            setDrawerWidth(DRAWER_DEFAULT_WIDTH);
            shellRef.current?.style.setProperty(
              "--drawer-width",
              `${DRAWER_DEFAULT_WIDTH}px`,
            );
            try {
              localStorage.setItem(DRAWER_WIDTH_KEY, String(DRAWER_DEFAULT_WIDTH));
            } catch {
              // ignore
            }
          }}
        />
      )}
      {searchOpen && (
        <ChatSearchModal
          chatThreads={chatThreads}
          onClose={() => setSearchOpen(false)}
          onSelectThread={handleSelectSearchThread}
        />
      )}
      {children}
    </div>
  );
}

const DRAWER_WIDTH_KEY = "ui.drawerWidth";
const DRAWER_DEFAULT_WIDTH = 292;
const DRAWER_MIN_WIDTH = 240;
const DRAWER_MAX_WIDTH = 560;

function readStoredDrawerWidth(): number {
  try {
    const raw = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= DRAWER_MIN_WIDTH && raw <= DRAWER_MAX_WIDTH) {
      return raw;
    }
  } catch {
    // Storage unavailable; fall back to the default.
  }
  return DRAWER_DEFAULT_WIDTH;
}
