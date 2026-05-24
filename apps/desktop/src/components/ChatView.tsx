import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Globe2,
  HardDrive,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pause,
  Play,
  Share2,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { coreBridge, type CoreComputerSessionSnapshot } from "../lib/coreBridge";
import {
  createLoadingComputerSession,
  createUnavailableComputerSession,
  mapCoreComputerSession,
} from "../lib/localComputerViewModel";
import type {
  ChatMessage,
  ChatThread,
  ComputerSession,
  ComputerSurfaceKind,
  RuntimeHealth,
  TaskItem,
} from "../types";

interface ChatViewProps {
  approvalsCount: number;
  computerSessionId: string;
  messages: ChatMessage[];
  health: RuntimeHealth[];
  task: TaskItem;
  thread: ChatThread;
  onMessagesChange: (messages: ChatMessage[]) => void;
}

const surfaceIcons: Record<ComputerSurfaceKind, typeof Globe2> = {
  browser: Globe2,
  shell: SquareTerminal,
  files: FileText,
  logs: HardDrive,
};

export function ChatView({
  approvalsCount,
  computerSessionId,
  messages,
  health,
  task,
  thread,
  onMessagesChange,
}: ChatViewProps) {
  const [computerSession, setComputerSession] = useState<ComputerSession>(() =>
    createLoadingComputerSession(computerSessionId),
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activeSurface, setActiveSurface] = useState<ComputerSurfaceKind>(
    computerSession.activeSurface,
  );
  const [smokeTestRunning, setSmokeTestRunning] = useState(false);
  const [smokeTestError, setSmokeTestError] = useState<string | null>(null);
  const [planStepRunning, setPlanStepRunning] = useState(false);
  const [planStepError, setPlanStepError] = useState<string | null>(null);
  const [computerControlBusy, setComputerControlBusy] = useState(false);
  const [computerControlError, setComputerControlError] = useState<string | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(true);
  const conversationRef = useRef<HTMLDivElement>(null);
  const activeHealth = useMemo(
    () => health.filter((item) => item.status !== "attention").slice(0, 2),
    [health],
  );
  const threadMessages = messages;

  async function runLocalSmokeTest() {
    setSmokeTestRunning(true);
    setSmokeTestError(null);
    try {
      const snapshot =
        await coreBridge.runLocalComputerSmokeTest(computerSessionId);
      setComputerSession(mapCoreComputerSession(snapshot));
    } catch (error) {
      setSmokeTestError(describeBridgeError(error));
    } finally {
      setSmokeTestRunning(false);
    }
  }

  async function runPromptPlanNextStep() {
    setPlanStepRunning(true);
    setPlanStepError(null);
    try {
      const result = await coreBridge.runPromptPlanReadySteps(
        computerSessionId,
        4,
      );
      const snapshot = await coreBridge.localComputerSession(computerSessionId);
      if (snapshot) {
        setComputerSession(mapCoreComputerSession(snapshot));
      }
      const lastResult = result.results.at(-1);
      onMessagesChange([
        ...threadMessages,
        {
          id: `local_plan_batch_${Date.now()}`,
          role: "system",
          text:
            result.completed > 0
              ? `Eseguiti ${result.completed} step locali. ${lastResult?.message ?? ""}`.trim()
              : (lastResult?.message ?? "Nessuno step pronto."),
          timestamp: "ora",
          metadata: result.stopped_reason ?? result.status,
        },
      ]);
    } catch (error) {
      setPlanStepError(describeBridgeError(error));
    } finally {
      setPlanStepRunning(false);
    }
  }

  async function runComputerControl(
    action: (sessionId: string) => Promise<CoreComputerSessionSnapshot>,
  ) {
    setComputerControlBusy(true);
    setComputerControlError(null);
    try {
      const snapshot = await action(computerSessionId);
      setComputerSession(mapCoreComputerSession(snapshot));
    } catch (error) {
      setComputerControlError(describeBridgeError(error));
    } finally {
      setComputerControlBusy(false);
    }
  }

  async function submitPrompt(prompt: string) {
    const text = prompt.trim();
    if (!text) return;

    setPromptSubmitting(true);
    setPromptError(null);
    const userMessage: ChatMessage = {
      id: `local_user_${Date.now()}`,
      role: "user",
      text,
      timestamp: "ora",
      metadata: "Inviato al core locale",
    };
    const promptMessages = [...threadMessages, userMessage];
    onMessagesChange(promptMessages);

    try {
      const result = await coreBridge.submitUserPrompt(computerSessionId, text);
      setComputerSession(mapCoreComputerSession(result.computer_session));
      onMessagesChange([
        ...promptMessages,
        {
          id: result.assistant_message.id,
          role: result.assistant_message.role,
          text: result.assistant_message.text,
          timestamp: result.assistant_message.timestamp,
          metadata: result.assistant_message.metadata ?? undefined,
        },
      ]);
    } catch (error) {
      const message = describeBridgeError(error);
      setPromptError(message);
      onMessagesChange([
        ...promptMessages,
        {
          id: `local_error_${Date.now()}`,
          role: "system",
          text: message,
          timestamp: "ora",
        },
      ]);
    } finally {
      setPromptSubmitting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setComputerSession(createLoadingComputerSession(computerSessionId));
    setPreviewDataUrl(null);

    async function loadLocalComputerSession() {
      try {
        const snapshot = await coreBridge.localComputerSession(computerSessionId);
        if (cancelled) return;
        setComputerSession(
          snapshot
            ? mapCoreComputerSession(snapshot)
            : createUnavailableComputerSession(
                computerSessionId,
                "Nessuna sessione computer trovata nel core locale.",
              ),
        );
      } catch (error) {
        if (cancelled) return;
        setComputerSession(
          createUnavailableComputerSession(
            computerSessionId,
            describeBridgeError(error),
          ),
        );
      }
    }

    void loadLocalComputerSession();
    const interval = window.setInterval(loadLocalComputerSession, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [computerSessionId]);

  useEffect(() => {
    let cancelled = false;
    const artifactId = computerSession.previewArtifactId;
    if (!artifactId || computerSession.source !== "core") {
      setPreviewDataUrl(null);
      return () => {
        cancelled = true;
      };
    }
    const previewArtifactId = artifactId;

    async function loadPreview() {
      try {
        const preview = await coreBridge.localComputerArtifactPreview(
          computerSession.id,
          previewArtifactId,
        );
        if (!cancelled) {
          setPreviewDataUrl(preview?.data_url ?? null);
        }
      } catch {
        if (!cancelled) {
          setPreviewDataUrl(null);
        }
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [computerSession.id, computerSession.previewArtifactId, computerSession.source]);

  useEffect(() => {
    if (
      !computerSession.surfaces.some((surface) => surface.id === activeSurface)
    ) {
      setActiveSurface(computerSession.activeSurface);
    }
  }, [activeSurface, computerSession.activeSurface, computerSession.surfaces]);

  useEffect(() => {
    function scrollToBottom(behavior: ScrollBehavior = "smooth") {
      const node = conversationRef.current;
      if (!node) return;
      node.scrollTo({ top: node.scrollHeight, behavior });
    }

    const handleResize = () => scrollToBottom("auto");

    requestAnimationFrame(() => scrollToBottom("auto"));
    const timeout = window.setTimeout(() => scrollToBottom(), 120);
    window.addEventListener("resize", handleResize);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", handleResize);
    };
  }, [threadMessages, detailsOpen]);

  return (
    <section className="chat-view active-task-layout" aria-labelledby="chat-title">
      <header className="task-topbar">
        <div className="task-title-area">
          <button
            className="task-title-button"
            type="button"
            onClick={() => setModelOpen((value) => !value)}
          >
            <span id="chat-title">{thread.title}</span>
            <ChevronDown size={15} />
          </button>
          {modelOpen && (
            <div className="floating-menu model-menu" role="menu">
              <button type="button">
                <Sparkles size={15} />
                Gemma 4 locale
                <span>attivo</span>
              </button>
              <button type="button">
                <HardDrive size={15} />
                Solo strumenti locali
                <span>default</span>
              </button>
            </div>
          )}
        </div>

        <div className="task-top-actions">
          {activeHealth.map((item) => (
            <span className={`status-pill ${item.status}`} key={item.label}>
              {item.label}
            </span>
          ))}
          <button
            className="top-action"
            type="button"
            onClick={() => setShareOpen((value) => !value)}
          >
            <Share2 size={15} />
            Condividi
          </button>
          <button className="icon-button" type="button" aria-label="Altre azioni">
            <MoreHorizontal size={18} />
          </button>
          {shareOpen && (
            <div className="floating-menu share-menu" role="menu">
              <strong>Condivisione</strong>
              <button type="button">Solo io</button>
              <button type="button">Esporta riepilogo redatto</button>
              <button type="button">Crea link locale</button>
            </div>
          )}
        </div>
      </header>

      <div className="thread-scroll" aria-label="Thread attivo" ref={conversationRef}>
        <div className="thread-content">
          {threadMessages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              {message.role !== "user" && (
                <header className="assistant-label">
                  <Sparkles size={17} />
                  <strong>assistant</strong>
                  <span>Local</span>
                </header>
              )}
              <p>{message.text}</p>
              <footer>
                <span>{message.timestamp}</span>
                {message.metadata && <span>{message.metadata}</span>}
              </footer>
            </article>
          ))}

          <InlineTimeline
            collapsed={timelineCollapsed}
            onToggle={() => setTimelineCollapsed((current) => !current)}
            session={computerSession}
          />

          <LocalComputerCard
            approvalsCount={approvalsCount}
            smokeTestError={smokeTestError}
            smokeTestRunning={smokeTestRunning}
            planStepError={planStepError}
            planStepRunning={planStepRunning}
            previewDataUrl={previewDataUrl}
            session={computerSession}
            task={task}
            onOpen={() => setDetailsOpen(true)}
            onRunPlanStep={runPromptPlanNextStep}
            onRunSmokeTest={runLocalSmokeTest}
          />
        </div>
      </div>

      {detailsOpen && (
        <ComputerDetailPanel
          activeSurface={activeSurface}
          controlBusy={computerControlBusy}
          controlError={computerControlError}
          onClose={() => setDetailsOpen(false)}
          onPause={() => runComputerControl(coreBridge.pauseLocalComputerSession)}
          onResume={() => runComputerControl(coreBridge.resumeLocalComputerSession)}
          onSelectSurface={setActiveSurface}
          onTakeover={() => runComputerControl(coreBridge.requestLocalComputerTakeover)}
          previewDataUrl={previewDataUrl}
          session={computerSession}
        />
      )}

      <Composer
        disabled={promptSubmitting}
        error={promptError}
        onSubmit={submitPrompt}
      />
    </section>
  );
}

function describeBridgeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Bridge Tauri non raggiungibile in questa visualizzazione.";
  }

  if (error.message.includes("invoke")) {
    return "Anteprima web attiva: il read model reale e' disponibile aprendo l'app Tauri.";
  }

  return error.message;
}

function InlineTimeline({
  collapsed,
  onToggle,
  session,
}: {
  collapsed: boolean;
  onToggle: () => void;
  session: ComputerSession;
}) {
  if (session.timeline.length === 0) {
    return null;
  }

  const visibleTimeline = collapsed ? session.timeline.slice(-2) : session.timeline;

  return (
    <div
      className={`inline-timeline ${collapsed ? "timeline-collapsed" : ""}`}
      aria-label="Avanzamento attività"
    >
      <div className="timeline-header">
        <div>
          <strong>Attività computer</strong>
          <span>
            {session.progressCurrent} / {session.progressTotal}
          </span>
        </div>
        <button
          className="timeline-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span>{collapsed ? "Mostra dettagli" : "Nascondi"}</span>
          <ChevronDown
            className={collapsed ? "" : "timeline-toggle-icon-open"}
            size={15}
          />
        </button>
      </div>
      {visibleTimeline.map((item) => {
        const Icon = surfaceIcons[item.surface];
        return (
          <div className={`timeline-step ${item.status}`} key={item.id}>
            <span className="timeline-state">
              {item.status === "done" ? <Check size={12} /> : <Clock3 size={12} />}
            </span>
            <div>
              <strong>{item.title}</strong>
              <small>
                <Icon size={13} />
                {item.detail}
              </small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LocalComputerCard({
  approvalsCount,
  onOpen,
  onRunPlanStep,
  onRunSmokeTest,
  planStepError,
  planStepRunning,
  previewDataUrl,
  session,
  smokeTestError,
  smokeTestRunning,
  task,
}: {
  approvalsCount: number;
  onOpen: () => void;
  onRunPlanStep: () => void;
  onRunSmokeTest: () => void;
  planStepError: string | null;
  planStepRunning: boolean;
  previewDataUrl: string | null;
  session: ComputerSession;
  smokeTestError: string | null;
  smokeTestRunning: boolean;
  task: TaskItem;
}) {
  return (
    <article className="local-computer-card">
      <button className="computer-card-main" type="button" onClick={onOpen}>
        <div className="computer-preview" aria-hidden="true">
          {previewDataUrl ? (
            <img
              className="computer-preview-image"
              alt=""
              src={previewDataUrl}
            />
          ) : (
            <>
              <div className="browser-chrome">
                <span />
                <span />
                <span />
              </div>
              <div className="browser-lines">
                <i />
                <i />
                <i />
              </div>
              <div className="terminal-preview">
                <span>$ date</span>
                <span>CEST · local</span>
              </div>
            </>
          )}
        </div>
        <div className="computer-card-copy">
          <div className="computer-card-title">
            <strong>{session.title}</strong>
            <span>{session.elapsed}</span>
          </div>
          <p>{session.subtitle}</p>
          <small>{session.previewDetail}</small>
        </div>
        <div className="computer-card-progress">
          <span>{session.progressCurrent} / {session.progressTotal}</span>
          <ChevronDown size={16} />
        </div>
      </button>

      <div className="computer-card-footer">
        <span className="status-line">
          <Play size={14} />
          {task.title}
        </span>
        <div className="computer-card-actions">
          {(smokeTestError || planStepError) && (
            <span>{smokeTestError ?? planStepError}</span>
          )}
          <button
            className="smoke-test-button"
            disabled={planStepRunning}
            type="button"
            onClick={onRunPlanStep}
          >
            {planStepRunning ? "Esecuzione" : "Esegui piano"}
          </button>
          <button
            className="smoke-test-button"
            disabled={smokeTestRunning}
            type="button"
            onClick={onRunSmokeTest}
          >
            {smokeTestRunning ? "In esecuzione" : "Test reale"}
          </button>
          <span>{approvalsCount} approval</span>
        </div>
      </div>
    </article>
  );
}

function ComputerDetailPanel({
  activeSurface,
  controlBusy,
  controlError,
  onClose,
  onPause,
  onResume,
  onSelectSurface,
  onTakeover,
  previewDataUrl,
  session,
}: {
  activeSurface: ComputerSurfaceKind;
  controlBusy: boolean;
  controlError: string | null;
  onClose: () => void;
  onPause: () => void;
  onResume: () => void;
  onSelectSurface: (surface: ComputerSurfaceKind) => void;
  onTakeover: () => void;
  previewDataUrl: string | null;
  session: ComputerSession;
}) {
  const currentSurface = session.surfaces.find((surface) => surface.id === activeSurface);
  const paused = session.status === "paused";

  return (
    <aside className="computer-detail-panel" aria-label="Dettaglio computer locale">
      <header>
        <div>
          <strong>{session.title}</strong>
          <small>{session.subtitle}</small>
        </div>
        <button className="icon-button" type="button" aria-label="Chiudi computer" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <nav className="surface-tabs" aria-label="Superfici computer">
        {session.surfaces.map((surface) => {
          const Icon = surfaceIcons[surface.id];
          return (
            <button
              className={activeSurface === surface.id ? "active" : ""}
              key={surface.id}
              type="button"
              onClick={() => onSelectSurface(surface.id)}
            >
              <Icon size={15} />
              {surface.label}
            </button>
          );
        })}
      </nav>

      <div className="computer-live-view">
        {activeSurface === "browser" && (
          <div className="browser-live-frame">
            <div className="browser-live-bar">
              <span>{session.previewTitle}</span>
            </div>
            <div className="browser-live-body">
              {previewDataUrl ? (
                <img
                  className="browser-live-image"
                  alt="Preview browser redatta"
                  src={previewDataUrl}
                />
              ) : (
                <>
                  <strong>{session.previewTitle}</strong>
                  <p>{session.previewDetail}</p>
                  <div className="result-skeleton">
                    <span />
                    <span />
                    <span />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {activeSurface === "shell" && (
          <pre className="terminal-live-frame">
            {session.terminalExcerpt.length
              ? session.terminalExcerpt.join("\n")
              : "Nessun output terminale disponibile."}
          </pre>
        )}

        {activeSurface === "files" && (
          <div className="artifact-list">
            {session.artifacts.length ? (
              session.artifacts.map((artifact) => (
                <article key={artifact.id}>
                  <FileText size={17} />
                  <div>
                    <strong>{artifact.name}</strong>
                    <small>{artifact.detail}</small>
                  </div>
                </article>
              ))
            ) : (
              <p className="empty-panel-state">Nessun artifact redatto.</p>
            )}
          </div>
        )}

        {activeSurface === "logs" && (
          <div className="log-list">
            {session.timeline.length ? (
              session.timeline.map((item) => (
                <span key={item.id}>
                  {item.timestamp} · {item.title}
                </span>
              ))
            ) : (
              <span>Nessun evento redatto disponibile.</span>
            )}
          </div>
        )}
      </div>

      <footer className="computer-panel-footer">
        <span>{controlError ?? currentSurface?.detail}</span>
        <div>
          <button
            className="secondary-button"
            disabled={controlBusy}
            type="button"
            onClick={paused ? onResume : onPause}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Riprendi" : "Pausa"}
          </button>
          <button
            className="primary-button"
            disabled={controlBusy}
            type="button"
            onClick={onTakeover}
          >
            Prendi controllo
          </button>
        </div>
      </footer>
    </aside>
  );
}

function Composer({
  disabled,
  error,
  onSubmit,
}: {
  disabled: boolean;
  error: string | null;
  onSubmit: (prompt: string) => void;
}) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = value.trim();
    if (!prompt || disabled) return;
    setValue("");
    onSubmit(prompt);
  }

  return (
    <form className="composer-surface" aria-label="Prompt operativo" onSubmit={handleSubmit}>
      <textarea
        aria-label="Richiesta per l'assistente"
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Invia un messaggio o aggiungi istruzioni al task"
        value={value}
      />
      <div className="composer-toolbar">
        <div className="composer-actions">
          <button className="icon-button" type="button" aria-label="Aggiungi allegato">
            <Paperclip size={17} />
          </button>
          <button className="tool-chip" type="button">
            <Globe2 size={16} />
            Computer locale
          </button>
        </div>
        <div className="composer-actions">
          <button className="icon-button" type="button" aria-label="Dettatura">
            <Mic size={17} />
          </button>
          {error && <span className="composer-error">{error}</span>}
          <button className="send-button" disabled={disabled || !value.trim()} type="submit" aria-label="Invia">
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </form>
  );
}
