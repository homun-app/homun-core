/** Engine teams: grouping collaborators with a coordinator (Fonte=motore). */
import { useState } from "react";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import type { EngineTeam } from "@/lib/engine-projects-client";
import { createEngineTeam, updateEngineTeam } from "@/lib/engine-projects-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationAvatar } from "./ConversationAvatar";
import { ConversationSelectField } from "./ConversationSelect";
import { Users, Plus, Pencil } from "lucide-react";
import "./engine-teams.css";

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
    <section className="cw-teams-panel" aria-label="Team">
      <div className="cw-squad-section-head">
        <div className="cw-squad-section-title">
          <span>Team</span>
          <span className="cw-squad-section-count">{teams.length}</span>
        </div>
        {editing !== "new" && active.length >= 2 && (
          <button
            type="button"
            className="cw-squad-btn-subtle"
            onClick={() => setEditing("new")}
          >
            <Plus size={13} />
            <span>Nuovo team</span>
          </button>
        )}
      </div>

      {editing === "new" ? (
        <EngineTeamEditor
          team={null}
          agents={active}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      ) : teams.length === 0 ? (
        <div className="ph-overview-empty">
          <span>
            {active.length < 2
              ? "Servono almeno due collaboratori per creare un team."
              : "Nessun team configurato. I team raggruppano collaboratori attorno a un coordinatore."}
          </span>
        </div>
      ) : null}

      <div className="cw-teams-grid">
        {teams.map((team) => (
          <article key={team.id} className="cw-team-card">
            <header className="cw-team-card__head">
              <div>
                <h3>{team.name}</h3>
                {team.coordinator_id && (
                  <span className="cw-team-coordinator">
                    Coordinatore: <strong>{agentName(team.coordinator_id)}</strong>
                  </span>
                )}
              </div>
              {editing !== team.id && onChanged && (
                <button
                  type="button"
                  className="cw-agent-card__edit-btn"
                  onClick={() => setEditing(team.id)}
                >
                  <Pencil size={13} />
                  <span>Modifica</span>
                </button>
              )}
            </header>
            <div className="cw-team-members">
              {team.member_ids.map((id) => (
                <span key={id} className="cw-team-member-chip">
                  <ConversationAvatar name={agentName(id)} />
                  <span>{agentName(id)}</span>
                </span>
              ))}
            </div>
            {editing === team.id && (
              <EngineTeamEditor
                team={team}
                agents={active}
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                  setEditing(null);
                  await refresh();
                }}
                onArchived={async () => {
                  setEditing(null);
                  await refresh();
                }}
              />
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
    <form
      className="cw-team-editor"
      aria-label={team ? `Modifica ${team.name}` : "Nuovo team"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <HomunErrorNotice error={error} />
      <label>
        Nome del team
        <input
          value={name}
          maxLength={80}
          disabled={saving}
          placeholder="es. Analisi Commerciale"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset className="cw-team-editor__members">
        <legend>Membri del team</legend>
        {agents.map((agent) => (
          <label key={agent.id}>
            <input
              type="checkbox"
              checked={memberIds.includes(agent.id)}
              disabled={saving}
              onChange={() => toggleMember(agent.id)}
            />
            {agent.name}
          </label>
        ))}
      </fieldset>
      <label>
        Coordinatore
        <ConversationSelectField
          aria-label="Coordinatore del team"
          value={coordinatorId}
          disabled={saving}
          onChange={(event) => setCoordinatorId(event.target.value)}
        >
          <option value="">Nessuno (collaborativi)</option>
          {memberIds.map((id) => (
            <option key={id} value={id}>
              {agents.find((agent) => agent.id === id)?.name ?? id}
            </option>
          ))}
        </ConversationSelectField>
      </label>
      <div className="cw-team-editor__actions">
        <button
          type="submit"
          className="cw-squad-btn-primary"
          disabled={saving || !name.trim() || memberIds.length < 1}
        >
          {saving ? "Sto salvando…" : team ? "Salva team" : "Crea team"}
        </button>
        <button type="button" className="cw-squad-btn-subtle" disabled={saving} onClick={onCancel}>
          Annulla
        </button>
        {team &&
          onArchived &&
          (confirmingArchive ? (
            <div className="cw-team-editor__actions">
              <button
                type="button"
                className="cw-squad-btn-subtle"
                disabled={saving}
                onClick={() => void archive()}
              >
                {saving ? "Sto archiviando…" : "Sì, archivia"}
              </button>
              <button
                type="button"
                className="cs-link"
                disabled={saving}
                onClick={() => setConfirmingArchive(false)}
              >
                Annulla
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="cs-link"
              disabled={saving}
              onClick={() => setConfirmingArchive(true)}
            >
              Archivia team
            </button>
          ))}
      </div>
      {saving && <p role="status">Salvataggio in corso…</p>}
    </form>
  );
}
