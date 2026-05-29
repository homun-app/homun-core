import type { ComputerSession, ComputerSurfaceKind } from "../types";
import type { CoreComputerSessionSnapshot } from "./coreBridge";

const surfaceKinds: ComputerSurfaceKind[] = ["browser", "shell", "files", "logs"];

export function mapCoreComputerSession(
  snapshot: CoreComputerSessionSnapshot,
): ComputerSession {
  const activeSurface = toSurfaceKind(snapshot.active_surface);
  const previewArtifact = [...snapshot.artifact_refs]
    .reverse()
    .find((artifact) => artifact.preview_ref);
  const operationalPlanMarkdown = [...snapshot.timeline]
    .reverse()
    .find((item) => item.markdown_redacted)?.markdown_redacted ?? undefined;
  const timeline = snapshot.timeline.map((item) => ({
    id: item.event_id,
    surface: toSurfaceKind(item.surface),
    title: item.title,
    detail: item.payload_redacted
      ? item.subtitle_redacted
      : "Dettaglio non mostrato: payload non redatto",
    status: toTimelineStatus(item.status, item.approval_required),
    timestamp: formatClock(item.started_at),
    markdown: item.markdown_redacted ?? undefined,
  }));

  return {
    id: snapshot.computer_session_id,
    title: snapshot.activity_title,
    subtitle: snapshot.activity_subtitle,
    status: toSessionStatus(snapshot.status, snapshot.approval_state),
    activeSurface,
    elapsed: formatElapsed(snapshot.elapsed_seconds),
    progressCurrent: snapshot.progress_current,
    progressTotal: Math.max(snapshot.progress_total, 1),
    previewTitle: snapshot.current_url_redacted ?? "Sessione locale",
    previewDetail: snapshot.preview_frame_ref
      ? `Preview redatta disponibile: ${snapshot.preview_frame_ref}`
      : "Preview non ancora disponibile",
    previewArtifactId: previewArtifact?.artifact_id,
    terminalExcerpt: snapshot.terminal_excerpt_redacted,
    operationalPlanMarkdown,
    surfaces: snapshot.surfaces.map((surface) => ({
      id: toSurfaceKind(surface.surface),
      label: surface.label,
      status: toSurfaceStatus(surface.status),
      detail: surface.detail_redacted ?? "Nessun dettaglio operativo",
    })),
    timeline,
    artifacts: snapshot.artifact_refs.map((artifact) => ({
      id: artifact.artifact_id,
      name: artifact.title_redacted,
      kind: toArtifactKind(artifact.kind),
      detail: `${formatBytes(artifact.size_bytes)} · ${artifact.preview_ref ? "preview redatta" : "solo metadati"}`,
      previewRef: artifact.preview_ref ?? undefined,
    })),
    source: "core",
  };
}

export function createLoadingComputerSession(sessionId: string): ComputerSession {
  return {
    id: sessionId,
    title: "Computer locale",
    subtitle: "Caricamento sessione dal core locale",
    status: "running",
    activeSurface: "browser",
    elapsed: "0s",
    progressCurrent: 0,
    progressTotal: 1,
    previewTitle: "Connessione al Rust Core",
    previewDetail: "Lettura del read model UI-safe in corso",
    terminalExcerpt: [],
    operationalPlanMarkdown: undefined,
    surfaces: defaultSurfaces("waiting"),
    timeline: [],
    artifacts: [],
    source: "loading",
  };
}

export function createUnavailableComputerSession(
  sessionId: string,
  reason: string,
): ComputerSession {
  return {
    id: sessionId,
    title: "Computer locale non collegato",
    subtitle: reason,
    status: "waiting_user",
    activeSurface: "logs",
    elapsed: "0s",
    progressCurrent: 0,
    progressTotal: 1,
    previewTitle: "Gateway locale non disponibile",
    previewDetail: "Il read model operativo sara' esposto dal gateway Rust autonomo.",
    terminalExcerpt: ["local-computer % waiting for local gateway"],
    operationalPlanMarkdown: undefined,
    surfaces: defaultSurfaces("waiting"),
    timeline: [
      {
        id: "bridge-unavailable",
        surface: "logs",
        title: "Bridge locale non disponibile",
        detail: reason,
        status: "waiting",
        timestamp: "ora",
      },
    ],
    artifacts: [],
    source: "unavailable",
  };
}

function defaultSurfaces(status: "idle" | "running" | "waiting" | "done") {
  return [
    { id: "browser" as const, label: "Browser", status, detail: "Superficie browser" },
    { id: "shell" as const, label: "Terminale", status, detail: "Superficie shell" },
    { id: "files" as const, label: "File", status, detail: "Artifact redatti" },
    { id: "logs" as const, label: "Log", status, detail: "Timeline redatta" },
  ];
}

function toSurfaceKind(value: string): ComputerSurfaceKind {
  return surfaceKinds.includes(value as ComputerSurfaceKind)
    ? (value as ComputerSurfaceKind)
    : "logs";
}

function toSessionStatus(
  status: string,
  approvalState: string,
): ComputerSession["status"] {
  if (approvalState === "waiting_user" || status === "waiting_user") {
    return "waiting_user";
  }
  if (status === "paused") {
    return "paused";
  }
  if (status === "completed") {
    return "completed";
  }
  return "running";
}

function toSurfaceStatus(
  status: string,
): "idle" | "running" | "waiting" | "done" {
  if (status === "done" || status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "waiting" || status === "failed") return "waiting";
  return "idle";
}

function toTimelineStatus(
  status: string,
  approvalRequired: boolean,
): "done" | "running" | "waiting" {
  if (approvalRequired || status === "waiting" || status === "blocked") {
    return "waiting";
  }
  if (status === "running") return "running";
  return "done";
}

function toArtifactKind(kind: string): "screenshot" | "terminal" | "file" | "log" {
  if (kind === "screenshot" || kind === "terminal" || kind === "log") return kind;
  return "file";
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "ora";
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
