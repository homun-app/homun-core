import { useState } from "react";
import { Info, Check } from "lucide-react";
import { ConversationAvatar } from "./ConversationAvatar";
import { memberProfile, isHumanMember, type MemberProfile } from "./conversation-members";
export function ConversationMemberPicker({
  people,
  profiles,
  selected,
  onChange,
  label = "Cerca collaboratori",
}: {
  people: string[];
  profiles?: Record<string, MemberProfile> | undefined;
  selected: string[];
  onChange: (names: string[]) => void;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState("");
  const matches = people.filter((n) => {
    const p = memberProfile(n, profiles);
    return [n, p.role, p.bio, ...p.skills].join(" ").toLowerCase().includes(query.toLowerCase());
  });
  return (
    <div className="cv-member-picker">
      <input
        aria-label={label}
        placeholder="Nome, ruolo o specializzazione…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="cv-member-options">
        {matches.map((n) => {
          const p = memberProfile(n, profiles),
            human = isHumanMember(n, profiles),
            chosen = selected.includes(n);
          return (
            <div className="cv-member-option" key={n}>
              <div className="cv-member-choice">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={chosen}
                  aria-label={"Seleziona " + n}
                  disabled={p.invitation === "pending"}
                  onClick={() =>
                    onChange(chosen ? selected.filter((s) => s !== n) : [...selected, n])
                  }
                >
                  <ConversationAvatar name={n} human={human} />
                  <span>
                    <strong>
                      {n}
                      <small>{human ? "Persona" : "Agente AI"}</small>
                    </strong>
                    <span>{p.role}</span>
                    <em>{p.skills.slice(0, 2).join(" · ")}</em>
                  </span>
                  <span className="cv-member-tick">{chosen && <Check size={14} />}</span>
                </button>
                <button
                  type="button"
                  className="cv-member-info"
                  aria-label={"Scheda di " + n}
                  aria-expanded={detail === n}
                  onClick={() => setDetail(detail === n ? "" : n)}
                >
                  <Info size={16} />
                </button>
              </div>
              {detail === n && (
                <div className="cv-member-cv">
                  <strong>Di cosa si occupa</strong>
                  <p>{p.bio || "Descrizione non ancora compilata."}</p>
                  <strong>Specializzazioni</strong>
                  <p>{p.skills.join(" · ") || "Non ancora indicate"}</p>
                  {!!p.plugins.length && (
                    <>
                      <strong>Strumenti</strong>
                      <p>{p.plugins.join(" · ")}</p>
                    </>
                  )}
                  {!!p.tone && (
                    <>
                      <strong>Come comunica</strong>
                      <p>{p.tone}</p>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!matches.length && <p className="cw-hint">Nessun collaboratore trovato.</p>}
      </div>
    </div>
  );
}
