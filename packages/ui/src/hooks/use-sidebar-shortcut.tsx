import * as React from "react";

const SIDEBAR_KEYBOARD_SHORTCUT = "b";

/** Toggles the sidebar on Cmd/Ctrl+B while mounted. */
export function useSidebarKeyboardShortcut(toggle: () => void) {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggle();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);
}
