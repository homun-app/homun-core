import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  RotateCcw,
} from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

const IDLE: ContainedComputerLive = {
  enabled: false,
  novnc_url: null,
  active: false,
  activity: null,
  steps: [],
};

// Manus-style: a short card DOCKED above the prompt (same width), shown ONLY
// while the contained browser is working. Header + live "Avanzamento attività"
// checklist; expand to the live view; fullscreen for the overlay. Hidden idle.
export function ChatComputerPanel() {
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  // "bar" (collapsed, default) | "expanded" (live inline) | "full" (overlay)
  const [view, setView] = useState<"bar" | "expanded" | "full">("bar");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const value = await coreBridge.containedComputerLive();
        if (!cancelled) setLive(value);
      } catch {
        if (!cancelled) setLive(IDLE);
      }
    };
    void poll();
    pollRef.current = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (view !== "full") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView("expanded");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  if (!live?.enabled || !live.novnc_url || !live.active) return null;

  const base = live.novnc_url.replace("/vnc.html", "/vnc_lite.html");
  const src = `${base}${base.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&reconnect=true&view_only=true`;
  const activity = live.activity?.trim() || "sta lavorando…";
  const fullscreen = view === "full";
  const showStage = view === "expanded" || fullscreen;
  const steps = live.steps ?? [];

  return (
    <>
      {fullscreen && (
        <button
          className="cc-scrim"
          type="button"
          aria-label="Chiudi"
          onClick={() => setView("expanded")}
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
          {showStage && (
            <button
              className="cc-icon-btn"
              type="button"
              onClick={() => setView(fullscreen ? "expanded" : "full")}
              title={fullscreen ? "Riduci" : "Schermo intero"}
              aria-label={fullscreen ? "Riduci" : "Schermo intero"}
            >
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button
            className="cc-icon-btn"
            type="button"
            onClick={() => setView(view === "bar" ? "expanded" : "bar")}
            title={view === "bar" ? "Mostra il browser" : "Comprimi"}
            aria-label={view === "bar" ? "Mostra il browser" : "Comprimi"}
          >
            {view === "bar" ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </header>

        {!fullscreen && (
          <div className="cc-plan">
            <div className="cc-plan-head">
              Avanzamento attività
              {steps.length > 0 && <span className="cc-plan-count">{steps.length}</span>}
            </div>
            <ul className="cc-plan-steps">
              {steps.map((step, index) => (
                <li className={`cc-step ${step.status}`} key={index}>
                  {step.status === "retry" ? (
                    <RotateCcw size={13} />
                  ) : (
                    <Check size={13} />
                  )}
                  <span>{step.label}</span>
                </li>
              ))}
              <li className="cc-step running">
                <Loader2 size={13} className="spin" />
                <span>{steps.length === 0 ? "Avvio…" : "in corso…"}</span>
              </li>
            </ul>
          </div>
        )}

        {showStage && (
          <div className="cc-stage">
            <iframe
              className="cc-frame"
              title="Computer contenuto (live)"
              src={src}
              allow="clipboard-read; clipboard-write"
              tabIndex={-1}
            />
          </div>
        )}
      </div>
    </>
  );
}
