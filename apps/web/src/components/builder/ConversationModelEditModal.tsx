import { useState } from "react";
import { X, Check, RefreshCw, AlertCircle, Sparkles } from "lucide-react";
import {
  applyOllamaPreset,
  setOpenAICompatibleCredentials,
  verifyModelProvider,
} from "@/lib/engine-models-client";

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
      <div className="cv-unified-modal" role="dialog" aria-modal="true">
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
