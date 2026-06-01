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
  type ComposioToolkit,
  type ContainedComputerLive,
  type CoreCapabilitySnapshot,
  type AgentView,
  type CoreMemoryDashboard,
  type ProviderView,
  type RoleView,
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
    <section className="settings-view" aria-labelledby="settings-title">
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
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [presetId, setPresetId] = useState("ollama");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");

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

  const reloadAgents = async () => {
    try {
      setAgents((await coreBridge.agents()).agents);
    } catch {
      /* leave empty */
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        apply(await coreBridge.providers());
      } catch {
        /* leave empty */
      }
      await reloadRoles();
      await reloadAgents();
    })();
  }, []);

  // Model-binding encoding shared by the role pickers and agent pickers:
  // "role:<key>" inherits a role; "<provider>::<model>" pins explicitly.
  const agentBindingValue = (agent: AgentView): string => {
    if (agent.provider_id && agent.model) return `${agent.provider_id}::${agent.model}`;
    return `role:${agent.role || "orchestrator"}`;
  };
  const bindingToInput = (value: string) => {
    if (value.startsWith("role:")) return { role: value.slice(5) };
    const [provider_id, ...rest] = value.split("::");
    return { provider_id, model: rest.join("::") };
  };

  const saveAgent = async (key: string, input: Parameters<typeof coreBridge.upsertAgent>[0]) => {
    setBusy(key);
    setNote(null);
    try {
      setAgents((await coreBridge.upsertAgent(input)).agents);
    } catch (error) {
      setNote(`Operazione non riuscita: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const run = async (key: string, action: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setNote(null);
    try {
      const result = (await action()) as { providers: ProviderView[]; active_provider_id: string | null };
      if (result?.providers) apply(result);
      // Provider/catalog changes can shift auto role resolution.
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

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0];

  return (
    <>
      <div className="set-section-label">Modello per compito</div>
      {roles.length === 0 ? (
        <p className="set-hint">
          Aggiungi un provider e aggiorna i suoi modelli per assegnare un modello a ogni compito.
        </p>
      ) : (
        roles.map((role) => {
          const value = role.auto
            ? "auto"
            : `${role.binding_provider_id}::${role.binding_model}`;
          return (
            <div className="set-card" key={role.key}>
              <div className="set-card-top">
                <span className="set-card-name">{role.label}</span>
                <span className={`set-badge ${role.auto ? "muted" : "green"}`}>
                  {role.auto ? "Auto" : "Manuale"}
                </span>
              </div>
              <p className="set-meter-sub">{role.description}</p>
              <select
                className="set-input"
                value={value}
                disabled={busy === `role:${role.key}`}
                onChange={(event) => changeRole(role.key, event.target.value)}
                style={{ marginTop: "var(--s2)" }}
              >
                <option value="auto">
                  Auto{role.resolved_model ? ` — ${role.resolved_model}` : ""}
                </option>
                {providers.map((provider) => (
                  <optgroup key={provider.id} label={provider.label}>
                    {provider.models.map((m) => (
                      <option key={`${provider.id}::${m.id}`} value={`${provider.id}::${m.id}`}>
                        {m.id}
                        {m.tier ? ` · ${m.tier}` : ""}
                        {m.vision ? " · vision" : ""}
                        {m.modality !== "text" ? ` · ${m.modality}` : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          );
        })
      )}

      <div className="set-section-label">Provider configurati</div>
      {providers.length === 0 && (
        <p className="set-hint">Nessun provider. Aggiungine uno qui sotto (es. Ollama locale).</p>
      )}
      {providers.map((provider) => {
        const isActive = provider.id === activeId;
        const acting = busy === provider.id;
        return (
          <div className="set-card" key={provider.id}>
            <div className="set-card-top">
              <span className="set-card-name">{provider.label}</span>
              <span className={`set-badge ${isActive ? "green" : "muted"}`}>
                {isActive ? "Attivo" : provider.kind}
              </span>
            </div>
            <p className="set-meter-sub" style={{ wordBreak: "break-all" }}>
              {provider.base_url}
              {provider.has_key ? " · chiave configurata" : " · senza chiave"}
            </p>
            <div className="set-card-divider" />
            <div className="set-field-label">Modello</div>
            <select
              className="set-input"
              value={provider.active_model ?? ""}
              disabled={acting}
              onChange={(event) =>
                run(provider.id, () =>
                  coreBridge.upsertProvider({
                    id: provider.id,
                    label: provider.label,
                    kind: provider.kind,
                    base_url: provider.base_url,
                    active_model: event.target.value,
                  }),
                )
              }
              style={{ marginBottom: "var(--s3)" }}
            >
              {provider.models.length === 0 && <option value="">— nessun modello: aggiorna —</option>}
              {provider.active_model &&
                !provider.models.some((m) => m.id === provider.active_model) && (
                  <option value={provider.active_model}>{provider.active_model}</option>
                )}
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.tier ? ` · ${m.tier}` : ""}
                  {m.modality !== "text" ? ` · ${m.modality}` : ""}
                  {m.vision ? " · vision" : ""}
                </option>
              ))}
            </select>
            <div className="set-card-actions" style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
              <button
                className="set-btn"
                type="button"
                disabled={acting}
                onClick={() =>
                  run(
                    provider.id,
                    () => coreBridge.refreshProviderModels(provider.id),
                    `Catalogo aggiornato per ${provider.label}.`,
                  )
                }
              >
                {acting ? "…" : "Aggiorna modelli"}
              </button>
              {!isActive && (
                <button
                  className="set-btn"
                  type="button"
                  disabled={acting}
                  onClick={() => run(provider.id, () => coreBridge.activateProvider(provider.id))}
                >
                  Imposta attivo
                </button>
              )}
              <button
                className="set-btn danger"
                type="button"
                disabled={acting}
                onClick={() => run(provider.id, () => coreBridge.removeProvider(provider.id))}
              >
                Rimuovi
              </button>
            </div>
            {provider.models.length > 0 && (
              <details style={{ marginTop: "var(--s3)" }}>
                <summary className="set-field-label" style={{ cursor: "pointer" }}>
                  Profili modello — in cosa eccelle ({provider.models.length})
                </summary>
                <div style={{ maxHeight: 240, overflowY: "auto", marginTop: "var(--s2)" }}>
                  {provider.models.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--s2)",
                        padding: "2px 0",
                      }}
                    >
                      <span style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}>
                        {m.id}
                        {m.profile_source && m.profile_source !== "user" ? (
                          <em style={{ opacity: 0.5 }}> · {m.profile_source}</em>
                        ) : m.profile_source === "user" ? (
                          <em style={{ opacity: 0.6 }}> · tuo</em>
                        ) : null}
                      </span>
                      <select
                        className="set-input"
                        style={{ width: 130, fontSize: 12 }}
                        value={m.tier ?? "balanced"}
                        disabled={acting}
                        onChange={(event) =>
                          run(provider.id, () =>
                            coreBridge.setModelProfile({
                              provider_id: provider.id,
                              model: m.id,
                              tier: event.target.value,
                            }),
                          )
                        }
                      >
                        <option value="fast">fast</option>
                        <option value="balanced">balanced</option>
                        <option value="reasoning">reasoning</option>
                      </select>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}

      <div className="set-section-label">Aggiungi provider</div>
      <div className="set-rows" style={{ padding: "var(--s4) var(--s5)" }}>
        <div className="set-field-label">Tipo</div>
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
          style={{ marginBottom: "var(--s3)" }}
        >
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="set-field-label">Nome</div>
        <input
          className="set-input"
          placeholder={preset.label}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <div className="set-field-label" style={{ marginTop: 12 }}>
          Endpoint (base URL)
        </div>
        <input
          className="set-input"
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <div className="set-field-label" style={{ marginTop: 12 }}>
          API key (opzionale per endpoint locali)
        </div>
        <input
          className="set-input"
          type="password"
          placeholder="sk-…"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <button
          className="set-btn primary"
          type="button"
          style={{ marginTop: 12, alignSelf: "flex-start" }}
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
                // Best-effort: pull the new provider's model catalog immediately.
                const added = result.providers.find(
                  (p) => p.base_url === baseUrl.trim().replace(/\/$/, ""),
                );
                if (added) {
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
      </div>
      <div className="set-section-label">Agenti specializzati</div>
      {agents.length === 0 && (
        <p className="set-hint">
          Nessun agente. Creane uno con un suo prompt e un suo modello (un task può poi
          essere eseguito da quell'agente).
        </p>
      )}
      {agents.map((agent) => {
        const acting = busy === `agent:${agent.id}`;
        return (
          <div className="set-card" key={agent.id}>
            <div className="set-card-top">
              <span className="set-card-name">{agent.name}</span>
              <span className={`set-badge ${agent.enabled ? "green" : "muted"}`}>
                {agent.enabled ? "Attivo" : "Disattivo"}
              </span>
            </div>
            {agent.description && <p className="set-meter-sub">{agent.description}</p>}
            {agent.system_prompt && (
              <p className="set-meter-sub" style={{ fontStyle: "italic", opacity: 0.8 }}>
                “{agent.system_prompt}”
              </p>
            )}
            <div className="set-card-divider" />
            <div className="set-field-label">Modello</div>
            <select
              className="set-input"
              value={agentBindingValue(agent)}
              disabled={acting}
              onChange={(event) =>
                saveAgent(`agent:${agent.id}`, {
                  id: agent.id,
                  name: agent.name,
                  description: agent.description,
                  system_prompt: agent.system_prompt,
                  tools: agent.tools,
                  enabled: agent.enabled,
                  ...bindingToInput(event.target.value),
                })
              }
              style={{ marginBottom: "var(--s3)" }}
            >
              <optgroup label="Per ruolo">
                <option value="role:orchestrator">Come gestione generale</option>
                <option value="role:browser">Come browser</option>
              </optgroup>
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
            </select>
            <p className="set-meter-sub">
              Esegue su: <strong>{agent.resolved_model ?? "n/d"}</strong>
            </p>
            <div className="set-card-actions" style={{ display: "flex", gap: "var(--s2)" }}>
              <button
                className="set-btn"
                type="button"
                disabled={acting}
                onClick={() =>
                  saveAgent(`agent:${agent.id}`, {
                    id: agent.id,
                    name: agent.name,
                    description: agent.description,
                    system_prompt: agent.system_prompt,
                    tools: agent.tools,
                    enabled: !agent.enabled,
                    ...bindingToInput(agentBindingValue(agent)),
                  })
                }
              >
                {agent.enabled ? "Disattiva" : "Attiva"}
              </button>
              <button
                className="set-btn danger"
                type="button"
                disabled={acting}
                onClick={async () => {
                  setBusy(`agent:${agent.id}`);
                  try {
                    setAgents((await coreBridge.removeAgent(agent.id)).agents);
                  } catch (error) {
                    setNote(`Operazione non riuscita: ${(error as Error).message}`);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Rimuovi
              </button>
            </div>
          </div>
        );
      })}

      <div className="set-rows" style={{ padding: "var(--s4) var(--s5)" }}>
        <div className="set-field-label">Nuovo agente — nome</div>
        <input
          className="set-input"
          placeholder="es. Ricercatore"
          value={agentName}
          onChange={(event) => setAgentName(event.target.value)}
        />
        <div className="set-field-label" style={{ marginTop: 12 }}>
          Istruzioni / persona (system prompt)
        </div>
        <textarea
          className="set-input"
          rows={3}
          placeholder="Sei un ricercatore meticoloso: cerca fonti affidabili e sintetizza…"
          value={agentPrompt}
          onChange={(event) => setAgentPrompt(event.target.value)}
        />
        <button
          className="set-btn primary"
          type="button"
          style={{ marginTop: 12, alignSelf: "flex-start" }}
          disabled={busy === "agent:new" || !agentName.trim()}
          onClick={async () => {
            await saveAgent("agent:new", {
              name: agentName.trim(),
              system_prompt: agentPrompt.trim(),
              role: "orchestrator",
            });
            setAgentName("");
            setAgentPrompt("");
          }}
        >
          {busy === "agent:new" ? "Creazione…" : "Crea agente"}
        </button>
      </div>

      <div className="set-meter" style={{ margin: "var(--s3) var(--s5)" }}>
        <span className="k">
          <Cpu size={15} /> Contesto modello attivo
        </span>
        <span className="v">{model ? `~${formatK(model.context_window)} token` : "n/d"}</span>
      </div>
      <p className="set-hint">
        Più provider insieme: scegli quale è attivo e il suo modello. La chiave è cifrata nel secret
        store locale, mai mostrata. (Prossima fase: un modello diverso per compito.)
      </p>
      {note && <p className="set-hint">{note}</p>}
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
