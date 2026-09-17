import { StudioTeamMembers, type TeamMember } from "./StudioTeamMembers";
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus, Users, SlidersHorizontal } from "lucide-react";
export type WorkTeam = { id: string; name: string; members: string[]; leader?: string };
type Member = TeamMember;
export function StudioSquad({
  members,
  projects,
  teams,
  onTeams,
  onPerson,
  onManage,
  compact = false,
  filter,
  onFilter,
  query,
  onQuery,
  avatar,
  onAutonomy,
}: {
  avatar?: (id: string) => ReactNode;
  onAutonomy?: (modes: Record<string, "stage" | "review" | "autonomous">) => void;
  members: Member[];
  projects: { id: string; name: string; members: string[] }[];
  teams: WorkTeam[];
  onTeams: (teams: WorkTeam[]) => void;
  onPerson: (id: string) => void;
  onManage: () => void;
  compact?: boolean;
  filter: string;
  onFilter: (v: string) => void;
  query: string;
  onQuery: (v: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const hasFilters = filter !== "all" || !!query.trim();
  const filterButton = (
    <button
      className={`st-squad-filter-toggle ${hasFilters ? "has-filter" : ""}`}
      aria-label={compact ? "Mostra filtri squadra nella sidebar" : "Mostra filtri squadra"}
      title={hasFilters ? "Filtri attivi" : "Filtra la squadra"}
      aria-expanded={filtersOpen}
      aria-controls={compact ? "sidebar-squad-filters" : "main-squad-filters"}
      onClick={() => {
        setFiltersOpen(!filtersOpen);
        setCollapsed(false);
      }}
    >
      <SlidersHorizontal size={16} />
      {hasFilters && <span className="st-filter-dot" aria-label="Filtri attivi" />}
    </button>
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [leader, setLeader] = useState("");
  const [modes, setModes] = useState<Record<string, "stage" | "review" | "autonomous">>({});
  const [error, setError] = useState("");
  const scope = filter.startsWith("project:")
    ? projects.find((p) => "project:" + p.id === filter)
    : teams.find((t) => "team:" + t.id === filter);
  const normalized = query.trim().toLocaleLowerCase("it-IT");
  const visible = members.filter(
    (m) =>
      (filter === "all" || scope?.members.includes(m.id)) &&
      (!normalized || (m.name + " " + m.role).toLocaleLowerCase("it-IT").includes(normalized)),
  );
  function edit(team?: WorkTeam) {
    setEditing(team?.id || "new");
    setName(team?.name || "");
    setLeader(team?.leader || "");
    setModes({});
    setChosen(team?.members || []);
    setError("");
  }
  return (
    <section className={compact ? "st-squad compact" : "st-squad"}>
      {compact && (
        <div className="st-squad-heading">
          <button
            aria-expanded={!collapsed}
            aria-controls="sidebar-squad-list"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}Squadra{" "}
            <small>{members.length}</small>
          </button>
          <div className="st-squad-header-actions">
            {filterButton}
            <button aria-label="Gestisci team" onClick={onManage}>
              <Users size={16} />
            </button>
          </div>
        </div>
      )}
      {!compact && (
        <div className="st-squad-heading">
          <span>Collaboratori · {visible.length}</span>
          {filterButton}
        </div>
      )}
      {(!compact || !collapsed) && (
        <div id={compact ? "sidebar-squad-list" : undefined}>
          {filtersOpen && (
            <div
              className="st-squad-filters"
              id={compact ? "sidebar-squad-filters" : "main-squad-filters"}
            >
              <select
                aria-label={compact ? "Filtra squadra nella sidebar" : "Filtra squadra"}
                value={filter}
                onChange={(e) => onFilter(e.target.value)}
              >
                <option value="all">Tutta la squadra</option>
                <optgroup label="Progetti">
                  {projects.map((p) => (
                    <option key={p.id} value={"project:" + p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Team">
                  {teams.map((t) => (
                    <option key={t.id} value={"team:" + t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <input
                aria-label={compact ? "Cerca nella squadra della sidebar" : "Cerca nella squadra"}
                value={query}
                placeholder="Cerca persone o agenti…"
                onChange={(e) => onQuery(e.target.value)}
              />
            </div>
          )}
          <div className="st-squad-list">
            {visible.map((m) => (
              <button className="st-person" key={m.id} onClick={() => onPerson(m.id)}>
                {avatar?.(m.id) ?? (
                  <span
                    className={"st-avatar-dot " + (m.id.startsWith("user:") ? "human" : m.id)}
                    aria-hidden="true"
                  >
                    {m.name.slice(0, 1)}
                  </span>
                )}
                <span>
                  <strong>{m.name}</strong>
                  <small>{m.id.startsWith("user:") ? "Persona" : m.role}</small>
                </span>
              </button>
            ))}
          </div>
          {!visible.length && (
            <p className="st-muted">Nessun collaboratore corrisponde ai filtri.</p>
          )}
          {filtersOpen && (filter !== "all" || query) && (
            <button
              className="st-text-link"
              onClick={() => {
                onFilter("all");
                onQuery("");
              }}
            >
              Mostra tutta la squadra
            </button>
          )}
          {!compact && (
            <>
              <div className="st-section-head">
                <h2>Team</h2>
                <button className="st-btn" onClick={() => edit()}>
                  <Plus size={15} />
                  Crea team
                </button>
              </div>
              <p className="st-muted">
                Gruppi riutilizzabili, indipendenti dai progetti. Un collaboratore può appartenere a
                più team. L’appartenenza non modifica i permessi.
              </p>
              {teams.map((t) => (
                <div className="st-team-group" key={t.id}>
                  <button
                    onClick={() => {
                      onFilter("team:" + t.id);
                      onQuery("");
                    }}
                  >
                    <strong>{t.name}</strong>
                    <small>
                      {t.leader
                        ? `★ ${members.find((m) => m.id === t.leader)?.name || "Coordinatore non disponibile"}`
                        : "Supervisione: tu"}
                    </small>
                    <small>
                      {t.members.filter((id) => members.some((m) => m.id === id)).length}{" "}
                      collaboratori attivi
                    </small>
                  </button>
                  <button className="st-text-link" onClick={() => edit(t)}>
                    Modifica
                  </button>
                </div>
              ))}
              {!teams.length && (
                <p className="st-muted">
                  Nessun team ancora. Puoi continuare a lavorare con singoli collaboratori.
                </p>
              )}
              {editing && (
                <form
                  className="st-paper st-team-editor"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!name.trim()) return;
                    if (
                      teams.some(
                        (t) =>
                          t.id !== editing &&
                          t.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
                      )
                    ) {
                      setError("Esiste già un team con questo nome.");
                      return;
                    }
                    const id = editing === "new" ? crypto.randomUUID() : editing;
                    const t = {
                      id,
                      name: name.trim(),
                      members: chosen,
                      ...(leader && chosen.includes(leader) ? { leader } : {}),
                    };
                    onAutonomy?.(modes);
                    onTeams(
                      editing === "new"
                        ? [...teams, t]
                        : teams.map((old) => (old.id === id ? t : old)),
                    );
                    onFilter("team:" + id);
                    onQuery("");
                    setEditing(null);
                  }}
                >
                  <h3>{editing === "new" ? "Nuovo team" : "Modifica team"}</h3>
                  <label>
                    Nome del team
                    <input
                      autoFocus
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <StudioTeamMembers
                    key={editing}
                    members={members.map((m) =>
                      modes[m.id] ? { ...m, autonomy: modes[m.id]! } : m,
                    )}
                    leader={leader}
                    onLeader={setLeader}
                    onAutonomy={(id, mode) => setModes((old) => ({ ...old, [id]: mode }))}
                    chosen={chosen}
                    onChange={(ids) => {
                      setChosen(ids);
                      if (!ids.includes(leader)) setLeader("");
                    }}
                    {...(avatar ? { avatar } : {})}
                  />
                  {error && <p role="alert">{error}</p>}
                  <div className="st-sim-actions st-team-actions">
                    {editing !== "new" && (
                      <button
                        type="button"
                        className="st-btn"
                        onClick={() => {
                          onTeams(teams.filter((t) => t.id !== editing));
                          if (filter === "team:" + editing) onFilter("all");
                          setEditing(null);
                        }}
                      >
                        Sciogli team
                      </button>
                    )}
                    <div className="st-team-confirm-actions">
                      <button type="button" className="st-btn" onClick={() => setEditing(null)}>
                        Annulla
                      </button>
                      <button type="submit" className="st-btn dark">
                        Salva team
                      </button>
                    </div>
                  </div>
                  <p className="st-muted">
                    Sciogliere un team non elimina collaboratori, progetti o incarichi. Gruppi
                    conservati fino al ricaricamento della demo.
                  </p>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
