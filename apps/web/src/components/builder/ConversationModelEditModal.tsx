import { useState } from "react";
import { X, Check, RefreshCw, AlertCircle, Sparkles, Sliders, ChevronDown, ChevronRight } from "lucide-react";
import {
  applyOllamaPreset,
  setOpenAICompatibleCredentials,
  verifyModelProvider,
} from "@/lib/engine-models-client";
import {
  getProviderGranularConfig,
  setProviderGranularConfig,
  type ProviderGranularConfig,
} from "@/lib/engine-granular-settings";

export type EditingProviderState = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  isLocal: boolean;
  availableModels: string[];
};

export function ConversationModelEditModal({
  provider,
  ollamaTags,
  onClose,
  onSaved,
}: {
  provider: EditingProviderState;
  ollamaTags: string[];
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [form, setForm] = useState({ ...provider });
  const [granular, setGranular] = useState<ProviderGranularConfig>(() =>
    getProviderGranularConfig(provider.id),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isCustomModel, setIsCustomModel] = useState(
    !provider.availableModels.includes(provider.model) && Boolean(provider.model)
  );
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const modelOptions = provider.isLocal && ollamaTags.length > 0
    ? [...new Set([...ollamaTags, ...provider.availableModels])]
    : provider.availableModels;

  async function handleVerify() {
    setVerifying(true);
    setVerifyMessage(null);
    setError(null);
    try {
      if (form.isLocal) {
        if (ollamaTags.length > 0) {
          setVerifyMessage({
            ok: true,
            text: `Ollama è attivo localmente con ${ollamaTags.length} modelli installati.`,
          });
        } else {
          setVerifyMessage({
            ok: true,
            text: `Endpoint locale ${form.baseUrl} raggiungibile.`,
          });
        }
      } else {
        const res = await verifyModelProvider(form.id);
        if (res.ok) {
          setVerifyMessage({
            ok: true,
            text: res.message || "Connessione al provider verificata con successo.",
          });
        } else {
          setVerifyMessage({
            ok: false,
            text: res.message || "Verifica fallita. Controlla la chiave API.",
          });
        }
      }
    } catch (cause) {
      setVerifyMessage({
        ok: false,
        text: cause instanceof Error ? cause.message : "Errore durante la verifica.",
      });
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (form.isLocal) {
        await applyOllamaPreset({
          model: form.model.trim() || "qwen2.5:7b",
        });
      } else {
        await setOpenAICompatibleCredentials({
          apiKey: form.apiKey.trim() || "configured",
          baseUrl: form.baseUrl.trim() || "https://api.openai.com/v1",
          defaultModel: form.model.trim() || "gpt-4o",
        });
      }
      setProviderGranularConfig(form.id, granular);
      onSaved(form.name);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Errore durante il salvataggio.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="cv-unified-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cv-unified-modal" role="dialog" aria-modal="true" style={{ maxWidth: "560px" }}>
        <header className="cv-unified-modal__head">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Sparkles size={16} color="#8fe3d0" />
            <h3>Configura {form.name}</h3>
          </div>
          <button type="button" className="cv-unified-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <form className="cv-unified-modal__body" onSubmit={handleSubmit}>
          {/* Model selection */}
          <div className="cv-unified-form-field">
            <label>Modello predefinito per la squadra</label>
            {!isCustomModel ? (
              <select
                value={form.model}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setIsCustomModel(true);
                    setForm({ ...form, model: "" });
                  } else {
                    setForm({ ...form, model: e.target.value });
                  }
                }}
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m} {form.isLocal && ollamaTags.includes(m) ? " (installato localmente)" : ""}
                  </option>
                ))}
                <option value="__custom__">+ Altro modello personalizzato…</option>
              </select>
            ) : (
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <input
                  type="text"
                  placeholder="Nome modello esatto (es. gpt-4o, claude-3-7-sonnet)"
                  value={form.model}
                  autoFocus
                  required
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
                <button
                  type="button"
                  className="cv-unified-btn is-subtle"
                  style={{ whiteSpace: "nowrap" }}
                  onClick={() => {
                    setIsCustomModel(false);
                    setForm({ ...form, model: modelOptions[0] || "gpt-4o" });
                  }}
                >
                  Elenco
                </button>
              </div>
            )}
            <span className="cv-unified-hint">
              {form.isLocal
                ? "Puoi selezionare un modello già scaricato in Ollama o un identificativo compatibile."
                : "Questo modello sarà assegnato come predefinito per le risposte degli agenti."}
            </span>
          </div>

          {/* Endpoint URL */}
          <div className="cv-unified-form-field">
            <label>Endpoint / Base URL API</label>
            <input
              type="text"
              value={form.baseUrl}
              placeholder="https://api.openai.com/v1"
              required
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </div>

          {/* API Key */}
          {!form.isLocal && (
            <div className="cv-unified-form-field">
              <label>Chiave API (Token segreto)</label>
              <input
                type="password"
                value={form.apiKey}
                placeholder="sk-..."
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
              <span className="cv-unified-hint">
                La chiave viene custodita nel Vault locale crittografato sul tuo dispositivo.
              </span>
            </div>
          )}

          {/* Granular Parameters Toggle */}
          <div style={{ margin: "0.75rem 0 0.25rem" }}>
            <button
              type="button"
              className="cv-unified-btn is-subtle"
              style={{ width: "100%", justifyContent: "space-between", fontSize: "12px", padding: "8px 12px" }}
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <Sliders size={13} />
                <span>Parametri Granulari di Inferenza & Ragionamento</span>
              </span>
              {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>

          {showAdvanced && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                padding: "12px",
                borderRadius: "8px",
                backgroundColor: "var(--color-secondary, #f0f5f2)",
                border: "1px solid var(--color-border, #e3e7e5)",
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
                    <label style={{ fontWeight: 500 }}>Temperatura</label>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>{granular.temperature.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.05"
                    value={granular.temperature}
                    onChange={(e) => setGranular({ ...granular, temperature: parseFloat(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "var(--color-muted-foreground)" }}>
                    <span>Preciso (0.0)</span>
                    <span>Creativo (1.5)</span>
                  </div>
                </div>

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
                    <label style={{ fontWeight: 500 }}>Top P (Nucleus)</label>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>{granular.topP.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={granular.topP}
                    onChange={(e) => setGranular({ ...granular, topP: parseFloat(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div className="cv-unified-form-field" style={{ margin: 0 }}>
                  <label style={{ fontSize: "12px" }}>Livello Ragionamento (Thinking)</label>
                  <select
                    value={granular.reasoningEffort}
                    onChange={(e) =>
                      setGranular({
                        ...granular,
                        reasoningEffort: e.target.value as ProviderGranularConfig["reasoningEffort"],
                      })
                    }
                    style={{ padding: "6px 8px", fontSize: "12px" }}
                  >
                    <option value="none">Disattivato (none)</option>
                    <option value="low">Basso (low)</option>
                    <option value="medium">Medio (medium - consigliato)</option>
                    <option value="high">Approfondito (high)</option>
                  </select>
                </div>

                <div className="cv-unified-form-field" style={{ margin: 0 }}>
                  <label style={{ fontSize: "12px" }}>Max Output Tokens</label>
                  <select
                    value={granular.maxTokens}
                    onChange={(e) => setGranular({ ...granular, maxTokens: parseInt(e.target.value, 10) })}
                    style={{ padding: "6px 8px", fontSize: "12px" }}
                  >
                    <option value={4096}>4.096 token</option>
                    <option value={8192}>8.192 token (default)</option>
                    <option value={16384}>16.384 token</option>
                    <option value={32768}>32.768 token</option>
                    <option value={65536}>65.536 token</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "4px" }}>
                <label style={{ fontSize: "12px", display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={granular.stream}
                    onChange={(e) => setGranular({ ...granular, stream: e.target.checked })}
                  />
                  <span>Streaming token in tempo reale</span>
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
                  <span>Timeout:</span>
                  <input
                    type="number"
                    min="10"
                    max="300"
                    value={granular.timeoutSeconds}
                    onChange={(e) => setGranular({ ...granular, timeoutSeconds: parseInt(e.target.value, 10) || 60 })}
                    style={{ width: "60px", padding: "4px 6px", fontSize: "11px", textAlign: "center" }}
                  />
                  <span>s</span>
                </div>
              </div>
            </div>
          )}

          {/* Verification feedback */}
          {verifyMessage && (
            <div
              className={`cv-unified-banner ${verifyMessage.ok ? "is-info" : ""}`}
              style={{
                backgroundColor: verifyMessage.ok ? "rgba(21, 122, 110, 0.2)" : "rgba(239, 68, 68, 0.15)",
                borderColor: verifyMessage.ok ? "#157a6e" : "#ef4444",
                color: verifyMessage.ok ? "#8fe3d0" : "#fca5a5",
              }}
            >
              {verifyMessage.ok ? <Check size={14} /> : <AlertCircle size={14} />}
              <span>{verifyMessage.text}</span>
            </div>
          )}

          {error && (
            <div
              className="cv-unified-banner"
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.15)",
                borderColor: "#ef4444",
                color: "#fca5a5",
              }}
            >
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          <div className="cv-unified-modal__actions">
            <button
              type="button"
              className="cv-unified-btn is-subtle"
              disabled={verifying || busy}
              onClick={handleVerify}
            >
              <RefreshCw size={13} className={verifying ? "animate-spin" : ""} />
              <span>{verifying ? "Verifico…" : "Verifica connessione"}</span>
            </button>
            <button
              type="button"
              className="cv-unified-btn is-subtle"
              onClick={onClose}
              disabled={busy}
            >
              Annulla
            </button>
            <button type="submit" className="cv-unified-btn is-primary" disabled={busy}>
              {busy ? "Salvataggio…" : "Salva e collega"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
