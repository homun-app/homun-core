import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import { assertEngineReadyForDomain } from "@/lib/engine-client";

/**
 * One-line product status. Diagnostics stay under developer options.
 */
export function EngineStatusBar() {
  const status = useEngineStatus();
  const connectionLabel =
    status.connection === "connected"
      ? "pronto"
      : status.connection === "checking"
        ? "verifica…"
        : "spento";

  let gateError: unknown = null;
  if (status.dataSource === "engine") {
    try {
      assertEngineReadyForDomain(
        status.dataSource,
        status.connection === "connected",
        status.capabilities,
      );
    } catch (cause) {
      gateError = cause;
    }
  }

  const offlineHint =
    status.connection === "absent" ? "Avvia il motore con npm run engine:dev" : null;

  return (
    <div className="engine-status-bar" role="status" aria-live="polite">
      <div className="engine-status-bar__row">
        <span
          className={`engine-status-bar__dot engine-status-bar__dot--${status.connection}`}
          aria-hidden
        />
        <span>
          Fonte: <strong>{status.dataSource === "engine" ? "motore" : "simulazione"}</strong> ·{" "}
          {connectionLabel}
        </span>
      </div>
      <details className="engine-status-bar__dev">
        <summary>Dettagli tecnici</summary>
        <button type="button" className="engine-status-bar__refresh" onClick={status.refresh}>
          Aggiorna stato
        </button>
        <p className="engine-status-bar__hint">
          {status.health ? `v${status.health.version}` : "—"}
          {status.capabilities
            ? ` · domain=${String(status.capabilities.features.domain)} models=${String(status.capabilities.features.models)}`
            : ""}
          {status.error ? ` · ${status.error}` : ""}
        </p>
        <label className="engine-status-bar__source">
          Fonte dati
          <select
            value={status.dataSource}
            onChange={(event) => {
              const value = event.target.value;
              status.setDataSource(value === "simulation" ? "simulation" : "engine");
            }}
          >
            <option value="engine">motore</option>
            <option value="simulation">simulazione (deprecata)</option>
          </select>
        </label>
        {offlineHint && status.dataSource === "engine" ? (
          <p className="engine-status-bar__hint">{offlineHint}</p>
        ) : null}
      </details>
      <HomunErrorNotice error={gateError} className="engine-status-bar__error" />
    </div>
  );
}
