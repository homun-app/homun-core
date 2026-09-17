import { ConversationAvatar } from "./ConversationAvatar";
import { useState } from "react";
import { ArrowLeft, Check, Pencil, Plus, X } from "lucide-react";
import { ConversationPluginCatalog } from "./ConversationPluginCatalog";
import { type MemberProfile } from "./conversation-members";
export function ConversationMember({
  name,
  profile,
  onChange,
  onAssign,
  onBack,
  onDelete,
  impact,
}: {
  name: string;
  profile: MemberProfile;
  onChange: (profile: MemberProfile) => void;
  onAssign: () => void;
  onBack: () => void;
  onDelete: () => void;
  impact: string;
}) {
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile);
  const [plugins, setPlugins] = useState(false);
  const human = profile.kind === "human";
  return (
    <>
      <button className="cs-link" onClick={onBack}>
        <ArrowLeft size={14} /> Torna alla squadra
      </button>
      <div className="cs-heading">
        <ConversationAvatar name={name} human={human} large />
        <h2>{name}</h2>
        <span className="cs-badge">{human ? "Persona" : "Agente AI"}</span>
      </div>
      {(!human || profile.invitation !== "pending") && (
        <button className="cw-primary" onClick={onAssign}>
          Affida un lavoro
        </button>
      )}
      {human && (
        <>
          <p className="cw-hint">{profile.email || "Membro della squadra"}</p>
          {profile.invitation === "pending" ? (
            <>
              <span className="cs-badge">Invito in attesa · demo</span>
              <p className="cw-hint">
                Nessun invito è stato inviato. Simula l’accettazione per provare l’ingresso nel
                team.
              </p>
              <button
                className="cw-primary"
                onClick={() => onChange({ ...profile, invitation: "accepted" })}
              >
                Simula accettazione
              </button>
            </>
          ) : (
            <span className="cs-badge">Membro attivo{profile.invitation ? " · demo" : ""}</span>
          )}
        </>
      )}
      {deleting && (
        <div className="cs-delete-confirm">
          <h3>
            {human
              ? profile.invitation === "pending"
                ? "Revocare l’invito a"
                : "Rimuovere"
              : "Eliminare"}{" "}
            {name}?
          </h3>
          <p className="cw-hint">{impact}</p>
          <div className="cs-actions">
            <button className="cs-link" onClick={() => setDeleting(false)}>
              Annulla
            </button>
            <button className="cw-primary" onClick={onDelete}>
              {human ? "Conferma rimozione persona" : "Conferma eliminazione agente"}
            </button>
          </div>
        </div>
      )}
      {editing ? (
        <>
          <label>
            Ruolo
            <input
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            />
          </label>
          <label>
            Curriculum
            <textarea
              rows={5}
              value={draft.bio}
              onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
            />
          </label>
          <label>
            Specializzazioni
            <input
              value={draft.skills.join(", ")}
              onChange={(e) =>
                setDraft({ ...draft, skills: e.target.value.split(",").map((s) => s.trim()) })
              }
            />
            <small>Separate da una virgola</small>
          </label>
          {!human && (
            <label>
              Come comunica
              <textarea
                rows={2}
                value={draft.tone}
                onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
              />
            </label>
          )}
          <div className="cs-actions">
            <button className="cs-link" onClick={() => setEditing(false)}>
              Annulla
            </button>
            <button
              className="cw-primary"
              disabled={!draft.role.trim()}
              onClick={() => {
                onChange({ ...draft, skills: draft.skills.filter(Boolean) });
                setEditing(false);
              }}
            >
              Salva profilo <Check size={14} />
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{profile.role}</p>
          <h3>Di cosa si occupa</h3>
          <p className="cw-hint">
            {profile.bio || "Aggiungi una descrizione del ruolo e delle esperienze."}
          </p>
          <h3>Specializzazioni</h3>
          <div className="cs-members">
            {profile.skills.map((s) => (
              <span className="cs-badge" key={s}>
                {s}
              </span>
            ))}
          </div>
          {!human && (
            <>
              <h3>Come comunica</h3>
              <p className="cw-hint">{profile.tone}</p>
            </>
          )}
          <button
            className="cs-link"
            onClick={() => {
              setDraft(profile);
              setEditing(true);
              setPlugins(false);
            }}
          >
            <Pencil size={14} /> Modifica curriculum
          </button>
          {!human && (
            <>
              <div className="cs-heading">
                <h3>Plugin</h3>
                <button className="cs-link" onClick={() => setPlugins(!plugins)}>
                  <Plus size={14} /> Collega
                </button>
              </div>
              {profile.plugins.length ? (
                profile.plugins.map((p) => (
                  <div className="cs-plugin" key={p}>
                    <span>
                      <strong>{p}</strong>
                      <small>Assegnato · connessione da configurare</small>
                    </span>
                    <button
                      aria-label={`Scollega ${p}`}
                      className="cs-link"
                      onClick={() =>
                        onChange({ ...profile, plugins: profile.plugins.filter((x) => x !== p) })
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <p className="cw-hint">Nessuno strumento assegnato.</p>
              )}
              {plugins && (
                <ConversationPluginCatalog
                  target={name}
                  assigned={profile.plugins}
                  onAdd={(plugin) =>
                    onChange({ ...profile, plugins: [...new Set([...profile.plugins, plugin])] })
                  }
                  onClose={() => setPlugins(false)}
                />
              )}
              <p className="cw-hint">
                Assegnare un plugin non concede accesso ai dati. Connessioni e permessi sono da
                configurare nel motore.
              </p>
            </>
          )}
        </>
      )}
      {name !== "Fabio" && !editing && !deleting && (
        <div className="cs-actions">
          <button className="cs-link" onClick={() => setDeleting(true)}>
            {human
              ? profile.invitation === "pending"
                ? "Revoca invito"
                : "Rimuovi persona"
              : "Elimina agente"}
          </button>
        </div>
      )}
    </>
  );
}
