import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import {
  ChatSearchModal,
  NavDrawer,
  NavigationRail,
  SettingsDrawer,
} from "./Sidebar";
import type { ChatThread, NavItem, SettingsSectionId, ViewId } from "../types";

interface ShellProps {
  activeView: ViewId;
  activeThreadId: string;
  chatThreads: ChatThread[];
  drawerOpen: boolean;
  // Composed at runtime in App: static core + enabled addon entries (ADR 0011 §10-A).
  navItems: NavItem[];
  onArchiveChatThread: (threadId: string) => void;
  onBackFromSettings: () => void;
  onCreateChatThread: () => void;
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
  chatThreads,
  children,
  drawerOpen,
  navItems,
  onArchiveChatThread,
  onBackFromSettings,
  onCreateChatThread,
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
  const isSettings = activeView === "settings";
  const [searchOpen, setSearchOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const [drawerWidth, setDrawerWidth] = useState(readStoredDrawerWidth);

  function handleSelectSearchThread(threadId: string) {
    setSearchOpen(false);
    onSelectThread(threadId);
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
        drawerOpen ? "drawer-open" : "drawer-closed",
        isSettings ? "settings-mode" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {!drawerOpen && (
        <>
          {/* When collapsed the rail stays narrow (icons only); the expand control lives
              on the CONTENT side, just past the lights — so the column doesn't widen. */}
          <button
            className="sidebar-expand"
            type="button"
            aria-label="Espandi barra laterale"
            title="Espandi barra laterale"
            onClick={onToggleDrawer}
          >
            <PanelLeftOpen size={18} />
          </button>
          <NavigationRail
            activeView={activeView}
            navItems={navItems}
            onNavigate={onNavigate}
            onSearch={() => setSearchOpen(true)}
            onToggleDrawer={onToggleDrawer}
          />
        </>
      )}
      {drawerOpen && !isSettings && (
        <NavDrawer
          activeView={activeView}
          activeThreadId={activeThreadId}
          chatThreads={chatThreads}
          navItems={navItems}
          onArchiveChatThread={onArchiveChatThread}
          onCreateChatThread={onCreateChatThread}
          onDeleteChatThread={onDeleteChatThread}
          onNavigate={onNavigate}
          onSearchChat={() => setSearchOpen(true)}
          onSelectThread={onSelectThread}
          onSetChatThreadPinned={onSetChatThreadPinned}
          onToggleDrawer={onToggleDrawer}
          onUnarchiveChatThread={onUnarchiveChatThread}
        />
      )}
      {drawerOpen && isSettings && (
        <SettingsDrawer
          activeSection={settingsSection}
          activeSub={settingsSub}
          onBack={onBackFromSettings}
          onSelect={onSelectSettingsSection}
          onSelectSub={onSelectSettingsSub}
        />
      )}
      {drawerOpen && (
        <div
          className="drawer-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Ridimensiona la barra laterale"
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
