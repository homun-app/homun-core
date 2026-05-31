import {
  Check,
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  MonitorPlay,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  coreBridge,
  type ActiveModelInfo,
  type ContainedComputerLive,
} from "../lib/coreBridge";
import { useSetting } from "../lib/settingsStore";
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

const SECTION_TITLES: Record<SettingsSectionId, string> = {
  account: "Account",
  general: "Generale",
  runtime: "Modello & Runtime",
  privacy: "Privacy & Autonomia",
  connections: "Connettori",
  computer: "Computer locale",
  audit: "Dati & Audit",
};

export function SettingsView({
  health,
  runtimeControls,
  connections,
  section,
  onRuntimeAction,
}: SettingsViewProps) {
  const [model, setModel] = useState<ActiveModelInfo | null>(null);
  const [computer, setComputer] = useState<ContainedComputerLive | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await coreBridge.runtimeModel();
        if (!cancelled) setModel(value);
      } catch {
        /* leave null → shown as "non disponibile" */
      }
      try {
        const value = await coreBridge.containedComputerLive();
        if (!cancelled) setComputer(value);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [section]);

  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <div className="set-pane">
        <h2 id="settings-title" className="set-title">
          {SECTION_TITLES[section]}
        </h2>
        {section === "account" && <AccountPane model={model} computer={computer} />}
        {section === "general" && <GeneralPane />}
        {section === "runtime" && (
          <RuntimePane
            model={model}
            health={health}
            runtimeControls={runtimeControls}
            onRuntimeAction={onRuntimeAction}
          />
        )}
        {section === "privacy" && <PrivacyPane />}
        {section === "connections" && <ConnectorsPane connections={connections} />}
        {section === "computer" && <ComputerPane computer={computer} />}
        {section === "audit" && <AuditPane />}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- primitives */

function CopyButton({ value, label = "Copia" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="set-btn"
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span style={{ marginLeft: 6 }}>{copied ? "Copiato" : label}</span>
    </button>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      className={`set-toggle ${on ? "on" : ""}`}
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    />
  );
}

function ToggleRow({
  title,
  description,
  settingKey,
  fallback,
}: {
  title: string;
  description: string;
  settingKey: Parameters<typeof useSetting>[0];
  fallback: boolean;
}) {
  const [value, setValue] = useSetting<boolean>(settingKey, fallback);
  return (
    <div className="set-trow">
      <div>
        <div className="tt">{title}</div>
        <div className="td">{description}</div>
      </div>
      <Toggle on={value} onChange={setValue} />
    </div>
  );
}

function formatK(value: number): string {
  if (!value) return "n/d";
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/* ------------------------------------------------------------------- account */

function AccountPane({
  model,
  computer,
}: {
  model: ActiveModelInfo | null;
  computer: ContainedComputerLive | null;
}) {
  const [name, setName] = useSetting("displayName", "Fabio Cantone");
  const [accountEmail, setAccountEmail] = useSetting<string>("email", "");

  return (
    <>
      <div className="set-profile">
        <span className="set-profile-avatar" aria-hidden />
        <label className="set-field">
          <span className="set-field-label">Nome completo</span>
          <input
            className="set-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Il tuo nome"
          />
        </label>
      </div>

      <div className="set-card">
        <div className="set-card-top">
          <span className="set-card-name">Local-first</span>
          <span className="set-badge green">
            <Check size={13} /> Tutto sul dispositivo
          </span>
        </div>
        <div className="set-card-divider" />
        <div className="set-meter">
          <span className="k">
            <Cpu size={15} /> Modello attivo
          </span>
          <span className="v">{model?.model ?? "non disponibile"}</span>
        </div>
        <p className="set-meter-sub">
          {model
            ? `${model.backend} · ${model.locality} · contesto ~${formatK(model.context_window)}`
            : "Configura un backend nelle impostazioni Modello & Runtime."}
        </p>
        <div className="set-meter" style={{ marginTop: 8 }}>
          <span className="k">
            <MonitorPlay size={15} /> Computer locale
          </span>
          <span className="v">{computer?.enabled ? "Attivo" : "Spento"}</span>
        </div>
        <p className="set-meter-sub">
          {computer?.enabled
            ? "Browser reale contenuto · vista live noVNC"
            : "Avvia il computer contenuto per browsing reale e non invasivo."}
        </p>
      </div>

      <div className="set-section-label">Identità</div>
      <div className="set-rows">
        <div className="set-row">
          <div style={{ flex: 1 }}>
            <div className="rk">Email</div>
            <input
              className="set-input"
              style={{ marginTop: 6, maxWidth: 320 }}
              value={accountEmail}
              onChange={(event) => setAccountEmail(event.target.value)}
              placeholder="tu@esempio.com"
            />
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="rk">Workspace</div>
            <div className="rv">Personale</div>
          </div>
          <CopyButton value="Personale" />
        </div>
      </div>

      <div className="set-danger">
        <div>
          <div className="dt">Elimina dati locali</div>
          <div className="dd">Rimuove memoria, task e audit dal dispositivo. Irreversibile.</div>
        </div>
        <button className="set-btn danger" type="button" disabled title="Disponibile a breve">
          Elimina dati
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- general */

function GeneralPane() {
  return (
    <>
      <div className="set-section-label">Conversazione</div>
      <div className="set-rows">
        <ToggleRow
          title="Risposte in streaming"
          description="Mostra la risposta token-per-token mentre il modello genera."
          settingKey="general.streamResponses"
          fallback={true}
        />
        <ToggleRow
          title="Suono a fine attività"
          description="Riproduci un breve suono quando un task del computer locale finisce."
          settingKey="general.soundOnComplete"
          fallback={false}
        />
      </div>
      <p className="set-hint">
        Aspetto e lingua seguono il sistema. Tema scuro e altre preferenze arriveranno qui.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------- runtime */

function RuntimePane({
  model,
  health,
  runtimeControls,
  onRuntimeAction,
}: {
  model: ActiveModelInfo | null;
  health: RuntimeHealth[];
  runtimeControls: RuntimeControl[];
  onRuntimeAction: SettingsViewProps["onRuntimeAction"];
}) {
  const primary = runtimeControls[0] ?? null;
  const primaryHealth = health[0] ?? null;
  return (
    <>
      <div className="set-card">
        <div className="set-card-top">
          <span className="set-card-name">{model?.model ?? "Modello"}</span>
          <span className={`set-badge ${model?.capable ? "green" : "muted"}`}>
            {model?.capable ? "Capace" : "Locale"}
          </span>
        </div>
        <div className="set-card-divider" />
        <div className="set-meter">
          <span className="k">
            <Globe size={15} /> Backend
          </span>
          <span className="v">{model?.backend ?? "n/d"}</span>
        </div>
        <div className="set-meter">
          <span className="k">
            <Cpu size={15} /> Contesto
          </span>
          <span className="v">{model ? `~${formatK(model.context_window)} token` : "n/d"}</span>
        </div>
        {model?.missing_api_key && (
          <p className="set-meter-sub" style={{ color: "var(--amber)" }}>
            Chiave API mancante per questo backend.
          </p>
        )}
      </div>

      <div className="set-section-label">Runtime locale</div>
      <div className="set-rows">
        <div className="set-row">
          <div>
            <div className="rk">Stato</div>
            <div className="rv">{primaryHealth?.label ?? primary?.status ?? "Inattivo"}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="set-btn"
              type="button"
              title="Avvia"
              onClick={() => primary && void onRuntimeAction(primary.processId, "start")}
            >
              <Play size={14} />
            </button>
            <button
              className="set-btn"
              type="button"
              title="Riavvia"
              onClick={() => primary && void onRuntimeAction(primary.processId, "restart")}
            >
              <RotateCcw size={14} />
            </button>
            <button
              className="set-btn"
              type="button"
              title="Ferma"
              onClick={() => primary && void onRuntimeAction(primary.processId, "stop")}
            >
              <Square size={14} />
            </button>
          </div>
        </div>
        {primary?.port ? (
          <div className="set-row">
            <div>
              <div className="rk">Porta</div>
              <div className="rv">{primary.port}</div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- privacy */

function PrivacyPane() {
  return (
    <>
      <div className="set-rows">
        <ToggleRow
          title="Local-first per default"
          description="Memoria, task e audit restano sul dispositivo salvo opt-in esplicito."
          settingKey="privacy.localFirst"
          fallback={true}
        />
        <ToggleRow
          title="Managed cloud"
          description="Connettori cloud (Composio/Zapier) restano disabilitati finché non scegli un provider."
          settingKey="privacy.managedCloud"
          fallback={false}
        />
        <ToggleRow
          title="Gate di approvazione"
          description="Le azioni write e approved-automation richiedono una conferma esplicita."
          settingKey="privacy.approvalGate"
          fallback={true}
        />
      </div>
      <p className="set-hint">
        <ShieldCheck size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
        Il browser si ferma comunque prima di login, dati personali, pagamenti o acquisti.
      </p>
    </>
  );
}

/* ---------------------------------------------------------------- connectors */

const CONNECTOR_TABS = [
  { id: "app", label: "App" },
  { id: "api", label: "API personalizzata" },
  { id: "mcp", label: "MCP personalizzato" },
] as const;

function ConnectorsPane({ connections }: { connections: ConnectionItem[] }) {
  const [tab, setTab] = useState<(typeof CONNECTOR_TABS)[number]["id"]>("app");
  const [query, setQuery] = useState("");
  const filtered = connections.filter((item) => {
    if (tab === "mcp" && item.type !== "mcp") return false;
    if (!query.trim()) return true;
    const needle = query.toLowerCase();
    return (
      item.name.toLowerCase().includes(needle) ||
      item.description.toLowerCase().includes(needle)
    );
  });
  return (
    <>
      <div className="set-connectors-tabs">
        {CONNECTOR_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`set-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <input
        className="set-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Cerca connettori"
      />
      {filtered.length === 0 ? (
        <p className="set-hint">Nessun connettore per questo filtro.</p>
      ) : (
        <div className="set-grid">
          {filtered.map((item) => {
            const connected = item.status === "connected";
            return (
              <div key={item.id} className={`set-conn ${connected ? "connected" : ""}`}>
                <span className="set-conn-icon">
                  <Globe size={18} />
                </span>
                <div className="set-conn-body">
                  <div className="set-conn-title">{item.name}</div>
                  <div className="set-conn-desc">{item.description}</div>
                </div>
                <button
                  className="set-conn-add"
                  type="button"
                  title={connected ? "Connesso" : "Aggiungi"}
                  aria-label={connected ? "Connesso" : "Aggiungi"}
                >
                  {connected ? <Check size={15} /> : <Plus size={15} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ computer */

function ComputerPane({ computer }: { computer: ContainedComputerLive | null }) {
  const enabled = Boolean(computer?.enabled);
  return (
    <>
      <div className="set-card">
        <div className="set-card-top">
          <span className="set-card-name">Computer contenuto</span>
          <span className={`set-badge ${enabled ? "green" : "muted"}`}>
            {enabled ? "Disponibile" : "Spento"}
          </span>
        </div>
        <div className="set-card-divider" />
        <p className="set-meter-sub" style={{ marginBottom: 0 }}>
          Un browser reale e contenuto (passa i controlli anti-bot) in un computer virtuale non
          invasivo, visibile live nella chat. {computer?.active ? "In esecuzione ora." : ""}
        </p>
      </div>
      {enabled && computer?.novnc_url && (
        <div className="set-rows" style={{ marginTop: "var(--s4)" }}>
          <div className="set-row">
            <div>
              <div className="rk">Vista live</div>
              <div className="rv">noVNC</div>
            </div>
            <a className="set-btn" href={computer.novnc_url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              <span style={{ marginLeft: 6 }}>Apri</span>
            </a>
          </div>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------------- audit */

function AuditPane() {
  return (
    <>
      <div className="set-rows">
        <div className="set-row">
          <div>
            <div className="rk">Audit locale</div>
            <div className="rv">
              Ogni azione del modello e del browser è registrata sul dispositivo.
            </div>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="rk">Esportazione</div>
            <div className="rv">Scarica i tuoi dati locali (memoria, task, audit).</div>
          </div>
          <button className="set-btn" type="button" disabled title="Disponibile a breve">
            Esporta
          </button>
        </div>
      </div>
      <div className="set-danger">
        <div>
          <div className="dt">Svuota audit</div>
          <div className="dd">Rimuove lo storico delle azioni. Non tocca memoria e task.</div>
        </div>
        <button className="set-btn danger" type="button" disabled title="Disponibile a breve">
          Svuota
        </button>
      </div>
    </>
  );
}
