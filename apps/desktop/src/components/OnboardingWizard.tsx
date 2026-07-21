import { useEffect, useRef, useState } from "react";
import { Check, Loader2, X, ArrowRight, Download, ExternalLink } from "lucide-react";
import { coreBridge } from "../lib/coreBridge";
import type { PullProgress, SetupStatus } from "../lib/coreBridge";
import { getSystemSpecs } from "../lib/gatewayConfig";
import { ProviderLogo, providerLogoKey } from "./providerLogos";
import {
  isLocalOllamaProvider,
  notifyRuntimeModelsChanged,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../lib/providerPresets";
import homunWordmark from "../assets/homun-wordmark-dark.svg";
import modelsCatalog from "../assets/models-catalog.json";

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = "prereq" | "model" | "done";

// Local model recommendations come from a catalog we scrape from ollama.com at
// BUILD time (scripts/refresh-models-catalog.mjs) — tools-capable models ranked
// by recency-decayed popularity, factual data only. We surface the top-ranked
// model per tier and let the detected RAM recommend + gate them. FALLBACK_MODELS
// covers an empty/unparseable catalog so onboarding never shows zero options.
type TierKey = "light" | "balanced" | "powerful";
type CatalogModel = {
  model: string;
  name: string;
  params: number;
  sizeGb: number;
  minRamGb: number;
  tier: TierKey;
  vision: boolean;
  thinking: boolean;
  score?: number;
};
type UiModel = {
  model: string;
  title: string;
  size: string;
  minRamGb: number;
  tierKey: TierKey;
  vision: boolean;
  thinking: boolean;
};

const TIER_ORDER: readonly TierKey[] = ["light", "balanced", "powerful"];

const FALLBACK_MODELS: UiModel[] = [
  { model: "qwen3:4b", title: "Qwen3 4B", size: "~2.5 GB", minRamGb: 4, tierKey: "light", vision: false, thinking: true },
  { model: "qwen3:8b", title: "Qwen3 8B", size: "~5 GB", minRamGb: 10, tierKey: "balanced", vision: false, thinking: true },
  { model: "gemma4:12b", title: "Gemma 4 12B", size: "~7.4 GB", minRamGb: 12, tierKey: "powerful", vision: true, thinking: true },
];

const MODELS: UiModel[] = (() => {
  const catalog = ((modelsCatalog as { models?: CatalogModel[] }).models ?? []);
  // Within a tier the variants share a score (same model, different sizes), so
  // break ties by params descending — pick the strongest size that still belongs
  // to the tier (e.g. light → qwen3.5:4b, not the near-useless :0.8b).
  const bestInTier = (tier: TierKey) =>
    catalog
      .filter((m) => m.tier === tier)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.params - a.params)[0];
  const picks = TIER_ORDER.map(bestInTier)
    .filter((m): m is CatalogModel => !!m)
    .map<UiModel>((m) => ({
      model: m.model,
      title: m.name,
      size: `~${m.sizeGb} GB`,
      minRamGb: m.minRamGb,
      tierKey: m.tier,
      vision: m.vision,
      thinking: m.thinking,
    }));
  return picks.length === TIER_ORDER.length ? picks : FALLBACK_MODELS;
})();

// Cloud providers come from the shared catalog (../lib/providerPresets), the same
// source Settings → Model & Runtime uses, so the two stay aligned. We drop the
// local Ollama preset (the main onboarding flow already covers local models);
// "Custom" renders last as the "More" tile.
const CLOUD_PROVIDERS: ProviderPreset[] = PROVIDER_PRESETS.filter((p) => p.id !== "ollama");

const DOCKER_URL = "https://www.docker.com/products/docker-desktop/";
const OLLAMA_URL = "https://ollama.com/download";

// Recommend the most capable model whose RAM floor the machine clears (MODELS is
// ordered light → balanced → powerful), so a roomy machine is steered to the best.
function recommendIndex(ramGb: number | null): number {
  if (ramGb == null) return Math.min(1, MODELS.length - 1);
  for (let i = MODELS.length - 1; i >= 0; i--) {
    if (ramGb >= MODELS[i].minRamGb) return i;
  }
  return 0;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { t } = useTranslationSafe();
  const [step, setStep] = useState<Step>("prereq");

  // Prerequisites (polled so a manual install is auto-detected → marked done).
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);

  // System specs + model choice
  const [ramGb, setRamGb] = useState<number | null>(null);
  const [cpus, setCpus] = useState<number | null>(null);
  const [modelIdx, setModelIdx] = useState(1);

  // Download
  const [pulling, setPulling] = useState(false);
  const [pullPercent, setPullPercent] = useState(0);
  const [pullStatus, setPullStatus] = useState("");
  const [pullError, setPullError] = useState<string | null>(null);

  // Provider slide-over
  const [panel, setPanel] = useState<ProviderPreset | null>(null);

  const dockerOk = !!setup?.docker_running;
  const ollamaOk = ollamaUp === true;
  const selected = MODELS[modelIdx];
  const activeDot = step === "prereq" ? 0 : step === "model" ? (panel ? 2 : 1) : 3;


  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const [s, o] = await Promise.all([
          coreBridge.setupStatus().catch(() => null),
          coreBridge.ollamaSetup().catch(() => null),
        ]);
        if (cancelled) return;
        if (s) setSetup(s);
        if (o) setOllamaUp(o.running);
      } catch {
        /* gateway not ready yet */
      }
    }
    void probe();
    if (step === "prereq") {
      pollRef.current = window.setInterval(() => void probe(), 4000);
    }
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [step]);

  // Detect machine specs once and pre-select the recommended model.
  useEffect(() => {
    void (async () => {
      const specs = await getSystemSpecs();
      if (specs) {
        setRamGb(specs.totalMemGb);
        setCpus(specs.cpuCount);
        setModelIdx(recommendIndex(specs.totalMemGb));
      }
    })();
  }, []);

  async function downloadAndStart() {
    setPulling(true);
    setPullError(null);
    setPullPercent(0);
    setPullStatus(t("onboarding.preparing"));
    try {
      await coreBridge.pullModel(selected.model, (p: PullProgress) => {
        setPullStatus(p.status);
        if (p.total && p.completed) setPullPercent(Math.min(100, Math.round((p.completed / p.total) * 100)));
      });
      // Register Ollama with the model we just pulled as its active_model — the
      // active provider's active_model is what the gateway resolves as the global
      // default model, so the user lands on Gemma straight away. Then refresh the
      // provider's model list so Settings shows all local models without a manual
      // Refresh.
      const providerId = "ollama";
      await coreBridge.upsertProvider({
        id: providerId,
        kind: "ollama",
        label: "Ollama Local",
        base_url: "http://127.0.0.1:11434",
        active_model: selected.model,
      });
      await coreBridge.refreshProviderModels(providerId).catch(() => undefined);
      notifyRuntimeModelsChanged();
      setStep("done");
    } catch (error) {
      setPullError((error as Error).message || t("onboarding.pullFailed"));
    } finally {
      setPulling(false);
    }
  }

  async function finish() {
    await coreBridge.completeSetup();
    onComplete();
  }
  async function skip() {
    await coreBridge.completeSetup().catch(() => undefined);
    onComplete();
  }

  return (
    <div className="onb-overlay">
      {/* Our own window-drag region (Shell's is hidden during onboarding). Kept
          to the top-center so it never overlaps the traffic lights (left), the
          brand mark, or the provider slide-over's close button (right). */}
      <div className="onb-drag-strip" aria-hidden="true" />
      <img className="onb-brand" src={homunWordmark} alt="Homun" />

      <div className="onb-stage">
        <div className="onb-dots" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`onb-dot ${i === activeDot ? "active" : ""}`} />
          ))}
        </div>

        {step === "prereq" && (
          <div className="onb-screen">
            <h1 className="onb-title">{t("onboarding.prereqTitle")}</h1>
            <p className="onb-subtitle">{t("onboarding.prereqSubtitle")}</p>

            <div className="onb-checks">
              <PrereqRow
                name="Docker"
                desc={t("onboarding.dockerDesc")}
                state={setup == null ? "checking" : dockerOk ? "ok" : "missing"}
                installUrl={DOCKER_URL}
                t={t}
              />
              <PrereqRow
                name="Ollama"
                desc={t("onboarding.ollamaDesc")}
                state={ollamaUp == null ? "checking" : ollamaOk ? "ok" : "missing"}
                installUrl={OLLAMA_URL}
                t={t}
              />
            </div>

            <button
              type="button"
              className="onb-primary"
              disabled={!dockerOk || !ollamaOk}
              onClick={() => setStep("model")}
            >
              {dockerOk && ollamaOk ? t("onboarding.continue") : t("onboarding.waitingPrereq")}
              {dockerOk && ollamaOk && <ArrowRight size={16} />}
            </button>
          </div>
        )}

        {step === "model" && (
          <div className="onb-screen">
            <button type="button" className="onb-back" onClick={() => setStep("prereq")}>
              <ArrowRight size={14} style={{ transform: "rotate(180deg)" }} /> {t("common.back")}
            </button>
            <h1 className="onb-title">{t("onboarding.modelTitle")}</h1>
            <p className="onb-subtitle">
              {ramGb != null
                ? t("onboarding.specsLine", { ram: ramGb, cpus: cpus ?? "?" })
                : t("onboarding.modelSubtitle")}
            </p>

            <div className="onb-models">
              {MODELS.map((m, i) => {
                const fits = ramGb == null || ramGb >= m.minRamGb;
                const recommended = i === recommendIndex(ramGb);
                return (
                  <button
                    key={m.model}
                    type="button"
                    className={`onb-model ${i === modelIdx ? "active" : ""} ${fits ? "" : "tight"}`}
                    onClick={() => setModelIdx(i)}
                    disabled={pulling}
                  >
                    <span className="onb-model-top">
                      <strong>{m.title}</strong>
                      <span className="onb-model-size">{m.size}</span>
                    </span>
                    <span className="onb-model-meta">
                      {t(`onboarding.tier.${m.tierKey}`)}
                      {m.vision && <span className="onb-cap">{t("onboarding.cap.vision")}</span>}
                      {m.thinking && <span className="onb-cap">{t("onboarding.cap.thinking")}</span>}
                      {recommended && <span className="onb-rec">{t("onboarding.recommended")}</span>}
                      {!fits && <span className="onb-tight-tag">{t("onboarding.needsRam", { gb: m.minRamGb })}</span>}
                    </span>
                  </button>
                );
              })}
            </div>

            {pulling ? (
              <div className="onb-progress">
                <div className="onb-progress-bar">
                  <div className="onb-progress-fill" style={{ width: `${pullPercent}%` }} />
                </div>
                <p className="onb-progress-label">
                  <Loader2 size={13} className="spin" /> {pullStatus}
                  {pullPercent > 0 ? ` · ${pullPercent}%` : ""}
                </p>
              </div>
            ) : (
              <button type="button" className="onb-primary" onClick={() => void downloadAndStart()}>
                <Download size={15} /> {t("onboarding.downloadStart")}
              </button>
            )}
            {pullError && (
              <p className="onb-error">
                <X size={13} /> {pullError}
              </p>
            )}

            <div className="onb-or">{t("onboarding.orConnect")}</div>
            <div className="onb-provider-grid">
              {CLOUD_PROVIDERS.map((p) => (
                <button key={p.id} type="button" className="onb-provider" onClick={() => setPanel(p)}>
                  <ProviderLogo logoKey={providerLogoKey(p.id)} size={22} />
                  {p.id === "custom" ? t("onboarding.more") : p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="onb-screen onb-screen-center">
            <div className="onb-done-icon">
              <Check size={26} />
            </div>
            <h1 className="onb-title">{t("onboarding.ready")}</h1>
            <p className="onb-subtitle">{t("onboarding.readyDesc")}</p>
            <button type="button" className="onb-primary onb-done-btn" onClick={() => void finish()}>
              {t("onboarding.start")} <ArrowRight size={16} />
            </button>
          </div>
        )}

        <div className="onb-footer">
          <div className="onb-footer-links">
            <a href="https://homun.app" target="_blank" rel="noreferrer">
              {t("onboarding.site")}
            </a>
            <span>·</span>
            <a href="https://homun.app/docs/" target="_blank" rel="noreferrer">
              {t("onboarding.docs")}
            </a>
          </div>
          {step !== "done" && (
            <button type="button" className="onb-skip" onClick={() => void skip()}>
              {t("onboarding.skip")} →
            </button>
          )}
        </div>
      </div>

      {panel && <ProviderSlideOver preset={panel} onClose={() => setPanel(null)} onSaved={() => setStep("done")} />}
    </div>
  );
}

function PrereqRow({
  name,
  desc,
  state,
  installUrl,
  t,
}: {
  name: string;
  desc: string;
  state: "checking" | "ok" | "missing";
  installUrl: string;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const logoKey = providerLogoKey(name.toLowerCase());
  return (
    <div className={`onb-check ${state}`}>
      <span className="onb-check-logo">
        <ProviderLogo logoKey={logoKey} size={22} />
      </span>
      <span className="onb-check-text">
        <strong>{name}</strong>
        <small>{desc}</small>
      </span>
      {state === "checking" && <Loader2 size={16} className="spin onb-check-icon" />}
      {state === "ok" && (
        <span className="onb-check-ok">
          <Check size={15} /> {t("onboarding.detected")}
        </span>
      )}
      {state === "missing" && (
        <a className="onb-check-install" href={installUrl} target="_blank" rel="noreferrer">
          {t("onboarding.install")} <ExternalLink size={13} />
        </a>
      )}
    </div>
  );
}

function ProviderSlideOver({
  preset,
  onClose,
  onSaved,
}: {
  preset: ProviderPreset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslationSafe();
  const isCustom = preset.id === "custom";
  const [label, setLabel] = useState<string>(isCustom ? "" : preset.label);
  const [kind, setKind] = useState<string>(preset.kind);
  const [baseUrl, setBaseUrl] = useState<string>(preset.baseUrl || "https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState(0);
  const localOllama = isLocalOllamaProvider(kind, baseUrl);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await coreBridge.validateLlm(kind, baseUrl, localOllama ? null : apiKey || null);
      if (!result.valid) {
        setError(t("onboarding.validationFailed"));
        return;
      }
      setModels(result.models_count);
      const providerId = isCustom ? crypto.randomUUID() : preset.id;
      await coreBridge.upsertProvider({
        id: providerId,
        kind,
        label: label || preset.label || "Provider",
        base_url: baseUrl,
        api_key: localOllama ? undefined : apiKey || undefined,
      });
      await coreBridge.refreshProviderModels(providerId);
      notifyRuntimeModelsChanged();
      onSaved();
    } catch (e) {
      setError((e as Error).message || t("onboarding.validationFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onb-slideover-scrim" onClick={onClose}>
      <aside className="onb-slideover" onClick={(e) => e.stopPropagation()}>
        <header className="onb-slideover-head">
          <h2>
            <ProviderLogo logoKey={providerLogoKey(preset.id)} size={20} />
            {isCustom ? t("onboarding.newProvider") : preset.label}
          </h2>
          <button type="button" className="onb-slideover-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="onb-slideover-body">
          <label className="onb-field">
            <span>{t("onboarding.baseUrl")}</span>
            <input className="set-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          {localOllama ? (
            <p className="onb-slideover-hint">{t("onboarding.localOllamaNoKey")}</p>
          ) : (
            <label className="onb-field">
              <span>{t("onboarding.apiKey")}</span>
              <input
                className="set-input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </label>
          )}
          {isCustom && (
            <label className="onb-field">
              <span>{t("onboarding.providerKind")}</span>
              <select className="set-input" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="openai_compat">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
          )}
          {!localOllama && (
            <p className="onb-slideover-hint">{preset.hint ?? t("onboarding.providerHint")}</p>
          )}
          {models > 0 && (
            <p className="onb-ok">
              <Check size={13} /> {t("onboarding.modelsFound", { count: models })}
            </p>
          )}
          {error && (
            <p className="onb-error">
              <X size={13} /> {error}
            </p>
          )}
        </div>
        <footer className="onb-slideover-foot">
          <input
            className="set-input onb-name-input"
            placeholder={t("onboarding.uniqueName")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button type="button" className="onb-primary onb-save-btn" disabled={busy || !baseUrl} onClick={() => void save()}>
            {busy ? <Loader2 size={15} className="spin" /> : t("common.save")}
          </button>
        </footer>
      </aside>
    </div>
  );
}

// Safe useTranslation that doesn't crash if i18n isn't ready yet (first launch).
import { useTranslation } from "react-i18next";
function useTranslationSafe() {
  try {
    return useTranslation();
  } catch {
    return {
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && typeof opts === "object" && "count" in opts) return `${key} (${opts.count})`;
        return key;
      },
      i18n: { language: "en" },
    };
  }
}
