import { useEffect, useState } from "react";
import {
  Settings2,
  Check,
  Plus,
  Search,
  Star,
  Layers,
  ArrowRight,
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
import {
  ConversationModelEditModal,
  type EditingProviderState,
} from "./ConversationModelEditModal";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { KNOWN_MODEL_PRESETS } from "@/lib/known-model-presets";
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
};

const KNOWN_PRESETS = KNOWN_MODEL_PRESETS;

export function ConversationUnifiedModelsSection({
  onNavigateSection,
}: {
  onNavigateSection?: (sectionId: string) => void;
} = {}) {
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
    const isConfigured = preset.kind === "local"
      ? (ollamaTags.length > 0 || Boolean(fromEngine?.configured))
      : Boolean(fromEngine?.credential_present);

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

  async function handleSetDefault(provider: ProviderCardData) {
    if (!provider.configured) {
      openEdit(provider);
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (provider.kind === "local") {
        await applyOllamaPreset({
          model: provider.defaultModel,
        });
      }
      await setActiveModelProvider(provider.id);
      setActiveProviderId(provider.id);
      setInfo(`Provider ${provider.name} impostato come predefinito per lo spazio.`);
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

      {/* Guidance Banner for Multi-Provider Pool */}
      <div className="cv-unified-guidance-banner">
        <div className="cv-unified-guidance-banner__icon">
          <Layers size={17} />
        </div>
        <div className="cv-unified-guidance-banner__content">
          <div className="cv-unified-guidance-banner__title">
            Pool di Modelli Multi-Provider
          </div>
          <p className="cv-unified-guidance-banner__text">
            Tutti i provider con credenziali configurate sono attivi contemporaneamente nel pool.
            Puoi assegnare cervelli e modelli diversi a ciascun collaboratore AI (es. Claude 3.7 per il codice, GPT-4o per l'analisi, Ollama per i task locali senza costi) nella sezione{" "}
            {onNavigateSection ? (
              <button
                type="button"
                className="cv-unified-guidance-banner__link"
                onClick={() => onNavigateSection("agents")}
              >
                Catalogo Agenti dello Spazio <ArrowRight size={12} />
              </button>
            ) : (
              <strong>Catalogo Agenti dello Spazio</strong>
            )}
            . Il provider contrassegnato con <em>Predefinito Spazio</em> viene usato come fallback per le operazioni generiche.
          </p>
        </div>
      </div>

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
              <div className="cv-unified-row__icon" title={item.name}>
                <ProviderBrandIcon providerId={item.id} size={22} />
              </div>

              <div className="cv-unified-row__main">
                <div className="cv-unified-row__title-line">
                  <span className="cv-unified-row__title">{item.name}</span>
                  <span className="cv-unified-badge">
                    {item.kind === "local" ? "Locale" : "Cloud"}
                  </span>
                  {item.configured ? (
                    <span className="cv-unified-badge is-pool" title="Configurato e disponibile per tutti gli agenti nel pool">
                      <span className="cv-unified-dot is-green" /> Nel Pool
                    </span>
                  ) : (
                    <span className="cv-unified-badge is-muted">Non configurato</span>
                  )}
                  {item.isActive && (
                    <span className="cv-unified-badge is-default-space" title="Fallback predefinito per lo spazio">
                      <Star size={11} fill="currentColor" /> Predefinito Spazio
                    </span>
                  )}
                </div>
                <p className="cv-unified-row__desc">{item.description}</p>
              </div>

              <div className="cv-unified-row__controls">
                <button
                  type="button"
                  className="cv-unified-icon-btn"
                  title={`Configura credenziali e parametri per ${item.name}`}
                  aria-label={`Configura ${item.name}`}
                  onClick={() => openEdit(item)}
                >
                  <Settings2 size={16} />
                </button>

                {item.configured ? (
                  item.isActive ? (
                    <span
                      className="cv-unified-default-badge is-active"
                      title="Questo provider è il predefinito di fallback per lo spazio"
                    >
                      <Star size={12} fill="currentColor" /> Predefinito
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cv-unified-set-default-btn"
                      disabled={busy}
                      title="Imposta come provider predefinito di riserva per lo spazio"
                      onClick={() => void handleSetDefault(item)}
                    >
                      <Star size={12} /> Imposta predefinito
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="cv-unified-btn cv-unified-btn--sm is-primary"
                    onClick={() => openEdit(item)}
                  >
                    Configura
                  </button>
                )}
              </div>
            </div>

            {/* Available Models Pills */}
            <div className="cv-unified-row__models-pills">
              <span style={{ fontSize: "0.72rem", color: "#647a6d" }}>Modelli nel pool:</span>
              {item.availableModels.slice(0, 5).map((m) => (
                <span
                  key={m}
                  className={`cv-unified-model-pill ${m === item.defaultModel && item.isActive ? "is-default" : ""}`}
                  title={m === item.defaultModel ? "Modello predefinito di questo provider" : "Disponibile per gli agenti"}
                >
                  {m}
                </span>
              ))}
              {item.availableModels.length > 5 && (
                <span
                  className="cv-unified-model-pill is-more"
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
