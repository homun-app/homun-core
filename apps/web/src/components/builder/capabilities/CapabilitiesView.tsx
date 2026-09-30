import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { listEngineSkills, type Skill } from "@/lib/engine-mcp-client";
import { listEngineChannelPlatforms, type ChannelPlatformInfo } from "@/lib/engine-channels-client";
import { listEnginePlugins, type EnginePluginSummaryItem } from "@/lib/engine-plugins-client";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      listEngineSkills(true).catch(() => []),
      listEngineChannelPlatforms().catch(() => []),
      listEnginePlugins().then((s) => s.plugins).catch(() => []),
    ])
      .then(([s, c, p]) => {
        if (!live) return;
        setSkills(s);
        setChannels(c);
        setPlugins(p);
        setError(null);
      })
      .catch(setError)
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

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
    connectors: channels.length,
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
                {s.resources.length > 0 && (
                  <div className="cap-card-footer">
                    <div className="cap-card-tags">
                      <span className="cap-tag-pill">{s.resources.length} risorse</span>
                    </div>
                  </div>
                )}
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
          </div>
        ) : activeTab === "connectors" ? (
          <div className="cap-grid">
            {filteredChannels.map((c) => (
              <article key={c.id} className="cap-card">
                <div>
                  <div className="cap-card-top">
                    <h4 className="cap-card-title">{c.name}</h4>
                    <span
                      className="cap-card-version"
                      title={c.state}
                    >
                      {c.state === "connected" ? "connesso" : c.enabled ? c.state === "needs_setup" ? "da configurare" : c.state : "disattivato"}
                    </span>
                  </div>
                  <p className="cap-card-desc">
                    Canale {c.id}
                    {c.state === "connected" ? " — attivo e configurato." : c.enabled ? " — abilitato." : " — non abilitato."}
                  </p>
                </div>
              </article>
            ))}
            {filteredChannels.length === 0 && <div className="cap-empty">Nessun connettore corrisponde.</div>}
          </div>
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
                      <span className="cap-card-version">{p.enabled ? "abilitato" : "disabilitato"}</span>
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
