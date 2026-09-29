import { useState } from "react";
import { Zap, ShieldCheck, Eye, ChevronDown, Check } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@homun/ui/components/popover";
import type { AutonomyLevel } from "./conversation-preferences";
import "./autonomy-selector.css";

interface AutonomyOption {
  level: AutonomyLevel;
  label: string;
  badge: string;
  description: string;
  icon: typeof Zap;
  color: string;
}

const AUTONOMY_OPTIONS: AutonomyOption[] = [
  {
    level: "autonomous",
    label: "Autonomo",
    badge: "Delega totale",
    description: "L'agente esegue senza pause (tool, terminale, codice, subagenti) e consegna il risultato.",
    icon: Zap,
    color: "#d97706",
  },
  {
    level: "guarded",
    label: "Con guardrail",
    badge: "Bilanciato",
    description: "Autonomo su esplorazione, codice e test; chiede conferma su azioni esterne o critiche.",
    icon: ShieldCheck,
    color: "#059669",
  },
  {
    level: "supervised",
    label: "Supervisionato",
    badge: "Passo-passo",
    description: "Richiede accordo preventivo e approvazione esplicita per ciascuna fase.",
    icon: Eye,
    color: "#4f46e5",
  },
];

export function AutonomySelector({
  value = "guarded",
  onChange,
  disabled = false,
}: {
  value?: AutonomyLevel | undefined;
  onChange: (level: AutonomyLevel) => void;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);

  const current = AUTONOMY_OPTIONS.find((o) => o.level === value) ?? AUTONOMY_OPTIONS[1]!;
  const Icon = current.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`autonomy-selector-trigger autonomy-${current.level}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`Modalità: ${current.label} (${current.badge})`}
        >
          <Icon size={14} className="autonomy-icon" style={{ color: current.color }} />
          <span className="autonomy-label">{current.label}</span>
          <ChevronDown size={12} className={`autonomy-arrow ${open ? "open" : ""}`} />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="autonomy-popover"
      >
        <div className="autonomy-popover-header">
          <strong>Livello di autonomia</strong>
          <small>Decidi quanta delega affidare agli agenti</small>
        </div>
        <div className="autonomy-popover-list" role="listbox" aria-label="Livello di autonomia">
          {AUTONOMY_OPTIONS.map((opt) => {
            const OptIcon = opt.icon;
            const isSelected = opt.level === value;
            return (
              <button
                key={opt.level}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`autonomy-option-item ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  onChange(opt.level);
                  setOpen(false);
                }}
              >
                <div className="autonomy-option-icon-box" style={{ background: `${opt.color}15` }}>
                  <OptIcon size={16} style={{ color: opt.color }} />
                </div>
                <div className="autonomy-option-text">
                  <div className="autonomy-option-row">
                    <span className="autonomy-option-title">{opt.label}</span>
                    <span className="autonomy-option-badge">{opt.badge}</span>
                    {isSelected && <Check size={14} className="autonomy-check" />}
                  </div>
                  <p className="autonomy-option-desc">{opt.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
