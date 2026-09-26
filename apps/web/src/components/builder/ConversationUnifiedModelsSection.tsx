import { useEffect, useState } from "react";
import {
  Brain,
  Settings2,
  Check,
  Plus,
  Search,
  Laptop,
} from "lucide-react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  applyOllamaPreset,
  listModelProviders,
  listOllamaTags,
  setActiveModelProvider,
  type ModelProviderInfo,
} from "@/lib/engine-models-client";
import { SettingsToggleSwitch } from "./SettingsToggleSwitch";
import {
  ConversationModelEditModal,
  type EditingProviderState,
} from "./ConversationModelEditModal";
import "./conversation-unified-models.css";

type ProviderCardData = {
  id: string;
  name: string;
  kind: "cloud" | "local";
  description: string;
  defaultModel: string;
  availableModels: string[];
  baseUrl?: string;
  configured: boolean;
  isActive: boolean;
  iconBg: string;
  iconColor: string;
};

const KNOWN_PRESETS: Array<{
  id: string;
  name: string;
  kind: "cloud" | "local";
  defaultModel: string;
  availableModels: string[];
  defaultBaseUrl: string;
  iconBg: string;
  iconColor: string;
  description: string;
}> = [
  {
    id: "openai_compatible",
    name: "OpenAI",
    kind: "cloud",
    defaultModel: "gpt-4o",
    availableModels: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1", "gpt-4-turbo"],
    defaultBaseUrl: "https://api.openai.com/v1",
    iconBg: "#10a37f",
    iconColor: "#ffffff",
    description: "Modelli di punta GPT-4o, o3-mini e compatibili OpenAI API.",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    kind: "cloud",
    defaultModel: "claude-3-7-sonnet-20250219",
    availableModels: ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
    defaultBaseUrl: "https://api.anthropic.com/v1",
    iconBg: "#d97706",
    iconColor: "#ffffff",
    description: "Modelli Claude 3.7 Sonnet, Claude 3.5 Haiku ad alto ragionamento.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "cloud",
    defaultModel: "gemini-2.0-flash",
    availableModels: ["gemini-2.0-flash", "gemini-2.0-pro-exp-02-05", "gemini-1.5-pro", "gemini-1.5-flash"],
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    iconBg: "#2563eb",
    iconColor: "#ffffff",
    description: "Modelli multimodali ad alta velocità e grande finestra di contesto.",
  },
  {
    id: "ollama",
    name: "Ollama (Locale)",
    kind: "local",
    defaultModel: "qwen2.5:7b",
    availableModels: ["qwen2.5:7b", "deepseek-r1:8b", "llama3.2:3b", "mistral:7b", "phi4:14b"],
    defaultBaseUrl: "http://localhost:11434",
    iconBg: "#1b302b",
    iconColor: "#8fe3d0",
    description: "Esecuzione 100% locale sul tuo hardware senza costi o invio dati.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "cloud",
    defaultModel: "deepseek-chat",
    availableModels: ["deepseek-chat", "deepseek-reasoner"],
    defaultBaseUrl: "https://api.deepseek.com/v1",
    iconBg: "#4f46e5",
    iconColor: "#ffffff",
    description: "DeepSeek-V3 e R1 per ragionamento logico e codice ad alta efficienza.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "cloud",
    defaultModel: "anthropic/claude-3.5-sonnet",
    availableModels: ["anthropic/claude-3.5-sonnet", "meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-r1", "google/gemini-2.0-flash-001"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    iconBg: "#7c3aed",
    iconColor: "#ffffff",
    description: "Router unificato per accedere a centinaia di modelli da un'unica chiave.",
  },
];

export function ConversationUnifiedModelsSection() {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected" && status.capabilities?.features.models;
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string>("openai_compatible");
  const [filterTab, setFilterTab] = useState<"all" | "cloud" | "local">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingProvider, setEditingProvider] = useState<EditingProviderState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [ollamaTags, setOllamaTags] = useState<string[]>([]);

  async function load() {
    try {
      const data = await listModelProviders();
      setProviders(data.items);
      setActiveProviderId(data.active_provider_id);
      try {
        const tags = await listOllamaTags();
        setOllamaTags(tags);
      } catch {
        setOllamaTags([]);
      }
    } catch (cause) {
      setError(cause);
    }
  }

  useEffect(() => {
    if (engineReady) {
      void load();
    }
  }, [engineReady]);

  const displayList: ProviderCardData[] = KNOWN_PRESETS.map((preset) => {
    const fromEngine = providers.find((p) => p.id === preset.id);
    const isAct = activeProviderId === preset.id;
    const isConfigured = !!(
      (fromEngine && (fromEngine.credential_present || fromEngine.configured)) ||
      (preset.kind === "local" && ollamaTags.length > 0)
    );

    let displayModel = fromEngine?.default_model || preset.defaultModel;
    let avail = [...preset.availableModels];
    if (preset.kind === "local" && ollamaTags.length > 0) {
      avail = [...new Set([...ollamaTags, ...preset.availableModels])];
      if (!ollamaTags.includes(displayModel)) {
        displayModel = ollamaTags[0] ?? displayModel;
      }
    }

    return {
      id: preset.id,
      name: preset.name,
      kind: preset.kind,
      description: preset.description,
      defaultModel: displayModel,
      availableModels: avail,
      baseUrl: fromEngine?.base_url || preset.defaultBaseUrl,
      configured: isConfigured,
      isActive: isAct,
      iconBg: preset.iconBg,
      iconColor: preset.iconColor,
    };
  });

  const filtered = displayList.filter((item) => {
    if (filterTab === "cloud" && item.kind !== "cloud") return false;
    if (filterTab === "local" && item.kind !== "local") return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.defaultModel.toLowerCase().includes(q) ||
        item.availableModels.some((m) => m.toLowerCase().includes(q))
      );
    }
    return true;
  });

  async function handleToggleProvider(provider: ProviderCardData, turnOn: boolean) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (turnOn) {
        if (provider.kind === "local") {
          await applyOllamaPreset({
            model: provider.defaultModel,
          });
        }
        await setActiveModelProvider(provider.id);
        setActiveProviderId(provider.id);
        setInfo(`Provider ${provider.name} impostato come attivo per la squadra.`);
      } else {
        const nextId = provider.id === "openai_compatible" ? "ollama" : "openai_compatible";
        await setActiveModelProvider(nextId);
        setActiveProviderId(nextId);
      }
      await load();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(provider: ProviderCardData) {
    setEditingProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl || "",
      model: provider.defaultModel || "",
      apiKey: "",
      isLocal: provider.kind === "local",
      availableModels: provider.availableModels,
    });
  }

  return (
    <div className="cv-unified-section">
      {/* Header */}
      <header className="cv-unified-section__head">
        <div>
          <h2 className="cv-unified-section__title">Modelli & Intelligenza</h2>
          <p className="cv-unified-section__subtitle">
            Gestisci provider, chiavi API e modelli disponibili per Homun e i collaboratori AI.
          </p>
        </div>
        <div className="cv-unified-section__actions">
          <button
            type="button"
            className="cv-unified-btn is-primary"
            onClick={() =>
              setEditingProvider({
                id: "custom",
                name: "Nuovo Provider",
                baseUrl: "https://api.openai.com/v1",
                model: "gpt-4o",
                apiKey: "",
                isLocal: false,
                availableModels: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
              })
            }
          >
            <Plus size={14} />
            Collega modello
          </button>
        </div>
      </header>

      {/* Sub-tabs & Search bar */}
      <div className="cv-unified-toolbar">
        <div className="cv-unified-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === "all"}
            className={`cv-unified-tab ${filterTab === "all" ? "is-active" : ""}`}
            onClick={() => setFilterTab("all")}
          >
            Tutti <span className="cv-unified-tab__count">{displayList.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === "cloud"}
            className={`cv-unified-tab ${filterTab === "cloud" ? "is-active" : ""}`}
            onClick={() => setFilterTab("cloud")}
          >
            Cloud <span className="cv-unified-tab__count">{displayList.filter((d) => d.kind === "cloud").length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === "local"}
            className={`cv-unified-tab ${filterTab === "local" ? "is-active" : ""}`}
            onClick={() => setFilterTab("local")}
          >
            Locali <span className="cv-unified-tab__count">{displayList.filter((d) => d.kind === "local").length}</span>
          </button>
        </div>

        <div className="cv-unified-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Cerca provider o modello…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {info && (
        <div className="cv-unified-banner is-info">
          <Check size={14} />
          <span>{info}</span>
        </div>
      )}
      <HomunErrorNotice error={error} />

      {/* Providers List Rows */}
      <div className="cv-unified-list">
        {filtered.map((item) => (
          <div key={item.id} className="cv-unified-row">
            <div className="cv-unified-row__top-line">
              <div
                className="cv-unified-row__icon"
                style={{ backgroundColor: item.iconBg, color: item.iconColor }}
              >
                {item.kind === "local" ? <Laptop size={18} /> : <Brain size={18} />}
              </div>

              <div className="cv-unified-row__main">
                <div className="cv-unified-row__title-line">
                  <span className="cv-unified-row__title">{item.name}</span>
                  {item.isActive && (
                    <span className="cv-unified-badge is-active">In uso</span>
                  )}
                  <span className="cv-unified-badge">
                    {item.kind === "local" ? "Locale" : "Cloud"}
                  </span>
                  {item.configured && (
                    <span className="cv-unified-badge is-ok">Configurato</span>
                  )}
                </div>
                <p className="cv-unified-row__desc">{item.description}</p>
              </div>

              <div className="cv-unified-row__controls">
                <button
                  type="button"
                  className="cv-unified-icon-btn"
                  title={`Configura ${item.name}`}
                  aria-label={`Configura ${item.name}`}
                  onClick={() => openEdit(item)}
                >
                  <Settings2 size={16} />
                </button>

                <SettingsToggleSwitch
                  checked={item.isActive}
                  ariaLabel={`Attiva ${item.name}`}
                  disabled={busy}
                  onChange={(turnOn) => void handleToggleProvider(item, turnOn)}
                />
              </div>
            </div>

            {/* Available Models Pills */}
            <div className="cv-unified-row__models-pills">
              <span style={{ fontSize: "0.72rem", color: "#9db3ad" }}>Modelli disponibili:</span>
              {item.availableModels.slice(0, 5).map((m) => (
                <span
                  key={m}
                  className={`cv-unified-model-pill ${m === item.defaultModel ? "is-default" : ""}`}
                  title={m === item.defaultModel ? "Modello predefinito attivo" : "Disponibile per la squadra"}
                >
                  {m}
                </span>
              ))}
              {item.availableModels.length > 5 && (
                <span
                  className="cv-unified-model-pill"
                  style={{ opacity: 0.75, cursor: "pointer" }}
                  onClick={() => openEdit(item)}
                  title="Apri per visualizzare e selezionare tutti i modelli"
                >
                  +{item.availableModels.length - 5} altri
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Clean Connection Modal */}
      {editingProvider && (
        <ConversationModelEditModal
          provider={editingProvider}
          ollamaTags={ollamaTags}
          onClose={() => setEditingProvider(null)}
          onSaved={(name) => {
            void load();
            setInfo(`Provider ${name} configurato e modelli aggiornati.`);
          }}
        />
      )}
    </div>
  );
}
