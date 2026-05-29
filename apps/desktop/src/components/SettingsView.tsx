import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import { settingsSections } from "../data/mockData";
import type {
  ConnectionItem,
  RuntimeControl,
  RuntimeHealth,
  RuntimeLogs,
  SettingsSectionId,
} from "../types";

interface SettingsViewProps {
  health: RuntimeHealth[];
  runtimeControls: RuntimeControl[];
  runtimeLogs: RuntimeLogs | null;
  connections: ConnectionItem[];
  section: SettingsSectionId;
  onRuntimeAction: (
    processId: string,
    action: "start" | "stop" | "restart",
  ) => void | Promise<void>;
}

export function SettingsView({
  health,
  runtimeControls,
  runtimeLogs,
  connections,
  section,
  onRuntimeAction,
}: SettingsViewProps) {
  const primaryRuntime = runtimeControls[0] ?? null;
  const primaryHealth = health[0] ?? null;
  const runtimeSummary = useMemo(
    () => buildRuntimeDiagnosticText(health, runtimeControls, runtimeLogs),
    [health, runtimeControls, runtimeLogs],
  );
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);

  async function copyDiagnostics() {
    await navigator.clipboard.writeText(runtimeSummary);
    setCopiedDiagnostics(true);
    window.setTimeout(() => setCopiedDiagnostics(false), 1400);
  }

  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <div className="settings-content">
        <header>
          <h2 id="settings-title">{titleFor(section)}</h2>
        </header>

        {section === "privacy" && (
          <div className="settings-section">
            <SettingsRow
              title="Local-first per default"
              description="Memoria, task e audit restano sul dispositivo salvo opt-in esplicito."
              enabled
            />
            <SettingsRow
              title="Managed cloud"
              description="Composio/Zapier/Pipedream restano disabilitati finche' non scegli un provider."
              enabled={false}
            />
            <SettingsRow
              title="Accesso completo"
              description="Le azioni write e approved automation passano da approval gates."
              enabled
            />
          </div>
        )}

        {section === "runtime" && (
          <div className="runtime-diagnostics">
            <div className="runtime-hero">
              <div className="runtime-hero-title">
                <RuntimeStatusIcon status={primaryHealth?.status} />
                <div>
                  <strong>{primaryHealth?.label ?? "Gemma 4 MLX"}</strong>
                  <small>{runtimeHeadline(primaryHealth, primaryRuntime)}</small>
                </div>
              </div>
              <button
                className="runtime-copy-button"
                type="button"
                onClick={() => void copyDiagnostics()}
              >
                <Copy size={15} />
                <span>{copiedDiagnostics ? "Copiato" : "Copia diagnostica"}</span>
              </button>
            </div>

            {primaryRuntime && (
              <div className="runtime-metric-strip" aria-label="Metriche runtime">
                <RuntimeMetric label="Stato" value={statusLabel(primaryRuntime.status)} />
                <RuntimeMetric
                  label="Porta"
                  value={primaryRuntime.port ? String(primaryRuntime.port) : "n/d"}
                />
                <RuntimeMetric
                  label="PID"
                  value={primaryRuntime.portOwnerPid ? String(primaryRuntime.portOwnerPid) : "n/d"}
                />
                <RuntimeMetric
                  label="Memoria"
                  value={formatMemoryPair(
                    primaryRuntime.memoryMb,
                    primaryRuntime.totalMemoryMb,
                  )}
                />
                <RuntimeMetric
                  label="CPU"
                  value={
                    primaryRuntime.cpuPercent != null
                      ? `${primaryRuntime.cpuPercent.toFixed(1)}%`
                      : "n/d"
                  }
                />
                <RuntimeMetric
                  label="Duplicati"
                  value={String(primaryRuntime.duplicateCount)}
                  attention={primaryRuntime.duplicateCount > 1}
                />
              </div>
            )}

            <div className="settings-section runtime-action-section">
              {runtimeControls.map((control) => (
                <div className="settings-row static runtime-control-row" key={control.processId}>
                  <div>
                    <strong>{control.label}</strong>
                    <small>{runtimeControlDetail(control)}</small>
                  </div>
                  <div className="runtime-actions">
                    <button
                      type="button"
                      title="Avvia runtime"
                      onClick={() => void onRuntimeAction(control.processId, "start")}
                    >
                      <Play size={14} />
                      <span>Avvia</span>
                    </button>
                    <button
                      type="button"
                      title="Riavvia runtime"
                      onClick={() => void onRuntimeAction(control.processId, "restart")}
                    >
                      <RotateCcw size={14} />
                      <span>Riavvia</span>
                    </button>
                    <button
                      type="button"
                      title="Ferma runtime"
                      onClick={() => void onRuntimeAction(control.processId, "stop")}
                    >
                      <Square size={14} />
                      <span>Ferma</span>
                    </button>
                  </div>
                </div>
              ))}
              {health.map((item) => (
                <div className="settings-row static runtime-health-row" key={item.label}>
                  <div>
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </div>
                  <span className={`status-dot ${item.status}`} />
                </div>
              ))}
            </div>

            <div className="runtime-log-panel" aria-label="Log runtime redatti">
              <div className="runtime-log-header">
                <strong>Log runtime</strong>
                <small>{runtimeLogs?.message ?? "Log non ancora caricati."}</small>
              </div>
              {runtimeLogs?.entries.length ? (
                <pre>
                  {runtimeLogs.entries.slice(-12).map((entry, index) => (
                    <span key={`${entry.stream}-${index}`}>
                      <b>{entry.stream}</b> {entry.line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              ) : (
                <div className="runtime-log-empty">
                  I log sono disponibili quando Gemma viene avviato dal gateway
                  gestito. Se il runtime e' esterno, mostriamo solo stato e
                  risorse.
                </div>
              )}
            </div>
          </div>
        )}

        {section === "connections" && (
          <div className="settings-grid">
            {connections.map((connection) => (
              <article className="connection-tile" key={connection.id}>
                <CheckCircle2 size={18} />
                <div>
                  <strong>{connection.name}</strong>
                  <small>{connection.description}</small>
                </div>
                <span>{connection.status}</span>
              </article>
            ))}
          </div>
        )}

        {section !== "privacy" && section !== "runtime" && section !== "connections" && (
          <div className="settings-section">
            <div className="settings-row static">
              <div>
                <strong>Configurazione pronta</strong>
                <small>
                  Questa sezione verra' cablata al relativo read model nel prossimo blocco.
                </small>
              </div>
              <ChevronRight size={18} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function RuntimeStatusIcon({ status }: { status: RuntimeHealth["status"] | undefined }) {
  if (status === "ready") return <CircleCheck size={22} className="runtime-icon ready" />;
  if (status === "running") return <Activity size={22} className="runtime-icon running" />;
  return <CircleAlert size={22} className="runtime-icon attention" />;
}

function RuntimeMetric({
  label,
  value,
  attention = false,
}: {
  label: string;
  value: string;
  attention?: boolean;
}) {
  return (
    <div className={`runtime-metric ${attention ? "attention" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function runtimeHeadline(
  health: RuntimeHealth | null,
  control: RuntimeControl | null,
) {
  if (health?.status === "ready") {
    return control?.portOwnerPid
      ? `Pronto su porta ${control.port ?? 8765}, PID ${control.portOwnerPid}`
      : "Pronto e raggiungibile dal gateway locale";
  }
  if (health?.status === "running") {
    return "Processo rilevato, health in verifica";
  }
  return health?.detail ?? "Runtime non raggiungibile o da avviare";
}

function runtimeControlDetail(control: RuntimeControl) {
  const details = [
    control.message,
    control.port ? `porta ${control.port}` : null,
    control.portOwnerPid ? `pid ${control.portOwnerPid}` : null,
    control.memoryMb ? `${control.memoryMb} MB processo` : null,
    control.totalMemoryMb ? `${control.totalMemoryMb} MB sistema` : null,
    control.cpuPercent != null ? `CPU ${control.cpuPercent.toFixed(1)}%` : null,
    control.duplicateCount > 1 ? `duplicati ${control.duplicateCount}` : null,
  ].filter(Boolean);
  return details.join(" · ");
}

function buildRuntimeDiagnosticText(
  health: RuntimeHealth[],
  controls: RuntimeControl[],
  logs: RuntimeLogs | null,
) {
  const lines = [
    "Local First Assistant runtime diagnostics",
    `generated_at=${new Date().toISOString()}`,
    "",
    "[health]",
    ...health.map((item) => `${item.label}: ${item.status} - ${item.detail}`),
    "",
    "[controls]",
    ...controls.map((control) =>
      [
        `process_id=${control.processId}`,
        `status=${control.status}`,
        `port=${control.port ?? "n/d"}`,
        `pid=${control.portOwnerPid ?? "n/d"}`,
        `duplicates=${control.duplicateCount}`,
        `process_memory_mb=${control.memoryMb ?? "n/d"}`,
        `total_memory_mb=${control.totalMemoryMb ?? "n/d"}`,
        `available_memory_mb=${control.availableMemoryMb ?? "n/d"}`,
        `cpu_percent=${control.cpuPercent ?? "n/d"}`,
        `message=${control.message}`,
      ].join(" "),
    ),
    "",
    "[logs]",
    logs
      ? `source=${logs.source} message=${logs.message}`
      : "source=unavailable message=Log non caricati",
    ...(logs?.entries.slice(-20).map((entry) => `${entry.stream}: ${entry.line}`) ?? []),
  ];
  return lines.join("\n");
}

function formatMemoryPair(processMemoryMb: number | undefined, totalMemoryMb: number | undefined) {
  if (processMemoryMb && totalMemoryMb) return `${processMemoryMb} / ${totalMemoryMb} MB`;
  if (processMemoryMb) return `${processMemoryMb} MB`;
  return "n/d";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    ready: "Pronto",
    external_running: "Esterno",
    managed_running: "Gestito",
    configured: "Configurato",
    stopped: "Fermo",
    unhealthy: "Errore",
    duplicate_conflict: "Duplicati",
  };
  return labels[status] ?? status;
}

function SettingsRow({
  title,
  description,
  enabled,
}: {
  title: string;
  description: string;
  enabled: boolean;
}) {
  return (
    <div className="settings-row">
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <button
        type="button"
        className={`switch ${enabled ? "enabled" : ""}`}
        aria-pressed={enabled}
        aria-label={title}
      >
        <span />
      </button>
    </div>
  );
}

function titleFor(section: string) {
  return settingsSections.find((item) => item.id === section)?.label ?? "Generali";
}
