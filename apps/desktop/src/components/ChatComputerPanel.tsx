import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  AppWindow,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  Pause,
  Play,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  approveHostComputerAction,
  cancelHostComputerSession,
  coreBridge,
  denyHostComputerAction,
  hostComputerStatus,
  pauseHostComputerSession,
  resumeHostComputerSession,
  type ContainedComputerLive,
  type HostComputerWireEvent,
  type TerminalEntry,
} from "../lib/coreBridge";
import {
  initialHostComputerState,
  reduceHostComputerEvent,
  type HostComputerState,
} from "../lib/hostComputerState";
import { wsSubscription } from "../lib/wsSubscription";

type ComputerConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "failed";

const IDLE: ContainedComputerLive = {
  enabled: false,
  phase: "off",
  container_ok: false,
  cdp_ok: false,
  novnc_ok: false,
  error_code: null,
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
  const [hostComputerSession, setHostComputerSession] = useState<HostComputerState>(() => ({ ...initialHostComputerState }));
  // "bar" (collapsed, default) | "expanded" (live inline) | "full" (overlay)
  // Default to the big browser (Fabio's ask): the live view takes the space, not a thumbnail.
  const [view, setView] = useState<"bar" | "expanded" | "full">("expanded");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  void pollRef; // kept for compatibility; no longer used after WS migration
  // Liveness: track WHEN the activity last changed so the panel can show "Xs ago" and a
  // soft "may be stuck" warning — otherwise the spinner looks identical whether the agent
  // is advancing or frozen (the "I can't tell if it's stuck" report).
  const lastActivityAtRef = useRef<number>(Date.now());
  const prevActivitySigRef = useRef<string>("");
  const [now, setNow] = useState<number>(() => Date.now());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [computerConnectionState, setComputerConnectionState] =
    useState<ComputerConnectionState>("idle");
  const [viewerRetry, setViewerRetry] = useState(0);
  const viewerBase = live?.novnc_url?.replace("/vnc.html", "/lfpa-view.html") ?? null;
  const computerViewerSrc = viewerBase
    ? `${viewerBase}${viewerBase.includes("?") ? "&" : "?"}view_only=1&viewer=csp-external-v1&retry=${viewerRetry}`
    : null;

  useEffect(() => {
    // Primary: unified WS push (computer.live events from the gateway).
    const unsub = wsSubscription.subscribe((msg) => {
      if (msg.type === "computer.live" && msg.state) {
        const state = msg.state as { source?: string; host?: HostComputerWireEvent };
        if (state.source === "host_apps" && state.host) {
          const event = state.host;
          setHostComputerSession((current) => reduceHostComputerEvent(current, event));
        } else {
          setLive(msg.state as ContainedComputerLive);
        }
      }
      if (msg.type === "app.event" && msg.event) {
        const event = msg.event as HostComputerWireEvent;
        if (typeof event.type === "string" && event.type.startsWith("host_computer.")) {
          setHostComputerSession((current) => reduceHostComputerEvent(current, event));
        }
      }
    });
    // Fallback: initial fetch so we don't wait for the first WS push.
    void coreBridge.containedComputerLive().then((value) => setLive(value)).catch(() => {});
    void hostComputerStatus().then((value) => {
      if (value.host_session) {
        setHostComputerSession((current) => reduceHostComputerEvent(current, value.host_session!));
      }
    }).catch(() => {});
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

  useEffect(() => {
    if (!computerViewerSrc) {
      setComputerConnectionState("idle");
      return;
    }
    setComputerConnectionState(live?.phase === "failed" ? "failed" : "connecting");
    const expectedOrigin = new URL(computerViewerSrc, window.location.href).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== expectedOrigin) return;
      const payload = event.data as { type?: unknown; state?: unknown } | null;
      if (payload?.type !== "homun-novnc-state") return;
      if (!["connecting", "connected", "disconnected", "failed"].includes(String(payload.state))) return;
      setComputerConnectionState(payload.state as ComputerConnectionState);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [computerViewerSrc, live?.phase]);

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
  const hostIsRunning = Boolean(
    hostComputerSession.sessionId &&
    !["done", "failed", "cancelled"].includes(hostComputerSession.phase),
  );
  // Only bubble a CHANGED status up to ChatView. The unified-WS publisher pushes
  // `computer.live` ~1×/s while the container is alive (now that it stays alive across
  // idle), and `live.activity` changes each frame — but for a thread that doesn't own
  // the live session the reported status is a constant {active:false, activity:null}.
  // Without this guard we called onLiveChange (→ setComputerLiveStatus, a NEW object)
  // every second, re-rendering ChatView ~1Hz and wiping the composer draft mid-typing.
  const lastSentRef = useRef<{ active: boolean; activity: string | null }>({
    active: false,
    activity: null,
  });
  useEffect(() => {
    const next = {
      active: Boolean(hostIsRunning || ownedLiveActivity),
      activity: hostIsRunning
        ? `${hostComputerSession.app ?? t("chat.hostComputer.macApps")} · ${hostComputerSession.phase}`
        : ownedLiveActivity ? (live?.activity ?? null) : null,
    };
    if (
      lastSentRef.current.active === next.active &&
      lastSentRef.current.activity === next.activity
    ) {
      return;
    }
    lastSentRef.current = next;
    onLiveChange?.(next);
  }, [hostComputerSession.app, hostComputerSession.phase, hostIsRunning, live?.activity, onLiveChange, ownedLiveActivity, t]);
  if (hostComputerSession.sessionId) {
    return <HostComputerDock state={hostComputerSession} />;
  }
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

  if (!live?.enabled || !live.novnc_url || !live.active || !computerViewerSrc) return null;

  // Chrome-free embed page (RFB core with scaleViewport) — shows the WHOLE
  // contained display, scaled to fit and proportioned, with no noVNC toolbar.
  const src = computerViewerSrc;
  const fullscreen = view === "full";
  const showStage = view === "expanded" || fullscreen;
  const steps = live.steps ?? [];
  // Seconds since the last visible activity change → liveness. A soft "may be stuck"
  // warning after the threshold (a single slow action can legitimately take ~30s, so the
  // threshold is generous to avoid false alarms).
  const idleSec = Math.max(0, Math.floor((now - lastActivityAtRef.current) / 1000));
  const stalled = idleSec >= 45;
  // Single, alternating status line (Fabio's ask): the browser takes the space, and ONE
  // line below shows the CURRENT action, cycling as the backend pushes new steps — not a
  // growing scrollable list. Prefer the latest browser STEP (the real action, e.g. "navigate
  // to …"); NEVER `live.activity`, which carries the raw browse goal (the whole prompt) and
  // would leak the system prompt into the status line. Strip the leading emoji for clean text.
  const rawAction = steps.length > 0 ? steps[steps.length - 1]?.label ?? "" : "";
  const currentAction =
    rawAction.replace(/^(?:\p{Extended_Pictographic}|️|‍|\s)+/u, "").trim() || t("chat.starting");

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
            {computerConnectionState === "connected" ? (
              <span className="cc-live">
                <i className="cc-live-dot" /> live
              </span>
            ) : (
              <span className="cc-connection-state">{t("chat.starting")}</span>
            )}
          </span>
          {/* One control, right-aligned: enlarge to fullscreen ⇄ contract back. */}
          <button
            className="cc-icon-btn cc-dock-toggle"
            type="button"
            onClick={() => setView(fullscreen ? "expanded" : "full")}
            title={fullscreen ? t("chat.collapse") : t("chat.fullscreen")}
            aria-label={fullscreen ? t("chat.collapse") : t("chat.fullscreen")}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </header>

        {/* The browser takes the space; one status line below it alternates the actions. */}
        {showStage && (
          <div className="cc-stage">
            {computerConnectionState !== "connected" && (
              <div className="cc-connection-overlay" role={computerConnectionState === "failed" ? "alert" : "status"}>
                {computerConnectionState === "failed" || computerConnectionState === "disconnected" ? (
                  <AlertTriangle size={18} />
                ) : (
                  <Loader2 size={18} className="spin" />
                )}
                <strong>
                  {computerConnectionState === "failed" || computerConnectionState === "disconnected"
                    ? "Computer non disponibile"
                    : "Connessione al computer…"}
                </strong>
                {(computerConnectionState === "failed" || computerConnectionState === "disconnected") && (
                  <button
                    type="button"
                    className="state-retry"
                    onClick={() => {
                      setComputerConnectionState("connecting");
                      setViewerRetry((value) => value + 1);
                    }}
                  >
                    {t("common.retry")}
                  </button>
                )}
              </div>
            )}
            <iframe
              ref={iframeRef}
              className="cc-frame"
              title="Contained computer (live)"
              src={src}
              allow="clipboard-read; clipboard-write"
              tabIndex={-1}
            />
          </div>
        )}

        {!fullscreen && (
          <div className={`cc-statusline${stalled ? " stalled" : ""}`}>
            {stalled ? (
              <AlertTriangle size={13} />
            ) : (
              <Loader2 size={13} className="spin" />
            )}
            <span className="cc-statusline-text">{currentAction}</span>
            {idleSec >= 3 && <span className="cc-step-elapsed">· {idleSec}s</span>}
          </div>
        )}
      </div>
    </>
  );
}

function HostComputerDock({ state }: { state: HostComputerState }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const pending = state.pendingApproval;
  const terminal = ["done", "failed", "cancelled"].includes(state.phase);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`cc-dock expanded host-computer-dock phase-${state.phase}`}>
      <header className="cc-dock-bar">
        <span className="cc-dock-title">
          <AppWindow size={15} />
          <strong>{t("chat.hostComputer.computer")}</strong>
          <span className="cc-source-badge">{t("chat.hostComputer.mac")}</span>
          {!terminal && <span className="cc-live"><i className="cc-live-dot" /> {t("chat.hostComputer.live")}</span>}
        </span>
        {!terminal && state.phase !== "paused_by_user" && (
          <button className="cc-icon-btn" type="button" disabled={busy} onClick={() => void run(() => pauseHostComputerSession(state.sessionId!))} aria-label={t("chat.hostComputer.pause")} title={t("chat.hostComputer.pause")}>
            <Pause size={15} />
          </button>
        )}
      </header>

      <div className="host-computer-stage" aria-live="polite">
        <div className="host-computer-app">
          <AppWindow size={28} />
          <div>
            <strong>{state.app ?? t("chat.hostComputer.macApps")}</strong>
            {state.window && <span>{state.window}</span>}
          </div>
          <span className="host-computer-phase">{t(`chat.hostComputer.phase.${state.phase}`)}</span>
        </div>
        {state.artifactRef ? (
          <div className="host-computer-observation" role="img" aria-label={t("chat.hostComputer.observationAvailable")}>
            <Monitor size={32} />
            <span>{t("chat.hostComputer.observationAvailable")}</span>
          </div>
        ) : (
          <div className="host-computer-observation empty">
            <Monitor size={32} />
            <span>{t("chat.hostComputer.semanticObservation")}</span>
          </div>
        )}
      </div>

      {pending && state.phase === "awaiting_approval" && (
        <div className="host-computer-approval">
          <div>
            <strong>{t("chat.hostComputer.approvalTitle")}</strong>
            <p>{pending.summary}</p>
          </div>
          <div className="host-computer-actions">
            <button className="set-btn primary" type="button" disabled={busy} onClick={() => void run(() => approveHostComputerAction(state.sessionId!, pending.actionDigest))}>
              <Check size={14} /> {t("chat.hostComputer.approve")}
            </button>
            <button className="set-btn" type="button" disabled={busy} onClick={() => void run(() => denyHostComputerAction(state.sessionId!, pending.actionDigest))}>
              <X size={14} /> {t("chat.hostComputer.deny")}
            </button>
          </div>
        </div>
      )}

      {state.phase === "paused_by_user" && (
        <div className="host-computer-takeover">
          <strong>{t("chat.hostComputer.youTookControl")}</strong>
          <button className="set-btn primary" type="button" disabled={busy} onClick={() => void run(() => resumeHostComputerSession(state.sessionId!, state.generation))}>
            <Play size={14} /> {t("chat.hostComputer.resume")}
          </button>
        </div>
      )}

      {state.errorCode && <div className="cc-statusline stalled"><AlertTriangle size={13} /><span>{t(`chat.hostComputer.error.${state.errorCode}`, { defaultValue: state.errorCode })}</span></div>}
      {!terminal && (
        <div className="host-computer-footer">
          <span>{t("chat.hostComputer.physicalInputHint")}</span>
          <button className="set-btn" type="button" disabled={busy} onClick={() => void run(() => cancelHostComputerSession(state.sessionId!))}>
            <X size={14} /> {t("chat.hostComputer.cancel")}
          </button>
        </div>
      )}
    </div>
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
