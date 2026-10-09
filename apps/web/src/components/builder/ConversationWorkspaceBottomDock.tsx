import { useState, useRef, useEffect } from "react";
import { History, Sparkles, Check, MessageSquare } from "lucide-react";
import type { Work } from "./conversation-types";
import "./linear-menu.css";

type Props = {
  space: string | null;
  onToggleAgent: () => void;
  isFloatingOpen?: boolean;
  works?: Work[];
  activeWorkId?: string | null;
  onOpenWork?: (id: string | null) => void;
};

export function ConversationWorkspaceBottomDock({
  space,
  onToggleAgent,
  isFloatingOpen = false,
  works = [],
  activeWorkId,
  onOpenWork,
}: Props) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    }
    if (historyOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
    return undefined;
  }, [historyOpen]);

  const recentWorks = [...works]
    .sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 8);

  const isAgentActive = !space || isFloatingOpen;

  return (
    <div className="linear-agent-dock" ref={historyRef}>
      <button
        type="button"
        className={`linear-agent-dock-btn ${isAgentActive ? "is-active" : ""}`}
        onClick={onToggleAgent}
        title={
          space
            ? isFloatingOpen
              ? "Chiudi finestra Homun"
              : "Apri Homun (sempre disponibile)"
            : "Homun attivo"
        }
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: "translateY(0.5px)" }}
        >
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
        <span>Homun</span>
      </button>

      {onOpenWork && (
        <button
          type="button"
          className="linear-agent-dock-history"
          title="Cronologia conversazioni recenti"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <History size={13} />
        </button>
      )}

      {historyOpen && (
        <div
          className="linear-menu-popover"
          style={{ bottom: "calc(100% + 8px)", top: "auto", right: 0, left: "auto" }}
          role="menu"
        >
          <div className="linear-menu-header">Cronologia conversazioni</div>
          <div className="linear-menu-scrollable">
            {recentWorks.length === 0 ? (
              <div style={{ padding: "8px 10px", fontSize: "12px", color: "#a1a1aa" }}>
                Nessuna conversazione recente
              </div>
            ) : (
              recentWorks.map((w) => {
                const isSelected = activeWorkId === w.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    className={`linear-menu-item ${isSelected ? "is-active" : ""}`}
                    onClick={() => {
                      onOpenWork?.(w.id);
                      setHistoryOpen(false);
                    }}
                  >
                    <div className="linear-menu-item-left">
                      <MessageSquare size={13} />
                      <span className="linear-menu-item-title">{w.title}</span>
                    </div>
                    {isSelected && <Check size={13} style={{ color: "#16a34a" }} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
