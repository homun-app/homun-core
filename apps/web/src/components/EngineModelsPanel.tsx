/**
 * Thin F3.1 panel: list providers, verify fake, optional OpenAI-compatible credentials.
 */

import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  applyOllamaPreset,
  completeWithModel,
  listModelProviders,
  setOpenAICompatibleCredentials,
  verifyModelProvider,
  type ModelProviderInfo,
} from "@/lib/engine-models-client";

export function EngineModelsPanel() {
  const status = useEngineStatus();
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [active, setActive] = useState<string>("fake");
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [busy, setBusy] = useState(false);

  const modelsReady = status.connection === "connected" && status.capabilities?.features.models;

  async function refresh() {
    const data = await listModelProviders();
    setProviders(data.items);
    setActive(data.active_provider_id);
  }

  useEffect(() => {
    if (!modelsReady) {
      setProviders([]);
      return;
    }
    void refresh().catch((cause: unknown) => setError(cause));
  }, [modelsReady, status.connection]);

  if (status.dataSource !== "engine") {
    return null;
  }

  return (
    <section className="engine-domain-panel" aria-label="Modelli motore">
      <h2 className="engine-domain-panel__title">Modelli (F3.1–F3.2)</h2>
      {!modelsReady ? (
        <p className="engine-domain-panel__hint">
          Avvia il motore con capability `models` per verificare provider e credenziali.
        </p>
      ) : (
        <>
          <p className="engine-domain-panel__hint">
            Attivo: <code>{active}</code>. Default prodotto = Ollama locale. Fake solo per test/CI.
            Secret file non cifrati (D-CRYPTO-01).
          </p>
          <ul>
            {providers.map((provider) => (
              <li key={provider.id}>
                {provider.display_name} · credenziale=
                {provider.credential_present ? "sì" : "no"}
                {provider.default_model ? ` · ${provider.default_model}` : ""}
              </li>
            ))}
          </ul>
          <div className="engine-domain-panel__form">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                setInfo(null);
                void applyOllamaPreset({ model: "qwen3.5:4b" })
                  .then(async (preset) => {
                    setInfo(
                      `Ollama preset: ${preset.base_url} · ${preset.default_model} (attivo ${preset.active_provider_id})`,
                    );
                    setBaseUrl(preset.base_url);
                    await refresh();
                  })
                  .catch((cause: unknown) => setError(cause))
                  .finally(() => setBusy(false));
              }}
            >
              Usa Ollama locale
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                setInfo(null);
                void verifyModelProvider("fake")
                  .then((result) => setInfo(result.message))
                  .catch((cause: unknown) => setError(cause))
                  .finally(() => setBusy(false));
              }}
            >
              Verifica fake
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                setInfo(null);
                void completeWithModel([{ role: "user", content: "Prepara il catalogo" }], {
                  providerId: "fake",
                })
                  .then((result) => setInfo(result.text))
                  .catch((cause: unknown) => setError(cause))
                  .finally(() => setBusy(false));
              }}
            >
              Complete fake
            </button>
          </div>
          <form
            className="engine-domain-panel__form"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              setInfo(null);
              void setOpenAICompatibleCredentials({ apiKey, baseUrl })
                .then(async () => {
                  setInfo("Credenziale salvata sul motore (file locale).");
                  setApiKey("");
                  await refresh();
                })
                .catch((cause: unknown) => setError(cause))
                .finally(() => setBusy(false));
            }}
          >
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="API key OpenAI-compatible"
              aria-label="API key"
            />
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              aria-label="Base URL"
            />
            <button type="submit" disabled={busy || !apiKey.trim()}>
              Salva credenziale
            </button>
          </form>
          <HomunErrorNotice error={error} className="engine-domain-panel__error" />
          {info ? <p className="engine-domain-panel__message">{info}</p> : null}
        </>
      )}
    </section>
  );
}
