import { useState, useMemo } from "react";
import { Search, Sparkles, Filter } from "lucide-react";
import { SettingsToggleSwitch } from "../SettingsToggleSwitch";
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_SOURCES,
  INITIAL_CAPABILITIES,
  type CapabilityCategory,
  type CapabilityItem,
  type CapabilitySource,
  type CapabilityTab,
} from "./capabilities-data";
import "./capabilities-view.css";

export function CapabilitiesView() {
  const [activeTab, setActiveTab] = useState<CapabilityTab>("skills");
  const [selectedSource, setSelectedSource] = useState<CapabilitySource>("all");
  const [selectedCategory, setSelectedCategory] = useState<CapabilityCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [items, setItems] = useState<CapabilityItem[]>(() => {
    try {
      const saved = localStorage.getItem("homun_capabilities_state");
      if (saved) {
        const savedIds: Record<string, boolean> = JSON.parse(saved);
        return INITIAL_CAPABILITIES.map((it) => ({
          ...it,
          enabled: savedIds[it.id] ?? it.enabled,
        }));
      }
    } catch {
      // fallback
    }
    return INITIAL_CAPABILITIES;
  });

  function handleToggle(id: string, next: boolean) {
    setItems((prev) => {
      const updated = prev.map((item) =>
        item.id === id ? { ...item, enabled: next } : item
      );
      try {
        const stateMap = Object.fromEntries(updated.map((i) => [i.id, i.enabled]));
        localStorage.setItem("homun_capabilities_state", JSON.stringify(stateMap));
      } catch {
        // ignore
      }
      return updated;
    });
  }

  // Counts by tab
  const tabCounts = useMemo(() => {
    return {
      skills: items.filter((i) => i.tab === "skills").length,
      tools: items.filter((i) => i.tab === "tools").length,
      connectors: items.filter((i) => i.tab === "connectors").length,
      plugins: items.filter((i) => i.tab === "plugins").length,
    };
  }, [items]);

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (item.tab !== activeTab) return false;
      if (selectedSource !== "all" && item.source !== selectedSource) return false;
      if (selectedCategory !== "all" && item.category !== selectedCategory) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = item.name.toLowerCase().includes(q);
        const matchesDesc = item.description.toLowerCase().includes(q);
        const matchesTags = item.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchesName && !matchesDesc && !matchesTags) return false;
      }
      return true;
    });
  }, [items, activeTab, selectedSource, selectedCategory, searchQuery]);

  return (
    <div className="cap-container" role="region" aria-label="Catalogo Capacità e Skill">
      {/* Header with Sub-tabs and Search */}
      <header className="cap-header">
        <div className="cap-tabs" role="tablist" aria-label="Tipo di capacità">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "skills"}
            className={`cap-tab-btn ${activeTab === "skills" ? "is-active" : ""}`}
            onClick={() => setActiveTab("skills")}
          >
            <span>Skills</span>
            <span className="cap-tab-count">{tabCounts.skills}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "tools"}
            className={`cap-tab-btn ${activeTab === "tools" ? "is-active" : ""}`}
            onClick={() => setActiveTab("tools")}
          >
            <span>Tools</span>
            <span className="cap-tab-count">{tabCounts.tools}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "connectors"}
            className={`cap-tab-btn ${activeTab === "connectors" ? "is-active" : ""}`}
            onClick={() => setActiveTab("connectors")}
          >
            <span>Connectors</span>
            <span className="cap-tab-count">{tabCounts.connectors}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "plugins"}
            className={`cap-tab-btn ${activeTab === "plugins" ? "is-active" : ""}`}
            onClick={() => setActiveTab("plugins")}
          >
            <span>Plugins</span>
            <span className="cap-tab-count">{tabCounts.plugins}</span>
          </button>
        </div>

        <div className="cap-search-wrap">
          <Search size={14} className="cap-search-icon" />
          <input
            type="text"
            className="cap-search-input"
            placeholder={`Cerca in ${activeTab}…`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </header>

      {/* Main 2-column layout */}
      <div className="cap-layout">
        {/* Left filter column */}
        <aside className="cap-sidebar" aria-label="Filtri catalogo">
          <div className="cap-sidebar-group">
            <span className="cap-sidebar-title">Sorgente</span>
            {CAPABILITY_SOURCES.map((source) => (
              <button
                key={source.id}
                type="button"
                className={`cap-filter-item ${selectedSource === source.id ? "is-selected" : ""}`}
                onClick={() => setSelectedSource(source.id)}
              >
                <span>{source.label}</span>
              </button>
            ))}
          </div>

          <div className="cap-sidebar-group">
            <span className="cap-sidebar-title">Categoria</span>
            {CAPABILITY_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`cap-filter-item ${selectedCategory === cat.id ? "is-selected" : ""}`}
                onClick={() => setSelectedCategory(cat.id)}
              >
                <span>{cat.label}</span>
                {cat.count !== undefined && (
                  <span className="cap-filter-badge">{cat.count.toLocaleString()}</span>
                )}
              </button>
            ))}
          </div>
        </aside>

        {/* Right cards grid */}
        <main className="cap-grid-wrap">
          {filteredItems.length === 0 ? (
            <div className="cap-empty">
              Nessuna capacità trovata con i filtri selezionati.
            </div>
          ) : (
            <div className="cap-grid">
              {filteredItems.map((item) => (
                <article key={item.id} className="cap-card">
                  <div>
                    <div className="cap-card-top">
                      <h4 className="cap-card-title">{item.name}</h4>
                      <SettingsToggleSwitch
                        checked={item.enabled}
                        onChange={(val) => handleToggle(item.id, val)}
                        ariaLabel={`Abilita ${item.name}`}
                      />
                    </div>

                    <div className="cap-card-author-row">
                      <span className="cap-card-author">{item.author}</span>
                      <span className="cap-card-version">{item.version}</span>
                    </div>

                    <p className="cap-card-desc">{item.description}</p>
                  </div>

                  <div className="cap-card-footer">
                    <div className="cap-card-tags">
                      {item.tags.map((tag) => (
                        <span key={tag} className="cap-tag-pill">
                          {tag}
                        </span>
                      ))}
                    </div>

                    {item.commandShortcut && (
                      <div className="cap-shortcut-row">
                        <span className="cap-shortcut-code">{item.commandShortcut}</span>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
