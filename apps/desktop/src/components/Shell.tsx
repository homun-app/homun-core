import type { ReactNode } from "react";
import { NavDrawer, NavigationRail, SettingsDrawer } from "./Sidebar";
import type { SettingsSectionId, ViewId } from "../types";

interface ShellProps {
  activeView: ViewId;
  drawerOpen: boolean;
  onBackFromSettings: () => void;
  onNavigate: (view: ViewId) => void;
  onSelectSettingsSection: (section: SettingsSectionId) => void;
  onToggleDrawer: () => void;
  settingsSection: SettingsSectionId;
  children: ReactNode;
}

export function Shell({
  activeView,
  children,
  drawerOpen,
  onBackFromSettings,
  onNavigate,
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
      <NavigationRail
        activeView={activeView}
        drawerOpen={drawerOpen}
        onNavigate={onNavigate}
        onToggleDrawer={onToggleDrawer}
      />
      {drawerOpen && !isSettings && (
        <NavDrawer
          activeView={activeView}
          onNavigate={onNavigate}
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
