import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InspectorTabKind } from "../lib/inspectorWorkspace";

// Header kebab menu: the island was slimmed down (artifacts/files/activity rows
// dropped), so this is the one entry point that reopens the docked Workbench on a
// specific tab, plus a screenshot shortcut. Kept separate from ChatView's own
// per-message action menu (different trigger, different item set).
export function ChatHeaderMenu({
  onOpenInspector,
  onCaptureScreenshot,
}: {
  onOpenInspector: (tab: InspectorTabKind) => void;
  onCaptureScreenshot?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape — a menu that traps focus/click would be a bug.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  return (
    <div className="chat-header-menu" ref={ref}>
      <button
        type="button"
        className="chat-header-menu-trigger"
        aria-label={t("chat.headerMenuLabel")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="chat-header-menu-popover" role="menu">
          <button role="menuitem" type="button" onClick={() => pick(() => onOpenInspector("artifact"))}>
            {t("chat.headerMenuArtifacts")}
          </button>
          <button role="menuitem" type="button" onClick={() => pick(() => onOpenInspector("file"))}>
            {t("chat.headerMenuFiles")}
          </button>
          {onCaptureScreenshot && (
            <button role="menuitem" type="button" onClick={() => pick(onCaptureScreenshot)}>
              {t("chat.captureScreenshot")}
            </button>
          )}
          <button role="menuitem" type="button" onClick={() => pick(() => onOpenInspector("activity"))}>
            {t("chat.headerMenuActivity")}
          </button>
        </div>
      )}
    </div>
  );
}
