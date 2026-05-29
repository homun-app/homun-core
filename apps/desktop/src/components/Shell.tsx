import { useState, type ReactNode } from "react";
import {
  ChatSearchModal,
  NavDrawer,
  NavigationRail,
  SettingsDrawer,
} from "./Sidebar";
import type { ChatThread, SettingsSectionId, ViewId } from "../types";

interface ShellProps {
  activeView: ViewId;
  activeThreadId: string;
  chatThreads: ChatThread[];
  drawerOpen: boolean;
  onArchiveChatThread: (threadId: string) => void;
  onBackFromSettings: () => void;
  onCreateChatThread: () => void;
  onDeleteChatThread: (threadId: string) => void;
  onNavigate: (view: ViewId) => void;
  onSelectThread: (threadId: string) => void;
  onSetChatThreadPinned: (threadId: string, pinned: boolean) => void;
  onSelectSettingsSection: (section: SettingsSectionId) => void;
  onToggleDrawer: () => void;
  onUnarchiveChatThread: (threadId: string) => void;
  settingsSection: SettingsSectionId;
  children: ReactNode;
}

export function Shell({
  activeView,
  activeThreadId,
  chatThreads,
  children,
  drawerOpen,
  onArchiveChatThread,
  onBackFromSettings,
  onCreateChatThread,
  onDeleteChatThread,
  onNavigate,
  onSelectThread,
  onSetChatThreadPinned,
  onSelectSettingsSection,
  onToggleDrawer,
  onUnarchiveChatThread,
  settingsSection,
}: ShellProps) {
  const isSettings = activeView === "settings";
  const [searchOpen, setSearchOpen] = useState(false);

  function handleSelectSearchThread(threadId: string) {
    setSearchOpen(false);
    onSelectThread(threadId);
  }

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
          onSearch={() => setSearchOpen(true)}
          onToggleDrawer={onToggleDrawer}
        />
      )}
      {drawerOpen && !isSettings && (
        <NavDrawer
          activeView={activeView}
          activeThreadId={activeThreadId}
          chatThreads={chatThreads}
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
          onBack={onBackFromSettings}
          onSelect={onSelectSettingsSection}
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
