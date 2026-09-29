import { useEffect, useState, useRef } from "react";
import {
  Puzzle,
  Sparkles,
  Server,
  AppWindow,
  Settings2,
  Check,
  Plus,
  Search,
  ChevronDown,
  Trash2,
  RefreshCw,
  FileCode,
  ShieldCheck,
} from "lucide-react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import {
  createEngineServer,
  declareCatalogEntry,
  listEngineCatalog,
  listEngineServers,
  listEngineSkills,
  probeEngineServer,
  removeEngineServer,
  createEngineSkill,
  skillEngineAction,
  type CatalogEntry,
  type ExternalServer,
  type ProbeResult,
  type Skill,
} from "@/lib/engine-mcp-client";
import {
  listEnginePlugins,
  enableEnginePlugin,
  disableEnginePlugin,
} from "@/lib/engine-plugins-client";
import { SettingsToggleSwitch } from "./SettingsToggleSwitch";
import { AddMcpServerModal, AddSkillModal, ViewSkillModal } from "./ConversationPluginModals";
import { ConversationSkillPacksSection } from "./ConversationSkillPacksSection";
import "./conversation-unified-models.css";
import "./conversation-unified-plugins.css";

type TabKind = "plugins" | "apps" | "mcp" | "skills" | "packs";

type UnifiedToolItem = {
  id: string;
  name: string;
  kind: TabKind;
  category: string;
  description: string;
  iconBg: string;
  iconColor: string;
  badge?: string;
  badgeType?: "ok" | "pending" | "info" | "neutral";
  details?: string | undefined;
  enabled: boolean;
  rawMcpServer?: ExternalServer;
  rawSkill?: Skill;
  rawCatalog?: CatalogEntry;
};

// Built-in standard plugins & apps for Homun
const BUILTIN_TOOLS: UnifiedToolItem[] = [
  {
    id: "web-search",
    name: "Web Browser & Search",
    kind: "plugins",
    category: "Navigazione",
    description: "Ricerca web in tempo reale e consultazione documentazione tramite browser sandbox.",
    iconBg: "#0ea5e9",
    iconColor: "#ffffff",
    badge: "Integrato",
    badgeType: "ok",
    details: "Google Search API & Headless Chromium",
    enabled: true,
  },
  {
    id: "code-sandbox",
    name: "Code Sandbox (Python / Node)",
    kind: "plugins",
    category: "Esecuzione",
    description: "Ambiente isolato per calcoli matematici, analisi dati e prototipazione script.",
    iconBg: "#10b981",
    iconColor: "#ffffff",
    badge: "Sicuro",
    badgeType: "ok",
    details: "Deno / WebAssembly sandbox",
    enabled: true,
  },
  {
    id: "memory-vault",
    name: "Knowledge Vault",
    kind: "plugins",
    category: "Memoria",
    description: "Archivio vettoriale e note di progetto per il recupero semantico delle decisioni.",
    iconBg: "#8b5cf6",
    iconColor: "#ffffff",
    badge: "Attivo",
    badgeType: "ok",
    details: "Embeddings locali con SQLite Vec",
    enabled: true,
  },
  {
    id: "github-connector",
    name: "GitHub / GitLab",
    kind: "apps",
    category: "Sviluppo",
    description: "Sincronizzazione repository, lettura commit, gestione PR e revisione codice.",
    iconBg: "#24292f",
    iconColor: "#ffffff",
    badge: "Connesso",
    badgeType: "ok",
    details: "OAuth GitHub App v3/v4",
    enabled: true,
  },
  {
    id: "postgres-connector",
    name: "PostgreSQL & Database",
    kind: "apps",
    category: "Database",
    description: "Query su schemi relazionali, ispezione indici e generazione migrazioni.",
    iconBg: "#336791",
    iconColor: "#ffffff",
    badge: "Configurato",
    badgeType: "ok",
    details: "Connessione diretta SSL sola lettura",
    enabled: false,
  },
  {
    id: "slack-notifier",
    name: "Slack & Teams Bridge",
    kind: "apps",
    category: "Comunicazione",
    description: "Inoltro aggiornamenti, checkpoint e riepiloghi sui canali di squadra.",
    iconBg: "#4a154b",
    iconColor: "#ffffff",
    badge: "Non attivo",
    badgeType: "neutral",
    details: "Incoming Webhooks & Bot Token",
    enabled: false,
  },
];

export function ConversationUnifiedPluginsSection() {
  const [activeTab, setActiveTab] = useState<TabKind>("plugins");
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Live state from engine
  const [servers, setServers] = useState<ExternalServer[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [builtins, setBuiltins] = useState<UnifiedToolItem[]>(BUILTIN_TOOLS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Modals state
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [newServerForm, setNewServerForm] = useState({
    name: "",
    transport: "stdio" as "stdio" | "http",
    command: "",
    args: "",
    url: "",
  });

  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [viewingSkill, setViewingSkill] = useState<Skill | null>(null);
  const [newSkillForm, setNewSkillForm] = useState({
    name: "",
    description: "",
    body: "",
  });

  const [probingServerId, setProbingServerId] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    try {
      const [srvs, sks, cat, engPlugs] = await Promise.all([
        listEngineServers().catch(() => [] as ExternalServer[]),
        listEngineSkills().catch(() => [] as Skill[]),
        listEngineCatalog().catch(() => [] as CatalogEntry[]),
        listEnginePlugins().catch(() => null),
      ]);
      setServers(srvs);
      setSkills(sks);
      setCatalog(cat);
      if (engPlugs?.plugins && engPlugs.plugins.length > 0) {
        setBuiltins((prev) =>
          prev.map((b) => {
            const match = engPlugs.plugins.find((p) => p.name === b.id);
            return match ? { ...b, enabled: match.enabled } : b;
          })
        );
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Format list items
  const mcpItems: UnifiedToolItem[] = servers.map((s) => ({
    id: `mcp-${s.id}`,
    name: s.name,
    kind: "mcp",
    category: s.transport.toUpperCase(),
    description: s.transport === "stdio" ? `${s.command} ${s.args.join(" ")}`.trim() : s.url,
    iconBg: "#475569",
    iconColor: "#f8fafc",
    badge: s.status === "enabled" ? "Attivo" : "Disattivato",
    badgeType: s.status === "enabled" ? "ok" : "neutral",
    details: `${s.tools_include.length > 0 ? `Inclusi: ${s.tools_include.join(", ")}` : "Tutti gli strumenti"}`,
    enabled: s.status === "enabled",
    rawMcpServer: s,
  }));

  const skillItems: UnifiedToolItem[] = skills.map((sk) => ({
    id: `skill-${sk.id}`,
    name: sk.name,
    kind: "skills",
    category: sk.author_type === "agent" ? "Generata da Agente" : "Manuale",
    description: sk.description || "Nessuna descrizione specificata.",
    iconBg: "#6366f1",
    iconColor: "#ffffff",
    badge: sk.status === "approved" ? "Approvata" : sk.status === "staged" ? "In attesa" : "Archiviata",
    badgeType: sk.status === "approved" ? "ok" : sk.status === "staged" ? "pending" : "neutral",
    details: sk.body ? `${sk.body.slice(0, 80)}...` : undefined,
    enabled: sk.status === "approved",
    rawSkill: sk,
  }));

  const pluginItems: UnifiedToolItem[] = [
    ...builtins.filter((b) => b.kind === "plugins"),
    ...catalog.map((c) => ({
      id: `cat-${c.id}`,
      name: c.name,
      kind: "plugins" as TabKind,
      category: c.source,
      description: c.description,
      iconBg: "#059669",
      iconColor: "#ffffff",
      badge: servers.some((s) => s.name === c.name) ? "Installato" : "Catalogo",
      badgeType: (servers.some((s) => s.name === c.name) ? "ok" : "info") as "ok" | "info",
      details: `${c.command} ${c.args_prefix.join(" ")}`,
      enabled: servers.some((s) => s.name === c.name),
      rawCatalog: c,
    })),
  ];

  const appItems: UnifiedToolItem[] = builtins.filter((b) => b.kind === "apps");

  let currentItems: UnifiedToolItem[] = [];
  if (activeTab === "plugins") currentItems = pluginItems;
  else if (activeTab === "apps") currentItems = appItems;
  else if (activeTab === "mcp") currentItems = mcpItems;
  else if (activeTab === "skills") currentItems = skillItems;

  const filtered = currentItems.filter((item) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
    );
  });

  async function handleProbe(server: ExternalServer) {
    setProbingServerId(server.id);
    setError(null);
    try {
      const res = await probeEngineServer(server.id);
      setInfo(`Server ${server.name} risponde correttamente (${res.tool_count_total} strumenti rilevati).`);
    } catch (cause) {
      setError(cause);
    } finally {
      setProbingServerId(null);
    }
  }

  async function handleToggleSkill(skill: Skill, turnOn: boolean) {
    try {
      const action = turnOn ? "approve" : "archive";
      await skillEngineAction({ skillId: skill.id, action, expectedVersion: skill.revision });
      await loadAll();
      setInfo(turnOn ? `Skill "${skill.name}" approvata e resa disponibile.` : `Skill archiviata.`);
    } catch (cause) {
      setError(cause);
    }
  }

  async function handleToggleBuiltin(id: string, next: boolean) {
    setBuiltins((prev) =>
      prev.map((b) => (b.id === id ? { ...b, enabled: next } : b))
    );
    try {
      if (next) {
        await enableEnginePlugin(id);
      } else {
        await disableEnginePlugin(id);
      }
    } catch {
      // Non-engine or virtual builtin, local state suffices
    }
  }

  async function handleSaveNewServer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const argsArray = newServerForm.args
        .split(" ")
        .map((a) => a.trim())
        .filter(Boolean);
      await createEngineServer({
        name: newServerForm.name,
        transport: newServerForm.transport,
        ...(newServerForm.transport === "stdio"
          ? {
              command: newServerForm.command,
              args: argsArray,
            }
          : {
              url: newServerForm.url,
            }),
      });
      setMcpModalOpen(false);
      setNewServerForm({ name: "", transport: "stdio", command: "", args: "", url: "" });
      await loadAll();
      setInfo("Server MCP aggiunto con successo.");
    } catch (cause) {
      setError(cause);
    }
  }

  async function handleSaveNewSkill(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createEngineSkill({
        name: newSkillForm.name,
        description: newSkillForm.description,
        body: newSkillForm.body,
        authorType: "person",
      });
      setSkillModalOpen(false);
      setNewSkillForm({ name: "", description: "", body: "" });
      await loadAll();
      setInfo("Procedura / Skill registrata correttamente.");
    } catch (cause) {
      setError(cause);
    }
  }

  return (
    <div className="cv-unified-section">
      {/* Header matching ChatGPT pattern */}
      <header className="cv-unified-section__head">
        <div>
          <h2 className="cv-unified-section__title">Plugin e strumenti</h2>
          <p className="cv-unified-section__subtitle">
            Estendi le capacità della tua squadra con server MCP, skill procedurali, integrazioni cloud e connettori.
          </p>
        </div>
        <div className="cv-unified-section__actions" ref={menuRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="cv-unified-btn is-primary"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Plus size={14} />
            Aggiungi
            <ChevronDown size={14} />
          </button>

          {menuOpen && (
            <div className="cv-unified-dropdown-menu">
              <button
                type="button"
                className="cv-unified-dropdown-item"
                onClick={() => {
                  setMenuOpen(false);
                  setActiveTab("plugins");
                }}
              >
                <Puzzle size={15} />
                <span>Installa dal Catalogo</span>
              </button>
              <button
                type="button"
                className="cv-unified-dropdown-item"
                onClick={() => {
                  setMenuOpen(false);
                  setMcpModalOpen(true);
                }}
              >
                <Server size={15} />
                <span>Aggiungi server MCP</span>
              </button>
              <button
                type="button"
                className="cv-unified-dropdown-item"
                onClick={() => {
                  setMenuOpen(false);
                  setSkillModalOpen(true);
                }}
              >
                <Sparkles size={15} />
                <span>Registra una skill</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Explainer: Cosa accade quando colleghi uno strumento */}
      <div className="cv-unified-explainer" style={{ margin: "14px 0 16px" }}>
        <div className="flex items-start gap-3 p-3.5 rounded-xl bg-[rgba(21,122,110,0.12)] border border-[rgba(143,227,208,0.25)] text-xs text-[#9db3ad]">
          <ShieldCheck size={18} className="text-[#8fe3d0] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <strong className="text-[#f4f1ee] block font-semibold">
              Come funzionano Plugin, App e Server MCP in Homun
            </strong>
            <p className="m-0 leading-relaxed">
              Ogni strumento installato conferisce agli agenti nuove capacità (es. query a database,
              consultazione web, script sandbox). <strong className="text-[#f4f1ee]">Nessuna azione critica avviene in segreto</strong>:
              Homun applica la supervisione umana (Human-in-the-Loop) e richiederà sempre la tua
              autorizzazione esplicita in chat prima di eseguire comandi o modifiche.
            </p>
          </div>
        </div>
      </div>

      {/* 4 Segmented Sub-Tabs matching Screenshots 1-4 */}
      <div className="cv-unified-toolbar">
        <div className="cv-unified-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "plugins"}
            className={`cv-unified-tab ${activeTab === "plugins" ? "is-active" : ""}`}
            onClick={() => {
              setMenuOpen(false);
              setActiveTab("plugins");
            }}
          >
            Plugin <span className="cv-unified-tab__count">{pluginItems.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "apps"}
            className={`cv-unified-tab ${activeTab === "apps" ? "is-active" : ""}`}
            onClick={() => {
              setMenuOpen(false);
              setActiveTab("apps");
            }}
          >
            App <span className="cv-unified-tab__count">{appItems.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "mcp"}
            className={`cv-unified-tab ${activeTab === "mcp" ? "is-active" : ""}`}
            onClick={() => {
              setMenuOpen(false);
              setActiveTab("mcp");
            }}
          >
            MCP <span className="cv-unified-tab__count">{mcpItems.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "skills"}
            className={`cv-unified-tab ${activeTab === "skills" ? "is-active" : ""}`}
            onClick={() => {
              setMenuOpen(false);
              setActiveTab("skills");
            }}
          >
            Skill <span className="cv-unified-tab__count">{skillItems.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "packs"}
            className={`cv-unified-tab ${activeTab === "packs" ? "is-active" : ""}`}
            onClick={() => {
              setMenuOpen(false);
              setActiveTab("packs");
            }}
          >
            Pacchetti
          </button>
        </div>

        <div className="cv-unified-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Cerca tra plugin e strumenti…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {info && (
        <div className="cv-unified-banner is-info">
          <Check size={14} />
          <span>{info}</span>
        </div>
      )}
      <HomunErrorNotice error={error} />

      {activeTab === "packs" ? (
        <div className="mt-4">
          <ConversationSkillPacksSection onPackInstalled={() => void loadAll()} />
        </div>
      ) : (
      /* Unified Rows matching ChatGPT / Desktop pattern */
      <div className="cv-unified-list">
        {filtered.length === 0 ? (
          <div className="cv-unified-empty">
            <p>
              {activeTab === "mcp"
                ? "Nessun server MCP configurato. Aggiungi un server per connettere database, filesystem o strumenti esterni."
                : activeTab === "skills"
                ? "Nessuna skill procedurale salvata. Puoi registrarne una adesso o salvarla direttamente da un messaggio dell'agente."
                : "Nessun elemento trovato per la ricerca o categoria selezionata."}
            </p>
            {activeTab === "mcp" && (
              <button
                type="button"
                className="cv-unified-btn is-primary"
                style={{ marginTop: "0.5rem" }}
                onClick={() => setMcpModalOpen(true)}
              >
                <Plus size={14} />
                Aggiungi server MCP
              </button>
            )}
            {activeTab === "skills" && (
              <button
                type="button"
                className="cv-unified-btn is-primary"
                style={{ marginTop: "0.5rem" }}
                onClick={() => setSkillModalOpen(true)}
              >
                <Plus size={14} />
                Registra nuova skill
              </button>
            )}
          </div>
        ) : (
          filtered.map((item) => {
            let iconComponent = <Puzzle size={18} />;
            if (item.kind === "apps") iconComponent = <AppWindow size={18} />;
            else if (item.kind === "mcp") iconComponent = <Server size={18} />;
            else if (item.kind === "skills") iconComponent = <Sparkles size={18} />;

            return (
              <div key={item.id} className="cv-unified-row">
                <div
                  className="cv-unified-row__icon"
                  style={{ backgroundColor: item.iconBg, color: item.iconColor }}
                >
                  {iconComponent}
                </div>

                <div className="cv-unified-row__main">
                  <div className="cv-unified-row__title-line">
                    <span className="cv-unified-row__title">{item.name}</span>
                    {item.badge && (
                      <span
                        className={`cv-unified-badge ${
                          item.badgeType === "ok"
                            ? "is-ok"
                            : item.badgeType === "pending"
                            ? "is-active"
                            : ""
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                    <span className="cv-unified-badge">{item.category}</span>
                  </div>
                  <p className="cv-unified-row__desc">{item.description}</p>
                  {item.details && (
                    <span className="cv-unified-row__submeta">{item.details}</span>
                  )}
                </div>

                <div className="cv-unified-row__controls">
                  {item.rawMcpServer && (
                    <>
                      <button
                        type="button"
                        className="cv-unified-btn is-subtle"
                        title="Verifica connessione"
                        disabled={probingServerId === item.rawMcpServer.id}
                        onClick={() => void handleProbe(item.rawMcpServer!)}
                      >
                        <RefreshCw
                          size={13}
                          className={probingServerId === item.rawMcpServer.id ? "animate-spin" : ""}
                        />
                        <span>{probingServerId === item.rawMcpServer.id ? "Provo…" : "Test"}</span>
                      </button>
                      <button
                        type="button"
                        className="cv-unified-icon-btn"
                        title="Rimuovi server"
                        onClick={async () => {
                          if (confirm(`Rimuovere il server "${item.name}"?`)) {
                            try {
                              await removeEngineServer(item.rawMcpServer!.id, item.rawMcpServer!.revision);
                              await loadAll();
                            } catch (e) {
                              setError(e);
                            }
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}

                  {item.rawSkill && (
                    <button
                      type="button"
                      className="cv-unified-btn is-subtle"
                      onClick={() => setViewingSkill(item.rawSkill!)}
                    >
                      <FileCode size={13} />
                      <span>Codice</span>
                    </button>
                  )}

                  {item.rawCatalog && !item.enabled && (
                    <button
                      type="button"
                      className="cv-unified-btn is-primary"
                      onClick={async () => {
                        try {
                          await declareCatalogEntry({ entry: item.rawCatalog! });
                          await loadAll();
                          setInfo(`Installato "${item.name}" dal catalogo.`);
                        } catch (e) {
                          setError(e);
                        }
                      }}
                    >
                      Installa
                    </button>
                  )}

                  {(item.rawSkill || item.kind === "apps" || item.id === "web-search" || item.id === "code-sandbox" || item.id === "memory-vault") && (
                    <SettingsToggleSwitch
                      checked={item.enabled}
                      ariaLabel={`Abilita ${item.name}`}
                      onChange={(next) => {
                        if (item.rawSkill) {
                          void handleToggleSkill(item.rawSkill, next);
                        } else {
                          handleToggleBuiltin(item.id, next);
                        }
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      )}

      {/* Modals extracted to subcomponents */}
      {mcpModalOpen && (
        <AddMcpServerModal
          form={newServerForm}
          setForm={setNewServerForm}
          onSubmit={handleSaveNewServer}
          onClose={() => setMcpModalOpen(false)}
        />
      )}

      {skillModalOpen && (
        <AddSkillModal
          form={newSkillForm}
          setForm={setNewSkillForm}
          onSubmit={handleSaveNewSkill}
          onClose={() => setSkillModalOpen(false)}
        />
      )}

      {viewingSkill && (
        <ViewSkillModal
          skill={viewingSkill}
          onClose={() => setViewingSkill(null)}
          onToggle={handleToggleSkill}
        />
      )}
    </div>
  );
}
