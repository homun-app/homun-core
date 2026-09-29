import { useMemo, useState } from "react";
import {
  Plus,
  Search,
  Zap,
  ShieldCheck,
  Eye,
  Paperclip,
  AtSign,
  Check,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@homun/ui/components/popover";
import type { AutonomyLevel } from "./conversation-preferences";
import "./composer-plus-menu.css";

export type ComposerPlusMenuProps = {
  autonomyLevel?: AutonomyLevel | undefined;
  onAutonomyLevelChange?: ((level: AutonomyLevel) => void) | undefined;
  onAttachFiles?: (() => void) | undefined;
  onMentionAgent?: (() => void) | undefined;
  disabled?: boolean;
};

export function ComposerPlusMenu({
  autonomyLevel = "guarded",
  onAutonomyLevelChange,
  onAttachFiles,
  onMentionAgent,
  disabled = false,
}: ComposerPlusMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const modes = [
    {
      id: "autonomous" as AutonomyLevel,
      title: "Autonomo",
      badge: "Delega totale",
      desc: "Esegue senza pause (tool, shell, codice, subagenti) e consegna.",
      icon: Zap,
      color: "#d97706",
    },
    {
      id: "guarded" as AutonomyLevel,
      title: "Con guardrail",
      badge: "Bilanciato",
      desc: "Autonomo su analisi e codice; chiede conferma su azioni critiche.",
      icon: ShieldCheck,
      color: "#059669",
    },
    {
      id: "supervised" as AutonomyLevel,
      title: "Supervisionato",
      badge: "Passo-passo",
      desc: "Richiede accordo preventivo e approvazione per ciascuna fase.",
      icon: Eye,
      color: "#4f46e5",
    },
  ];

  const tools = [
    {
      id: "attach-file",
      title: "Allega file",
      badge: "Documenti / Img",
      desc: "Seleziona file o documenti da includere nel contesto.",
      icon: Paperclip,
      action: () => {
        onAttachFiles?.();
      },
    },
    {
      id: "mention-agent",
      title: "Menziona agente (@)",
      badge: "Delega diretta",
      desc: "Inserisci @ per assegnare l'incarico a un agente specifico.",
      icon: AtSign,
      action: () => {
        onMentionAgent?.();
      },
    },
  ];

  const filteredModes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return modes;
    return modes.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.desc.toLowerCase().includes(q) ||
        m.badge.toLowerCase().includes(q),
    );
  }, [query]);

  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.desc.toLowerCase().includes(q) ||
        t.badge.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`composer-plus-trigger ${open ? "is-open" : ""}`}
          disabled={disabled}
          aria-label="Aggiungi contesto o cambia modalità"
          title="Aggiungi contesto, file o cambia modalità"
        >
          <Plus size={15} />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="composer-plus-popover"
      >
        <div className="composer-plus-search">
          <Search size={13} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca modalità, azioni o contesto…"
            autoFocus
          />
        </div>

        <div className="composer-plus-list">
          {filteredModes.length > 0 && (
            <>
              <div className="composer-plus-section-title">Modalità operative</div>
              {filteredModes.map((mode) => {
                const Icon = mode.icon;
                const isSelected = autonomyLevel === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    className={`composer-plus-item ${isSelected ? "is-selected" : ""}`}
                    onClick={() => {
                      onAutonomyLevelChange?.(mode.id);
                      setOpen(false);
                    }}
                  >
                    <div
                      className="composer-plus-item-icon"
                      style={{ color: mode.color }}
                    >
                      <Icon size={14} />
                    </div>
                    <div className="composer-plus-item-body">
                      <div className="composer-plus-item-header">
                        <span className="composer-plus-item-title">{mode.title}</span>
                        {isSelected ? (
                          <Check size={13} className="text-emerald-600 flex-shrink-0" />
                        ) : (
                          <span className="composer-plus-item-badge">{mode.badge}</span>
                        )}
                      </div>
                      <span className="composer-plus-item-desc">{mode.desc}</span>
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {filteredModes.length > 0 && filteredTools.length > 0 && (
            <div className="composer-plus-divider" />
          )}

          {filteredTools.length > 0 && (
            <>
              <div className="composer-plus-section-title">Contesto & Allegati</div>
              {filteredTools.map((tool) => {
                const Icon = tool.icon;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className="composer-plus-item"
                    onClick={() => {
                      tool.action();
                      setOpen(false);
                    }}
                  >
                    <div className="composer-plus-item-icon">
                      <Icon size={14} />
                    </div>
                    <div className="composer-plus-item-body">
                      <div className="composer-plus-item-header">
                        <span className="composer-plus-item-title">{tool.title}</span>
                        <span className="composer-plus-item-badge">{tool.badge}</span>
                      </div>
                      <span className="composer-plus-item-desc">{tool.desc}</span>
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {filteredModes.length === 0 && filteredTools.length === 0 && (
            <div className="p-3 text-center text-xs text-muted-foreground">
              Nessuna azione trovata per &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
