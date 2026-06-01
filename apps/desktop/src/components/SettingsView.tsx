import {
  Boxes,
  Check,
  Copy,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  ListChecks,
  MonitorPlay,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  coreBridge,
  type ActiveModelInfo,
  type ComposioToolkit,
  type ContainedComputerLive,
  type CoreCapabilitySnapshot,
  type CoreMemoryDashboard,
  type ProviderView,
  type RoleView,
  type RoutingDecision,
  type SystemStatus,
} from "../lib/coreBridge";
import { useSetting } from "../lib/settingsStore";
import type {
  ConnectionItem,
  SettingsSectionId,
} from "../types";

interface SettingsViewProps {
  connections: ConnectionItem[];
  section: SettingsSectionId;
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

export function SettingsView({ section }: SettingsViewProps) {
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
    <section
      className={`settings-view ${section === "runtime" ? "settings-wide" : ""}`}
      aria-labelledby="settings-title"
    >
      <div className="set-pane">
        <h2 id="settings-title" className="set-title">
          {SECTION_TITLES[section]}
        </h2>
        {section === "account" && <AccountPane model={model} computer={computer} />}
        {section === "general" && <GeneralPane />}
        {section === "runtime" && <RuntimePane model={model} />}
        {section === "privacy" && <PrivacyPane />}
        {section === "connections" && <ConnectorsPane />}
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

// Provider presets (OpenAI-compatible base URLs). Selecting one fills the base
// URL; the user adds the key and picks a model. "Custom" leaves it blank.
const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  baseUrl: string;
  kind: string;
  hint?: string;
}> = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", kind: "openai_compat" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", kind: "anthropic" },
  { id: "zai", label: "Z.ai (GLM)", baseUrl: "https://api.z.ai/api/paas/v4", kind: "openai_compat", hint: "GLM-5" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", kind: "openai_compat" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", kind: "openai_compat" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", kind: "openai_compat" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", kind: "openai_compat" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", kind: "openai_compat" },
  { id: "moonshot", label: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai/v1", kind: "openai_compat" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", kind: "openai_compat" },
  { id: "ollama", label: "Ollama (locale)", baseUrl: "http://127.0.0.1:11434/v1", kind: "ollama" },
  { id: "custom", label: "Personalizzato", baseUrl: "", kind: "openai_compat" },
];

function RuntimePane({ model }: { model: ActiveModelInfo | null }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [decisions, setDecisions] = useState<RoutingDecision[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Selected left-rail entry: "roles" | "decisions" | "add" | a provider id.
  const [selected, setSelected] = useState<string>("roles");
  // Add-provider form.
  const [presetId, setPresetId] = useState("ollama");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  // Per-provider detail edits.
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editKey, setEditKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const apply = (snapshot: { providers: ProviderView[]; active_provider_id: string | null }) => {
    setProviders(snapshot.providers);
    setActiveId(snapshot.active_provider_id);
  };

  const reloadRoles = async () => {
    try {
      setRoles((await coreBridge.roles()).roles);
    } catch {
      /* leave empty */
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const snapshot = await coreBridge.providers();
        apply(snapshot);
        if (snapshot.providers.length > 0) {
          const initialId = snapshot.active_provider_id ?? snapshot.providers[0].id;
          setSelected(initialId);
          const initial = snapshot.providers.find((p) => p.id === initialId);
          if (initial) setEditBaseUrl(initial.base_url);
        }
      } catch {
        /* leave empty */
      }
      await reloadRoles();
      try {
        setDecisions((await coreBridge.routingDecisions()).decisions);
      } catch {
        /* leave empty */
      }
    })();
  }, []);

  const run = async (key: string, action: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setNote(null);
    try {
      const result = (await action()) as { providers: ProviderView[]; active_provider_id: string | null };
      if (result?.providers) apply(result);
      await reloadRoles();
      if (ok) setNote(ok);
    } catch (error) {
      setNote(`Operazione non riuscita: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (role: string, value: string) => {
    setBusy(`role:${role}`);
    setNote(null);
    try {
      const input =
        value === "auto"
          ? { role }
          : (() => {
              const [provider_id, ...rest] = value.split("::");
              return { role, provider_id, model: rest.join("::") };
            })();
      setRoles((await coreBridge.setRole(input)).roles);
    } catch (error) {
      setNote(`Operazione non riuscita: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const selectProvider = (provider: ProviderView) => {
    setSelected(provider.id);
    setEditBaseUrl(provider.base_url);
    setEditKey("");
    setShowKey(false);
    setNote(null);
  };

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0];
  const selectedProvider = providers.find((p) => p.id === selected);

  // Options for a model picker: "Auto" + per-provider optgroups (used by roles).
  const modelOptions = (
    <>
      {providers.map((provider) => (
        <optgroup key={provider.id} label={provider.label}>
          {provider.models.map((m) => (
            <option key={`${provider.id}::${m.id}`} value={`${provider.id}::${m.id}`}>
              {m.id}
              {m.tier ? ` · ${m.tier}` : ""}
              {m.vision ? " · vision" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );

  return (
    <div className="mdl-layout">
      <aside className="mdl-rail" aria-label="Sezioni modelli">
        <div className="mdl-rail-group">Routing</div>
        <button
          className={`mdl-rail-item ${selected === "roles" ? "active" : ""}`}
          type="button"
          onClick={() => setSelected("roles")}
        >
          <ListChecks size={16} />
          <span className="mdl-rail-name">Modello per compito</span>
        </button>
        <button
          className={`mdl-rail-item ${selected === "decisions" ? "active" : ""}`}
          type="button"
          onClick={() => setSelected("decisions")}
        >
          <Sparkles size={16} />
          <span className="mdl-rail-name">Decisioni di routing</span>
          {decisions.length > 0 && <em className="mdl-rail-badge">{decisions.length}</em>}
        </button>

        <div className="mdl-rail-group">Provider</div>
        {providers.map((provider) => (
          <button
            key={provider.id}
            className={`mdl-rail-item ${selected === provider.id ? "active" : ""}`}
            type="button"
            onClick={() => selectProvider(provider)}
          >
            <span className="mdl-rail-avatar">{provider.label.slice(0, 1).toUpperCase()}</span>
            <span className="mdl-rail-name">{provider.label}</span>
            {provider.id === activeId && <span className="mdl-rail-dot" title="Attivo" />}
          </button>
        ))}
        {providers.length === 0 && <p className="mdl-rail-empty">Nessun provider</p>}
        <button
          className={`mdl-rail-item add ${selected === "add" ? "active" : ""}`}
          type="button"
          onClick={() => setSelected("add")}
        >
          <Plus size={16} />
          <span className="mdl-rail-name">Aggiungi provider</span>
        </button>
      </aside>

      <section className="mdl-detail">
        {/* ── Roles ───────────────────────────────────────────────── */}
        {selected === "roles" && (
          <>
            <div className="mdl-detail-head">
              <h3>Modello per compito</h3>
              <p className="mdl-detail-sub">
                Il router sceglie automaticamente il modello migliore tra quelli idonei; puoi
                forzarne uno.
              </p>
            </div>
            {roles.length === 0 ? (
              <p className="set-hint">Aggiungi un provider e aggiorna i suoi modelli.</p>
            ) : (
              roles.map((role) => {
                const value = role.auto ? "auto" : `${role.binding_provider_id}::${role.binding_model}`;
                return (
                  <div className="mdl-row" key={role.key}>
                    <div className="mdl-row-main">
                      <div className="mdl-row-top">
                        <strong>{role.label}</strong>
                        <span className={`set-badge ${role.auto ? "muted" : "green"}`}>
                          {role.auto ? "Auto" : "Manuale"}
                        </span>
                      </div>
                      <p className="mdl-detail-sub">{role.description}</p>
                    </div>
                    <select
                      className="set-input mdl-row-select"
                      value={value}
                      disabled={busy === `role:${role.key}`}
                      onChange={(event) => changeRole(role.key, event.target.value)}
                    >
                      <option value="auto">
                        Auto{role.resolved_model ? ` — ${role.resolved_model}` : ""}
                      </option>
                      {modelOptions}
                    </select>
                  </div>
                );
              })
            )}
          </>
        )}

        {/* ── Decisions ───────────────────────────────────────────── */}
        {selected === "decisions" && (
          <>
            <div className="mdl-detail-head">
              <h3>Decisioni di routing</h3>
              <p className="mdl-detail-sub">
                Perché il router ha scelto un modello per ogni task (ultime {decisions.length}).
              </p>
            </div>
            {decisions.length === 0 ? (
              <p className="set-hint">Nessuna decisione ancora. Esegui un task per popolarle.</p>
            ) : (
              decisions.map((d, i) => (
                <div className="mdl-row" key={i}>
                  <div className="mdl-row-main">
                    <div className="mdl-row-top">
                      <strong>{d.chosen_model}</strong>
                      <span className={`set-badge ${d.stage === "semantic" ? "green" : "muted"}`}>
                        {d.stage === "semantic"
                          ? "semantico"
                          : d.stage === "single_candidate"
                            ? "unico"
                            : d.stage === "heuristic_disabled"
                              ? "euristico"
                              : "fallback"}
                      </span>
                      <span className="mdl-row-meta">{d.role} · {d.candidates.length} candidati</span>
                    </div>
                    <p className="mdl-detail-sub">«{d.goal}»</p>
                  </div>
                </div>
              ))
            )}
          </>
        )}

        {/* ── Add provider ────────────────────────────────────────── */}
        {selected === "add" && (
          <>
            <div className="mdl-detail-head">
              <h3>Aggiungi provider</h3>
              <p className="mdl-detail-sub">
                Qualsiasi endpoint OpenAI-compatibile, Anthropic o Ollama locale. La chiave è cifrata
                nel secret store, mai mostrata.
              </p>
            </div>
            <div className="mdl-field">
              <label>Tipo</label>
              <select
                className="set-input"
                value={presetId}
                onChange={(event) => {
                  const next = PROVIDER_PRESETS.find((p) => p.id === event.target.value);
                  setPresetId(event.target.value);
                  if (next && next.id !== "custom") {
                    setBaseUrl(next.baseUrl);
                    if (!label) setLabel(next.label);
                  }
                }}
              >
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="mdl-field">
              <label>Nome</label>
              <input className="set-input" placeholder={preset.label} value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="mdl-field">
              <label>Endpoint (base URL)</label>
              <input className="set-input" placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
            <div className="mdl-field">
              <label>API key (opzionale per endpoint locali)</label>
              <input className="set-input" type="password" placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
            <button
              className="set-btn primary"
              type="button"
              style={{ alignSelf: "flex-start" }}
              disabled={busy === "add" || !baseUrl.trim()}
              onClick={() =>
                run(
                  "add",
                  async () => {
                    const result = await coreBridge.upsertProvider({
                      label: (label || preset.label).trim(),
                      kind: preset.kind,
                      base_url: baseUrl.trim(),
                      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
                    });
                    setApiKey("");
                    const added = result.providers.find((p) => p.base_url === baseUrl.trim().replace(/\/$/, ""));
                    if (added) {
                      setSelected(added.id);
                      try {
                        return await coreBridge.refreshProviderModels(added.id);
                      } catch {
                        return result;
                      }
                    }
                    return result;
                  },
                  "Provider aggiunto.",
                )
              }
            >
              {busy === "add" ? "Salvataggio…" : "Aggiungi provider"}
            </button>
          </>
        )}

        {/* ── Provider detail ─────────────────────────────────────── */}
        {selectedProvider && (
          <ProviderDetailView
            key={selectedProvider.id}
            provider={selectedProvider}
            isActive={selectedProvider.id === activeId}
            busy={busy}
            editBaseUrl={editBaseUrl}
            setEditBaseUrl={setEditBaseUrl}
            editKey={editKey}
            setEditKey={setEditKey}
            showKey={showKey}
            setShowKey={setShowKey}
            contextWindow={model?.context_window ?? null}
            onActivate={() => run(selectedProvider.id, () => coreBridge.activateProvider(selectedProvider.id))}
            onRemove={() => {
              const id = selectedProvider.id;
              setSelected("roles");
              void run(id, () => coreBridge.removeProvider(id));
            }}
            onRefreshModels={() =>
              run(selectedProvider.id, () => coreBridge.refreshProviderModels(selectedProvider.id), "Catalogo aggiornato.")
            }
            onGenerateProfiles={() =>
              run(selectedProvider.id, () => coreBridge.generateProviderProfiles(selectedProvider.id), "Profili generati.")
            }
            onSaveConnection={() =>
              run(
                selectedProvider.id,
                () =>
                  coreBridge.upsertProvider({
                    id: selectedProvider.id,
                    label: selectedProvider.label,
                    kind: selectedProvider.kind,
                    base_url: (editBaseUrl || selectedProvider.base_url).trim(),
                    ...(editKey.trim() ? { api_key: editKey.trim() } : {}),
                  }),
                "Provider salvato.",
              )
            }
            onSetModel={(modelId) =>
              run(selectedProvider.id, () =>
                coreBridge.upsertProvider({
                  id: selectedProvider.id,
                  label: selectedProvider.label,
                  kind: selectedProvider.kind,
                  base_url: selectedProvider.base_url,
                  active_model: modelId,
                }),
              )
            }
            onSetTier={(modelId, tier) =>
              run(selectedProvider.id, () =>
                coreBridge.setModelProfile({ provider_id: selectedProvider.id, model: modelId, tier }),
              )
            }
          />
        )}

        {note && <p className="set-hint" style={{ marginTop: "var(--s3)" }}>{note}</p>}
      </section>
    </div>
  );
}

function ProviderDetailView({
  provider,
  isActive,
  busy,
  editBaseUrl,
  setEditBaseUrl,
  editKey,
  setEditKey,
  showKey,
  setShowKey,
  contextWindow,
  onActivate,
  onRemove,
  onRefreshModels,
  onGenerateProfiles,
  onSaveConnection,
  onSetModel,
  onSetTier,
}: {
  provider: ProviderView;
  isActive: boolean;
  busy: string | null;
  editBaseUrl: string;
  setEditBaseUrl: (value: string) => void;
  editKey: string;
  setEditKey: (value: string) => void;
  showKey: boolean;
  setShowKey: (value: boolean) => void;
  contextWindow: number | null;
  onActivate: () => void;
  onRemove: () => void;
  onRefreshModels: () => void;
  onGenerateProfiles: () => void;
  onSaveConnection: () => void;
  onSetModel: (modelId: string) => void;
  onSetTier: (modelId: string, tier: string) => void;
}) {
  const acting = busy === provider.id;
  const hasInferred = provider.models.some((m) => m.profile_source === "inferred" || !m.profile_source);
  return (
    <>
      <div className="mdl-detail-head">
        <h3>{provider.label}</h3>
        <div className="mdl-detail-actions">
          {isActive ? (
            <span className="set-badge green">Attivo</span>
          ) : (
            <button className="set-btn" type="button" disabled={acting} onClick={onActivate}>
              Imposta attivo
            </button>
          )}
          <button className="set-btn danger" type="button" disabled={acting} onClick={onRemove}>
            <Trash2 size={14} /> Rimuovi
          </button>
        </div>
      </div>
      <p className="mdl-detail-sub">{provider.kind} · {provider.has_key ? "chiave configurata" : "senza chiave"}</p>

      <div className="mdl-field">
        <label>API address</label>
        <input
          className="set-input"
          value={editBaseUrl}
          onChange={(event) => setEditBaseUrl(event.target.value)}
        />
      </div>
      <div className="mdl-field">
        <label>API key</label>
        <div className="mdl-key">
          <input
            className="set-input"
            type={showKey ? "text" : "password"}
            placeholder={provider.has_key ? "•••• (lascia vuoto per non cambiare)" : "sk-…"}
            value={editKey}
            onChange={(event) => setEditKey(event.target.value)}
          />
          <button className="mdl-icon-btn" type="button" aria-label="Mostra/nascondi" onClick={() => setShowKey(!showKey)}>
            {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </div>
      <button
        className="set-btn"
        type="button"
        style={{ alignSelf: "flex-start" }}
        disabled={acting}
        onClick={onSaveConnection}
      >
        Salva endpoint/chiave
      </button>

      <div className="mdl-field" style={{ marginTop: "var(--s4)" }}>
        <label>Modello attivo del provider</label>
        <select
          className="set-input"
          value={provider.active_model ?? ""}
          disabled={acting}
          onChange={(event) => onSetModel(event.target.value)}
        >
          {provider.models.length === 0 && <option value="">— nessun modello: aggiorna —</option>}
          {provider.active_model && !provider.models.some((m) => m.id === provider.active_model) && (
            <option value={provider.active_model}>{provider.active_model}</option>
          )}
          {provider.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.tier ? ` · ${m.tier}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="mdl-models-head">
        <span>Modelli ({provider.models.length})</span>
        <div className="mdl-detail-actions">
          <button className="set-btn" type="button" disabled={acting} onClick={onRefreshModels}>
            <RefreshCw size={14} /> Aggiorna
          </button>
          {hasInferred && (
            <button
              className="set-btn"
              type="button"
              disabled={acting}
              title="Un modello descrive i modelli senza profilo"
              onClick={onGenerateProfiles}
            >
              <Sparkles size={14} /> Genera profili
            </button>
          )}
        </div>
      </div>
      <div className="mdl-models">
        {provider.models.length === 0 && (
          <p className="set-hint">Nessun modello. Premi "Aggiorna" per leggere il catalogo.</p>
        )}
        {provider.models.map((m) => (
          <div className="mdl-model-row" key={m.id}>
            <div className="mdl-model-info">
              <span className="mdl-model-id">{m.id}</span>
              {m.strengths ? (
                <span className="mdl-model-str" title={m.strengths}>{m.strengths}</span>
              ) : null}
            </div>
            <div className="mdl-model-tags">
              {m.vision && <span className="mdl-tag">vision</span>}
              {m.modality !== "text" && <span className="mdl-tag">{m.modality}</span>}
              {m.profile_source === "user" && <span className="mdl-tag user">tuo</span>}
            </div>
            <select
              className="set-input mdl-tier"
              value={m.tier ?? "balanced"}
              disabled={acting}
              onChange={(event) => onSetTier(m.id, event.target.value)}
            >
              <option value="fast">fast</option>
              <option value="balanced">balanced</option>
              <option value="reasoning">reasoning</option>
            </select>
          </div>
        ))}
      </div>
      <div className="set-meter" style={{ marginTop: "var(--s3)" }}>
        <span className="k"><Cpu size={15} /> Contesto modello attivo</span>
        <span className="v">{contextWindow ? `~${formatK(contextWindow)} token` : "n/d"}</span>
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
  { id: "connessi", label: "Connessi" },
  { id: "mcp", label: "MCP" },
  { id: "composio", label: "Composio" },
] as const;

function ConnectorsPane() {
  const [tab, setTab] = useState<(typeof CONNECTOR_TABS)[number]["id"]>("connessi");
  const [snap, setSnap] = useState<CoreCapabilitySnapshot | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setSnap(await coreBridge.capabilities());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const toolsByProvider = (providerId: string) =>
    (snap?.tools ?? []).filter((tool) => tool.provider_id === providerId).length;

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

      {tab === "connessi" && (
        <>
          {!snap || snap.connections.length === 0 ? (
            <p className="set-hint">
              Nessun connettore attivo. Aggiungi un server MCP o collega Composio dalle altre tab.
            </p>
          ) : (
            <div className="set-grid">
              {snap.connections.map((connection) => {
                const ok = connection.status.toLowerCase().includes("connect");
                return (
                  <div key={connection.id} className={`set-conn ${ok ? "connected" : ""}`}>
                    <span className="set-conn-icon">
                      <Globe size={18} />
                    </span>
                    <div className="set-conn-body">
                      <div className="set-conn-title">{connection.display_name}</div>
                      <div className="set-conn-desc">
                        {connection.provider_id} · {toolsByProvider(connection.provider_id)} strumenti
                      </div>
                    </div>
                    <span
                      className={`set-badge ${ok ? "green" : "muted"}`}
                      title={connection.status}
                    >
                      {ok ? "Connesso" : connection.status}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "mcp" && <McpTab snap={snap} onChanged={refresh} onNote={setNote} />}
      {tab === "composio" && <ComposioTab onNote={setNote} onChanged={refresh} />}

      {note && <p className="set-hint">{note}</p>}
    </>
  );
}

function McpTab({
  snap,
  onChanged,
  onNote,
}: {
  snap: CoreCapabilitySnapshot | null;
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const mcpProviders = new Set(
    (snap?.tools ?? []).filter((t) => t.provider_kind === "mcp").map((t) => t.provider_id),
  );

  return (
    <>
      <div className="set-section-label" style={{ marginTop: 0 }}>
        Aggiungi un server MCP
      </div>
      <div className="set-rows" style={{ padding: "var(--s4) var(--s5)" }}>
        <input
          className="set-input"
          placeholder="Nome (es. GitHub MCP)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="set-input"
          style={{ marginTop: 8 }}
          placeholder="Comando (es. npx)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <input
          className="set-input"
          style={{ marginTop: 8 }}
          placeholder="Argomenti separati da spazio (es. -y @owner/mcp-server)"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <button
          className="set-btn primary"
          type="button"
          style={{ marginTop: 12, alignSelf: "flex-start" }}
          disabled={busy || !name.trim() || !command.trim()}
          onClick={async () => {
            setBusy(true);
            onNote(null);
            try {
              const result = await coreBridge.mcpConnect({
                name: name.trim(),
                command: command.trim(),
                args: args.trim() ? args.trim().split(/\s+/) : [],
              });
              onNote(
                result.discovery_error
                  ? `Connesso con avviso: ${result.discovery_error}`
                  : `Connesso: ${result.tools_cached} strumenti da ${result.provider_id}.`,
              );
              setName("");
              setCommand("");
              setArgs("");
              await onChanged();
            } catch (error) {
              onNote(`Connessione MCP non riuscita: ${(error as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Plus size={14} />
          <span style={{ marginLeft: 6 }}>{busy ? "Connessione…" : "Aggiungi MCP"}</span>
        </button>
      </div>
      {mcpProviders.size > 0 && (
        <>
          <div className="set-section-label">Server MCP attivi</div>
          <div className="set-rows">
            {[...mcpProviders].map((provider) => (
              <div key={provider} className="set-row">
                <div>
                  <div className="rk">Provider</div>
                  <div className="rv">{provider}</div>
                </div>
                <span className="set-badge green">Connesso</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ComposioTab({
  onChanged,
  onNote,
}: {
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <div className="set-section-label" style={{ marginTop: 0 }}>
        Collega Composio
      </div>
      <div className="set-rows" style={{ padding: "var(--s4) var(--s5)" }}>
        <input
          className="set-input"
          placeholder="Composio API key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button
          className="set-btn primary"
          type="button"
          style={{ marginTop: 12, alignSelf: "flex-start" }}
          disabled={busy || !apiKey.trim()}
          onClick={async () => {
            setBusy(true);
            onNote(null);
            try {
              const result = await coreBridge.composioConnect(apiKey.trim());
              onNote(`Composio collegato (${result.tools_cached} strumenti). Scegli un toolkit.`);
              setToolkits(await coreBridge.composioToolkits());
              await onChanged();
            } catch (error) {
              onNote(`Composio non collegato: ${(error as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Collegamento…" : "Collega"}
        </button>
      </div>
      {toolkits.length > 0 && (
        <>
          <div className="set-section-label">Toolkit disponibili</div>
          <div className="set-grid">
            {toolkits.slice(0, 40).map((toolkit) => (
              <div key={toolkit.slug} className="set-conn">
                <span className="set-conn-icon">
                  <Globe size={18} />
                </span>
                <div className="set-conn-body">
                  <div className="set-conn-title">{toolkit.name}</div>
                  <div className="set-conn-desc">
                    {toolkit.no_auth ? "Nessuna autenticazione" : "OAuth gestito"}
                  </div>
                </div>
                <button
                  className="set-conn-add"
                  type="button"
                  title="Collega"
                  aria-label={`Collega ${toolkit.name}`}
                  onClick={async () => {
                    onNote(null);
                    try {
                      await coreBridge.composioLink(toolkit.slug);
                      onNote(`Toolkit collegato: ${toolkit.name}.`);
                      await onChanged();
                    } catch (error) {
                      onNote(`Collegamento non riuscito: ${(error as Error).message}`);
                    }
                  }}
                >
                  <Plus size={15} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ computer */

function ComputerPane({ computer }: { computer: ContainedComputerLive | null }) {
  const enabled = Boolean(computer?.enabled);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [closing, setClosing] = useState(false);
  const [closedNote, setClosedNote] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await coreBridge.systemStatus());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, []);

  const docker = status?.docker;
  const dockerLabel = !docker
    ? "Verifica…"
    : !docker.installed
      ? "Non installato"
      : !docker.running
        ? "Installato, non in esecuzione"
        : docker.container_up
          ? "Attivo · container su"
          : "In esecuzione · container spento";
  const dockerOk = Boolean(docker?.running && docker.container_up);

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
        <p className="set-meter-sub">
          Un browser reale e contenuto (passa i controlli anti-bot) in un computer virtuale non
          invasivo, visibile live nella chat.
        </p>
        {enabled && computer?.novnc_url && (
          <div className="set-meter" style={{ marginTop: 8 }}>
            <span className="k">Vista live</span>
            <a className="set-btn" href={computer.novnc_url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              <span style={{ marginLeft: 6 }}>Apri noVNC</span>
            </a>
          </div>
        )}
      </div>

      <div className="set-section-label">Sistema</div>
      <div className="set-rows">
        <div className="set-row">
          <div>
            <div className="rk">Docker</div>
            <div className="rv">{dockerLabel}</div>
          </div>
          <span className={`set-badge ${dockerOk ? "green" : "muted"}`}>
            {dockerOk ? "OK" : "Attenzione"}
          </span>
        </div>
        <div className="set-row">
          <div>
            <div className="rk">Memoria — assistente</div>
            <div className="rv">{status ? `${status.gateway_memory_mb} MB` : "—"}</div>
          </div>
          {status?.container_memory_mb != null && (
            <div style={{ textAlign: "right" }}>
              <div className="rk">Container</div>
              <div className="rv">{status.container_memory_mb} MB</div>
            </div>
          )}
        </div>
        <div className="set-row">
          <div>
            <div className="rk">Sessioni browser attive</div>
            <div className="rv">{status ? status.browser_sessions : "—"}</div>
          </div>
          <button
            className="set-btn"
            type="button"
            disabled={closing}
            onClick={async () => {
              setClosing(true);
              setClosedNote(null);
              try {
                const result = await coreBridge.closeAllBrowsers();
                setClosedNote(
                  `Chiuse ${result.closed_sessions} sessioni e ${result.closed_tabs} schede.`,
                );
                await refresh();
              } catch {
                setClosedNote("Chiusura non riuscita.");
              } finally {
                setClosing(false);
              }
            }}
          >
            {closing ? "Chiusura…" : "Chiudi tutti i browser"}
          </button>
        </div>
      </div>
      {closedNote && <p className="set-hint">{closedNote}</p>}
    </>
  );
}

/* --------------------------------------------------------------------- audit */

function AuditPane() {
  const [memory, setMemory] = useState<CoreMemoryDashboard | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await coreBridge.memoryDashboard();
        if (!cancelled) setMemory(value);
      } catch {
        /* leave null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats: Array<{ k: string; v: number | undefined }> = [
    { k: "Memorie", v: memory?.total_memories },
    { k: "Entità", v: memory?.total_entities },
    { k: "Relazioni", v: memory?.total_relations },
    { k: "Pagine wiki", v: memory?.total_wiki_pages },
  ];

  return (
    <>
      <div className="set-section-label" style={{ marginTop: 0 }}>
        Memoria del progetto
      </div>
      <div className="set-card">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: "var(--s3)",
          }}
        >
          {stats.map((stat) => (
            <div key={stat.k}>
              <div className="set-card-name" style={{ fontSize: 22 }}>
                {stat.v ?? "—"}
              </div>
              <div className="rk">{stat.k}</div>
            </div>
          ))}
        </div>
        {memory && memory.by_sensitivity.length > 0 && (
          <>
            <div className="set-card-divider" />
            <p className="set-meter-sub" style={{ marginBottom: 0 }}>
              Per sensibilità:{" "}
              {memory.by_sensitivity.map((item) => `${item.key} ${item.count}`).join(" · ")}
            </p>
          </>
        )}
      </div>

      <div className="set-section-label">Audit</div>
      <div className="set-rows">
        <div className="set-row">
          <div>
            <div className="rk">Azioni registrate</div>
            <div className="rv">
              {memory ? `${memory.access_audit_count} accessi tracciati sul dispositivo` : "—"}
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
