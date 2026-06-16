import { useEffect, useState } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { coreBridge } from "../lib/coreBridge";
import type { SetupStatus } from "../lib/coreBridge";

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = "prerequisites" | "llm" | "done";
type LlmChoice = "cloud" | "ollama";

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { t } = useTranslationSafe();
  const [step, setStep] = useState<Step>("prerequisites");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [dockerStarting, setDockerStarting] = useState(false);

  // LLM config
  const [choice, setChoice] = useState<LlmChoice>("cloud");
  const [providerKind, setProviderKind] = useState("openai_compat");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validatedModels, setValidatedModels] = useState(0);

  async function refreshStatus() {
    setLoading(true);
    try {
      const s = await coreBridge.setupStatus();
      setStatus(s);
      // If Docker is installed but not running, try to start it.
      if (s.docker_installed && !s.docker_running && !dockerStarting) {
        setDockerStarting(true);
        // Re-check after a delay (Docker Desktop takes ~30-60s to start).
        setTimeout(() => void refreshStatus(), 10000);
      } else if (s.docker_running) {
        setDockerStarting(false);
      }
    } catch {
      /* gateway not ready yet — will retry */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function validateAndSave() {
    setValidating(true);
    setValidationError(null);
    try {
      const result = await coreBridge.validateLlm(providerKind, baseUrl, apiKey || null);
      if (!result.valid) {
        setValidationError("Validation failed.");
        return;
      }
      setValidatedModels(result.models_count);
      // Save the provider via the existing CRUD endpoint.
      await coreBridge.upsertProvider({
        id: crypto.randomUUID(),
        kind: providerKind,
        label: choice === "cloud" ? "Cloud" : "Ollama Local",
        base_url: baseUrl,
        api_key: apiKey || undefined,
      });
      setStep("done");
    } catch (error) {
      setValidationError((error as Error).message || "Could not validate the provider.");
    } finally {
      setValidating(false);
    }
  }

  async function finish() {
    await coreBridge.completeSetup();
    onComplete();
  }

  // ── Step 1: Prerequisites ──
  if (step === "prerequisites") {
    return (
      <WizardShell title={t("onboarding.title")} eyebrow={t("onboarding.eyebrow")}>
        <Section icon={<Check size={18} />} label={t("onboarding.docker")}>
          {loading ? (
            <p className="onb-hint">
              <Loader2 size={14} className="spin" /> {t("common.loading")}
            </p>
          ) : status?.docker_installed ? (
            status.docker_running ? (
              <p className="onb-ok">
                <Check size={14} /> {t("onboarding.dockerRunning")}
              </p>
            ) : (
              <p className="onb-waiting">
                <Loader2 size={14} className="spin" /> {t("onboarding.dockerStarting")}
              </p>
            )
          ) : (
            <p className="onb-error">
              <X size={14} /> {t("onboarding.dockerMissing")}{" "}
              <a href="https://docker.com" target="_blank" rel="noreferrer">
                docker.com
              </a>
            </p>
          )}
        </Section>

        <div className="onb-actions">
          <button
            type="button"
            className="primary-button"
            disabled={!status?.docker_running}
            onClick={() => setStep("llm")}
          >
            {t("onboarding.continue")} <ChevronRight size={16} />
          </button>
        </div>
      </WizardShell>
    );
  }

  // ── Step 2: LLM Configuration ──
  if (step === "llm") {
    return (
      <WizardShell title={t("onboarding.llmTitle")} eyebrow={t("onboarding.llmEyebrow")}>
        <div className="onb-choices">
          <button
            type="button"
            className={`onb-choice ${choice === "cloud" ? "active" : ""}`}
            onClick={() => {
              setChoice("cloud");
              setProviderKind("openai_compat");
              setBaseUrl("https://api.openai.com/v1");
            }}
          >
            <strong>{t("onboarding.cloudOption")}</strong>
            <small>{t("onboarding.cloudDesc")}</small>
          </button>
          <button
            type="button"
            className={`onb-choice ${choice === "ollama" ? "active" : ""}`}
            onClick={() => {
              setChoice("ollama");
              setProviderKind("ollama");
              setBaseUrl("http://localhost:11434");
            }}
          >
            <strong>{t("onboarding.ollamaOption")}</strong>
            <small>{t("onboarding.ollamaDesc")}</small>
          </button>
        </div>

        <Section label={t("onboarding.baseUrl")}>
          <input
            className="set-input"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </Section>

        {choice === "cloud" && (
          <Section label={t("onboarding.apiKey")}>
            <input
              className="set-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </Section>
        )}

        {validationError && <p className="onb-error">{validationError}</p>}
        {validatedModels > 0 && (
          <p className="onb-ok">
            <Check size={14} /> {t("onboarding.modelsFound", { count: validatedModels })}
          </p>
        )}

        <div className="onb-actions">
          <button type="button" className="secondary-button" onClick={() => setStep("prerequisites")}>
            {t("common.back")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={validating || !baseUrl}
            onClick={() => void validateAndSave()}
          >
            {validating ? (
              <>
                <Loader2 size={16} className="spin" /> {t("onboarding.validating")}
              </>
            ) : (
              t("onboarding.validateAndContinue")
            )}
          </button>
        </div>
      </WizardShell>
    );
  }

  // ── Step 3: Done ──
  return (
    <WizardShell title={t("onboarding.ready")} eyebrow={t("onboarding.readyEyebrow")}>
      <p className="onb-lead">{t("onboarding.readyDesc")}</p>
      <div className="onb-actions">
        <button type="button" className="primary-button" onClick={() => void finish()}>
          {t("onboarding.start")}
        </button>
      </div>
    </WizardShell>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function WizardShell({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <div className="onboarding-body">{children}</div>
      </div>
    </div>
  );
}

function Section({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="onb-section">
      <label className="onb-label">
        {icon} {label}
      </label>
      {children}
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
        if (opts && typeof opts === "object" && "count" in opts) {
          return `${key} (${opts.count})`;
        }
        return key;
      },
      i18n: { language: "en" },
    };
  }
}
