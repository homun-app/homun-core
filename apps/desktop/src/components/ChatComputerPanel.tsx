import { useEffect, useState } from "react";
import { Maximize2, Minimize2, Monitor, X } from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

interface ChatComputerPanelProps {
  /** What the agent is currently doing (e.g. the active browse_web goal). */
  activity?: string | null;
}

// Manus-style floating "Computer": a small fixed widget on the chat, COLLAPSED
// by default to a pill, expandable to a floating card, and to fullscreen. Shows
// the contained browser live without dominating the conversation. Rendered only
// when contained-computer mode is live.
export function ChatComputerPanel({ activity }: ChatComputerPanelProps) {
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  // "pill" (default, collapsed) | "card" (floating) | "full" (overlay)
  const [view, setView] = useState<"pill" | "card" | "full">("pill");

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
    if (view !== "full") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView("card");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  if (!live?.enabled || !live.novnc_url) return null;

  const src = `${live.novnc_url}${live.novnc_url.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&reconnect=true`;
  const status = activity?.trim() ? activity.trim() : "in attesa";

  // Collapsed pill — the default resting state.
  if (view === "pill") {
    return (
      <button
        className="cc-pill"
        type="button"
        onClick={() => setView("card")}
        title="Apri il Computer"
      >
        <Monitor size={15} />
        <span>Computer</span>
        <i className="cc-pill-dot" />
      </button>
    );
  }

  const fullscreen = view === "full";

  return (
    <>
      {fullscreen && (
        <button
          className="cc-scrim"
          type="button"
          aria-label="Chiudi"
          onClick={() => setView("card")}
        />
      )}
      <div className={`cc-float${fullscreen ? " full" : ""}`}>
        <header className="cc-float-head">
          <span className="cc-float-title">
            <Monitor size={15} />
            <strong>Computer</strong>
            <span className="cc-live">
              <i className="cc-live-dot" /> live
            </span>
          </span>
          <span className="cc-float-activity" title={status}>
            {status}
          </span>
          <button
            className="cc-icon-btn"
            type="button"
            onClick={() => setView(fullscreen ? "card" : "full")}
            title={fullscreen ? "Riduci" : "Schermo intero"}
            aria-label={fullscreen ? "Riduci" : "Schermo intero"}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            className="cc-icon-btn"
            type="button"
            onClick={() => setView("pill")}
            title="Chiudi"
            aria-label="Chiudi"
          >
            <X size={15} />
          </button>
        </header>
        <div className="cc-stage">
          <iframe
            className="cc-frame"
            title="Computer contenuto (live)"
            src={src}
            allow="clipboard-read; clipboard-write"
          />
        </div>
      </div>
    </>
  );
}
