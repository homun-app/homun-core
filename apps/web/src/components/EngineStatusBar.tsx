import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import { assertEngineReadyForDomain } from "@/lib/engine-client";

/**
 * Minimal production status: connection only, no source selector.
 * The engine is the only data source; diagnostics stay under developer options.
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
    status.connection === "absent" ? "Connessione non disponibile" : null;

  return (
    <div className="engine-status-bar" role="status" aria-live="polite">
      <div className="engine-status-bar__row">
        <span
          className={`engine-status-bar__dot engine-status-bar__dot--${status.connection}`}
          aria-hidden
        />
        <span>{connectionLabel}</span>
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
      </details>
      <HomunErrorNotice error={gateError} className="engine-status-bar__error" />
    </div>
  );
}
