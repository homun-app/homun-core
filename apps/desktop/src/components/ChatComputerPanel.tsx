import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  RotateCcw,
  SquareTerminal,
} from "lucide-react";
import { coreBridge, type ContainedComputerLive, type TerminalEntry } from "../lib/coreBridge";

const IDLE: ContainedComputerLive = {
  enabled: false,
  novnc_url: null,
  active: false,
  activity: null,
  steps: [],
  terminal_active: false,
  terminal: [],
};

// Manus-style: a short card DOCKED above the prompt (same width), shown ONLY
// while the contained browser is working. Header + live "Activity progress"
// checklist; expand to the live view; fullscreen for the overlay. Hidden idle.
export function ChatComputerPanel() {
  const { t } = useTranslation();
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

  const browserActive = Boolean(live?.active && live?.novnc_url);
  const terminal = live?.terminal ?? [];
  const hasTerminal = terminal.length > 0;

  // Terminal-only mode: CLI skill running/ran, no browser GUI to show. Render a
  // Manus-style terminal with the executed commands + their output.
  if (!browserActive && hasTerminal) {
    return (
      <TerminalDock
        entries={terminal}
        running={Boolean(live?.terminal_active)}
        expanded={view !== "bar"}
        onToggle={() => setView(view === "bar" ? "expanded" : "bar")}
      />
    );
  }

  if (!live?.enabled || !live.novnc_url || !live.active) return null;

  // Chrome-free embed page (RFB core with scaleViewport) — shows the WHOLE
  // contained display, scaled to fit and proportioned, with no noVNC toolbar.
  const base = live.novnc_url.replace("/vnc.html", "/lfpa-view.html");
  const src = `${base}${base.includes("?") ? "&" : "?"}view_only=1`;
  const activity = live.activity?.trim() || t("chat.working");
  const fullscreen = view === "full";
  const showStage = view === "expanded" || fullscreen;
  const steps = live.steps ?? [];

  return (
    <>
      {fullscreen && (
        <button
          className="cc-scrim"
          type="button"
          aria-label="Close"
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
              title={fullscreen ? t("chat.collapse") : t("chat.fullscreen")}
              aria-label={fullscreen ? t("chat.collapse") : t("chat.fullscreen")}
            >
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button
            className="cc-icon-btn"
            type="button"
            onClick={() => setView(view === "bar" ? "expanded" : "bar")}
            title={view === "bar" ? t("chat.showBrowser") : t("chat.collapse")}
            aria-label={view === "bar" ? t("chat.showBrowser") : t("chat.collapse")}
          >
            {view === "bar" ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </header>

        {!fullscreen && (
          <div className="cc-body">
            {view === "bar" && (
              // Manus-style PiP: an always-visible small LIVE preview while the
              // browser works. One iframe is mounted at a time (bar OR stage),
              // so this never doubles the noVNC connection. Click to expand.
              <button
                className="cc-thumb"
                type="button"
                onClick={() => setView("expanded")}
                title={t("chat.expandComputer")}
                aria-label={t("chat.expandComputer")}
              >
                <iframe
                  className="cc-thumb-frame"
                  title="Preview computer (live)"
                  src={src}
                  tabIndex={-1}
                />
                <span className="cc-thumb-expand">
                  <Maximize2 size={13} />
                </span>
              </button>
            )}
            <div className="cc-plan">
              <div className="cc-plan-head">
                Activity progress
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
                  <span>{steps.length === 0 ? t("chat.starting") : t("chat.inProgress")}</span>
                </li>
              </ul>
            </div>
          </div>
        )}

        {showStage && (
          <div className="cc-stage">
            <iframe
              className="cc-frame"
              title="Contained computer (live)"
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

/** Terminal view of CLI skill execution in the contained computer: the commands
 *  run + their output, Manus-style. Shown when a skill uses the shell (no GUI). */
function TerminalDock({
  entries,
  running,
  expanded,
  onToggle,
}: {
  entries: TerminalEntry[];
  running: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the latest line in view as commands/output arrive.
    if (expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [entries, expanded]);

  const last = entries[entries.length - 1];
  const summary = running
    ? last?.command ?? t("chat.executing")
    : `${entries.length} ${entries.length === 1 ? t("chat.commandCount_one") : t("chat.commandCount_other")}`;

  return (
    <div className={`cc-dock ${expanded ? "expanded" : "bar"}`}>
      <header className="cc-dock-bar">
        <span className="cc-dock-title">
          <SquareTerminal size={15} />
          <strong>Computer</strong>
          {running && (
            <span className="cc-live">
              <i className="cc-live-dot" /> live
            </span>
          )}
        </span>
        <span className="cc-dock-activity" title={summary}>
          {summary}
        </span>
        <button
          className="cc-icon-btn"
          type="button"
          onClick={onToggle}
          title={expanded ? t("chat.collapse") : t("chat.showTerminal")}
          aria-label={expanded ? t("chat.collapse") : t("chat.showTerminal")}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </header>
      {expanded && (
        <div className="cc-term" ref={bodyRef}>
          {entries.map((entry, index) => (
            <div className="cc-term-entry" key={index}>
              <div className="cc-term-cmd">
                <span className="cc-term-prompt">$</span>
                <span>{entry.command}</span>
                {entry.running && <Loader2 size={12} className="spin" />}
              </div>
              {entry.output && <pre className="cc-term-out">{entry.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
