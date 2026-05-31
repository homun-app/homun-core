import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  Monitor,
} from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

interface ChatComputerPanelProps {
  /** What the agent is currently doing (e.g. the active browse_web goal). */
  activity?: string | null;
}

// Manus-style inline "Computer": a polished, proportioned, collapsible live view
// of the contained browser, pinned in the chat so the user SEES what the agent
// is doing. Shown only when contained-computer mode is live.
export function ChatComputerPanel({ activity }: ChatComputerPanelProps) {
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  const [open, setOpen] = useState(true);
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

  // Esc closes fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  if (!live?.enabled || !live.novnc_url) return null;

  const src = `${live.novnc_url}${live.novnc_url.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&reconnect=true`;
  const status = activity?.trim()
    ? activity.trim()
    : "Browser reale contenuto · pronto";

  return (
    <div
      className={`chat-computer-panel${fullscreen ? " fullscreen" : ""}${open ? "" : " collapsed"}`}
    >
      <header className="chat-computer-head">
        <button
          className="chat-computer-toggle"
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Comprimi" : "Espandi"}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <Monitor size={15} />
          <strong>Computer</strong>
          <span className="chat-computer-live">
            <i className="chat-computer-dot" /> live
          </span>
        </button>
        <span className="chat-computer-activity" title={status}>
          {status}
        </span>
        <button
          className="chat-computer-action"
          type="button"
          onClick={() => setFullscreen((value) => !value)}
          title={fullscreen ? "Riduci" : "Schermo intero"}
          aria-label={fullscreen ? "Riduci" : "Schermo intero"}
        >
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </header>

      {(open || fullscreen) && (
        <div className="chat-computer-stage">
          <iframe
            className="chat-computer-frame"
            title="Computer contenuto (live)"
            src={src}
            allow="clipboard-read; clipboard-write"
          />
        </div>
      )}

      {fullscreen && (
        <button
          className="chat-computer-scrim"
          type="button"
          aria-label="Chiudi schermo intero"
          onClick={() => setFullscreen(false)}
        />
      )}
    </div>
  );
}
