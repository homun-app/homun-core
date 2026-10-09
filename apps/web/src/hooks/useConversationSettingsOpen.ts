/** Settings dialog open state with optional deep-link section (e.g. models). */
import { useState } from "react";

export function useConversationSettingsOpen(initialSection = "space") {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState(initialSection);

  function openSettings(nextSection = "space") {
    setSection(nextSection);
    setOpen(true);
  }

  return {
    settingsOpen: open,
    settingsSection: section,
    openSettings,
    closeSettings: () => setOpen(false),
  };
}
