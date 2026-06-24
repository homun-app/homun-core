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
  thread_id: null,
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
export function ChatComputerPanel({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  // "bar" (collapsed, default) | "expanded" (live inline) | "full" (overlay)
  const [view, setView] = useState<"bar" | "expanded" | "full">("bar");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const schedule = (delayMs: number) => {
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      try {
        const value = await coreBridge.containedComputerLive();
        if (!cancelled) {
          setLive(value);
          schedule(isComputerLiveBusy(value) ? 600 : 2500);
        }
      } catch {
        if (!cancelled) {
          setLive(IDLE);
          schedule(2500);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
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

  const browserRunning = Boolean(live?.active && live?.novnc_url);
  const terminal = live?.terminal ?? [];
  const terminalRunning = Boolean(live?.terminal_active || terminal.some((entry) => entry.running));
  const hasLiveActivity = browserRunning || terminalRunning;
  const ownedLiveActivity = hasLiveActivity && live?.thread_id === threadId;
  if (!ownedLiveActivity) return null;

  // Terminal-only mode: CLI skill running, no browser GUI to show. Completed
  // command history belongs to the message/artifact surfaces, not the live dock.
  if (!browserRunning && terminalRunning) {
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

function isComputerLiveBusy(live: ContainedComputerLive | null): boolean {
  const terminal = live?.terminal ?? [];
  return Boolean(
    (live?.active && live?.novnc_url) ||
      live?.terminal_active ||
      terminal.some((entry) => entry.running),
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
