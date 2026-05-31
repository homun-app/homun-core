import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Monitor,
} from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

interface ChatComputerPanelProps {
  /** What the agent is currently doing (e.g. the active browse_web goal). */
  activity?: string | null;
}

// Manus-style: a bar DOCKED above the prompt. When the contained computer is
// live it shows a compact "Computer" bar (collapsed by default) that expands to
// the live browser inline, and to fullscreen. Renders nothing when contained
// mode is off, so the conversation's task surfaces show instead.
export function ChatComputerPanel({ activity }: ChatComputerPanelProps) {
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    coreBridge
      .containedComputerLive()
      .then((value) => {
        if (!cancelled) setLive(value);
      })
      .catch(() => {
        if (!cancelled) setLive({ enabled: false, novnc_url: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  if (!live?.enabled || !live.novnc_url) return null;

  // vnc_lite.html has no noVNC toolbar, so the canvas fills the iframe — with a
  // 16:10 stage that means no black letterbox bars.
  const base = live.novnc_url.replace("/vnc.html", "/vnc_lite.html");
  const src = `${base}${base.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&reconnect=true`;
  const status = activity?.trim() ? activity.trim() : "in attesa";
  const showStage = expanded || fullscreen;

  return (
    <>
      {fullscreen && (
        <button
          className="cc-scrim"
          type="button"
          aria-label="Chiudi"
          onClick={() => setFullscreen(false)}
        />
      )}
      <div className={`cc-dock${fullscreen ? " full" : ""}`}>
        <header className="cc-dock-bar">
          <button
            className="cc-dock-toggle"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            title={expanded ? "Comprimi" : "Mostra il computer"}
          >
            <Monitor size={15} />
            <strong>Computer</strong>
            <span className="cc-live">
              <i className="cc-live-dot" /> live
            </span>
          </button>
          <span className="cc-dock-activity" title={status}>
            {status}
          </span>
          {showStage && (
            <button
              className="cc-icon-btn"
              type="button"
              onClick={() => setFullscreen((value) => !value)}
              title={fullscreen ? "Riduci" : "Schermo intero"}
              aria-label={fullscreen ? "Riduci" : "Schermo intero"}
            >
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button
            className="cc-icon-btn"
            type="button"
            onClick={() => {
              setFullscreen(false);
              setExpanded((value) => !value);
            }}
            title={expanded ? "Comprimi" : "Espandi"}
            aria-label={expanded ? "Comprimi" : "Espandi"}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </button>
        </header>
        {showStage && (
          <div className="cc-stage">
            <iframe
              className="cc-frame"
              title="Computer contenuto (live)"
              src={src}
              allow="clipboard-read; clipboard-write"
            />
          </div>
        )}
      </div>
    </>
  );
}
