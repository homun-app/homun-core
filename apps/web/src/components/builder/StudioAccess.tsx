import { StudioMemberPicker } from "./StudioMemberPicker";
import { useState } from "react";
import { LockKeyhole, Plus, ShieldCheck } from "lucide-react";
export type SpaceRole = "owner" | "admin" | "member" | "guest";
export type SpaceUser = {
  id: string;
  name: string;
  email: string;
  role: SpaceRole;
  status: "active" | "pending" | "suspended";
};
export const initialSpaceUsers: SpaceUser[] = [
  { id: "fabio", name: "Fabio", email: "fabio@example.test", role: "owner", status: "active" },
  { id: "giulia", name: "Giulia", email: "giulia@example.test", role: "member", status: "active" },
  {
    id: "cliente",
    name: "Cliente demo",
    email: "cliente@example.test",
    role: "guest",
    status: "active",
  },
];
export const spaceRoles: Record<SpaceRole, string> = {
  owner: "Proprietario",
  admin: "Amministratore",
  member: "Collaboratore",
  guest: "Ospite / cliente",
};
export function StudioAccess({
  users,
  onChange,
}: {
  users: SpaceUser[];
  onChange: (users: SpaceUser[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SpaceRole>("member");
  const [error, setError] = useState("");
  function invite() {
    if (!name.trim() || !email.trim()) return;
    if (users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
      setError("Questa email è già presente nello spazio.");
      return;
    }
    onChange([
      ...users,
      { id: `user-${Date.now()}`, name: name.trim(), email: email.trim(), role, status: "pending" },
    ]);
    setAdding(false);
    setName("");
    setEmail("");
    setError("");
  }
  return (
    <>
      <div className="st-section-head" style={{ marginTop: 0 }}>
        <div>
          <span className="st-eyebrow">IMPOSTAZIONI DELLO SPAZIO</span>
          <h1>Persone e accessi.</h1>
        </div>
        <button className="st-btn dark" onClick={() => setAdding(!adding)}>
          <Plus size={16} />
          {adding ? "Chiudi" : "Prepara un invito"}
        </button>
      </div>
      <p className="st-intro">
        Decidi chi può entrare e con quale ruolo. Progetti e bot hanno regole più specifiche.
      </p>
      <div className="st-soft-note">
        <ShieldCheck size={18} /> Stai configurando una demo come proprietario. Nessun invito viene
        inviato e nessun permesso reale viene applicato.
      </div>
      {adding && (
        <form
          className="st-paper st-access-form"
          onSubmit={(e) => {
            e.preventDefault();
            invite();
          }}
        >
          <h2>Invito dimostrativo</h2>
          <label>
            Nome della persona
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Email della persona
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Ruolo nell’invito
            <select value={role} onChange={(e) => setRole(e.target.value as SpaceRole)}>
              <option value="member">Collaboratore</option>
              <option value="admin">Amministratore</option>
              <option value="guest">Ospite / cliente</option>
            </select>
          </label>
          {error && <p role="alert">{error}</p>}
          <button className="st-btn dark">Salva bozza di invito</button>
        </form>
      )}
      <div className="st-access-list st-paper">
        {users.map((user) => (
          <div className="st-access-row" key={user.id}>
            <span className="st-access-avatar">{user.name.slice(0, 1)}</span>
            <div className="st-access-person">
              <strong>{user.name}</strong>
              <small>{user.email}</small>
              <span className="st-muted">
                {user.status === "pending"
                  ? "Invito in bozza · non inviato"
                  : user.status === "suspended"
                    ? "Accesso sospeso · demo"
                    : "Persona demo attiva"}
              </span>
            </div>
            {user.role === "owner" ? (
              <span className="st-role-fixed">
                <LockKeyhole size={13} /> Proprietario
              </span>
            ) : (
              <>
                <label>
                  Ruolo di {user.name}
                  <select
                    value={user.role}
                    onChange={(e) =>
                      onChange(
                        users.map((u) =>
                          u.id === user.id ? { ...u, role: e.target.value as SpaceRole } : u,
                        ),
                      )
                    }
                  >
                    <option value="admin">Amministratore</option>
                    <option value="member">Collaboratore</option>
                    <option value="guest">Ospite / cliente</option>
                  </select>
                </label>
                {user.status !== "pending" && (
                  <button
                    className="st-text-link"
                    onClick={() =>
                      onChange(
                        users.map((u) =>
                          u.id === user.id
                            ? { ...u, status: u.status === "suspended" ? "active" : "suspended" }
                            : u,
                        ),
                      )
                    }
                  >
                    {user.status === "suspended" ? "Ripristina accesso" : "Sospendi accesso"}
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <details className="st-paper st-access-help">
        <summary>Cosa permette ogni ruolo?</summary>
        <div className="st-role-grid">
          {[
            ["Proprietario", "Controllo dello spazio, persone, ruoli e configurazioni."],
            [
              "Amministratore",
              "Gestione di persone, bot e collegamenti; accesso ai progetti solo se condivisi.",
            ],
            ["Collaboratore", "Lavoro nei progetti assegnati, secondo i permessi del progetto."],
            ["Ospite / cliente", "Accesso ai soli contenuti di progetto esplicitamente condivisi."],
          ].map(([title, description]) => (
            <div key={title}>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          ))}
        </div>
        <p className="st-muted">
          Il proprietario mantiene il controllo. Ruoli e sospensioni sono descrizioni di policy:
          questo prototipo non implementa autorizzazioni server.
        </p>
      </details>
    </>
  );
}
export type ProjectGrant = {
  level: "none" | "view" | "work" | "manage";
  documents: boolean;
  conversation: boolean;
  approve: boolean;
};
const emptyGrant: ProjectGrant = {
  level: "none",
  documents: false,
  conversation: false,
  approve: false,
};
export function ProjectSharing({
  users,
  grants,
  onChange,
}: {
  users: SpaceUser[];
  grants: Record<string, ProjectGrant>;
  onChange: (grants: Record<string, ProjectGrant>) => void;
}) {
  return (
    <section className="st-paper st-project-section">
      <h2>Persone e accessi del progetto</h2>
      <p className="st-muted" style={{ marginTop: 10 }}>
        Accesso esplicito per persona. L’accesso al progetto non concede automaticamente documenti,
        conversazioni o approvazioni.
      </p>
      {users.map((u) => {
        const grant = grants[u.id] || emptyGrant;
        const blocked = u.status !== "active";
        return (
          <div className="st-sharing-row" key={u.id}>
            <div>
              <strong>{u.name}</strong>
              <small>
                {spaceRoles[u.role]}
                {blocked ? ` · ${u.status === "pending" ? "invito non inviato" : "sospeso"}` : ""}
              </small>
            </div>
            {u.role === "owner" ? (
              <span className="st-role-fixed">
                <LockKeyhole size={13} /> Gestione completa
              </span>
            ) : (
              <div>
                <label>
                  Accesso di {u.name}
                  <select
                    disabled={blocked}
                    value={grant.level}
                    onChange={(e) => {
                      const level = e.target.value as ProjectGrant["level"];
                      onChange({
                        ...grants,
                        [u.id]:
                          level === "none"
                            ? { ...emptyGrant }
                            : {
                                ...grant,
                                level,
                                approve: level === "view" ? false : grant.approve,
                              },
                      });
                    }}
                  >
                    <option value="none">Nessun accesso</option>
                    <option value="view">Può vedere</option>
                    <option value="work">Può lavorare</option>
                    <option value="manage">Può gestire</option>
                  </select>
                </label>
                {grant.level !== "none" && (
                  <div className="st-permission-checks">
                    {(
                      [
                        ["documents", "Documenti"],
                        ["conversation", "Conversazione"],
                        ["approve", "Approvare azioni"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          disabled={blocked || (key === "approve" && grant.level === "view")}
                          checked={grant[key]}
                          onChange={(e) =>
                            onChange({ ...grants, [u.id]: { ...grant, [key]: e.target.checked } })
                          }
                        />
                        {label} · {u.name}
                      </label>
                    ))}
                  </div>
                )}
                {blocked && (
                  <p className="st-muted">
                    Nessun accesso effettivo previsto finché la persona non è attiva.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="st-soft-note">
        <ShieldCheck size={18} /> Policy proposta: bot e memoria devono rispettare questi confini
        anche nei passaggi di lavoro. Non applicata dal motore in questa demo.
      </div>
    </section>
  );
}
export type BotAccessPolicy = {
  operators: string[];
  approver: string;
  actions: Record<string, string>;
};
export function BotAccess({
  name,
  tools,
  users,
  policy,
  onChange,
}: {
  name: string;
  tools: string[];
  users: SpaceUser[];
  policy: BotAccessPolicy;
  onChange: (policy: BotAccessPolicy) => void;
}) {
  return (
    <section className="st-paper st-bot-access">
      <h2>Accessi e autonomia</h2>
      <p className="st-muted" style={{ marginTop: 10 }}>
        Regole proposte per {name}. Il progetto può restringere ulteriormente gli accessi.
      </p>
      <h3 style={{ marginTop: 24 }}>Chi può assegnargli lavoro</h3>
      <StudioMemberPicker
        multiple
        label="Chi può assegnare lavoro"
        options={users
          .filter((u) => u.role !== "owner" && u.role !== "guest" && u.status === "active")
          .map((u) => ({ id: "user:" + u.id, name: u.name }))}
        value={policy.operators.map((id) => "user:" + id)}
        onChange={(ids) =>
          onChange({ ...policy, operators: ids.map((id) => id.replace(/^user:/, "")) })
        }
      />

      <p className="st-muted">
        Il proprietario può assegnare lavoro. Gli ospiti operano solo nel contesto dei progetti
        condivisi.
      </p>
      <h3 style={{ marginTop: 24 }}>Azioni per strumento</h3>
      {tools.map((tool) => (
        <label key={tool}>
          {tool}
          <select
            value={tool.includes("sola lettura") ? "read" : policy.actions[tool] || "review"}
            disabled={tool.includes("sola lettura")}
            onChange={(e) =>
              onChange({ ...policy, actions: { ...policy.actions, [tool]: e.target.value } })
            }
          >
            <option value="read">Solo consultazione</option>
            <option value="draft">Prepara bozze, senza applicare</option>
            <option value="review">Chiedi approvazione prima di agire</option>
            <option value="blocked">Non consentito</option>
          </select>
        </label>
      ))}
      {!tools.length && (
        <p className="st-muted" style={{ marginTop: 10 }}>
          Aggiungi strumenti dal marketplace per definirne le regole.
        </p>
      )}
      <StudioMemberPicker
        label="Responsabile delle approvazioni"
        options={users
          .filter((u) => u.status === "active" && (u.role === "owner" || u.role === "admin"))
          .map((u) => ({ id: "user:" + u.id, name: u.name }))}
        value={policy.approver ? ["user:" + policy.approver] : []}
        emptyLabel="Da scegliere · azioni in attesa"
        onChange={(ids) =>
          onChange({ ...policy, approver: (ids.at(-1) || "").replace(/^user:/, "") })
        }
      />

      <div className="st-soft-note">
        <ShieldCheck size={18} /> Un plugin assegnato non concede accesso a tutti gli account.
        Collegamenti, risorse autorizzate e verifiche effettive saranno gestiti dal motore.
      </div>
    </section>
  );
}
