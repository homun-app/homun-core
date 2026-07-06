import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
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
import { wsSubscription } from "../lib/wsSubscription";

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
export function ChatComputerPanel({
  threadId,
  onLiveChange,
}: {
  threadId: string;
  onLiveChange?: (live: { active: boolean; activity: string | null }) => void;
}) {
  const { t } = useTranslation();
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  // "bar" (collapsed, default) | "expanded" (live inline) | "full" (overlay)
  const [view, setView] = useState<"bar" | "expanded" | "full">("bar");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  void pollRef; // kept for compatibility; no longer used after WS migration
  // Liveness: track WHEN the activity last changed so the panel can show "Xs ago" and a
  // soft "may be stuck" warning — otherwise the spinner looks identical whether the agent
  // is advancing or frozen (the "I can't tell if it's stuck" report).
  const lastActivityAtRef = useRef<number>(Date.now());
  const prevActivitySigRef = useRef<string>("");
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // Primary: unified WS push (computer.live events from the gateway).
    const unsub = wsSubscription.subscribe((msg) => {
      if (msg.type === "computer.live" && msg.state) {
        setLive(msg.state as ContainedComputerLive);
      }
    });
    // Fallback: initial fetch so we don't wait for the first WS push.
    void coreBridge.containedComputerLive().then((value) => setLive(value)).catch(() => {});
    return unsub;
  }, []);

  // Watching = activity. The WS migration moved live DATA to a server push that
  // deliberately does NOT reset the container's idle clock, so while the user is
  // actually viewing the live screen (expanded/full) we ping the live endpoint — which
  // touches the idle timer server-side — otherwise the reaper recycles the container
  // out from under them mid-view. Cheap: one small request every 20s, only while open.
  useEffect(() => {
    if (view === "bar") return;
    const ping = () => void coreBridge.containedComputerLive().catch(() => {});
    ping();
    const id = window.setInterval(ping, 20_000);
    return () => window.clearInterval(id);
  }, [view]);

  // Reset the "last activity" clock whenever the step list or activity label changes.
  useEffect(() => {
    const liveSteps = live?.steps ?? [];
    const sig = `${liveSteps.length}:${liveSteps[liveSteps.length - 1]?.label ?? ""}:${live?.activity ?? ""}`;
    if (sig !== prevActivitySigRef.current) {
      prevActivitySigRef.current = sig;
      lastActivityAtRef.current = Date.now();
    }
  }, [live]);

  // 1s ticker so the "Xs ago" / stall state updates while a turn runs.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
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
  useEffect(() => {
    onLiveChange?.({
      active: Boolean(ownedLiveActivity),
      activity: ownedLiveActivity ? (live?.activity ?? null) : null,
    });
  }, [live?.activity, onLiveChange, ownedLiveActivity]);
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
  // Seconds since the last visible activity change → liveness. A soft "may be stuck"
  // warning after the threshold (a single slow action can legitimately take ~30s, so the
  // threshold is generous to avoid false alarms).
  const idleSec = Math.max(0, Math.floor((now - lastActivityAtRef.current) / 1000));
  const stalled = idleSec >= 45;

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
            onClick={() => setView(view === "bar" ? "full" : "bar")}
            title={view === "bar" ? t("chat.fullscreen") : t("chat.collapse")}
            aria-label={view === "bar" ? t("chat.fullscreen") : t("chat.collapse")}
          >
            {view === "bar" ? <Maximize2 size={15} /> : <ChevronDown size={15} />}
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
                <li className={`cc-step ${stalled ? "stalled" : "running"}`}>
                  {stalled ? (
                    <AlertTriangle size={13} />
                  ) : (
                    <Loader2 size={13} className="spin" />
                  )}
                  <span>
                    {steps.length === 0 ? t("chat.starting") : t("chat.inProgress")}
                    {idleSec >= 3 && (
                      <span className="cc-step-elapsed"> · {idleSec}s</span>
                    )}
                    {stalled && (
                      <span className="cc-step-stalled">
                        {" "}
                        — {t("chat.maybeStuck", { defaultValue: "no progress, may be stuck" })}
                      </span>
                    )}
                  </span>
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
