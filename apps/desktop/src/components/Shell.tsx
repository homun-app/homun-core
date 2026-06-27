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
  onCreateteChatThread: (workspaceId?: string) => void;
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
  // While a full-window modal (onboarding) is up, drop the window-drag strips:
  // Electron computes `-webkit-app-region: drag` zones at the OS level and won't
  // reliably recompute them from a CSS toggle, so the strips would swallow clicks
  // on modal controls (e.g. the provider slide-over close). DOM removal forces
  // the recompute; the modal renders its own drag strip in a safe zone.
  hideChrome?: boolean;
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
  hideChrome,
}: ShellProps) {
  const { t } = useTranslation();
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
        // Settings is always shown with its full sidebar open, so force the open
        // grid column when in settings.
        drawerOpen || isSettings ? "drawer-open" : "drawer-closed",
        isSettings ? "settings-mode" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {!hideChrome && (
        <div className="window-chrome" aria-hidden="true">
          <div className="window-drag-strip window-drag-strip--center" aria-hidden="true" />
          <div className="window-drag-strip window-drag-strip--right" aria-hidden="true" />
        </div>
      )}
      {!drawerOpen && !isSettings && (
        <button
          className="drawer-bottom-trigger"
          type="button"
          aria-label={t("sidebar.expandSidebar")}
          title={t("sidebar.expandSidebar")}
          onClick={onToggleDrawer}
        >
          <PanelLeftOpen size={18} />
        </button>
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
