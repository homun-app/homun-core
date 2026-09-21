/**
 * Short engine banner inside the workspace — product language, not debug dump.
 */

import type { EngineFollowupNotice } from "@/lib/engine-domain-client";
import { homunErrorFromHttp } from "@/lib/homun-errors";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";

type Props = {
  backend: "simulation" | "engine";
  dataSourceSelected: "simulation" | "engine";
  gateError: unknown;
  error: unknown;
  busy: boolean;
  workCount: number;
  followups: Array<EngineFollowupNotice & { conversationTitle: string }>;
  onRefresh: () => void;
};

export function ConversationEngineBanner({
  backend,
  dataSourceSelected,
  gateError,
  error,
  busy,
  workCount,
  followups,
  onRefresh,
}: Props) {
  if (dataSourceSelected !== "engine") {
    return null;
  }

  const ready = backend === "engine" && !gateError;
  const hasNotice = !ready || Boolean(error) || followups.length > 0;

  return (
    <section
      className={`cw-engine-banner${hasNotice ? "" : " cw-engine-banner--quiet"}`}
      aria-label="Stato lavori"
    >
      <details className="cw-engine-banner__details">
        <summary>{ready ? "Dettagli lavori" : "Connessione non disponibile"}</summary>
        <div className="cw-engine-banner__row">
          <strong>{ready ? "I tuoi lavori" : "Connessione non disponibile"}</strong>
          <span>
            {ready
              ? workCount === 0
                ? "Nessun lavoro ancora — scrivi sotto per crearne uno"
                : `${workCount} lavor${workCount === 1 ? "o" : "i"}`
              : "Controlla che l'app sia avviata correttamente"}
          </span>
          <button
            type="button"
            className="cw-secondary"
            disabled={busy || Boolean(gateError)}
            onClick={onRefresh}
          >
            Aggiorna
          </button>
        </div>
      </details>
      {!ready && (
        <p role="status">La connessione non è disponibile: il lavoro riprenderà quando sarà di nuovo accessibile.</p>
      )}
      {followups.map((notice) => (
        <div key={notice.commandId} className="cw-engine-banner__error">
          {notice.status === "failed" ? (
            <>
              <p>
                {notice.conversationTitle}: risposta non completata dopo {notice.attempts} tentativ
                {notice.attempts === 1 ? "o" : "i"}. Il recupero automatico è terminato.
              </p>
              <HomunErrorNotice
                error={homunErrorFromHttp(
                  0,
                  {
                    detail: {
                      code: notice.errorCode,
                      message: "La risposta non può essere recuperata automaticamente.",
                    },
                  },
                  "Risposta non completata.",
                )}
              />
            </>
          ) : (
            <p role="status">
              {notice.conversationTitle}:{" "}
              {notice.status === "retry_scheduled"
                ? "risposta interrotta; un nuovo tentativo è programmato."
                : "risposta in elaborazione o in attesa di recupero."}
            </p>
          )}
        </div>
      ))}
      <HomunErrorNotice error={gateError} className="cw-engine-banner__error" />
      <HomunErrorNotice error={error} className="cw-engine-banner__error" />
    </section>
  );
}
