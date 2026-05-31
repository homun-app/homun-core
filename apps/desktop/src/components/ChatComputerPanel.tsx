import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Monitor } from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

// Manus-style: a card DOCKED above the prompt, shown ONLY while the contained
// browser is actually working. It keeps a small live PiP of the browser always
// visible, expandable to a full view and to fullscreen. When the browser is idle
// it renders nothing (no fake "LIVE"), leaving the conversation's task surfaces.
export function ChatComputerPanel() {
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  // "pip" (small preview, default) | "expanded" (full inline) | "full" (overlay)
  const [view, setView] = useState<"pip" | "expanded" | "full">("pip");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const value = await coreBridge.containedComputerLive();
        if (!cancelled) setLive(value);
      } catch {
        if (!cancelled) setLive({ enabled: false, novnc_url: null, active: false, activity: null });
      }
    };
    void poll();
    pollRef.current = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (view !== "full") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView("pip");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  // Only present while the browser is actually working.
  if (!live?.enabled || !live.novnc_url || !live.active) return null;

  // vnc_lite.html (no noVNC toolbar) → the canvas fills the frame, no black bars.
  const base = live.novnc_url.replace("/vnc.html", "/vnc_lite.html");
  const src = `${base}${base.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&reconnect=true&view_only=true`;
  const activity = live.activity?.trim() || "sta lavorando…";
  const fullscreen = view === "full";

  return (
    <>
      {fullscreen && (
        <button
          className="cc-scrim"
          type="button"
          aria-label="Chiudi"
          onClick={() => setView("pip")}
        />
      )}
      <div className={`cc-dock ${view}`}>
        <header className="cc-dock-bar">
          <span className="cc-dock-title">
            <Monitor size={15} />
            <strong>Computer</strong>
            <span className="cc-live">
              <i className="cc-live-dot" /> live
            </span>
          </span>
          <span className="cc-dock-activity" title={activity}>
            {activity}
          </span>
          <button
            className="cc-icon-btn"
            type="button"
            onClick={() => setView(fullscreen ? "expanded" : "full")}
            title={fullscreen ? "Riduci" : "Schermo intero"}
            aria-label={fullscreen ? "Riduci" : "Schermo intero"}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </header>
        {/* One iframe, resized via the view class — no remount, no reconnect.
            Click the small PiP to expand. The iframe is pointer-events:none so
            the click toggles size (it's a view-only live preview). */}
        <div
          className="cc-stage"
          role="button"
          tabIndex={0}
          title={view === "pip" ? "Espandi" : "Riduci"}
          onClick={() => setView(view === "pip" ? "expanded" : "pip")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setView(view === "pip" ? "expanded" : "pip");
            }
          }}
        >
          <iframe
            className="cc-frame"
            title="Computer contenuto (live)"
            src={src}
            allow="clipboard-read; clipboard-write"
            tabIndex={-1}
          />
        </div>
      </div>
    </>
  );
}
