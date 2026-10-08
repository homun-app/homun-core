import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Search, Star, AlertCircle, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@homun/ui/components/popover";
import {
  listModelProviders,
  listOllamaTags,
  type ModelProviderInfo,
} from "@/lib/engine-models-client";
import {
  KNOWN_MODEL_PRESETS,
  findModelPreset,
} from "@/lib/known-model-presets";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./agent-model-selector.css";

export type AgentModelSelectorProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
};

type GroupedProviderModels = {
  providerId: string;
  providerName: string;
  kind: "cloud" | "local";
  defaultModel: string;
  models: string[];
};

function getModelCapabilityTag(model: string, kind: "cloud" | "local"): string {
  if (kind === "local") return "Locale";
  const m = model.toLowerCase();
  if (m.includes("mini") || m.includes("flash") || m.includes("haiku") || m.includes("nano")) return "Veloce";
  if (m.includes("o1") || m.includes("o3") || m.includes("r1") || m.includes("reasoning")) return "Ragionamento";
  if (m.includes("opus") || m.includes("sonnet") || m.includes("gpt-4o") || m.includes("pro")) return "Avanzato";
  return "Standard";
}

export function AgentModelSelector({
  value,
  onChange,
  disabled = false,
  className = "",
  compact = false,
  side = "bottom",
  sideOffset = 5,
}: AgentModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string>("openai_compatible");
  const [ollamaTags, setOllamaTags] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadData() {
      try {
        const [provRes, tagsRes] = await Promise.all([
          listModelProviders().catch(() => null),
          listOllamaTags().catch(() => []),
        ]);
        if (!active) return;
        if (provRes) {
          setProviders(provRes.items);
          setActiveProviderId(provRes.active_provider_id);
        }
        setOllamaTags(tagsRes);
        setLoaded(true);
      } catch {
        if (active) setLoaded(true);
      }
    }
    void loadData();
    return () => {
      active = false;
    };
  }, []);

  // Filter to only active/configured providers (hide fake and unconfigured providers)
  const activeProviders: GroupedProviderModels[] = useMemo(() => {
    const list: GroupedProviderModels[] = [];

    for (const preset of KNOWN_MODEL_PRESETS) {
      const fromEngine = providers.find((p) => p.id === preset.id);
      const isLocal = preset.kind === "local";

      const isActive = isLocal
        ? ollamaTags.length > 0 || Boolean(fromEngine?.configured)
        : Boolean(fromEngine?.credential_present);

      if (!isActive) continue;

      let availModels = [...preset.availableModels];
      let defModel = fromEngine?.default_model || preset.defaultModel;

      if (isLocal && ollamaTags.length > 0) {
        availModels = [...new Set([...ollamaTags, ...preset.availableModels])];
        if (!ollamaTags.includes(defModel)) {
          defModel = ollamaTags[0] ?? defModel;
        }
      }

      list.push({
        providerId: preset.id,
        providerName: preset.name,
        kind: preset.kind,
        defaultModel: defModel,
        models: availModels,
      });
    }

    return list;
  }, [providers, ollamaTags]);

  // Information about the current space default
  const spaceDefaultInfo = useMemo(() => {
    const fromActive = activeProviders.find((p) => p.providerId === activeProviderId);
    const fromPreset = KNOWN_MODEL_PRESETS.find((p) => p.id === activeProviderId);
    const provName = fromActive?.providerName || fromPreset?.name || activeProviderId;
    const modelName = fromActive?.defaultModel || fromPreset?.defaultModel || "predefinito";
    return `${provName} · ${modelName}`;
  }, [activeProviders, activeProviderId]);

  // Determine currently selected display labels
  const currentSelectionLabel = useMemo(() => {
    if (!value || value.trim() === "") {
      return {
        isDefault: true,
        title: "Quello dello spazio (predefinito)",
        subtitle: spaceDefaultInfo,
        providerId: null,
      };
    }

    let provId = value;
    let modId = "";

    if (value.includes(":")) {
      const parts = value.split(":");
      provId = parts[0] ?? "";
      modId = parts.slice(1).join(":");
    } else {
      const foundProv = activeProviders.find((p) => p.providerId === provId);
      modId = foundProv?.defaultModel || value;
    }

    const preset = findModelPreset(provId);
    const provName = preset ? preset.name : provId;

    return {
      isDefault: false,
      title: `${provName} · ${modId}`,
      subtitle: provName,
      modelId: modId,
      providerId: provId,
    };
  }, [value, activeProviders, spaceDefaultInfo]);

  // Filtered providers and models based on search query
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeProviders;

    return activeProviders
      .map((group) => {
        const provMatches = group.providerName.toLowerCase().includes(q) || group.providerId.toLowerCase().includes(q);
        const matchingModels = provMatches
          ? group.models
          : group.models.filter((m) => m.toLowerCase().includes(q));

        if (matchingModels.length === 0) return null;

        return {
          ...group,
          models: matchingModels,
        };
      })
      .filter((g): g is GroupedProviderModels => g !== null);
  }, [activeProviders, search]);

  function isModelSelected(providerId: string, modelName: string): boolean {
    if (!value) return false;
    if (value === `${providerId}:${modelName}`) return true;
    const provider = activeProviders.find((p) => p.providerId === providerId);
    if (value === providerId && provider?.defaultModel === modelName) return true;
    return false;
  }

  function handleSelect(selectedValue: string) {
    onChange(selectedValue);
    setOpen(false);
  }

  return (
    <div className={`cw-agent-model-selector ${compact ? "is-compact" : ""} ${className}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {compact ? (
            <button
              type="button"
              className="cw-agent-model-trigger-compact"
              disabled={disabled || !loaded}
              aria-label="Seleziona modello per il prompt"
              title={`Modello: ${currentSelectionLabel.title}`}
            >
              {currentSelectionLabel.isDefault ? (
                <Star size={13} className="text-amber-500 fill-amber-500/20 flex-shrink-0" />
              ) : (
                <ProviderBrandIcon
                  providerId={currentSelectionLabel.providerId || ""}
                  size={13}
                  className="flex-shrink-0"
                />
              )}
              <span className="truncate max-w-[130px]">
                {currentSelectionLabel.isDefault
                  ? `Spazio (${spaceDefaultInfo.split("·")[0]?.trim() || "Default"})`
                  : (currentSelectionLabel.modelId || currentSelectionLabel.title)}
              </span>
              <ChevronDown size={11} className={`cw-agent-model-chevron ${open ? "rotate-180" : ""}`} />
            </button>
          ) : (
            <button
              type="button"
              className="cw-agent-model-trigger"
              disabled={disabled || !loaded}
              aria-label="Seleziona modello del collaboratore"
            >
              <div className="cw-agent-model-trigger-content">
                {currentSelectionLabel.isDefault ? (
                  <>
                    <Star size={14} className="text-amber-500 fill-amber-500/20 flex-shrink-0" />
                    <span className="cw-agent-model-trigger-title">Quello dello spazio</span>
                    <span className="cw-agent-model-trigger-subtitle">({spaceDefaultInfo})</span>
                  </>
                ) : (
                  <>
                    <ProviderBrandIcon
                      providerId={currentSelectionLabel.providerId || ""}
                      size={15}
                      className="flex-shrink-0"
                    />
                    <span className="cw-agent-model-trigger-title">
                      {currentSelectionLabel.subtitle}
                    </span>
                    <span className="cw-agent-model-trigger-badge">
                      {currentSelectionLabel.modelId}
                    </span>
                  </>
                )}
              </div>
              <ChevronDown size={14} className="cw-agent-model-chevron" />
            </button>
          )}
        </PopoverTrigger>

        <PopoverContent align="start" side={side} sideOffset={sideOffset} className="cw-agent-model-popover">
          {/* Real-time search bar */}
          <div className="cw-agent-model-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="Cerca modello o provider…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {search && (
              <button
                type="button"
                className="cw-modal-close-btn"
                style={{ padding: 2 }}
                onClick={() => setSearch("")}
                aria-label="Cancella ricerca"
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div className="cw-agent-model-list">
            {/* Top option: Space default */}
            {!search && (
              <div className="cw-agent-model-default-option">
                <button
                  type="button"
                  className={`cw-agent-model-item ${!value ? "is-selected" : ""}`}
                  onClick={() => handleSelect("")}
                >
                  <div className="cw-agent-model-item-main">
                    <Star size={14} className="text-amber-500 fill-amber-500/20 flex-shrink-0" />
                    <div>
                      <div className="cw-agent-model-item-name font-medium">
                        Quello dello spazio (predefinito)
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        Attuale: {spaceDefaultInfo}
                      </div>
                    </div>
                  </div>
                  {!value && <Check size={14} className="text-emerald-600 flex-shrink-0" />}
                </button>
              </div>
            )}

            {/* Active providers grouped list */}
            {filteredGroups.length > 0 ? (
              filteredGroups.map((group) => (
                <div key={group.providerId} className="cw-agent-model-group">
                  <div className="cw-agent-model-group-header">
                    <div className="cw-agent-model-group-title">
                      <ProviderBrandIcon providerId={group.providerId} size={14} />
                      <span>{group.providerName}</span>
                    </div>
                    <span className="cw-agent-model-group-count">
                      {group.models.length} {group.models.length === 1 ? "modello" : "modelli"}
                    </span>
                  </div>

                  {group.models.map((model) => {
                    const selected = isModelSelected(group.providerId, model);
                    const isDef = model === group.defaultModel;
                    return (
                      <button
                        key={model}
                        type="button"
                        className={`cw-agent-model-item ${selected ? "is-selected" : ""}`}
                        onClick={() => handleSelect(`${group.providerId}:${model}`)}
                      >
                        <div className="cw-agent-model-item-main">
                          <span className="cw-agent-model-item-name font-mono text-[12px]">
                            {model}
                          </span>
                          {isDef && (
                            <span className="cw-agent-model-item-tag">predefinito</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span className="cw-agent-model-item-tag">
                            {getModelCapabilityTag(model, group.kind)}
                          </span>
                          {selected && (
                            <Check size={14} className="text-emerald-600 flex-shrink-0" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))
            ) : search ? (
              <div className="cw-agent-model-empty">
                Nessun modello trovato per &ldquo;{search}&rdquo;.
              </div>
            ) : null}

            {activeProviders.length === 0 && !search && (
              <div className="cw-agent-model-notice">
                <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                <div>
                  <strong>Nessun provider attivo</strong>
                  <br />
                  Configura una chiave API o avvia Ollama nella sezione Modelli &amp; Connessioni per assegnare modelli dedicati.
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
