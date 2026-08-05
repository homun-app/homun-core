import { FileText, Globe2, HardDrive, Pause, Play, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ComputerSession, ComputerSurfaceKind } from "../types";

const computerSurfaceIcons: Record<ComputerSurfaceKind, typeof Globe2> = {
  browser: Globe2,
  shell: SquareTerminal,
  files: FileText,
  logs: HardDrive,
};

export function ComputerDetailPanel({
  activeSurface,
  controlBusy,
  controlError,
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
  onPause: () => void;
  onResume: () => void;
  onSelectSurface: (surface: ComputerSurfaceKind) => void;
  onTakeover: () => void;
  previewDataUrl: string | null;
  session: ComputerSession;
}) {
  const { t } = useTranslation();
  const currentSurface = session.surfaces.find((surface) => surface.id === activeSurface);
  const paused = session.status === "paused";

  return (
    <div
      className="computer-detail-panel"
      aria-label={t("chat.localComputerDetail")}
    >
      <header>
        <div>
          <strong>{session.title}</strong>
          <small>{session.subtitle}</small>
        </div>
      </header>

      <nav className="surface-tabs" aria-label={t("chat.computerSurfaces")}>
        {session.surfaces.map((surface) => {
          const Icon = computerSurfaceIcons[surface.id];
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
                  alt={t("chat.redactedBrowserPreview")}
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
              : t("chat.noTerminalOutput")}
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
              <p className="empty-panel-state">{t("chat.noRedactedArtifact")}</p>
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
              <span>No redacted events available.</span>
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
            {paused ? t("chat.resume") : t("chat.pause")}
          </button>
          <button
            className="primary-button"
            disabled={controlBusy}
            type="button"
            onClick={onTakeover}
          >
            {t("chat.takeControl")}
          </button>
        </div>
      </footer>
    </div>
  );
}
