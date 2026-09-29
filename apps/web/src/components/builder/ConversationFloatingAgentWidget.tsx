import { useState, useRef, useEffect } from "react";
import {
  Sparkles,
  Minus,
  Maximize2,
  X,
  Send,
  ArrowUp,
  FolderPlus,
  Users,
  Search,
} from "lucide-react";
import type { Work } from "./conversation-types";
import "./linear-menu.css";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onExpand: () => void;
  onSend: (text: string) => void;
  work?: Work | null | undefined;
  engineMode?: boolean;
};

export function ConversationFloatingAgentWidget({
  isOpen,
  onClose,
  onExpand,
  onSend,
  work,
  engineMode = false,
}: Props) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim()) return;
    onSend(inputText.trim());
    setInputText("");
  };

  const handlePill = (text: string) => {
    onSend(text);
  };

  return (
    <aside className="linear-floating-agent" aria-label="Finestra rapida Agente">
      <div className="linear-floating-agent-head">
        <div className="linear-floating-agent-title">
          <Sparkles size={14} style={{ color: "#16a34a" }} />
          <span>{work ? work.title : "Nuova chat"}</span>
        </div>
        <div className="linear-floating-agent-actions">
          <button
            type="button"
            className="linear-floating-agent-btn"
            title="Espandi a schermo intero"
            onClick={onExpand}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className="linear-floating-agent-btn"
            title="Chiudi finestra"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="linear-floating-agent-body">
        {!work || work.messages.length === 0 ? (
          <div className="linear-floating-agent-empty">
            <div className="linear-floating-agent-empty-icon">
              <Sparkles size={18} />
            </div>
            <div className="linear-floating-agent-empty-title">Agente Homun</div>
            <div className="linear-floating-agent-empty-desc">
              Chiedi qualunque cosa, affida compiti o coordina la squadra in qualsiasi momento.
            </div>

            <div className="linear-floating-agent-pills">
              <button
                type="button"
                className="linear-floating-agent-pill-btn"
                onClick={() => handlePill("Crea un nuovo progetto e descrivi i primi passi")}
              >
                <FolderPlus size={13} style={{ color: "#71717a" }} />
                <span>Crea un nuovo progetto</span>
              </button>
              <button
                type="button"
                className="linear-floating-agent-pill-btn"
                onClick={() => handlePill("Aiutami a configurare la squadra di agenti")}
              >
                <Users size={13} style={{ color: "#71717a" }} />
                <span>Configura la squadra AI</span>
              </button>
              <button
                type="button"
                className="linear-floating-agent-pill-btn"
                onClick={() => handlePill("Quali sono i lavori e le attività in sospeso?")}
              >
                <Search size={13} style={{ color: "#71717a" }} />
                <span>Riepilogo delle attività in sospeso</span>
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {work.messages.slice(-8).map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.who === "you" ? "flex-end" : "flex-start",
                  background: m.who === "you" ? "#18181b" : "#f4f4f5",
                  color: m.who === "you" ? "#ffffff" : "#18181b",
                  borderRadius: "10px",
                  padding: "8px 12px",
                  fontSize: "12px",
                  maxWidth: "85%",
                  lineHeight: 1.4,
                }}
              >
                {m.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="linear-floating-agent-footer">
        <form onSubmit={handleSubmit} className="linear-floating-input-wrap">
          <input
            ref={inputRef}
            type="text"
            className="linear-floating-input"
            placeholder="@ per menzionare, o scrivi qui…"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          <button
            type="submit"
            className="linear-floating-send-btn"
            disabled={!inputText.trim()}
            title="Invia"
          >
            <ArrowUp size={14} />
          </button>
        </form>
      </div>
    </aside>
  );
}
