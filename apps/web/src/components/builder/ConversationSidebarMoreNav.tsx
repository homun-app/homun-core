/**
 * Day-1 secondary nav: Plugin / Canali / Spazi remoti / Automazioni under "Altro".
 */
import { useState } from "react";
import { ChevronDown, Globe, Puzzle, Radio, Zap } from "lucide-react";
import type { SpaceView } from "./ConversationSpace";

type Props = {
  engineMode: boolean;
  space: SpaceView | null;
  onOpenSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  routineCount: number | null;
};

const MORE_SPACES: SpaceView[] = ["Automazioni", "Plugin", "Canali", "Spazi remoti"];

export function ConversationSidebarMoreNav({
  engineMode,
  space,
  onOpenSpace,
  routineCount,
}: Props) {
  const moreActive = space !== null && MORE_SPACES.includes(space);
  const [open, setOpen] = useState(moreActive);

  return (
    <div className="cw-sb-more">
      <button
        type="button"
        className={`cw-sb-nav-item cw-sb-more-toggle ${moreActive ? "active" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="cw-sb-item-left">
          <ChevronDown
            size={15}
            style={{
              transform: open ? "none" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          />
          <span>Altro</span>
        </div>
      </button>
      {open && (
        <div className="cw-sb-more-items" role="group" aria-label="Strumenti aggiuntivi">
          <button
            type="button"
            className={`cw-sb-nav-item ${space === "Automazioni" ? "active" : ""}`}
            onClick={() => onOpenSpace("Automazioni")}
          >
            <div className="cw-sb-item-left">
              <Zap size={15} />
              <span>Automazioni</span>
            </div>
            {routineCount !== null && routineCount > 0 && (
              <span className="cw-sb-count">{routineCount}</span>
            )}
          </button>
          <button
            type="button"
            className={`cw-sb-nav-item ${space === "Plugin" ? "active" : ""}`}
            onClick={() => onOpenSpace("Plugin")}
          >
            <div className="cw-sb-item-left">
              <Puzzle size={15} />
              <span>Plugin</span>
            </div>
          </button>
          <button
            type="button"
            className={`cw-sb-nav-item ${space === "Canali" ? "active" : ""}`}
            onClick={() => onOpenSpace("Canali")}
          >
            <div className="cw-sb-item-left">
              <Radio size={15} />
              <span>Canali</span>
            </div>
          </button>
          {engineMode && (
            <button
              type="button"
              className={`cw-sb-nav-item ${space === "Spazi remoti" ? "active" : ""}`}
              onClick={() => onOpenSpace("Spazi remoti")}
            >
              <div className="cw-sb-item-left">
                <Globe size={15} />
                <span>Spazi remoti</span>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
