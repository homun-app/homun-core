/**
 * Operational notices inside the workspace: silent when healthy, typed errors
 * when not. Simulation stays explicitly labelled and never mixes with engine.
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
  if (dataSourceSelected === "simulation") {
    return (
      <p className="cw-hint" aria-label="Fonte dati">
        Fonte: simulazione — nessun dato reale è collegato.
      </p>
    );
  }
  if (dataSourceSelected !== "engine") {
    return null;
  }

  const ready = backend === "engine" && !gateError;
  // Healthy idle renders nothing: the conversation is the interface.
  if (ready && !error && followups.length === 0) {
    return null;
  }

  return (
    <section className="cw-engine-banner" aria-label="Stato lavori" role={gateError ? "alert" : undefined}>
      {!ready && (
        <>
          <p role="status">
            Connessione non disponibile: il lavoro riprenderà quando l'app sarà di nuovo
            accessibile.
          </p>
          <button type="button" className="cw-secondary" disabled={busy} onClick={onRefresh}>
            Riprova la connessione
          </button>
        </>
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
