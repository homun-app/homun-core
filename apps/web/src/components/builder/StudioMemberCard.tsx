import { useContext, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { StudioMembersContext, type StudioMember } from "../../lib/studio-members";
import { autonomyLabels } from "../../lib/studio-autonomy";
export function StudioMemberCard({
  member,
  children,
  avatar,
  onInspect,
}: {
  member: StudioMember;
  children?: ReactNode;
  avatar?: ReactNode;
  onInspect?: (id: string) => void;
}) {
  const directory = useContext(StudioMembersContext);
  const person = { ...directory.find((p) => p.id === member.id), ...member };
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="st-member-card st-member-card-shared">
        {avatar ||
          (person.id.startsWith("user:") ? (
            <span className="st-profile-avatar" aria-hidden="true">
              {person.name.slice(0, 1)}
            </span>
          ) : (
            <span className={`st-face small ${person.color || "mint"}`} aria-hidden="true">
              <span className="st-eyes">
                <i />
                <i />
              </span>
            </span>
          ))}
        <button
          type="button"
          className="st-member-summary"
          aria-label={`Curriculum di ${person.name}`}
          aria-expanded={onInspect ? undefined : open}
          onClick={() => (onInspect ? onInspect(person.id) : setOpen(!open))}
        >
          <strong>{person.name}</strong>
          <small>
            {person.id.startsWith("user:") ? "Persona" : "Agente AI"}
            {person.role && person.role !== "Persona" ? ` · ${person.role}` : ""}
          </small>
          {person.responsibility && (
            <span className="st-member-description">{person.responsibility}</span>
          )}
          {!person.id.startsWith("user:") && (
            <small className="st-autonomy-badge">
              {autonomyLabels[person.autonomy || "stage"]} · nuovi compiti
            </small>
          )}
        </button>
        {children}
      </div>
      {open && (
        <section
          className="st-member-cv st-member-mini"
          aria-label={`Curriculum di ${person.name}`}
        >
          <header>
            <h3>{person.name}</h3>
            <button
              type="button"
              className="st-icon"
              aria-label="Chiudi curriculum"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          <StudioMemberProfile member={person} />
        </section>
      )}
    </>
  );
}
export function StudioMemberProfile({ member: person }: { member: StudioMember }) {
  return (
    <div className="st-cv-grid">
      <div>
        <h4>Di cosa si occupa</h4>
        <p>{person.responsibility || "Responsabilità da definire."}</p>
      </div>
      <div>
        <h4>Specializzazioni</h4>
        {person.specializations?.length ? (
          <div className="st-tools">
            {person.specializations.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        ) : (
          <p className="st-muted">Non ancora indicate.</p>
        )}
      </div>
      {!!person.tools?.length && (
        <div>
          <h4>Strumenti previsti</h4>
          <div className="st-tools">
            {person.tools.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        </div>
      )}
      {!!person.method && (
        <div>
          <h4>Metodo di lavoro</h4>
          <ol>
            {person.method
              .split("\n")
              .filter(Boolean)
              .map((step, i) => (
                <li key={i}>{step}</li>
              ))}
          </ol>
        </div>
      )}
      {!!person.tone && (
        <div>
          <h4>Come comunica</h4>
          <p>{person.tone}</p>
        </div>
      )}
      {!person.id.startsWith("user:") && (
        <div>
          <h4>Formazione e autonomia</h4>
          {person.activities?.length ? (
            <ul>
              {person.activities.map((a) => (
                <li key={a.id}>
                  {a.title} · {a.scope} ·{" "}
                  {a.mode === "stage"
                    ? "In stage"
                    : a.mode === "review"
                      ? "Con revisione"
                      : "Autonomo"}
                </li>
              ))}
            </ul>
          ) : (
            <p>Le modalità dei singoli compiti possono differire da quella predefinita.</p>
          )}
        </div>
      )}
    </div>
  );
}
