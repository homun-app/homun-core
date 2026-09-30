import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { SettingsToggleSwitch } from "../SettingsToggleSwitch";
import {
  installEngineConnector,
  listEngineConnectors,
  listEngineSkills,
  skillEngineAction,
  startConnectorOAuth,
  type HostedConnector,
  type Skill,
} from "@/lib/engine-mcp-client";
import {
  listEngineChannelPlatforms,
  updateEngineChannelPlatform,
  type ChannelPlatformInfo,
} from "@/lib/engine-channels-client";
import {
  listEnginePlugins,
  enableEnginePlugin,
  disableEnginePlugin,
  type EnginePluginSummaryItem,
} from "@/lib/engine-plugins-client";
import { CHANNELS_CATALOG } from "../messaging/messaging-data";
import "./capabilities-view.css";

/**
 * Catalogo delle capacità del motore: skill approvate, connettori canale,
 * plugin registrati e superficie dei tool dei run. Fonte: solo motore.
 */
type CapabilityTab = "skills" | "tools" | "connectors" | "plugins";

const RUN_TOOL_SURFACE: Array<{ name: string; label: string; note: string }> = [
  { name: "terminal", label: "Terminale", note: "container Docker pinned, approvazione a digest" },
  { name: "computer_use", label: "Computer use", note: "desktop a tre livelli: hard-block, sensibili, allowlist" },
  { name: "browser", label: "Browser", note: "7 tool: open, click, type, snapshot…" },
  { name: "web_pages", label: "Web", note: "web_search, web_extract, x_search" },
  { name: "memory", label: "Memoria", note: "scoped person/progetto/agente/spazio" },
  { name: "skills", label: "Skill", note: "catalogo workspace con quarantena" },
  { name: "delegation", label: "Delegazione", note: "sub-run su team approvati" },
  { name: "goals", label: "Obiettivi", note: "goal gate e sub-goal" },
  { name: "cron", label: "Cron", note: "job programmati con delivery su canale" },
  { name: "clarify", label: "Chiarimenti", note: "domande a chi supervisiona" },
  { name: "code_execution", label: "Esecuzione codice", note: "execute_code nel run" },
  { name: "session_management", label: "Sessioni", note: "checkpoint e storico sessioni" },
  { name: "gateway", label: "Gateway", note: "gestione gateway dal run" },
  { name: "plugins", label: "Plugin", note: "tool aggiuntivi dai plugin abilitati" },
];

export function CapabilitiesView() {
  const [activeTab, setActiveTab] = useState<CapabilityTab>("skills");
  const [searchQuery, setSearchQuery] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [channels, setChannels] = useState<ChannelPlatformInfo[]>([]);
  const [plugins, setPlugins] = useState<EnginePluginSummaryItem[]>([]);
  const [connectors, setConnectors] = useState<HostedConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draftFields, setDraftFields] = useState<Record<string, string>>({});
  const [newFieldKey, setNewFieldKey] = useState("");
  const [oauthLink, setOauthLink] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    void refresh();
    // di ritorno dall'autorizzazione OAuth (altra finestra/scheda) lo stato si aggiorna da solo
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const [s, c, p, k] = await Promise.all([
        listEngineSkills(true).catch(() => []),
        listEngineChannelPlatforms().catch(() => []),
        listEnginePlugins().then((summary) => summary.plugins).catch(() => []),
        listEngineConnectors().catch(() => []),
      ]);
      setSkills(s);
      setChannels(c);
      setPlugins(p);
      setConnectors(k);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }

  function openConfig(c: ChannelPlatformInfo) {
    if (expanded === c.id) {
      setExpanded(null);
      return;
    }
    const defaults: Record<string, string> = {};
    for (const field of CHANNELS_CATALOG.find((d) => d.id === c.id)?.fields ?? []) {
      defaults[field.id] = "";
    }
    setDraftFields({ ...defaults, ...c.fields });
    setNewFieldKey("");
    setExpanded(c.id);
  }

  async function act(key: string, operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  const q = searchQuery.trim().toLowerCase();
  const match = (...fields: Array<string | undefined | null>) =>
    !q || fields.some((f) => (f ?? "").toLowerCase().includes(q));

  const filteredSkills = useMemo(
    () => skills.filter((s) => s.status !== "archived" && match(s.name, s.description, s.tags.join(" "))),
    [skills, q],
  );
  const filteredChannels = useMemo(
    () => channels.filter((c) => match(c.name, c.id)),
    [channels, q],
  );
  const [connectorFilter, setConnectorFilter] = useState<"all" | "connected" | "pending">("all");
  const sortedConnectors = useMemo(() => {
    const rank = (k: HostedConnector) => k.connected ? 0 : k.declared ? 1 : 2;
    return [...connectors].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [connectors]);
  const filteredConnectors = useMemo(
    () => sortedConnectors.filter((k) => match(k.name, k.description, k.keywords.join(" "))
      && (connectorFilter === "all"
        || (connectorFilter === "connected" && k.connected)
        || (connectorFilter === "pending" && !k.connected))),
    [sortedConnectors, q, connectorFilter],
  );
  const connectedCount = connectors.filter((k) => k.connected).length;
  const filteredPlugins = useMemo(
    () => plugins.filter((p) => match(p.name, p.kind, p.tools.join(" "))),
    [plugins, q],
  );
  const filteredTools = useMemo(
    () => RUN_TOOL_SURFACE.filter((t) => match(t.name, t.label, t.note)),
    [q],
  );

  const counts = {
    skills: skills.filter((s) => s.status !== "archived").length,
    tools: RUN_TOOL_SURFACE.length,
    connectors: channels.length + connectors.length,
    plugins: plugins.length,
  };

  const tabs: Array<{ id: CapabilityTab; label: string; count: number }> = [
    { id: "skills", label: "Skills", count: counts.skills },
    { id: "tools", label: "Tool dei run", count: counts.tools },
    { id: "connectors", label: "Connettori", count: counts.connectors },
    { id: "plugins", label: "Plugin", count: counts.plugins },
  ];

  return (
    <div className="cap-container" role="region" aria-label="Catalogo capacità del motore">
      <header className="cap-header">
        <div className="cap-tabs" role="tablist" aria-label="Tipo di capacità">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`cap-tab-btn ${activeTab === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              <span className="cap-tab-count">{loading ? "…" : tab.count}</span>
            </button>
          ))}
        </div>
        <div className="cap-search-wrap">
          <Search size={14} className="cap-search-icon" />
          <input
            type="text"
            className="cap-search-input"
            placeholder="Cerca nel motore…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </header>

      <HomunErrorNotice error={error} />

      <main className="cap-grid-wrap">
        {loading ? (
          <div className="cap-empty">Caricamento dal motore…</div>
        ) : activeTab === "skills" ? (
          <div className="cap-grid">
            {filteredSkills.map((s) => (
              <article key={s.id} className="cap-card">
                <div>
                  <div className="cap-card-top">
                    <h4 className="cap-card-title">{s.name}</h4>
                    <span className="cap-card-version">rev {s.revision}</span>
                  </div>
                  <div className="cap-card-author-row">
                    <span className="cap-card-author">{s.author_id || (s.author_type === "agent" ? "un agente" : "una persona")}</span>
                    <span className="cap-card-version">
                      {s.status === "staged" ? "in quarantena" : s.usage_count > 0 ? `usata ${s.usage_count}×` : "mai usata"}
                    </span>
                  </div>
                  <p className="cap-card-desc">{s.description}</p>
                </div>
                <div className="cap-card-footer">
                  <div className="cap-card-tags">
                    {s.resources.length > 0 && (
                      <span className="cap-tag-pill">{s.resources.length} risorse</span>
                    )}
                  </div>
                  {s.status === "staged" ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="cap-filter-item"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(`skill:${s.id}:approve`, () =>
                            skillEngineAction({ skillId: s.id, action: "approve", expectedVersion: s.revision }))}
                      >
                        Approva
                      </button>
                      <button
                        type="button"
                        className="cap-filter-item"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(`skill:${s.id}:reject`, () =>
                            skillEngineAction({ skillId: s.id, action: "reject", expectedVersion: s.revision }))}
                      >
                        Rifiuta
                      </button>
                    </div>
                  ) : s.status === "approved" && s.author_type === "agent" ? (
                    <button
                      type="button"
                      className="cap-filter-item"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(`skill:${s.id}:archive`, () =>
                          skillEngineAction({ skillId: s.id, action: "archive", expectedVersion: s.revision }))}
                    >
                      Archivia
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
            {filteredSkills.length === 0 && <div className="cap-empty">Nessuna skill corrisponde.</div>}
          </div>
        ) : activeTab === "tools" ? (
          <div className="cap-grid">
            {filteredTools.map((t) => (
              <article key={t.name} className="cap-card">
                <div>
                  <div className="cap-card-top">
                    <h4 className="cap-card-title">{t.label}</h4>
                    <span className="cap-card-version">{t.name}</span>
                  </div>
                  <p className="cap-card-desc">{t.note}</p>
                </div>
              </article>
            ))}
            <div className="cap-empty" style={{ border: "none" }}>
              In Homun i tool non si accendono globalmente: si scelgono per singolo run
              (flag di capability) o per agente nella directory. I comandi restano sempre
              sotto approvazione a digest.
            </div>
          </div>
        ) : activeTab === "connectors" ? (
          <>
          <div className="cap-grid">
            {filteredChannels.map((c) => (
              <article key={c.id} className="cap-card">
                <div>
                  <div className="cap-card-top">
                    <h4 className="cap-card-title">{c.name}</h4>
                    <SettingsToggleSwitch
                      checked={c.enabled}
                      disabled={busy !== null}
                      onChange={(val) =>
                        void act(`channel:${c.id}`, () =>
                          updateEngineChannelPlatform(c.id, { enabled: val }))}
                      ariaLabel={`Abilita canale ${c.name}`}
                    />
                  </div>
                  <div className="cap-card-author-row">
                    <span className="cap-card-author">{c.id}</span>
                    <span className="cap-card-version">
                      {c.state === "connected" ? "connesso" : c.enabled ? "da configurare" : "disattivato"}
                    </span>
                  </div>
                  <p className="cap-card-desc">
                    {c.state === "connected"
                      ? "Attivo e configurato."
                      : c.enabled
                        ? "Abilitato, in attesa di credenziali."
                        : "Disattivato."}
                  </p>
                </div>
                <div className="cap-card-footer">
                  <button
                    type="button"
                    className="cap-filter-item"
                    onClick={() => openConfig(c)}
                  >
                    {expanded === c.id ? "Chiudi" : "Configura"}
                  </button>
                </div>
                {expanded === c.id && (
                  <form
                    style={{ display: "grid", gap: 6, marginTop: 8 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(`channel-config:${c.id}`, () =>
                        updateEngineChannelPlatform(c.id, { enabled: true, fields: draftFields }));
                    }}
                  >
                    {Object.keys(draftFields).map((key) => {
                      const defined = CHANNELS_CATALOG.find((d) => d.id === c.id)
                        ?.fields.find((f) => f.id === key);
                      return (
                        <label key={key} style={{ display: "grid", gap: 2, fontSize: 11 }}>
                          <span>{defined?.label ?? key}{defined?.required ? " *" : ""}</span>
                          <input
                            type={key.toLowerCase().includes("token") ? "password" : "text"}
                            value={draftFields[key] ?? ""}
                            placeholder={defined?.placeholder ?? key}
                            onChange={(e) =>
                              setDraftFields((prev) => ({ ...prev, [key]: e.target.value }))}
                            className="cap-search-input"
                            style={{ width: "100%" }}
                          />
                        </label>
                      );
                    })}
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        type="text"
                        value={newFieldKey}
                        placeholder="nuova chiave (es. bot_token)"
                        onChange={(e) => setNewFieldKey(e.target.value)}
                        className="cap-search-input"
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="cap-filter-item"
                        onClick={() => {
                          const key = newFieldKey.trim();
                          if (key && !(key in draftFields)) {
                            setDraftFields((prev) => ({ ...prev, [key]: "" }));
                          }
                          setNewFieldKey("");
                        }}
                      >
                        Aggiungi campo
                      </button>
                    </div>
                    <button
                      type="submit"
                      className="cap-filter-item is-selected"
                      disabled={busy !== null}
                    >
                      Salva configurazione
                    </button>
                    <span style={{ fontSize: 10, opacity: 0.7 }}>
                      Il salvataggio abilita il canale; i segreti restano nel motore.
                    </span>
                  </form>
                )}
              </article>
            ))}
            {filteredChannels.length === 0 && <div className="cap-empty">Nessun connettore canale corrisponde.</div>}
          </div>
          <div className="cap-card-footer" style={{ marginTop: 16, borderTop: "1px solid #dce4d5", paddingTop: 12, justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: "#647a6d" }}>
                Connettori ospitati — {connectedCount} collegati su {connectors.length}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
            {([["all", "Tutti"], ["connected", `Collegati ${connectedCount}`], ["pending", "Da collegare"]] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`cap-filter-item ${connectorFilter === id ? "is-selected" : ""}`}
                    onClick={() => setConnectorFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="cap-grid">
            {filteredConnectors.map((k) => (
              <article key={k.name} className="cap-card">
                <div>
                  <div className="cap-card-top">
                    <h4 className="cap-card-title">{k.name}</h4>
                    <span
                      className="cap-card-version"
                      style={k.connected
                        ? { color: "#1f7a4d", fontWeight: 600, background: "rgba(31,122,77,0.08)",
                            padding: "2px 8px", borderRadius: 999 }
                        : undefined}
                    >
                      {k.connected ? "✓ collegato" : k.declared ? "da autorizzare" : ""}
                    </span>
                  </div>
                  <p className="cap-card-desc">{k.description}</p>
                </div>
                <div className="cap-card-footer">
                  <div className="cap-card-tags">
                    {k.keywords.slice(0, 3).map((word) => (
                      <span key={word} className="cap-tag-pill">{word}</span>
                    ))}
                  </div>
                  {k.connected ? (
                    <button type="button" className="cap-filter-item" disabled
                      title="Già autorizzato: i tool arrivano tramite i gate di approvazione">
                      Collegato
                    </button>
                  ) : oauthLink?.name === k.name ? (
                    <a
                      href={oauthLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cap-filter-item is-selected"
                      style={{ textDecoration: "none" }}
                    >
                      Apri l'autorizzazione →
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="cap-filter-item is-selected"
                      disabled={busy !== null}
                      onClick={() => {
                        // finestra aperta al click (gesto utente): niente popup blocker
                        const popup = window.open("", "_blank");
                        void act(`connector:${k.name}`, async () => {
                          const serverId = k.server_id
                            ?? (await installEngineConnector(k.name)).server_id;
                          const flow = await startConnectorOAuth(serverId);
                          if (popup && !popup.closed) {
                            popup.location.href = flow.authorize_url;
                          } else {
                            setOauthLink({ name: k.name, url: flow.authorize_url });
                          }
                        });
                      }}
                    >
                      Connetti
                    </button>
                  )}
                  {oauthLink?.name === k.name && (
                    <span style={{ fontSize: 10, opacity: 0.7 }}>
                      Si apre la pagina del fornitore; dopo l'autorizzazione torna qui.
                    </span>
                  )}
                </div>
              </article>
            ))}
            {filteredConnectors.length === 0 && <div className="cap-empty">Nessun connettore del catalogo corrisponde.</div>}
          </div>
          </>
        ) : (
          <div className="cap-grid">
            {plugins.length === 0 ? (
              <div className="cap-empty">
                Nessun plugin registrato nel motore. Quando un plugin viene installato
                (API <code>/v1/plugins</code>) compare qui con i suoi tool. Fonte: motore.
              </div>
            ) : (
              filteredPlugins.map((p) => (
                <article key={p.name} className="cap-card">
                  <div>
                    <div className="cap-card-top">
                      <h4 className="cap-card-title">{p.name}</h4>
                      <SettingsToggleSwitch
                        checked={p.enabled}
                        disabled={busy !== null}
                        onChange={(val) =>
                          void act(`plugin:${p.name}`, () =>
                            val ? enableEnginePlugin(p.name) : disableEnginePlugin(p.name))}
                        ariaLabel={`Abilita plugin ${p.name}`}
                      />
                    </div>
                    <div className="cap-card-author-row">
                      <span className="cap-card-author">{p.kind}</span>
                      <span className="cap-card-version">v{p.version}</span>
                    </div>
                    <p className="cap-card-desc">{p.tools.join(", ") || "nessun tool esposto"}</p>
                  </div>
                </article>
              ))
            )}
          </div>
        )}
        <p className="cap-empty" style={{ border: "none" }}>Fonte: motore.</p>
      </main>
    </div>
  );
}
