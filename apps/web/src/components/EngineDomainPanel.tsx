import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import { resolveWorkspaceBackend } from "@/lib/engine-client";
import {
  defaultLocalActor,
  listEngineConversations,
  listEngineWorks,
  postEngineCommand,
} from "@/lib/engine-domain-client";

/**
 * Thin F2 panel: proves engine domain over HTTP without replacing ConversationWorkspace.
 */
export function EngineDomainPanel() {
  const status = useEngineStatus();
  const [title, setTitle] = useState("Conversazione motore");
  const [conversations, setConversations] = useState<Array<Record<string, unknown>>>([]);
  const [works, setWorks] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  let backend: "simulation" | "engine" = "simulation";
  let gateError: unknown = null;
  try {
    backend = resolveWorkspaceBackend(
      status.dataSource,
      status.connection === "connected",
      status.capabilities,
    );
  } catch (cause) {
    gateError = cause;
  }

  async function refresh() {
    if (backend !== "engine") {
      return;
    }
    const [nextConversations, nextWorks] = await Promise.all([
      listEngineConversations(),
      listEngineWorks(),
    ]);
    setConversations(nextConversations);
    setWorks(nextWorks);
  }

  useEffect(() => {
    if (backend !== "engine") {
      setConversations([]);
      setWorks([]);
      return;
    }
    void refresh().catch((cause: unknown) => {
      setError(cause);
    });
  }, [backend, status.connection]);

  if (status.dataSource !== "engine") {
    return null;
  }

  return (
    <section className="engine-domain-panel" aria-label="Dominio motore">
      <h2 className="engine-domain-panel__title">Dominio motore (F2)</h2>
      <HomunErrorNotice error={gateError} className="engine-domain-panel__error" />
      {!gateError ? (
        <>
          <p className="engine-domain-panel__hint">
            Pannello di prova F2. La chat principale (`ConversationWorkspace`) usa lo stesso dominio
            quando Fonte=motore: crea lavori e registra messaggi senza fallback alla simulazione.
          </p>
          <form
            className="engine-domain-panel__form"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              setInfo(null);
              void postEngineCommand({
                type: "conversation.create",
                payload: { title },
                actor: defaultLocalActor(),
              })
                .then(async (result) => {
                  setInfo(`Creata ${String(result.result["conversation_id"] ?? "")}`);
                  await refresh();
                })
                .catch((cause: unknown) => {
                  setError(cause);
                })
                .finally(() => setBusy(false));
            }}
          >
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Titolo conversazione"
            />
            <button type="submit" disabled={busy || Boolean(gateError)}>
              Crea conversazione
            </button>
            <button
              type="button"
              disabled={busy || Boolean(gateError)}
              onClick={() => {
                setBusy(true);
                setError(null);
                void refresh()
                  .catch((cause: unknown) => {
                    setError(cause);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Ricarica
            </button>
          </form>
          <HomunErrorNotice error={error} className="engine-domain-panel__error" />
          {info ? <p className="engine-domain-panel__message">{info}</p> : null}
          <div className="engine-domain-panel__lists">
            <div>
              <h3>Conversazioni ({conversations.length})</h3>
              <ul>
                {conversations.map((item) => (
                  <li key={String(item["id"])}>
                    {String(item["title"])} · <code>{String(item["id"])}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Lavori ({works.length})</h3>
              <ul>
                {works.map((item) => (
                  <li key={String(item["id"])}>
                    {String(item["title"])} · {String(item["status"])}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
