import { useState } from "react";
import type { SettingsSectionId, ViewId } from "../types";

export function useAppNavigation(): {
  activeView: ViewId;
  settingsSection: SettingsSectionId;
  settingsSub: string;
  searchOpen: boolean;
  setActiveView: (view: ViewId) => void;
  setSettingsSection: (section: SettingsSectionId) => void;
  setSettingsSub: (sub: string) => void;
  handleNavigate: (view: ViewId) => void;
  backFromSettings: () => void;
  openUsageSettings: () => void;
  openSearch: () => void;
  closeSearch: () => void;
} {
  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [previousView, setPreviousView] = useState<ViewId>("chat");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("account");
  const [settingsSub, setSettingsSub] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  function handleNavigate(view: ViewId) {
    if (view === "settings" && activeView !== "settings") {
      setPreviousView(activeView);
    }
    setActiveView(view);
  }

  function backFromSettings() {
    setActiveView(previousView);
  }

  function openUsageSettings() {
    setPreviousView("chat");
    setSettingsSection("usage");
    setSettingsSub("");
    setActiveView("settings");
  }

  return {
    activeView,
    settingsSection,
    settingsSub,
    searchOpen,
    setActiveView,
    setSettingsSection,
    setSettingsSub,
    handleNavigate,
    backFromSettings,
    openUsageSettings,
    openSearch: () => setSearchOpen(true),
    closeSearch: () => setSearchOpen(false),
  };
}
