import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { ConnectionItem } from "../types";
import {
  coreBridge,
  type ComposioConnection,
  type ComposioToolkit,
} from "../lib/coreBridge";

interface ConnectionsViewProps {
  connections: ConnectionItem[];
}

const featured = [
  {
    title: "Esegui attività complesse nel browser",
    description: "Azioni locali con profilo assistant e approval gates.",
  },
  {
    title: "Collega posta e calendario",
    description: "Provider managed solo con opt-in esplicito.",
  },
  {
    title: "Trasforma flussi in skill",
    description: "Abilità riutilizzabili, sandboxate e auditabili.",
  },
];

export function ConnectionsView({ connections }: ConnectionsViewProps) {
  return (
    <section className="connections-view" aria-labelledby="connections-title">
      <header className="page-heading">
        <div>
          <h2 id="connections-title">Connettori e skill</h2>
        </div>
        <div className="page-actions">
          <button className="secondary-button" type="button">I miei plugin</button>
          <button className="primary-button" type="button">Crea</button>
        </div>
      </header>

      <div className="feature-strip" aria-label="Plugin in evidenza">
        {featured.map((item) => (
          <article className="feature-card" key={item.title}>
            <ShieldCheck size={20} />
            <strong>{item.title}</strong>
            <small>{item.description}</small>
          </article>
        ))}
      </div>

      <ComposioPanel />

      <label className="search-field">
        <Search size={17} />
        <input placeholder="Cerca connettori, abilità, fonti dati" />
      </label>

      <ConnectorSection
        title="Connettori"
        description="Collega app e API per condividere il tuo contesto."
        connections={connections}
      />
      <ConnectorSection
        title="Skill"
        description="Trasforma conoscenze e workflow in strumenti riutilizzabili."
        connections={connections.filter((item) => item.type === "skill")}
      />
    </section>
  );
}

type ComposioPhase = "loading" | "needs-key" | "ready";

function ComposioPanel() {
  const [phase, setPhase] = useState<ComposioPhase>("loading");
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
  const [connections, setConnections] = useState<ComposioConnection[]>([]);
  const [search, setSearch] = useState("");
  const [linkingSlug, setLinkingSlug] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshConnections = useCallback(async () => {
    const items = await coreBridge.composioConnections();
    setConnections(items);
    return items;
  }, []);

  const loadReady = useCallback(async () => {
    const [tk] = await Promise.all([
      coreBridge.composioToolkits(),
      refreshConnections(),
    ]);
    setToolkits(tk);
    setPhase("ready");
  }, [refreshConnections]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await coreBridge.composioConnections();
        if (!cancelled) await loadReady();
      } catch {
        if (!cancelled) setPhase("needs-key");
      }
    })();
    return () => {
      cancelled = true;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [loadReady]);

  const handleConnectKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setConnecting(true);
    setError(null);
    try {
      // A resolved promise means HTTP 2xx — the gateway validated the key
      // against Composio v3 before returning. Errors surface as throws.
      await coreBridge.composioConnect(key);
      setApiKey("");
      await loadReady();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  // Poll connections for a short window after opening the OAuth window so the
  // status flips INITIALIZING → ACTIVE without a manual refresh.
  const startPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    let ticks = 0;
    pollTimer.current = setInterval(async () => {
      ticks += 1;
      try {
        await refreshConnections();
      } catch {
        // transient; keep polling within the window
      }
      if (ticks >= 12 && pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }, 3000);
  }, [refreshConnections]);

  const handleLink = async (slug: string) => {
    setLinkingSlug(slug);
    setError(null);
    try {
      const res = await coreBridge.composioLink(slug);
      window.open(res.redirect_url, "_blank", "noopener,noreferrer");
      startPolling();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkingSlug(null);
    }
  };

  const connectionBySlug = new Map(
    connections.map((item) => [item.toolkit_slug, item]),
  );

  const query = search.trim().toLowerCase();
  const visibleToolkits = (
    query
      ? toolkits.filter(
          (tk) =>
            tk.name.toLowerCase().includes(query) ||
            tk.slug.toLowerCase().includes(query),
        )
      : toolkits
  ).slice(0, 60);

  return (
    <section className="connector-section composio-panel" aria-label="Composio">
      <div className="connector-section-title">
        <div>
          <h3>Composio</h3>
          <small>
            Collega app esterne (Gmail, GitHub, Slack…) con la tua chiave Composio.
            Connessione remota — gli strumenti girano off-device.
          </small>
        </div>
        {phase === "ready" && (
          <button
            className="subtle-button"
            type="button"
            onClick={() => {
              void refreshConnections();
            }}
          >
            Aggiorna
          </button>
        )}
      </div>

      {error && (
        <p className="composio-error" role="alert">
          {error}
        </p>
      )}

      {phase === "loading" && (
        <p className="composio-hint">
          <Loader2 size={15} className="spin" /> Verifica connessione Composio…
        </p>
      )}

      {phase === "needs-key" && (
        <div className="composio-connect-card">
          <KeyRound size={18} />
          <div className="composio-connect-body">
            <strong>Incolla la tua chiave API Composio</strong>
            <small>
              Creala (gratis) su{" "}
              <a
                href="https://app.composio.dev/developers"
                target="_blank"
                rel="noopener noreferrer"
              >
                app.composio.dev/developers
              </a>
              . Viene salvata cifrata in locale, una sola volta.
            </small>
            <div className="composio-key-row">
              <input
                type="password"
                placeholder="ak_…"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleConnectKey();
                }}
              />
              <button
                className="primary-button"
                type="button"
                disabled={connecting || !apiKey.trim()}
                onClick={() => void handleConnectKey()}
              >
                {connecting ? <Loader2 size={15} className="spin" /> : "Connetti"}
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <>
          <label className="search-field composio-search">
            <Search size={16} />
            <input
              placeholder="Cerca app Composio (es. gmail, github)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="connector-grid">
            {visibleToolkits.map((tk) => {
              const conn = connectionBySlug.get(tk.slug);
              const active = conn?.status?.toUpperCase() === "ACTIVE";
              const pending = conn && !active ? conn.status : null;
              return (
                <article className="connector-row" key={tk.slug}>
                  <span className="connector-icon">
                    {tk.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>{tk.name}</strong>
                    <small>
                      {active
                        ? "Connesso"
                        : pending
                          ? `In connessione · ${pending}`
                          : tk.no_auth
                            ? "Nessuna autenticazione"
                            : "OAuth gestito da Composio"}
                    </small>
                  </div>
                  {active ? (
                    <span className="composio-badge connected" aria-label="Connesso">
                      <Check size={15} /> Connesso
                    </span>
                  ) : (
                    <button
                      className="add-button"
                      type="button"
                      aria-label={`Connetti ${tk.name}`}
                      disabled={linkingSlug === tk.slug}
                      onClick={() => void handleLink(tk.slug)}
                    >
                      {linkingSlug === tk.slug ? (
                        <Loader2 size={15} className="spin" />
                      ) : pending ? (
                        <ExternalLink size={15} />
                      ) : (
                        <Plus size={16} />
                      )}
                    </button>
                  )}
                </article>
              );
            })}
            {visibleToolkits.length === 0 && (
              <p className="composio-hint">Nessuna app trovata.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ConnectorSection({
  title,
  description,
  connections,
}: {
  title: string;
  description: string;
  connections: ConnectionItem[];
}) {
  return (
    <section className="connector-section" aria-label={title}>
      <div className="connector-section-title">
        <div>
          <h3>{title}</h3>
          <small>{description}</small>
        </div>
        <button className="subtle-button" type="button">Visualizza tutto</button>
      </div>
      <div className="connector-grid">
        {connections.map((connection) => (
          <article className="connector-row" key={`${title}-${connection.id}`}>
            <span className="connector-icon">{connection.name.slice(0, 1)}</span>
            <div>
              <strong>{connection.name}</strong>
              <small>{connection.description}</small>
            </div>
            <button className="add-button" type="button" aria-label={`Aggiungi ${connection.name}`}>
              <Plus size={16} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
