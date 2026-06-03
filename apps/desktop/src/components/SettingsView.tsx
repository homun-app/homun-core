import {
  Boxes,
  Check,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Folder,
  ListChecks,
  MonitorPlay,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  coreBridge,
  type ActiveModelInfo,
  type AllowedTool,
  type ArtifactDestination,
  type ArtifactsUsage,
  type ComposioToolkit,
  type ContainedComputerLive,
  type CoreCapabilitySnapshot,
  type CoreChannelSettings,
  type CoreContact,
  type CoreMemoryDashboard,
  type CoreTelegramStatus,
  type ProviderModelView,
  type ProviderView,
  type CatalogPreview,
  type CatalogSkill,
  type SkillCatalogResponse,
  type RoleView,
  type RoutingDecision,
  type SkillDetail,
  type SkillFileNode,
  type SkillSecurityReport,
  type SkillsResponse,
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
  memory: "Memoria",
  channels: "Canali",
  connections: "Connettori",
  skills: "Skill",
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
      className={`settings-view ${
        section === "runtime" || section === "connections" || section === "skills"
          ? "settings-wide"
          : ""
      }`}
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
        {section === "memory" && <MemoryPane />}
        {section === "channels" && <ChannelsPane />}
        {section === "connections" && <ConnectorsPane />}
        {section === "skills" && <SkillsPane />}
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
            onSaveModel={(modelId, patch) =>
              run(
                selectedProvider.id,
                () =>
                  coreBridge.setModelProfile({
                    provider_id: selectedProvider.id,
                    model: modelId,
                    ...patch,
                  }),
                "Modello aggiornato.",
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
  onSaveModel,
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
  onSaveModel: (
    modelId: string,
    patch: {
      tier: string;
      strengths?: string;
      vision?: boolean;
      tools?: boolean;
      reasoning?: boolean;
      context_window?: number;
    },
  ) => void;
}) {
  const acting = busy === provider.id;
  const hasInferred = provider.models.some((m) => m.profile_source === "inferred" || !m.profile_source);
  // Which model row is open in the editor, plus its draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    tier: string;
    strengths: string;
    vision: boolean;
    tools: boolean;
    reasoning: boolean;
    contextWindow: string;
  }>({ tier: "balanced", strengths: "", vision: false, tools: true, reasoning: false, contextWindow: "" });

  const openEditor = (m: ProviderModelView) => {
    setEditingId(m.id);
    setDraft({
      tier: m.tier ?? "balanced",
      strengths: m.strengths ?? "",
      vision: m.vision,
      tools: m.tools,
      reasoning: m.reasoning,
      contextWindow: m.context_window ? String(m.context_window) : "",
    });
  };
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
          <div className="mdl-model-cell" key={m.id}>
            <div className="mdl-model-row">
              <div className="mdl-model-info">
                <span className="mdl-model-id">{m.id}</span>
                <div className="mdl-model-tags">
                  {m.modality !== "text" && <span className="mdl-tag">{m.modality}</span>}
                  {m.vision && <span className="mdl-tag">vision</span>}
                  {m.tools && <span className="mdl-tag">tools</span>}
                  {m.reasoning && <span className="mdl-tag think">reasoning</span>}
                  {m.context_window ? <span className="mdl-tag">{formatK(m.context_window)} ctx</span> : null}
                  {m.tier && <span className="mdl-tag tier">{m.tier}</span>}
                  {m.profile_source === "user" && <span className="mdl-tag user">tuo</span>}
                </div>
                {m.strengths ? (
                  <span className="mdl-model-str" title={m.strengths}>{m.strengths}</span>
                ) : null}
              </div>
              <button
                className="set-btn"
                type="button"
                disabled={acting}
                onClick={() => (editingId === m.id ? setEditingId(null) : openEditor(m))}
              >
                {editingId === m.id ? "Chiudi" : "Modifica"}
              </button>
            </div>
            {editingId === m.id && (
              <div className="mdl-model-editor">
                <div className="mdl-field">
                  <label>Descrizione (in cosa eccelle)</label>
                  <textarea
                    className="set-input"
                    rows={2}
                    placeholder="es. Coding & agentic frontier. 1M context. Multimodale."
                    value={draft.strengths}
                    onChange={(e) => setDraft({ ...draft, strengths: e.target.value })}
                  />
                </div>
                <div className="mdl-editor-grid">
                  <div className="mdl-field">
                    <label>Tier</label>
                    <select
                      className="set-input"
                      value={draft.tier}
                      onChange={(e) => setDraft({ ...draft, tier: e.target.value })}
                    >
                      <option value="fast">fast</option>
                      <option value="balanced">balanced</option>
                      <option value="reasoning">reasoning (thinking)</option>
                    </select>
                  </div>
                  <div className="mdl-field">
                    <label>Context window (token)</label>
                    <input
                      className="set-input"
                      type="number"
                      placeholder="es. 1000000"
                      value={draft.contextWindow}
                      onChange={(e) => setDraft({ ...draft, contextWindow: e.target.value })}
                    />
                  </div>
                </div>
                <div className="mdl-editor-checks">
                  <label className="mdl-check">
                    <input
                      type="checkbox"
                      checked={draft.vision}
                      onChange={(e) => setDraft({ ...draft, vision: e.target.checked })}
                    />
                    vision
                  </label>
                  <label className="mdl-check">
                    <input
                      type="checkbox"
                      checked={draft.tools}
                      onChange={(e) => setDraft({ ...draft, tools: e.target.checked })}
                    />
                    tools
                  </label>
                  <label className="mdl-check">
                    <input
                      type="checkbox"
                      checked={draft.reasoning}
                      onChange={(e) => setDraft({ ...draft, reasoning: e.target.checked })}
                    />
                    reasoning (thinking)
                  </label>
                </div>
                <button
                  className="set-btn primary"
                  type="button"
                  style={{ alignSelf: "flex-start" }}
                  disabled={acting}
                  onClick={() => {
                    const ctx = parseInt(draft.contextWindow, 10);
                    onSaveModel(m.id, {
                      tier: draft.tier,
                      strengths: draft.strengths,
                      vision: draft.vision,
                      tools: draft.tools,
                      reasoning: draft.reasoning,
                      ...(Number.isFinite(ctx) && ctx > 0 ? { context_window: ctx } : {}),
                    });
                    setEditingId(null);
                  }}
                >
                  Salva modello
                </button>
              </div>
            )}
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

function ConnectorsPane() {
  const [snap, setSnap] = useState<CoreCapabilitySnapshot | null>(null);
  // Selected rail entry: "composio" | "add-mcp" | an MCP provider id.
  const [selected, setSelected] = useState<string>("composio");
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

  const composioConn = snap?.connections.find((c) => c.provider_id === "composio") ?? null;
  // The backend ConnectionStatus serializes as snake_case ("active" | "expired" |
  // "failed" | "disabled"). A stored composio connection in "active" means the key
  // verified and toolkits are cached → treat it as connected.
  const composioConnected = composioConn?.status.toLowerCase() === "active";

  // Group MCP tools by provider so each server shows as one rail entry + tool count.
  const mcpProviders = new Map<string, { name: string; tools: number }>();
  for (const tool of snap?.tools ?? []) {
    if (tool.provider_kind !== "mcp") continue;
    const entry = mcpProviders.get(tool.provider_id) ?? {
      name: tool.provider_id.replace(/^mcp:/, ""),
      tools: 0,
    };
    entry.tools += 1;
    mcpProviders.set(tool.provider_id, entry);
  }
  const mcpList = [...mcpProviders.entries()];

  const pick = (id: string) => {
    setSelected(id);
    setNote(null);
  };

  return (
    <div className="mdl-layout">
      <aside className="mdl-rail" aria-label="Connettori">
        <div className="mdl-rail-group">Cloud</div>
        <button
          type="button"
          className={`mdl-rail-item ${selected === "composio" ? "active" : ""}`}
          onClick={() => pick("composio")}
        >
          <span className="conn-avatar composio">Co</span>
          <span className="mdl-rail-name">Composio</span>
          {composioConnected && <span className="mdl-rail-dot" title="Connesso" />}
        </button>

        <div className="mdl-rail-group">Server MCP</div>
        {mcpList.map(([id, info]) => (
          <button
            key={id}
            type="button"
            className={`mdl-rail-item ${selected === id ? "active" : ""}`}
            onClick={() => pick(id)}
          >
            <span className="conn-avatar">
              <Server size={14} />
            </span>
            <span className="mdl-rail-name">{info.name}</span>
            <em className="mdl-rail-badge">{info.tools}</em>
          </button>
        ))}
        {mcpList.length === 0 && <p className="mdl-rail-empty">Nessun server</p>}
        <button
          type="button"
          className={`mdl-rail-item add ${selected === "add-mcp" ? "active" : ""}`}
          onClick={() => pick("add-mcp")}
        >
          <span className="conn-avatar add">
            <Plus size={14} />
          </span>
          <span className="mdl-rail-name">Aggiungi MCP</span>
        </button>
      </aside>

      <section className="mdl-detail">
        {selected === "composio" && (
          <ComposioDetail
            connected={composioConnected}
            onChanged={refresh}
            onNote={setNote}
          />
        )}
        {selected === "add-mcp" && (
          <McpAddDetail onChanged={refresh} onNote={setNote} onConnected={pick} />
        )}
        {mcpProviders.has(selected) && (
          <McpServerDetail
            providerId={selected}
            info={mcpProviders.get(selected)!}
            snap={snap}
          />
        )}
        {note && (
          <p className="set-hint" style={{ marginTop: "var(--s4)" }}>
            {note}
          </p>
        )}
      </section>
    </div>
  );
}

function ComposioDetail({
  connected,
  onChanged,
  onNote,
}: {
  connected: boolean;
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingKits, setLoadingKits] = useState(false);
  // Number of services with a live (ACTIVE) connected account — reported by the
  // toolkit browser, which already polls connections.
  const [connectedCount, setConnectedCount] = useState(0);
  // Set when the existing connection's key fails to list toolkits (invalid /
  // expired / revoked). We then fall back to the key form so the user can fix it.
  const [kitsError, setKitsError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);

  const loadToolkits = async () => {
    setLoadingKits(true);
    setKitsError(null);
    try {
      setToolkits(await coreBridge.composioToolkits());
    } catch (error) {
      setKitsError((error as Error).message);
    } finally {
      setLoadingKits(false);
    }
  };
  useEffect(() => {
    if (connected) {
      void loadToolkits();
    } else {
      setToolkits([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const submitKey = async () => {
    setBusy(true);
    onNote(null);
    try {
      const result = await coreBridge.composioConnect(apiKey.trim());
      onNote(`Composio collegato (${result.tools_cached} strumenti).`);
      setApiKey("");
      setEditingKey(false);
      setKitsError(null);
      await onChanged();
      await loadToolkits();
    } catch (error) {
      onNote(`Composio non collegato: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Show the key form when there is no live connection, when the stored key is
  // not working, or when the user explicitly chose to change it.
  const showForm = !connected || editingKey || kitsError !== null;

  return (
    <>
      <div className="mdl-detail-head">
        <div className="conn-detail-title">
          <span className="conn-avatar lg composio">Co</span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">Composio</h3>
            <p className="mdl-detail-sub">
              {connected
                ? connectedCount > 0
                  ? `Connesso · ${connectedCount} ${connectedCount === 1 ? "servizio collegato" : "servizi collegati"}`
                  : "Connesso · nessun servizio ancora collegato"
                : "Hub di toolkit cloud (Gmail, GitHub, Slack…) con OAuth gestito."}
            </p>
          </div>
          {connected && !showForm && (
            <button
              className="set-btn"
              type="button"
              onClick={() => setEditingKey(true)}
            >
              Cambia chiave
            </button>
          )}
          <span className={`set-badge ${connected ? "green" : "muted"}`}>
            {connected ? "Connesso" : "Non connesso"}
          </span>
        </div>
      </div>

      {showForm ? (
        <div className="mdl-field">
          {kitsError && (
            <p className="set-hint">
              La connessione esistente non risponde ({kitsError}). Reinserisci una API key valida.
            </p>
          )}
          <label className="mdl-field-label">Composio API key</label>
          <input
            className="set-input"
            type="password"
            placeholder="comp_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim() && !busy) void submitKey();
            }}
          />
          <div style={{ display: "flex", gap: "var(--s2)", marginTop: 12 }}>
            <button
              className="set-btn primary"
              type="button"
              disabled={busy || !apiKey.trim()}
              onClick={() => void submitKey()}
            >
              {busy ? "Collegamento…" : connected ? "Aggiorna chiave" : "Collega Composio"}
            </button>
            {connected && editingKey && !kitsError && (
              <button
                className="set-btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditingKey(false);
                  setApiKey("");
                }}
              >
                Annulla
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <AllowedToolsSection />
          <ComposioToolkitBrowser
            toolkits={toolkits}
            loading={loadingKits}
            onNote={onNote}
            onConnectedCount={setConnectedCount}
          />
        </>
      )}
    </>
  );
}

/** Tools the user marked "always allow": run without per-call confirmation.
 *  Listed here so the user can revoke them. */
function AllowedToolsSection() {
  const [tools, setTools] = useState<AllowedTool[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setTools(await coreBridge.composioAllowedTools());
      } catch {
        /* leave empty */
      }
    })();
  }, []);

  if (tools.length === 0) return null;

  const revoke = async (slug: string) => {
    setBusy(slug);
    try {
      setTools(await coreBridge.composioRevokeTool(slug));
    } catch {
      /* keep previous */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="cmp-allowed">
      <div className="mdl-detail-section-label">Sempre consentiti (eseguiti senza conferma)</div>
      <div className="cmp-allowed-list">
        {tools.map((tool) => (
          <div key={tool.slug} className="cmp-allowed-row">
            <ShieldCheck size={14} />
            <span className="cmp-allowed-name">{tool.name}</span>
            <code className="cmp-allowed-slug">{tool.slug}</code>
            <button
              className="mdl-icon-btn"
              type="button"
              disabled={busy === tool.slug}
              title={`Revoca: ${tool.name} chiederà di nuovo conferma`}
              aria-label={`Revoca ${tool.name}`}
              onClick={() => void revoke(tool.slug)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Connection status of a toolkit, derived from Composio connected-account state. */
type KitState = "connected" | "connecting" | "none";

function kitStateFromStatus(status: string | undefined): KitState {
  if (!status) return "none";
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "connected";
  if (s === "INITIATED" || s === "INITIALIZING" || s === "PENDING") return "connecting";
  return "none";
}

function ComposioToolkitBrowser({
  toolkits,
  loading,
  onNote,
  onConnectedCount,
}: {
  toolkits: ComposioToolkit[];
  loading: boolean;
  onNote: (note: string | null) => void;
  onConnectedCount: (n: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  // toolkit slug → best connection state. A toolkit can have several connected
  // accounts (e.g. a fresh ACTIVE one plus stale EXPIRED ones); we keep the best
  // so a live connection is never masked by an old expired record.
  const [connState, setConnState] = useState<Record<string, KitState>>({});
  // Slugs we are actively polling after kicking off an OAuth link.
  const [polling, setPolling] = useState<Set<string>>(new Set());
  const [modalKit, setModalKit] = useState<ComposioToolkit | null>(null);

  const refreshConnections = async () => {
    try {
      const conns = await coreBridge.composioConnections();
      const rank: Record<KitState, number> = { none: 0, connecting: 1, connected: 2 };
      const next: Record<string, KitState> = {};
      for (const c of conns) {
        if (!c.toolkit_slug) continue;
        const candidate = kitStateFromStatus(c.status);
        const current = next[c.toolkit_slug] ?? "none";
        if (rank[candidate] > rank[current]) next[c.toolkit_slug] = candidate;
      }
      setConnState(next);
      return next;
    } catch {
      return {} as Record<string, KitState>;
    }
  };
  useEffect(() => {
    void refreshConnections();
  }, []);

  // Report the live connected-service count up to the header.
  useEffect(() => {
    onConnectedCount(Object.values(connState).filter((s) => s === "connected").length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState]);

  // Composio exposes dozens of granular categories; show only the most populated
  // ones as quick filters (+ "Tutte") to keep the chip row clean — the rest stay
  // reachable via search.
  const categories = (() => {
    const counts = new Map<string, number>();
    for (const t of toolkits)
      for (const c of t.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c]) => c);
  })();

  // A confirmed live connection always wins; otherwise reflect the polling spinner.
  const stateOf = (slug: string): KitState => {
    const known = connState[slug] ?? "none";
    if (known === "connected") return "connected";
    return polling.has(slug) ? "connecting" : known;
  };

  const q = query.trim().toLowerCase();
  const filtered = toolkits.filter((t) => {
    if (category !== "all" && !(t.categories ?? []).includes(category)) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      t.slug.toLowerCase().includes(q) ||
      (t.categories ?? []).some((c) => c.toLowerCase().includes(q))
    );
  });

  // Link a toolkit. With an apiKey we run Composio's custom API-key flow (active
  // immediately, no browser); otherwise managed OAuth → open the redirect and
  // poll until Composio reports the account ACTIVE ("detect automatically").
  const connect = async (kit: ComposioToolkit, apiKey?: string) => {
    onNote(null);
    setModalKit(null);
    let redirect = "";
    try {
      const result = await coreBridge.composioLink(kit.slug, apiKey);
      redirect = result.redirect_url || "";
    } catch (error) {
      onNote(`Collegamento non riuscito: ${(error as Error).message}`);
      return;
    }
    if (redirect) {
      window.open(redirect, "_blank", "noopener,noreferrer");
      onNote(`Autorizza ${kit.name} nel browser, poi torna qui.`);
    } else {
      onNote(`Collego ${kit.name}…`);
    }
    setPolling((prev) => new Set(prev).add(kit.slug));
    // OAuth needs the user to authorize in the browser (slow); an API-key
    // connection is active right away (fast, short poll).
    const deadline = Date.now() + (redirect ? 150_000 : 20_000);
    const step = redirect ? 3000 : 1500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, step));
      const map = await refreshConnections();
      if (map[kit.slug] === "connected") {
        onNote(`${kit.name} connesso.`);
        break;
      }
    }
    setPolling((prev) => {
      const next = new Set(prev);
      next.delete(kit.slug);
      return next;
    });
  };

  return (
    <>
      <div className="conn-search">
        <Search size={15} />
        <input
          className="conn-search-input"
          placeholder="Cerca toolkit…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {categories.length > 0 && (
        <div className="cmp-cats">
          <button
            type="button"
            className={`cmp-cat ${category === "all" ? "active" : ""}`}
            onClick={() => setCategory("all")}
          >
            Tutte
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={`cmp-cat ${category === c ? "active" : ""}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="set-hint">Carico i toolkit…</p>
      ) : (
        <div className="cmp-grid">
          {filtered.slice(0, 120).map((kit) => (
            <ComposioCard
              key={kit.slug}
              kit={kit}
              state={stateOf(kit.slug)}
              onClick={() => setModalKit(kit)}
            />
          ))}
          {filtered.length === 0 && <p className="set-hint">Nessun toolkit trovato.</p>}
        </div>
      )}
      {filtered.length > 120 && (
        <p className="set-hint">Mostrati 120 di {filtered.length} — affina la ricerca.</p>
      )}

      {modalKit && (
        <ConnectModal
          kit={modalKit}
          state={stateOf(modalKit.slug)}
          onClose={() => setModalKit(null)}
          onConnect={(apiKey) => void connect(modalKit, apiKey)}
        />
      )}
    </>
  );
}

function ComposioCard({
  kit,
  state,
  onClick,
}: {
  kit: ComposioToolkit;
  state: KitState;
  onClick: () => void;
}) {
  const [imgOk, setImgOk] = useState(Boolean(kit.logo));
  return (
    <button type="button" className={`cmp-card ${state}`} onClick={onClick}>
      <span className="cmp-card-logo">
        {imgOk && kit.logo ? (
          <img src={kit.logo} alt="" loading="lazy" onError={() => setImgOk(false)} />
        ) : (
          <span className="conn-kit-fallback">{kit.name.slice(0, 1).toUpperCase()}</span>
        )}
      </span>
      <span className="cmp-card-name">{kit.name}</span>
      {state === "connected" && <span className="cmp-status connected">Connesso</span>}
      {state === "connecting" && <span className="cmp-status connecting">In corso…</span>}
    </button>
  );
}

function ConnectModal({
  kit,
  state,
  onClose,
  onConnect,
}: {
  kit: ComposioToolkit;
  state: KitState;
  onClose: () => void;
  onConnect: (apiKey?: string) => void;
}) {
  const [imgOk, setImgOk] = useState(Boolean(kit.logo));
  const [apiKey, setApiKey] = useState("");
  // Toolkits that are neither managed-OAuth nor no-auth need the user's own
  // credentials (e.g. openweather): collect the API key here.
  const needsKey = !kit.no_auth && !kit.managed_oauth;
  const canSubmit = !needsKey || apiKey.trim().length > 0;
  return (
    <div className="cmp-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cmp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmp-modal-head">
          <span className="cmp-card-logo sm">
            {imgOk && kit.logo ? (
              <img src={kit.logo} alt="" onError={() => setImgOk(false)} />
            ) : (
              <span className="conn-kit-fallback">{kit.name.slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">Collega {kit.name}</h3>
            <p className="mdl-detail-sub">
              {state === "connected"
                ? `${kit.name} è già connesso.`
                : `Collega il tuo account ${kit.name}.`}
            </p>
          </div>
          <button className="mdl-icon-btn" type="button" aria-label="Chiudi" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="cmp-modal-note">
          {needsKey
            ? `${kit.name} usa una tua API key. Inseriscila qui: viene salvata cifrata sul dispositivo e usata solo verso Composio. La connessione diventa attiva subito, senza browser.`
            : "Apriremo una finestra del browser: autorizzi l'accesso lì e l'app rileva la connessione automaticamente. I permessi degli agenti restano governati dai gate di approvazione."}
        </div>
        {needsKey && (
          <input
            className="set-input"
            type="password"
            placeholder="API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) onConnect(apiKey.trim());
            }}
          />
        )}
        <button
          className="set-btn primary cmp-modal-btn"
          type="button"
          disabled={!canSubmit}
          onClick={() => onConnect(needsKey ? apiKey.trim() : undefined)}
        >
          {needsKey
            ? `Collega con API key`
            : state === "connected"
              ? `Riconnetti ${kit.name}`
              : `Collega ${kit.name}`}
        </button>
      </div>
    </div>
  );
}

function McpAddDetail({
  onChanged,
  onNote,
  onConnected,
}: {
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
  onConnected: (providerId: string) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <div className="mdl-detail-head">
        <h3 className="mdl-detail-title">Aggiungi un server MCP</h3>
        <p className="mdl-detail-sub">
          Un server MCP (Model Context Protocol) espone strumenti via stdio. Indica comando e
          argomenti per avviarlo.
        </p>
      </div>
      <div className="mdl-field">
        <label className="mdl-field-label">Nome</label>
        <input
          className="set-input"
          placeholder="es. GitHub MCP"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="mdl-field">
        <label className="mdl-field-label">Comando</label>
        <input
          className="set-input"
          placeholder="es. npx"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
      </div>
      <div className="mdl-field">
        <label className="mdl-field-label">Argomenti</label>
        <input
          className="set-input"
          placeholder="separati da spazio — es. -y @owner/mcp-server"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </div>
      <button
        className="set-btn primary"
        type="button"
        style={{ marginTop: 4, alignSelf: "flex-start" }}
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
            onConnected(result.provider_id);
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
    </>
  );
}

function McpServerDetail({
  providerId,
  info,
  snap,
}: {
  providerId: string;
  info: { name: string; tools: number };
  snap: CoreCapabilitySnapshot | null;
}) {
  const tools = (snap?.tools ?? []).filter((tool) => tool.provider_id === providerId);
  return (
    <>
      <div className="mdl-detail-head">
        <div className="conn-detail-title">
          <span className="conn-avatar lg">
            <Server size={18} />
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">{info.name}</h3>
            <p className="mdl-detail-sub">
              {providerId} · {info.tools} strumenti
            </p>
          </div>
          <span className="set-badge green">Connesso</span>
        </div>
      </div>
      <div className="mdl-detail-section-label">Strumenti</div>
      <div className="conn-tool-list">
        {tools.map((tool) => (
          <div key={`${providerId}:${tool.name}`} className="conn-tool">
            <div className="conn-tool-main">
              <span className="conn-tool-name">{tool.name}</span>
              {tool.description && <span className="conn-tool-desc">{tool.description}</span>}
            </div>
            <span className="mdl-tag">{tool.action}</span>
          </div>
        ))}
        {tools.length === 0 && <p className="set-hint">Nessuno strumento esposto.</p>}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- skills */

/** Sentinel rail selection for the GitHub marketplace view. */
const MARKET = "__market__";

function SkillsPane() {
  const [resp, setResp] = useState<SkillsResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await coreBridge.skills();
        setResp(r);
        setSelected((cur) => cur ?? r.skills[0]?.id ?? null);
      } catch (e) {
        setError(`Impossibile leggere le skill: ${(e as Error).message}`);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected || selected === MARKET) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const d = await coreBridge.skillDetail(selected);
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await coreBridge.setSkillEnabled(id, enabled);
      setResp(r);
      setDetail((d) => (d && d.id === id ? { ...d, enabled } : d));
    } catch (e) {
      setError(`Aggiornamento non riuscito: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const skills = resp?.skills ?? [];
  const onMarket = selected === MARKET;

  return (
    <div className="mdl-layout">
      <aside className="mdl-rail" aria-label="Skill">
        <div className="mdl-rail-group">Skill personali</div>
        {skills.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`mdl-rail-item ${selected === s.id ? "active" : ""}`}
            onClick={() => setSelected(s.id)}
          >
            <span className="conn-avatar">
              <Sparkles size={13} />
            </span>
            <span className="mdl-rail-name">{s.name}</span>
            <span
              className={`skl-state ${s.enabled ? "on" : "off"}`}
              title={s.enabled ? "Attiva" : "Disattivata"}
            />
          </button>
        ))}
        {skills.length === 0 && <p className="mdl-rail-empty">Nessuna skill</p>}
        <button
          type="button"
          className={`mdl-rail-item add ${onMarket ? "active" : ""}`}
          onClick={() => setSelected(MARKET)}
        >
          <span className="conn-avatar add">
            <Download size={13} />
          </span>
          <span className="mdl-rail-name">Catalogo skill</span>
        </button>
      </aside>

      <section className="mdl-detail">
        {onMarket ? (
          <MarketplaceView
            installedIds={skills.map((s) => s.id)}
            onInstalled={(r, id) => {
              setResp(r);
              setSelected(id);
            }}
          />
        ) : skills.length === 0 ? (
          <SkillsEmpty dir={resp?.dir} onBrowse={() => setSelected(MARKET)} />
        ) : detail ? (
          <SkillDetailView detail={detail} busy={busy} onToggle={toggle} />
        ) : (
          <p className="set-hint">Carico…</p>
        )}
        {error && <p className="set-hint">{error}</p>}
      </section>
    </div>
  );
}

function SkillsEmpty({ dir, onBrowse }: { dir?: string; onBrowse: () => void }) {
  return (
    <div className="skl-empty">
      <span className="conn-avatar lg">
        <Sparkles size={20} />
      </span>
      <h3 className="mdl-detail-title">Nessuna skill installata</h3>
      <p className="mdl-detail-sub">
        Una skill è una cartella in formato Agent Skills: un <code>SKILL.md</code> con nome e
        descrizione (ciò che il modello legge per decidere quando usarla). Mettile in questa
        cartella e compariranno qui automaticamente:
      </p>
      {dir && <code className="skl-path">{dir}</code>}
      <button className="set-btn primary" type="button" onClick={onBrowse} style={{ alignSelf: "flex-start" }}>
        <Download size={14} />
        <span style={{ marginLeft: 6 }}>Sfoglia il catalogo</span>
      </button>
    </div>
  );
}

function MarketplaceView({
  installedIds,
  onInstalled,
}: {
  installedIds: string[];
  onInstalled: (resp: SkillsResponse, installedId: string) => void;
}) {
  const [data, setData] = useState<SkillCatalogResponse | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);

  const load = async (q: string, cat: string | null) => {
    setLoading(true);
    setNote(null);
    try {
      setData(await coreBridge.skillCatalog(q || undefined, cat || undefined));
    } catch (e) {
      setNote(`Catalogo non disponibile: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };
  // Initial load + reload on category/query change (debounced for typing).
  useEffect(() => {
    const handle = window.setTimeout(() => void load(query, category), query ? 350 : 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category]);

  const installed = new Set(installedIds);
  const skills = data?.skills ?? [];

  const install = async (slug: string, name: string) => {
    setBusy(slug);
    setNote(null);
    try {
      const r = await coreBridge.catalogInstall(slug);
      onInstalled(r, slug);
      setPreviewSlug(null);
      setNote(`Installata: ${name}.`);
    } catch (e) {
      setNote(`Installazione non riuscita: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mdl-detail-head">
        <div className="conn-detail-title">
          <span className="conn-avatar lg">
            <Download size={18} />
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">Catalogo skill (OpenClaw)</h3>
            <p className="mdl-detail-sub">
              {data ? `${data.total} skill nel registro.` : "Sfoglia e installa dal registro OpenClaw."}{" "}
              Sono codice: installa solo ciò di cui ti fidi.
            </p>
          </div>
        </div>
      </div>

      <div className="conn-search">
        <Search size={15} />
        <input
          className="conn-search-input"
          placeholder="Cerca skill…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {data && data.categories.length > 0 && (
        <div className="cmp-cats">
          <button
            type="button"
            className={`cmp-cat ${!category ? "active" : ""}`}
            onClick={() => setCategory(null)}
          >
            Tutte
          </button>
          {data.categories.map((c) => (
            <button
              key={c.name}
              type="button"
              className={`cmp-cat ${category === c.name ? "active" : ""}`}
              onClick={() => setCategory(c.name)}
            >
              {c.name} · {c.count}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="set-hint">Carico il catalogo…</p>
      ) : (
        <div className="conn-kit-grid">
          {skills.map((skill) => {
            const already = installed.has(skill.slug);
            return (
              <div
                key={skill.slug}
                className="conn-kit market clickable"
                role="button"
                tabIndex={0}
                title={`Dettaglio ${skill.name}`}
                onClick={() => setPreviewSlug(skill.slug)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setPreviewSlug(skill.slug);
                }}
              >
                <span className="conn-kit-logo">
                  <span className="conn-kit-fallback">{skill.name.slice(0, 1).toUpperCase()}</span>
                </span>
                <div className="conn-kit-body">
                  <div className="conn-kit-name">{skill.name}</div>
                  <div className="conn-kit-meta market">{skill.description || skill.slug}</div>
                </div>
                {already ? (
                  <span className="mdl-tag skl-installed">installata</span>
                ) : (
                  <button
                    className="mdl-icon-btn"
                    type="button"
                    disabled={busy === skill.slug}
                    title={`Installa ${skill.name}`}
                    aria-label={`Installa ${skill.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void install(skill.slug, skill.name);
                    }}
                  >
                    <Download size={15} />
                  </button>
                )}
              </div>
            );
          })}
          {!loading && skills.length === 0 && (
            <p className="set-hint">Nessuna skill per questo filtro.</p>
          )}
        </div>
      )}
      {note && <p className="set-hint">{note}</p>}
      {previewSlug && (
        <CatalogPreviewModal
          slug={previewSlug}
          installed={installed.has(previewSlug)}
          installing={busy === previewSlug}
          onClose={() => setPreviewSlug(null)}
          onInstall={(name) => void install(previewSlug, name)}
        />
      )}
    </>
  );
}

/** Preview of a catalog skill BEFORE installing: SKILL.md rendered + file list +
 *  security scan, with an Install action. */
function CatalogPreviewModal({
  slug,
  installed,
  installing,
  onClose,
  onInstall,
}: {
  slug: string;
  installed: boolean;
  installing: boolean;
  onClose: () => void;
  onInstall: (name: string) => void;
}) {
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await coreBridge.catalogPreview(slug);
        if (!cancelled) setPreview(p);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="cmp-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cmp-modal skl-preview" onClick={(e) => e.stopPropagation()}>
        <div className="cmp-modal-head">
          <span className="conn-avatar lg">
            <Sparkles size={18} />
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">{preview?.name ?? slug}</h3>
            <p className="mdl-detail-sub">
              {preview ? `${preview.files.length} file` : "Carico l'anteprima…"}
            </p>
          </div>
          <button className="mdl-icon-btn" type="button" aria-label="Chiudi" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {error && <p className="cmp-confirm-err">Anteprima non disponibile: {error}</p>}

        {preview && (
          <>
            {preview.description && <p className="skl-desc">{preview.description}</p>}
            <SkillSecuritySection report={preview.security} />
            <div className="skl-md-head">
              <span className="mdl-detail-section-label">SKILL.md</span>
              <div className="skl-md-toggle">
                <button
                  type="button"
                  className={`mdl-icon-btn ${!raw ? "active" : ""}`}
                  onClick={() => setRaw(false)}
                  aria-label="Anteprima"
                >
                  <Eye size={15} />
                </button>
                <button
                  type="button"
                  className={`mdl-icon-btn ${raw ? "active" : ""}`}
                  onClick={() => setRaw(true)}
                  aria-label="Sorgente"
                >
                  <Code2 size={15} />
                </button>
              </div>
            </div>
            {raw ? (
              <pre className="skl-raw">{preview.body}</pre>
            ) : (
              <div className="skl-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {preview.body}
                </ReactMarkdown>
              </div>
            )}
          </>
        )}

        <button
          className="set-btn primary cmp-modal-btn"
          type="button"
          disabled={installed || installing || !preview}
          onClick={() => preview && onInstall(preview.name)}
        >
          {installed ? "Già installata" : installing ? "Installo…" : "Installa"}
        </button>
      </div>
    </div>
  );
}

function SkillDetailView({
  detail,
  busy,
  onToggle,
}: {
  detail: SkillDetail;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}) {
  const [raw, setRaw] = useState(false);
  return (
    <>
      <div className="mdl-detail-head">
        <div className="conn-detail-title">
          <span className="conn-avatar lg">
            <Sparkles size={18} />
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">{detail.name}</h3>
            <p className="mdl-detail-sub">
              {detail.id}
              {detail.version ? ` · v${detail.version}` : ""}
            </p>
          </div>
          <label className="skl-toggle" title="Attiva o disattiva la skill">
            <input
              type="checkbox"
              checked={detail.enabled}
              disabled={busy}
              onChange={(e) => void onToggle(detail.id, e.target.checked)}
            />
            <span>{detail.enabled ? "Attiva" : "Disattivata"}</span>
          </label>
        </div>
      </div>

      <div className="skl-pills">
        <span className="mdl-tag">origine: {detail.source}</span>
        {detail.license && <span className="mdl-tag">licenza: {detail.license}</span>}
        {(detail.allowed_tools ?? []).map((t) => (
          <span key={t} className="mdl-tag tier">
            {t}
          </span>
        ))}
      </div>

      {detail.description && <p className="skl-desc">{detail.description}</p>}

      {detail.security && <SkillSecuritySection report={detail.security} />}

      <div className="skl-md-head">
        <span className="mdl-detail-section-label">SKILL.md</span>
        <div className="skl-md-toggle">
          <button
            type="button"
            className={`mdl-icon-btn ${!raw ? "active" : ""}`}
            onClick={() => setRaw(false)}
            title="Anteprima"
            aria-label="Anteprima"
          >
            <Eye size={15} />
          </button>
          <button
            type="button"
            className={`mdl-icon-btn ${raw ? "active" : ""}`}
            onClick={() => setRaw(true)}
            title="Sorgente"
            aria-label="Sorgente"
          >
            <Code2 size={15} />
          </button>
        </div>
      </div>
      {raw ? (
        <pre className="skl-raw">{detail.body}</pre>
      ) : (
        <div className="skl-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {detail.body}
          </ReactMarkdown>
        </div>
      )}

      {detail.files.length > 0 && (
        <>
          <div className="mdl-detail-section-label">File</div>
          <div className="skl-tree">
            <SkillTree nodes={detail.files} depth={0} />
          </div>
        </>
      )}
    </>
  );
}

function SkillTree({ nodes, depth }: { nodes: SkillFileNode[]; depth: number }) {
  return (
    <ul className="skl-tree-list">
      {nodes.map((node) => (
        <li key={node.path}>
          <span className="skl-tree-row" style={{ paddingLeft: 10 + depth * 16 }}>
            {node.is_dir ? <Folder size={14} /> : <FileText size={14} />}
            <span className="skl-tree-name">{node.name}</span>
          </span>
          {node.is_dir && node.children && node.children.length > 0 && (
            <SkillTree nodes={node.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

function SkillSecuritySection({ report }: { report: SkillSecurityReport }) {
  const level = report.blocked ? "high" : report.risk_score > 0 ? "warn" : "clean";
  const label =
    level === "high" ? "Rischio alto" : level === "warn" ? "Da rivedere" : "Pulita";
  return (
    <div className={`skl-sec ${level}`}>
      <div className="skl-sec-head">
        <ShieldCheck size={15} />
        <strong>Sicurezza</strong>
        <span className="skl-sec-badge">
          {label} · {report.risk_score}/100
        </span>
        <span className="skl-sec-files">{report.scanned_files} file analizzati</span>
      </div>
      {report.warnings.length === 0 ? (
        <p className="skl-sec-clean">Nessun pattern sospetto rilevato.</p>
      ) : (
        <ul className="skl-sec-list">
          {report.warnings.slice(0, 20).map((w, i) => (
            <li key={`${w.file}-${w.line}-${i}`} className={`skl-sec-warn ${w.severity}`}>
              <span className="skl-sec-sev">
                {w.severity === "critical" ? "CRITICO" : "ATTENZIONE"}
              </span>
              <span className="skl-sec-desc">{w.description}</span>
              {w.file && (
                <code>
                  {w.file}
                  {w.line ? `:${w.line}` : ""}
                </code>
              )}
            </li>
          ))}
          {report.warnings.length > 20 && (
            <li className="set-hint">+{report.warnings.length - 20} altri…</li>
          )}
        </ul>
      )}
    </div>
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

      <ArtifactsCard />
      <DestinationsCard />
    </>
  );
}

function DestinationsCard() {
  const [destinations, setDestinations] = useState<ArtifactDestination[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setDestinations(await coreBridge.artifactDestinations());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  async function add() {
    setBusy(true);
    try {
      const path = await coreBridge.pickFolder();
      if (path) {
        const label = path.replace(/\/+$/, "").split("/").pop() || path;
        setDestinations(await coreBridge.addArtifactDestination(label, path));
      }
    } catch {
      /* cancelled / unavailable */
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string) {
    setBusy(true);
    try {
      setDestinations(await coreBridge.removeArtifactDestination(path));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="set-section-label">Cartelle di destinazione</div>
      <div className="set-card">
        <div className="set-card-top">
          <span className="set-card-name">Dove l'assistente può salvare i file</span>
          <button className="set-btn" type="button" disabled={busy} onClick={() => void add()}>
            <Plus size={14} />
            <span style={{ marginLeft: 6 }}>Aggiungi</span>
          </button>
        </div>
        <div className="set-card-divider" />
        <p className="set-meter-sub">
          Cartelle autorizzate in cui l'assistente può copiare i file generati (es. ~/Reports), su
          richiesta o in automazione. Può scrivere SOLO qui.
        </p>
        {destinations.length ? (
          <div className="set-rows" style={{ marginTop: 8 }}>
            {destinations.map((destination) => (
              <div className="set-row" key={destination.path}>
                <div style={{ minWidth: 0 }}>
                  <div className="rk">{destination.label}</div>
                  <div
                    className="rv"
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {destination.path}
                  </div>
                </div>
                <button
                  className="set-btn"
                  type="button"
                  disabled={busy}
                  aria-label={`Rimuovi ${destination.label}`}
                  onClick={() => void remove(destination.path)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="set-hint">Nessuna cartella autorizzata. Aggiungine una per consentire i salvataggi.</p>
        )}
      </div>
    </>
  );
}

function formatArtifactBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactsCard() {
  const [usage, setUsage] = useState<ArtifactsUsage | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setUsage(await coreBridge.artifactsUsage());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const hasArtifacts = (usage?.threads.length ?? 0) > 0;

  return (
    <>
      <div className="set-section-label">File generati (artifacts)</div>
      <div className="set-card">
        <div className="set-card-top">
          <span className="set-card-name">Spazio usato</span>
          <span className="set-badge muted">
            {usage ? formatArtifactBytes(usage.total_bytes) : "—"}
          </span>
        </div>
        <div className="set-card-divider" />
        <p className="set-meter-sub">
          I file creati dalle skill restano sul disco{usage?.base_path ? ` in ${usage.base_path}` : ""}.
          Elimina ciò che non ti serve per non occupare spazio. Le conversazioni eliminate puliscono i
          loro file automaticamente.
        </p>
        <div className="set-meter" style={{ marginTop: 8, gap: 8 }}>
          <button
            className="set-btn"
            type="button"
            onClick={() => void coreBridge.revealPath(usage?.base_path ?? "")}
            disabled={!usage?.base_path}
          >
            <Folder size={14} />
            <span style={{ marginLeft: 6 }}>Apri cartella</span>
          </button>
          <button
            className="set-btn danger"
            type="button"
            disabled={busy || !hasArtifacts}
            onClick={() => void run(() => coreBridge.clearArtifacts())}
          >
            <Trash2 size={14} />
            <span style={{ marginLeft: 6 }}>Elimina tutto</span>
          </button>
        </div>
        {hasArtifacts ? (
          <div className="set-rows" style={{ marginTop: 10 }}>
            {usage!.threads.map((thread) => (
              <div className="set-row" key={thread.thread}>
                <div style={{ minWidth: 0 }}>
                  <div className="rk" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {thread.thread}
                  </div>
                  <div className="rv">
                    {thread.files.length} file · {formatArtifactBytes(thread.bytes)}
                  </div>
                </div>
                <button
                  className="set-btn"
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => coreBridge.deleteArtifactThread(thread.thread))}
                >
                  Elimina
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="set-hint">Nessun file generato finora.</p>
        )}
      </div>
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

/* --------------------------------------------------------------- channels */

type WhatsAppStatus = {
  connected: boolean;
  needs_pairing: boolean;
  qr: string | null;
  pair_code: string | null;
  running: boolean;
};

/** Normalize a contact identifier: trim + drop a leading "+". Keeps a full JID
 *  (e.g. "1234@lid") intact so power users can allowlist a precise address. */
function normalizeContact(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("+") ? trimmed.slice(1).trim() : trimmed;
}

/** Telegram (Bot API) connect/status section. Auth is a @BotFather token —
 *  no phone pairing — persisted server-side so reconnect needs no re-entry. */
function TelegramSection() {
  const [status, setStatus] = useState<CoreTelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await coreBridge.telegramStatus());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2500);
    return () => clearInterval(id);
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await coreBridge.telegramConnect(token.trim() || undefined);
      setToken("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await coreBridge.telegramDisconnect();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="set-section-label">Telegram</div>
      <div className="set-card">
        {status?.connected ? (
          <div className="set-row">
            <div>
              <div className="rk">Stato</div>
              <div className="rv">
                ✅ Connesso{status.bot_username ? ` — @${status.bot_username}` : ""}
              </div>
            </div>
            <button
              className="set-btn danger"
              type="button"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnetti
            </button>
          </div>
        ) : (
          <div>
            <p className="set-hint" style={{ marginTop: 0 }}>
              Crea un bot con <strong>@BotFather</strong> e incolla qui il token. Se l'hai già
              inserito, premi <strong>Connetti</strong> (il token resta salvato).
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                placeholder="token bot (123456:ABC…) — vuoto se già salvato"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="set-btn"
                type="button"
                disabled={busy}
                onClick={() => void connect()}
              >
                Connetti
              </button>
            </div>
            {status?.running && !status.connected && (
              <p className="set-hint">Bridge avviato, verifica del token in corso…</p>
            )}
            {status?.error && (
              <p className="set-hint" style={{ color: "var(--danger)" }}>
                {status.error}
              </p>
            )}
            {error && (
              <p className="set-hint" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function ChannelsPane() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<CoreChannelSettings | null>(null);
  const [newContact, setNewContact] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await coreBridge.whatsappStatus());
    } catch {
      /* leave previous */
    }
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2500);
    return () => clearInterval(id);
  }, []);
  // Settings are user-edited, not live state: load once, then mutate locally.
  useEffect(() => {
    void coreBridge.channelSettings().then(setSettings);
  }, []);

  // Persist optimistically: the gateway is the source of truth, so we echo its
  // saved copy back into state and roll back on failure.
  const saveSettings = async (next: CoreChannelSettings) => {
    const previous = settings;
    setSettings(next);
    setSavingSettings(true);
    setSettingsError(null);
    try {
      setSettings(await coreBridge.setChannelSettings(next));
    } catch (e) {
      setSettings(previous);
      setSettingsError((e as Error).message);
    } finally {
      setSavingSettings(false);
    }
  };

  const addContact = () => {
    if (!settings) return;
    const contact = normalizeContact(newContact);
    if (!contact || settings.allowlist.includes(contact)) {
      setNewContact("");
      return;
    }
    void saveSettings({ ...settings, allowlist: [...settings.allowlist, contact] });
    setNewContact("");
  };
  const removeContact = (contact: string) => {
    if (!settings) return;
    void saveSettings({
      ...settings,
      allowlist: settings.allowlist.filter((c) => c !== contact),
    });
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await coreBridge.whatsappConnect(phone.trim() || undefined);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await coreBridge.whatsappDisconnect();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="set-section-label" style={{ marginTop: 0 }}>
        WhatsApp
      </div>
      <div className="set-card">
        {status?.connected ? (
          <div className="set-row">
            <div>
              <div className="rk">Stato</div>
              <div className="rv">✅ Connesso</div>
            </div>
            <button className="set-btn danger" type="button" disabled={busy} onClick={() => void disconnect()}>
              Disconnetti
            </button>
          </div>
        ) : status?.pair_code ? (
          <div>
            <p className="set-hint" style={{ marginTop: 0 }}>
              Sul telefono: WhatsApp ▸ Dispositivi collegati ▸ Collega un dispositivo ▸{" "}
              <strong>Collega con numero di telefono</strong>, poi inserisci:
            </p>
            <div className="set-card-name" style={{ fontSize: 28, letterSpacing: 3 }}>
              {status.pair_code}
            </div>
            <button
              className="set-btn"
              type="button"
              disabled={busy}
              onClick={() => void disconnect()}
              style={{ marginTop: 12 }}
            >
              Annulla
            </button>
          </div>
        ) : (
          <div>
            <p className="set-hint" style={{ marginTop: 0 }}>
              Se hai già collegato il dispositivo, premi <strong>Connetti</strong> (riusa la
              sessione salvata). Per il primo collegamento, inserisci il numero in formato
              internazionale senza «+» (es. 39333…).
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder="numero di telefono (solo primo collegamento)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="set-btn"
                type="button"
                disabled={busy}
                onClick={() => void connect()}
              >
                Connetti
              </button>
            </div>
            {status?.running && (
              <p className="set-hint">Bridge avviato, in attesa di connessione/codice…</p>
            )}
            {error && (
              <p className="set-hint" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}
          </div>
        )}
      </div>

      <TelegramSection />

      <div className="set-section-label">Auto-risposta</div>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="rk">Canale attivo</div>
            <div className="rv">
              {settings?.enabled
                ? "I messaggi in arrivo vengono elaborati"
                : "Interruttore generale: tutti i messaggi in arrivo sono ignorati"}
            </div>
          </div>
          <Toggle
            on={!!settings?.enabled}
            onChange={(on) => {
              if (settings) void saveSettings({ ...settings, enabled: on });
            }}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="rk">Auto-risposta (solo testo)</div>
            <div className="rv">
              Risponde da sola ai contatti in allowlist; le altre azioni restano dietro conferma.
            </div>
          </div>
          <Toggle
            on={!!settings?.auto_reply}
            onChange={(on) => {
              if (settings) void saveSettings({ ...settings, auto_reply: on });
            }}
          />
        </div>
        {settings && !settings.enabled && (
          <p className="set-hint" style={{ marginBottom: 0 }}>
            Il canale è spento: l'auto-risposta non scatta finché non riattivi «Canale attivo».
          </p>
        )}
      </div>

      <div className="set-section-label">Allowlist</div>
      <div className="set-card">
        <p className="set-hint" style={{ marginTop: 0 }}>
          Solo questi contatti possono ricevere una risposta automatica (vale per tutti i canali).
          WhatsApp: numero internazionale senza «+» (es. 39333…) o JID completo (es. 1234@lid).
          Telegram: id utente numerico (es. 123456789).
        </p>
        {settings && settings.allowlist.length > 0 ? (
          <div>
            {settings.allowlist.map((contact) => (
              <div key={contact} className="set-row">
                <span style={{ fontFamily: "monospace" }}>{contact}</span>
                <button
                  className="set-btn danger"
                  type="button"
                  disabled={savingSettings}
                  onClick={() => removeContact(contact)}
                >
                  Rimuovi
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="set-hint">Nessun contatto in allowlist.</p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            placeholder="numero o JID"
            value={newContact}
            onChange={(e) => setNewContact(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addContact();
            }}
            style={{ flex: 1 }}
          />
          <button
            className="set-btn"
            type="button"
            disabled={savingSettings || !newContact.trim()}
            onClick={addContact}
          >
            Aggiungi
          </button>
        </div>
        {settingsError && (
          <p className="set-hint" style={{ color: "var(--danger)" }}>
            {settingsError}
          </p>
        )}
      </div>

      <p className="set-hint">
        I messaggi in arrivo sono trattati come dati non fidati: l'auto-risposta (solo testo) vale
        unicamente per i contatti in allowlist e le azioni restano dietro conferma.
      </p>
    </>
  );
}

/* --------------------------------------------------------------- memory */

const CONTACT_TYPES: { value: string; label: string }[] = [
  { value: "unknown", label: "Da definire" },
  { value: "self", label: "Sono io" },
  { value: "family", label: "Famiglia" },
  { value: "friend", label: "Amico/a" },
  { value: "professional", label: "Professionale" },
  { value: "colleague", label: "Collega" },
  { value: "other", label: "Altro" },
];
function contactTypeLabel(value: string): string {
  return CONTACT_TYPES.find((t) => t.value === value)?.label ?? value;
}

/* Contact cards (M6): each person the assistant knows, with their channels, type
   and conversation memory. Identity is unified by merging handles onto one card. */
function ContactsSection() {
  const [contacts, setContacts] = useState<CoreContact[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [memories, setMemories] = useState<string[] | null>(null);
  const [mergeInto, setMergeInto] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => setContacts(await coreBridge.contacts());
  useEffect(() => {
    void load();
  }, []);

  const open = contacts?.find((c) => c.reference === selected) ?? null;

  const openContact = async (reference: string) => {
    if (selected === reference) {
      setSelected(null);
      setMemories(null);
      return;
    }
    setSelected(reference);
    setMergeInto("");
    setMemories(null);
    setMemories(await coreBridge.contactMemories(reference));
  };

  const patch = async (update: { name?: string; contact_type?: string; notes?: string }) => {
    if (!open) return;
    setBusy(true);
    try {
      await coreBridge.updateContact({ reference: open.reference, ...update });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const merge = async () => {
    if (!open || !mergeInto) return;
    setBusy(true);
    try {
      // Absorb the open contact INTO the chosen one (survivor gains the handles).
      await coreBridge.mergeContacts(open.reference, mergeInto);
      setSelected(mergeInto);
      await load();
      setMemories(await coreBridge.contactMemories(mergeInto));
    } finally {
      setBusy(false);
    }
  };

  if (!contacts) return null;

  return (
    <>
      <div className="set-section-label">Contatti</div>
      {contacts.length === 0 ? (
        <p className="set-hint">
          Nessun contatto ancora. Quando ricevi messaggi dai canali (WhatsApp/Telegram) i
          contatti compaiono qui.
        </p>
      ) : (
        <div className="set-rows">
          {contacts.map((c) => {
            const isOpen = c.reference === selected;
            return (
              <div key={c.reference} className="set-card" style={{ marginBottom: 8 }}>
                <div
                  className="set-row"
                  style={{ cursor: "pointer" }}
                  onClick={() => void openContact(c.reference)}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rv">
                      {c.name || "(senza nome)"}
                      {c.is_self ? " · tu" : ""}
                    </div>
                    <div className="rk">
                      {contactTypeLabel(c.contact_type)}
                      {c.channels.length
                        ? ` · ${c.channels.map((ch) => ch.channel).join(", ")}`
                        : ""}
                      {` · ${c.memory_count} messaggi`}
                    </div>
                  </div>
                  <span className="rk">{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                    <label className="rk">
                      Tipo di contatto
                      <select
                        className="set-input"
                        value={c.contact_type}
                        disabled={busy}
                        onChange={(e) => void patch({ contact_type: e.target.value })}
                      >
                        {CONTACT_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="rk">
                      Nome
                      <input
                        className="set-input"
                        defaultValue={c.name}
                        disabled={busy}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && v !== c.name) void patch({ name: v });
                        }}
                      />
                    </label>
                    <label className="rk">
                      Note
                      <input
                        className="set-input"
                        defaultValue={c.notes}
                        placeholder="es. fratello, collega di lavoro…"
                        disabled={busy}
                        onBlur={(e) => {
                          if (e.target.value !== c.notes) void patch({ notes: e.target.value });
                        }}
                      />
                    </label>
                    <div className="rk">
                      Canali:{" "}
                      {c.channels.length
                        ? c.channels.map((ch) => `${ch.channel}:${ch.address}`).join("  ·  ")
                        : "nessuno"}
                    </div>
                    <div>
                      <div className="rk">Cosa so di lui/lei</div>
                      {memories === null ? (
                        <p className="set-hint">Carico…</p>
                      ) : memories.length === 0 ? (
                        <p className="set-hint">Nessun messaggio registrato.</p>
                      ) : (
                        <ul className="set-hint" style={{ margin: 0, paddingLeft: 16 }}>
                          {memories.slice(0, 30).map((m, i) => (
                            <li key={i}>{m}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="rk">Unisci a:</span>
                      <select
                        className="set-input"
                        value={mergeInto}
                        disabled={busy}
                        onChange={(e) => setMergeInto(e.target.value)}
                        style={{ flex: 1 }}
                      >
                        <option value="">— scegli un contatto —</option>
                        {contacts
                          .filter((o) => o.reference !== c.reference)
                          .map((o) => (
                            <option key={o.reference} value={o.reference}>
                              {o.name || o.reference}
                            </option>
                          ))}
                      </select>
                      <button
                        className="set-btn"
                        type="button"
                        disabled={busy || !mergeInto}
                        onClick={() => void merge()}
                      >
                        Unisci
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function MemoryPane() {
  return (
    <>
      <p className="set-hint" style={{ marginTop: 0 }}>
        Qui vedi e gestisci ciò che l'assistente ha imparato su di te. La memoria
        <strong> personale</strong> vale in tutti i progetti; quella di
        <strong> progetto</strong> solo in quello attivo. I dati sensibili (es. dati
        personali o documenti) restano <em>da confermare</em> e non vengono usati
        finché non li approvi.
      </p>
      <ContactsSection />
      <MemoryItemsList />
    </>
  );
}

/* What the assistant has learned about you (M5): list + confirm/reject/delete.
   Personal scope spans all projects; project scope is the active workspace. */
type MemoryItem = {
  reference: string;
  scope: string;
  memory_type: string;
  status: string;
  sensitivity: string;
  confidence: number;
  text: string;
};

function MemoryItemsList() {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ ref: string; text: string } | null>(null);

  const load = async () => {
    try {
      setItems(await coreBridge.memoryItems());
    } catch {
      setItems([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const decide = async (
    reference: string,
    action: "confirm" | "reject" | "delete" | "edit",
    text?: string,
  ) => {
    setBusy(true);
    try {
      await coreBridge.decideMemory(reference, action, text);
      setEditing(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!items) return null;

  const groups = [
    { key: "personal", label: "Personale (vale ovunque)" },
    { key: "project", label: "Progetto attivo" },
  ];

  return (
    <>
      <div className="set-section-label">Cosa ricordo di te</div>
      {items.length === 0 ? (
        <p className="set-hint">
          Non ho ancora memorizzato nulla. Dimmi in chat le tue preferenze o informazioni e le
          imparerò automaticamente.
        </p>
      ) : (
        groups.map((group) => {
          const rows = items.filter((item) => item.scope === group.key);
          if (rows.length === 0) return null;
          return (
            <div key={group.key}>
              <p className="set-meter-sub">{group.label}</p>
              <div className="set-rows">
                {rows.map((item) => {
                  const isEditing = editing?.ref === item.reference;
                  return (
                    <div className="set-row" key={item.reference}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editing.text}
                            onChange={(e) =>
                              setEditing({ ref: item.reference, text: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void decide(item.reference, "edit", editing.text);
                              if (e.key === "Escape") setEditing(null);
                            }}
                            style={{ width: "100%" }}
                          />
                        ) : (
                          <div className="rv">{item.text}</div>
                        )}
                        <div className="rk">
                          {item.memory_type}
                          {item.status === "candidate" ? " · da confermare" : ""}
                          {item.sensitivity !== "internal" && item.sensitivity !== "public"
                            ? ` · ${item.sensitivity}`
                            : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flex: "none" }}>
                        {isEditing ? (
                          <>
                            <button
                              className="set-btn"
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(item.reference, "edit", editing.text)}
                            >
                              Salva
                            </button>
                            <button
                              className="set-btn"
                              type="button"
                              disabled={busy}
                              onClick={() => setEditing(null)}
                            >
                              Annulla
                            </button>
                          </>
                        ) : (
                          <>
                            {item.status === "candidate" && (
                              <>
                                <button
                                  className="set-btn"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void decide(item.reference, "confirm")}
                                >
                                  Conferma
                                </button>
                                <button
                                  className="set-btn"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void decide(item.reference, "reject")}
                                >
                                  Rifiuta
                                </button>
                              </>
                            )}
                            <button
                              className="set-btn"
                              type="button"
                              disabled={busy}
                              onClick={() => setEditing({ ref: item.reference, text: item.text })}
                            >
                              Modifica
                            </button>
                            <button
                              className="set-btn danger"
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(item.reference, "delete")}
                            >
                              Dimentica
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
