import type { ReactNode } from "react";
import { NavDrawer, NavigationRail, SettingsDrawer } from "./Sidebar";
import type { ChatThread, SettingsSectionId, ViewId } from "../types";

interface ShellProps {
  activeView: ViewId;
  activeThreadId: string;
  chatThreads: ChatThread[];
  drawerOpen: boolean;
  onBackFromSettings: () => void;
  onCreateChatThread: () => void;
  onNavigate: (view: ViewId) => void;
  onSelectThread: (threadId: string) => void;
  onSelectSettingsSection: (section: SettingsSectionId) => void;
  onToggleDrawer: () => void;
  settingsSection: SettingsSectionId;
  children: ReactNode;
}

export function Shell({
  activeView,
  activeThreadId,
  chatThreads,
  children,
  drawerOpen,
  onBackFromSettings,
  onCreateChatThread,
  onNavigate,
  onSelectThread,
  onSelectSettingsSection,
  onToggleDrawer,
  settingsSection,
}: ShellProps) {
  const isSettings = activeView === "settings";

  return (
    <div
      className={[
        "app-shell",
        drawerOpen ? "drawer-open" : "drawer-closed",
        isSettings ? "settings-mode" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {!drawerOpen && (
        <NavigationRail
          activeView={activeView}
          onNavigate={onNavigate}
          onToggleDrawer={onToggleDrawer}
        />
      )}
      {drawerOpen && !isSettings && (
        <NavDrawer
          activeView={activeView}
          activeThreadId={activeThreadId}
          chatThreads={chatThreads}
          onCreateChatThread={onCreateChatThread}
          onNavigate={onNavigate}
          onSelectThread={onSelectThread}
          onToggleDrawer={onToggleDrawer}
        />
      )}
      {drawerOpen && isSettings && (
        <SettingsDrawer
          activeSection={settingsSection}
          onBack={onBackFromSettings}
          onSelect={onSelectSettingsSection}
        />
      )}
      {children}
    </div>
  );
}
