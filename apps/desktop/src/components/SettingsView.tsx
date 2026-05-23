import { CheckCircle2, ChevronRight } from "lucide-react";
import { settingsSections } from "../data/mockData";
import type { ConnectionItem, RuntimeHealth, SettingsSectionId } from "../types";

interface SettingsViewProps {
  health: RuntimeHealth[];
  connections: ConnectionItem[];
  section: SettingsSectionId;
}

export function SettingsView({ health, connections, section }: SettingsViewProps) {
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
          <div className="settings-section">
            {health.map((item) => (
              <div className="settings-row static" key={item.label}>
                <div>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </div>
                <span className={`status-dot ${item.status}`} />
              </div>
            ))}
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
