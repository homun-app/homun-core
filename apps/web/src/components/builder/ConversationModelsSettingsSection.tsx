/**
 * Settings → Modelli: wire live engine providers (Ollama / OpenAI-compatible).
 * Budget preferences stay in ConversationPreferences; connection lives on the engine.
 */

import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  applyOllamaPreset,
  listModelProviders,
  listOllamaTags,
  listUsageAttempts,
  postModelChat,
  setActiveModelProvider,
  setOpenAICompatibleCredentials,
  verifyModelProvider,
  type ModelProviderInfo,
  type UsageAttemptRow,
} from "@/lib/engine-models-client";
import { ConversationSelect } from "./ConversationSelect";
import type { ConversationPreferences } from "./conversation-preferences";

type Props = {
  draft: ConversationPreferences;
  onChange: <K extends keyof ConversationPreferences>(
    key: K,
    value: ConversationPreferences[K],
  ) => void;
};

export function ConversationModelsSettingsSection(props: Props) {
  return (
    <ConversationModelsConnectionSection onExecution={props.onChange.bind(null, "execution")} />
  );
}

/** Connection to the engine's model providers; the active link rules execution. */
export function ConversationModelsConnectionSection({ onExecution }: {
  onExecution?: (value: ConversationPreferences["execution"]) => void;
}) {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected" && status.capabilities?.features.models;
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [active, setActive] = useState("openai_compatible");
  const [ollamaModel, setOllamaModel] = useState("qwen3.5:4b");
  const [ollamaTags, setOllamaTags] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("https://api.openai.com/v1");
  const [cloudModel, setCloudModel] = useState("gpt-4o-mini");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [provaPrompt, setProvaPrompt] = useState("Ciao, rispondi in una frase.");
  const [provaReply, setProvaReply] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<UsageAttemptRow[]>([]);

  async function refresh() {
    const data = await listModelProviders();
    setProviders(data.items);
    setActive(data.active_provider_id);
    const openai = data.items.find((item) => item.id === "openai_compatible");
    const nextAttempts = await listUsageAttempts(12).catch(() => [] as UsageAttemptRow[]);
    setAttempts(nextAttempts);
    if (openai?.default_model) {
      const model = openai.default_model;
      if (openai.base_url?.includes("11434")) {
        setOllamaModel(model);
      } else {
        setCloudModel(model);
      }
      if (openai.base_url) {
        setCloudBaseUrl(openai.base_url);
      }
    }
    try {
      const tags = await listOllamaTags();
      setOllamaTags(tags);
      if (tags.length && !tags.includes(ollamaModel)) {
        const preferred = tags.find((name) => name.startsWith("qwen")) ?? tags[0]!;
        setOllamaModel(preferred);
      }
    } catch {
      setOllamaTags([]);
    }
  }

  useEffect(() => {
    if (!engineReady) {
      setProviders([]);
      setAttempts([]);
      return;
    }
    void refresh().catch((cause: unknown) => setError(cause));
  }, [engineReady, status.connection]);

  const openai = providers.find((item) => item.id === "openai_compatible");
  const verifiedHint =
    openai?.base_url?.includes("11434")
      ? `Ollama · ${openai.default_model ?? ollamaModel}`
      : openai
        ? `OpenAI-compatible · ${openai.default_model ?? cloudModel}`
        : null;

  return (
    <>
      <h3>Modelli collegati al motore</h3>
      {!engineReady ? (
        <p>
          Avvia il motore (<code>npm run engine:dev</code>) con capability <code>models</code> per
          configurare Ollama o un provider OpenAI-compatible. Le preferenze budget restano locali.
        </p>
      ) : (
        <>
          <p>
            Provider attivo: <code>{active}</code>
            {verifiedHint ? ` · ${verifiedHint}` : ""}. Le richieste chat (Fonte motore) usano
            questo collegamento — non la demo IndexedDB.
          </p>
          <div className="cv-settings-card">
            <strong>Ollama locale (consigliato)</strong>
            <p>
              Richiede <code>ollama serve</code> e un modello scaricato (es.{" "}
              <code>ollama pull llama3.2</code>).
            </p>
            <label>
              Modello Ollama
              {ollamaTags.length > 0 ? (
                <select
                  value={ollamaTags.includes(ollamaModel) ? ollamaModel : ollamaTags[0]}
                  onChange={(event) => setOllamaModel(event.target.value)}
                  aria-label="Modello Ollama"
                >
                  {ollamaTags.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={ollamaModel}
                  onChange={(event) => setOllamaModel(event.target.value)}
                  placeholder="qwen3.5:4b"
                  aria-label="Nome modello Ollama"
                />
              )}
            </label>
            <div className="cv-settings-grid">
              <button
                type="button"
                className="cw-primary"
                disabled={busy || !ollamaModel.trim()}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  setInfo(null);
                  void applyOllamaPreset({ model: ollamaModel.trim() })
                    .then(async (preset) => {
                      onExecution?.("local");
                      setInfo(
                        `Collegato a ${preset.base_url} · modello ${preset.default_model}`,
                      );
                      await refresh();
                    })
                    .catch((cause: unknown) => setError(cause))
                    .finally(() => setBusy(false));
                }}
              >
                Usa Ollama
              </button>
              <button
                type="button"
                className="cw-secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  setInfo(null);
                  void verifyModelProvider("openai_compatible")
                    .then((result) => setInfo(result.message))
                    .catch((cause: unknown) => setError(cause))
                    .finally(() => setBusy(false));
                }}
              >
                Verifica connessione
              </button>
              <button
                type="button"
                className="cw-secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  setInfo(null);
                  void setActiveModelProvider("fake")
                    .then(async () => {
                      setInfo(
                        "Provider fake attivo (solo test rapidi, senza Ollama). Non è il percorso prodotto.",
                      );
                      await refresh();
                    })
                    .catch((cause: unknown) => setError(cause))
                    .finally(() => setBusy(false));
                }}
              >
                Usa fake (test rapido)
              </button>
            </div>
          </div>
          <div className="cv-settings-card">
            <strong>Provider cloud OpenAI-compatible</strong>
            <p>Chiave e base URL salvati sul motore (file locale, non cifrato — D-CRYPTO-01).</p>
            <label>
              API key
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                aria-label="API key"
              />
            </label>
            <label>
              Base URL
              <input
                value={cloudBaseUrl}
                onChange={(event) => setCloudBaseUrl(event.target.value)}
                aria-label="Base URL cloud"
              />
            </label>
            <label>
              Modello
              <input
                value={cloudModel}
                onChange={(event) => setCloudModel(event.target.value)}
                aria-label="Modello cloud"
              />
            </label>
            <button
              type="button"
              className="cw-secondary"
              disabled={busy || !apiKey.trim()}
              onClick={() => {
                setBusy(true);
                setError(null);
                setInfo(null);
                void setOpenAICompatibleCredentials({
                  apiKey: apiKey.trim(),
                  baseUrl: cloudBaseUrl.trim(),
                  defaultModel: cloudModel.trim(),
                })
                  .then(() => setActiveModelProvider("openai_compatible"))
                  .then(async () => {
                    onExecution?.("cloud");
                    setApiKey("");
                    setInfo("Credenziali cloud salvate e provider attivato.");
                    await refresh();
                  })
                  .catch((cause: unknown) => setError(cause))
                  .finally(() => setBusy(false));
              }}
            >
              Salva e attiva cloud
            </button>
          </div>
          <div className="cv-settings-card">
            <strong>Prova chat</strong>
            <p>
              Invia un messaggio al collegamento attivo tramite ModelPort (
              <code>POST /v1/models/chat</code>). Nessun fallback in simulazione.
            </p>
            <label>
              Messaggio di prova
              <textarea
                value={provaPrompt}
                onChange={(event) => setProvaPrompt(event.target.value)}
                rows={3}
                aria-label="Messaggio di prova chat"
              />
            </label>
            <button
              type="button"
              className="cw-primary"
              disabled={busy || !provaPrompt.trim()}
              onClick={() => {
                setBusy(true);
                setError(null);
                setInfo(null);
                setProvaReply(null);
                void postModelChat([{ role: "user", content: provaPrompt.trim() }], {
                  connectionId: active,
                })
                  .then((result) => {
                    setProvaReply(result.text);
                    setInfo(`Risposta da ${result.provider_id} · ${result.model_id}`);
                  })
                  .catch((cause: unknown) => setError(cause))
                  .finally(() => setBusy(false));
              }}
            >
              Invia prova
            </button>
            {provaReply ? (
              <p className="cv-settings-note" role="status">
                {provaReply}
              </p>
            ) : null}
          </div>
          <div className="cv-settings-card">
            <strong>Tentativi modello (UsageAttempt)</strong>
            <p>
              Ledger F3.5: ogni interpret (anche i retry) con command/conversation. Token assenti
              restano sconosciuti — mai inventati come zero.
            </p>
            {!attempts.length ? (
              <p>Nessun tentativo ancora. Invia un messaggio in Fonte=motore.</p>
            ) : (
              <ul className="cv-settings-memory-list">
                {[...attempts].reverse().map((row) => (
                  <li key={row.id}>
                    <span>
                      {row.purpose} · {row.status}
                      {row.attempt_index > 0 ? ` · retry ${row.attempt_index}` : ""} ·{" "}
                      {row.provider_id}
                      {row.command_id ? (
                        <>
                          {" "}
                          · <code>{row.command_id}</code>
                        </>
                      ) : null}
                    </span>
                    <small>
                      tokens:{" "}
                      {row.input_tokens == null && row.output_tokens == null
                        ? "sconosciuti"
                        : `${row.input_tokens ?? "?"} in / ${row.output_tokens ?? "?"} out`}
                    </small>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="cw-secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void listUsageAttempts(12)
                  .then((rows) => setAttempts(rows))
                  .catch((cause: unknown) => setError(cause))
                  .finally(() => setBusy(false));
              }}
            >
              Aggiorna tentativi
            </button>
          </div>
          <HomunErrorNotice error={error} />
          {info ? <p className="cv-settings-note">{info}</p> : null}
        </>
      )}
    </>
  );
}

/** Space-level routing and budget preferences; saved in this browser. */
export function ConversationBudgetSettingsSection({ draft, onChange }: Props) {
  return (
    <>
      <h3>Preferenze di routing e budget</h3>
      <p>
        Preferenze di spazio salvate nel browser. Non sostituiscono il provider attivo sul motore.
      </p>
      <label>
        Scelta del modello
        <ConversationSelect
          label="Scelta del modello"
          value={draft.routing}
          options={[
            { value: "automatic", label: "Automatico · in base al lavoro" },
            { value: "quality", label: "Privilegia la qualità" },
            { value: "fast", label: "Privilegia la velocità" },
          ]}
          onChange={(value) => onChange("routing", value as ConversationPreferences["routing"])}
        />
      </label>
      <label>
        Ambiente preferito
        <ConversationSelect
          label="Ambiente preferito"
          value={draft.execution}
          options={[
            { value: "local", label: "Modello locale (Ollama)" },
            { value: "cloud", label: "Provider cloud OpenAI-compatible" },
          ]}
          onChange={(value) => onChange("execution", value as ConversationPreferences["execution"])}
        />
      </label>
      <div className="cv-settings-grid">
        <label>
          Budget mensile indicativo (€)
          <input
            type="number"
            min="0"
            max="100000"
            value={draft.budget}
            onChange={(event) => onChange("budget", Number(event.target.value))}
          />
        </label>
        <label>
          Limite per lavoro (€)
          <input
            type="number"
            min="0"
            max={draft.budget}
            value={draft.perWorkBudget}
            onChange={(event) => onChange("perWorkBudget", Number(event.target.value))}
          />
        </label>
      </div>
      {draft.perWorkBudget > draft.budget ? (
        <p role="alert">Il limite per lavoro non può superare il budget mensile.</p>
      ) : null}
    </>
  );
}
