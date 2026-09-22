/** Engine teams: grouping collaborators with a coordinator (Fonte=motore). */
import { useState } from "react";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import type { EngineTeam } from "@/lib/engine-projects-client";
import { createEngineTeam, updateEngineTeam } from "@/lib/engine-projects-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationAvatar } from "./ConversationAvatar";
import { ConversationSelectField } from "./ConversationSelect";
import "./engine-teams.css";

type Draft = { name: string; memberIds: string[]; coordinatorId: string };

function draftOf(team: EngineTeam | null): Draft {
  return {
    name: team?.name ?? "",
    memberIds: team?.member_ids ?? [],
    coordinatorId: team?.coordinator_id ?? "",
  };
}

export function EngineWorkspaceTeams({
  teams,
  agents,
  onChanged,
}: {
  teams: EngineTeam[];
  agents: EngineAgentProfile[];
  onChanged?: (() => Promise<void>) | undefined;
}) {
  const active = agents.filter((agent) => agent.status === "active");
  const [editing, setEditing] = useState<string | null>(null); // "new" | team id
  const refresh = onChanged ?? (async () => {});

  function agentName(id: string) {
    return active.find((agent) => agent.id === id)?.name ?? "Collaboratore";
  }

  return (
    <section className="cw-workspace cw-teams-panel" aria-label="Team">
      <div className="cw-panel-top">
        <h2>Team</h2>
        <span className="cw-hint">
          {teams.length} {teams.length === 1 ? "team" : "team"}
        </span>
      </div>
      <p className="cw-hint">
        Un team raggruppa collaboratori per i lavori di squadra: il coordinatore è il riferimento
        dei passaggi che richiedono una firma unica.
      </p>
      {editing === "new" ? (
        <EngineTeamEditor
          team={null}
          agents={active}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh(); }}
        />
      ) : (
        <button type="button" className="cw-secondary" disabled={active.length < 2}
          onClick={() => setEditing("new")}>
          Crea un team
        </button>
      )}
      {active.length < 2 && editing !== "new" && (
        <p className="cw-hint">Servono almeno due collaboratori per un team.</p>
      )}
      <div className="cw-teams-grid">
        {teams.map((team) => (
          <article key={team.id} className="cw-team-card">
            <header>
              <h3>{team.name}</h3>
              {team.coordinator_id && (
                <span className="cw-team-coordinator">
                  Coordinatore: {agentName(team.coordinator_id)}
                </span>
              )}
            </header>
            <div className="cw-team-members">
              {team.member_ids.map((id) => (
                <span key={id} className="cw-team-member">
                  <ConversationAvatar name={agentName(id)} />
                  {agentName(id)}
                </span>
              ))}
            </div>
            {editing === team.id ? (
              <EngineTeamEditor
                team={team}
                agents={active}
                onCancel={() => setEditing(null)}
                onSaved={async () => { setEditing(null); await refresh(); }}
                onArchived={async () => { setEditing(null); await refresh(); }}
              />
            ) : (
              onChanged && (
                <button type="button" className="cs-link" onClick={() => setEditing(team.id)}>
                  Modifica team
                </button>
              )
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function EngineTeamEditor({
  team,
  agents,
  onCancel,
  onSaved,
  onArchived,
}: {
  team: EngineTeam | null;
  agents: EngineAgentProfile[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onArchived?: (() => Promise<void>) | undefined;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(team?.member_ids ?? []);
  const [coordinatorId, setCoordinatorId] = useState(team?.coordinator_id ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function toggleMember(id: string) {
    setMemberIds((current) => {
      const next = current.includes(id) ? current.filter((m) => m !== id) : [...current, id];
      setCoordinatorId((coord) => (next.includes(coord) ? coord : ""));
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (team) {
        await updateEngineTeam({
          teamId: team.id,
          expectedVersion: team.revision,
          name: name.trim(),
          memberIds,
          coordinatorId: coordinatorId || null,
        });
      } else {
        await createEngineTeam({
          name: name.trim(),
          memberIds,
          coordinatorId: coordinatorId || null,
        });
      }
      await onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (saving || !team) return;
    setSaving(true);
    setError(null);
    try {
      await updateEngineTeam({
        teamId: team.id,
        expectedVersion: team.revision,
        status: "archived",
      });
      await (onArchived ?? onSaved)();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="cw-team-editor" aria-label={team ? `Modifica ${team.name}` : "Nuovo team"}
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>
        Nome del team
        <input value={name} maxLength={80} disabled={saving}
          onChange={(event) => setName(event.target.value)} />
      </label>
      <fieldset className="cw-team-editor__members">
        <legend>Membri</legend>
        {agents.map((agent) => (
          <label key={agent.id}>
            <input type="checkbox" checked={memberIds.includes(agent.id)} disabled={saving}
              onChange={() => toggleMember(agent.id)} />
            {agent.name}
          </label>
        ))}
      </fieldset>
      <label>
        Coordinatore
        <ConversationSelectField aria-label="Coordinatore del team" value={coordinatorId} disabled={saving}
          onChange={(event) => setCoordinatorId(event.target.value)}>
          <option value="">Nessuno (collaborativi)</option>
          {memberIds.map((id) => (
            <option key={id} value={id}>
              {agents.find((agent) => agent.id === id)?.name ?? id}
            </option>
          ))}
        </ConversationSelectField>
      </label>
      <div className="cs-actions">
        <button className="cw-primary" disabled={saving || !name.trim() || memberIds.length < 1}>
          {saving ? "Sto salvando…" : team ? "Salva team" : "Crea team"}
        </button>
        <button type="button" className="cw-secondary" disabled={saving} onClick={onCancel}>
          Annulla
        </button>
      </div>
      {team && onArchived && (
        confirmingArchive ? (
          <div className="cs-actions">
            <button type="button" className="cw-secondary" disabled={saving} onClick={() => void archive()}>
              {saving ? "Sto archiviando…" : "Sì, archivia"}
            </button>
            <button type="button" className="cs-link" disabled={saving} onClick={() => setConfirmingArchive(false)}>
              Annulla
            </button>
          </div>
        ) : (
          <button type="button" className="cs-link" disabled={saving} onClick={() => setConfirmingArchive(true)}>
            Archivia team
          </button>
        )
      )}
      {saving && <p role="status">Salvataggio in corso…</p>}
      <HomunErrorNotice error={error} />
    </form>
  );
}
