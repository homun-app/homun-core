import { useState, useRef, useEffect } from "react";
import {
  HelpCircle,
  BookOpen,
  Keyboard,
  Radio,
  Settings,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import "./linear-menu.css";

type Props = {
  engineMode?: boolean;
  onOpenSettings: () => void;
  onSearchOpen: () => void;
  searchShortcut: string;
};

export function ConversationHelpPopover({
  engineMode = false,
  onOpenSettings,
  onSearchOpen,
  searchShortcut,
}: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
    return undefined;
  }, [open]);

  return (
    <div style={{ position: "relative", display: "inline-flex" }} ref={containerRef}>
      <button
        type="button"
        className="cw-sb-footer-btn"
        aria-label="Informazioni e aiuto"
        title="Informazioni e aiuto"
        onClick={() => setOpen((prev) => !prev)}
      >
        <HelpCircle size={15} />
      </button>

      {open && (
        <div
          className="linear-menu-popover"
          style={{
            bottom: "calc(100% + 10px)",
            left: "-120px",
            width: "280px",
            zIndex: 120,
          }}
          role="menu"
        >
          <div className="linear-menu-header">Homun · Informazioni</div>

          <button
            type="button"
            className="linear-menu-item"
            onClick={() => {
              onSearchOpen();
              setOpen(false);
            }}
          >
            <div className="linear-menu-item-left">
              <Keyboard size={14} />
              <span>Scorciatoie da tastiera</span>
            </div>
            <span className="linear-menu-item-shortcut">{searchShortcut}</span>
          </button>

          <button
            type="button"
            className="linear-menu-item"
            onClick={() => {
              onOpenSettings();
              setOpen(false);
            }}
          >
            <div className="linear-menu-item-left">
              <Settings size={14} />
              <span>Impostazioni dello spazio</span>
            </div>
          </button>

          <div className="linear-menu-divider" />

          <div className="linear-menu-header">Stato del sistema</div>
          <div
            style={{
              padding: "4px 9px 8px",
              fontSize: "12px",
              color: "#3f3f46",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: engineMode ? "#10b981" : "#0284c7",
                flexShrink: 0,
              }}
            />
            <span>
              {engineMode ? "Motore orchestratore attivo" : "Simulatore in esecuzione locale"}
            </span>
          </div>

          <div className="linear-menu-divider" />

          <div className="linear-menu-header">Novità</div>
          <div style={{ padding: "4px 9px", fontSize: "11px", color: "#71717a", lineHeight: 1.4 }}>
            • Nuova interfaccia Linear-style con box curvo
            <br />
            • Agente sempre accessibile e history rapida
            <br />
            • Palette monochrome pulita
          </div>
        </div>
      )}
    </div>
  );
}
