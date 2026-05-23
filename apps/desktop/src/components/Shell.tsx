import type { ReactNode } from "react";
import { SettingsSidebar, Sidebar } from "./Sidebar";
import type { SettingsSectionId, ViewId } from "../types";

interface ShellProps {
  activeView: ViewId;
  isInspectorCollapsed: boolean;
  isNavCollapsed: boolean;
  onBackFromSettings: () => void;
  onNavigate: (view: ViewId) => void;
  onSelectSettingsSection: (section: SettingsSectionId) => void;
  onToggleNav: () => void;
  settingsSection: SettingsSectionId;
  children: ReactNode;
}

export function Shell({
  activeView,
  children,
  isInspectorCollapsed,
  isNavCollapsed,
  onBackFromSettings,
  onNavigate,
  onSelectSettingsSection,
  onToggleNav,
  settingsSection,
}: ShellProps) {
  const isSettings = activeView === "settings";

  return (
    <div
      className={[
        "app-shell",
        isSettings ? "settings-mode" : "",
        isNavCollapsed ? "nav-collapsed" : "",
        isInspectorCollapsed ? "inspector-collapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isSettings ? (
        <SettingsSidebar
          activeSection={settingsSection}
          isCollapsed={isNavCollapsed}
          onBack={onBackFromSettings}
          onSelect={onSelectSettingsSection}
          onToggle={onToggleNav}
        />
      ) : (
        <Sidebar
          activeView={activeView}
          isCollapsed={isNavCollapsed}
          onNavigate={onNavigate}
          onToggle={onToggleNav}
        />
      )}
      {children}
    </div>
  );
}
