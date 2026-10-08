import { useState } from "react";
import { Search, X, Bot, User, Users, Plus } from "lucide-react";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import type { MemberProfile } from "./conversation-members";
import { ConversationAvatar } from "./ConversationAvatar";
import { EngineAgentDetailModal, type DetailTarget } from "./EngineAgentDetailModal";
import "./engine-agents.css";

const CAPABILITY_LABELS: Record<string, string> = {
  compare_csv: "Confronto CSV",
  read_material: "Lettura materiale",
  general: "Coordinamento",
};

type Props = {
  agents: EngineAgentProfile[];
  profiles?: Record<string, MemberProfile> | undefined;
  removedPeople?: string[] | undefined;
  onChanged?: (() => Promise<void>) | undefined;
  onCreateMember?: (() => void) | undefined;
  initialFilter?: string | undefined;
};

export function EngineWorkspaceAgents({
  agents,
  profiles = {},
  removedPeople = [],
  onChanged,
  onCreateMember,
  initialFilter,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "agents" | "humans">(() => {
    if (initialFilter === "agents" || initialFilter === "humans") return initialFilter;
    return "all";
  });

  if (initialFilter && (initialFilter === "agents" || initialFilter === "humans" || initialFilter === "all") && filter !== initialFilter && !search) {
    setFilter(initialFilter);
  }
  const [selectedTarget, setSelectedTarget] = useState<DetailTarget | null>(null);

  // Active engine agents
  const agentItems: DetailTarget[] = agents
    .filter((a) => a.status === "active")
    .map((agent) => ({ kind: "agent", agent }));

  // Human collaborators
  const humanItems: DetailTarget[] = Object.entries(profiles)
    .filter(([name, p]) => !removedPeople.includes(name) && p.kind === "human")
    .map(([name, profile]) => ({ kind: "human", name, profile }));

  const allItems: DetailTarget[] = [...agentItems, ...humanItems];

  // Filtering by tab
  const tabFiltered = allItems.filter((item) => {
    if (filter === "agents") return item.kind === "agent";
    if (filter === "humans") return item.kind === "human";
    return true;
  });

  // Filtering by search query
  const q = search.trim().toLowerCase();
  const searchFiltered = tabFiltered.filter((item) => {
    if (!q) return true;
    if (item.kind === "agent") {
      const a = item.agent;
      const haystack = [
        a.name,
        a.role,
        a.responsibility ?? "",
        ...(a.capabilities ?? []),
        ...(a.specializations ?? []),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    } else {
      const h = item;
      const haystack = [
        h.name,
        h.profile.role,
        h.profile.bio,
        ...(h.profile.skills || []),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    }
  });

  return (
    <section className="cw-agents-panel" aria-label="Collaboratori e Agenti">
      {/* Section Header with inline search */}
      <div className="cw-squad-section-head">
        <div className="cw-squad-section-title">
          <span>Squadra & Collaboratori</span>
          <span className="cw-squad-section-count">{allItems.length}</span>
        </div>
        <div className="cw-squad-search-wrap">
          <Search size={13} className="cw-squad-search-icon" />
          <input
            type="text"
            className="cw-squad-search-input"
            placeholder="Cerca collaboratore..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="cw-squad-search-clear"
              onClick={() => setSearch("")}
              title="Azzera ricerca"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Grid of Compact Cards */}
      {searchFiltered.length === 0 ? (
        <div className="ph-overview-empty">
          <span>
            {search
              ? `Nessun risultato per "${search}". Prova a modificare i filtri o la ricerca.`
              : "Non hai ancora collaboratori in questa categoria."}
          </span>
        </div>
      ) : (
        <div className="cw-squad-compact-grid">
          {searchFiltered.map((item) => {
            const isAgent = item.kind === "agent";
            const name = isAgent ? item.agent.name : item.name;
            const role = isAgent ? item.agent.role : item.profile.role;
            const summary = isAgent
              ? item.agent.responsibility || item.agent.instructions
              : item.profile.bio || "Membro del team";

            return (
              <article
                key={isAgent ? item.agent.id : item.name}
                className="cw-agent-compact-card"
                onClick={() => setSelectedTarget(item)}
                title={`Visualizza scheda di ${name}`}
              >
                <div className="cw-compact-head">
                  <ConversationAvatar name={name} human={!isAgent} />
                  <div className="cw-compact-info">
                    <div className="cw-compact-title-row">
                      <h4 className="cw-compact-name">{name}</h4>
                      <span className={`cw-compact-type-badge ${isAgent ? "is-bot" : "is-human"}`}>
                        {isAgent ? "AI" : "Persona"}
                      </span>
                    </div>
                    <p className="cw-compact-role">{role}</p>
                  </div>
                </div>

                <p className="cw-compact-summary">{summary}</p>

                <div className="cw-compact-tags">
                  {isAgent ? (
                    <>
                      {item.agent.autonomy_mode === "autonomous" ? (
                        <span className="cw-compact-status-chip autonomous">Autonomo</span>
                      ) : (
                        <span className="cw-compact-status-chip supervised">Supervisione</span>
                      )}
                      {(item.agent.capabilities || []).slice(0, 2).map((cap) => (
                        <span key={cap} className="cw-compact-tag">
                          {CAPABILITY_LABELS[cap] ?? cap}
                        </span>
                      ))}
                      {(item.agent.capabilities || []).length > 2 && (
                        <span className="cw-compact-tag-more">
                          +{item.agent.capabilities!.length - 2}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      {(item.profile.skills || []).slice(0, 2).map((sk) => (
                        <span key={sk} className="cw-compact-tag">
                          {sk}
                        </span>
                      ))}
                      {item.profile.invitation === "pending" && (
                        <span className="cw-compact-status-chip pending">In attesa</span>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selectedTarget && (
        <EngineAgentDetailModal
          target={selectedTarget}
          onClose={() => setSelectedTarget(null)}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}
