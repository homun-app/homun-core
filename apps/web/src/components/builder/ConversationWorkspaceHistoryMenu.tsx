import { useState, useRef, useEffect } from "react";
import { ChevronDown, Plus, MessageSquare, Check, Sparkles } from "lucide-react";
import type { Work } from "./conversation-types";
import "./linear-menu.css";

type Props = {
  activeWork: Work | null | undefined;
  works?: Work[];
  onOpenWork: (id: string | null) => void;
  onNewConversation: () => void;
};

export function ConversationWorkspaceHistoryMenu({
  activeWork,
  works = [],
  onOpenWork,
  onNewConversation,
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

  const recentWorks = [...works]
    .sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 10);

  const displayTitle = activeWork ? activeWork.title : "Nuova conversazione";

  return (
    <div className="linear-chat-switcher" ref={containerRef}>
      <button
        type="button"
        className="linear-chat-switcher-btn"
        onClick={() => setOpen((prev) => !prev)}
        title="Cronologia e selezione conversazione"
      >
        <MessageSquare size={14} style={{ color: "#71717a" }} />
        <span className="linear-menu-item-title" style={{ maxWidth: "220px" }}>
          {displayTitle}
        </span>
        <ChevronDown
          size={13}
          className={`linear-chat-switcher-chevron ${open ? "is-open" : ""}`}
        />
      </button>

      {open && (
        <div className="linear-menu-popover" role="menu">
          <button
            type="button"
            className="linear-menu-item"
            onClick={() => {
              onNewConversation();
              setOpen(false);
            }}
          >
            <div className="linear-menu-item-left">
              <Plus size={14} />
              <span>Nuova conversazione</span>
            </div>
            <span className="linear-menu-item-shortcut">⌥N</span>
          </button>

          <div className="linear-menu-divider" />

          <div className="linear-menu-header">Conversazioni recenti</div>
          <div className="linear-menu-scrollable">
            {recentWorks.length === 0 ? (
              <div style={{ padding: "8px 10px", fontSize: "12px", color: "#a1a1aa" }}>
                Nessuna conversazione ancora
              </div>
            ) : (
              recentWorks.map((w) => {
                const isSelected = activeWork?.id === w.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    className={`linear-menu-item ${isSelected ? "is-active" : ""}`}
                    onClick={() => {
                      onOpenWork(w.id);
                      setOpen(false);
                    }}
                  >
                    <div className="linear-menu-item-left">
                      <Sparkles size={13} />
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
