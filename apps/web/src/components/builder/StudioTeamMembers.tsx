import type { AutonomyMode } from "../../lib/studio-supervision";
import { useState, useEffect, useRef, type DragEvent, type ReactNode } from "react";
import { GripVertical, Plus, X, Star } from "lucide-react";
import { StudioMemberCard, StudioMemberProfile } from "./StudioMemberCard";
import { matchesMember, type StudioMember } from "../../lib/studio-members";
export type TeamMember = StudioMember;
const memberType = "application/x-homun-member";
export function StudioTeamMembers({
  members,
  chosen,
  onChange,
  avatar,
  leader,
  onLeader,
  onAutonomy,
}: {
  leader: string;
  onLeader: (id: string) => void;
  onAutonomy: (id: string, mode: AutonomyMode) => void;
  members: TeamMember[];
  chosen: string[];
  onChange: (ids: string[]) => void;
  avatar?: (id: string) => ReactNode;
}) {
  const detailRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => {
    if (detail) detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [detail]);
  const [over, setOver] = useState<"team" | "available" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const normalized = query.trim().toLocaleLowerCase("it");
  const selected = members.filter((m) => chosen.includes(m.id));
  const available = members.filter((m) => !chosen.includes(m.id) && matchesMember(m, normalized));
  const person = members.find((m) => m.id === detail);
  function move(id: string, add: boolean) {
    const member = members.find((m) => m.id === id);
    if (!member) return;
    onChange(add ? [...new Set([...chosen, id])] : chosen.filter((value) => value !== id));
    setAnnouncement(`${member.name} ${add ? "aggiunto al" : "rimosso dal"} team.`);
  }
  function drop(e: DragEvent, destination: "team" | "available") {
    e.preventDefault();
    setOver(null);
    move(e.dataTransfer.getData(memberType), destination === "team");
  }
  function card(member: TeamMember, inTeam: boolean) {
    return (
      <div
        className="st-team-draggable"
        key={member.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(memberType, member.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setOver(null)}
      >
        <GripVertical size={14} className="st-drag-grip" aria-hidden="true" />
        <StudioMemberCard member={member} avatar={avatar?.(member.id)} onInspect={setDetail}>
          {inTeam && (
            <button
              type="button"
              className="st-leader-star"
              aria-label={`Coordinatore ${member.name}`}
              title={leader === member.id ? "Rimuovi coordinatore" : "Nomina coordinatore"}
              aria-pressed={leader === member.id}
              onClick={() => onLeader(leader === member.id ? "" : member.id)}
            >
              <Star size={17} fill={leader === member.id ? "currentColor" : "none"} />
            </button>
          )}
          <button
            type="button"
            className="st-icon"
            aria-label={`${inTeam ? "Rimuovi" : "Aggiungi"} ${member.name} ${inTeam ? "dal" : "al"} team`}
            onClick={() => move(member.id, !inTeam)}
          >
            {inTeam ? <X size={16} /> : <Plus size={16} />}
          </button>
        </StudioMemberCard>
      </div>
    );
  }
  return (
    <div className="st-team-composition">
      <p className="st-muted">
        Trascina i collaboratori nel team oppure usa +. Seleziona un nome per conoscerne il profilo.
      </p>
      <p className="st-team-supervision" role="status">
        {leader
          ? `★ ${members.find((m) => m.id === leader)?.name} coordina e segue gli stagisti.${leader.startsWith("user:") ? "" : " Prima verifica dell’agente; approvazione finale a una persona."}`
          : "Scegli la stellina per nominare un coordinatore. Senza coordinatore, le revisioni arrivano a te."}
      </p>
      <div className="st-team-columns">
        {(["available", "team"] as const).map((zone) => (
          <section
            key={zone}
            aria-label={zone === "team" ? "Membri del team" : "Collaboratori disponibili"}
            className={`st-member-zone ${over === zone ? "is-over" : ""}`}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(memberType)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(zone);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => drop(e, zone)}
          >
            <h4>{zone === "team" ? `Nel team · ${selected.length}` : "Disponibili"}</h4>
            {zone === "available" && (
              <input
                aria-label="Cerca collaboratori per il team"
                placeholder="Nome, ruolo o specializzazione…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <div className="st-member-candidates">
              {(zone === "team" ? selected : available).map((m) => card(m, zone === "team"))}
              {!(zone === "team" ? selected : available).length && (
                <p className="st-member-empty">
                  {zone === "team"
                    ? "Trascina qui persone e agenti."
                    : normalized
                      ? "Nessun collaboratore trovato."
                      : "Hai aggiunto tutti i collaboratori."}
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
      <span className="sr-only" role="status">
        {announcement}
      </span>
      {person && (
        <section
          ref={detailRef}
          className="st-member-cv"
          aria-label={`Curriculum di ${person.name}`}
        >
          <header>
            <div>
              <small>
                {person.id.startsWith("user:") ? "Persona" : "Agente AI"} · Profilo professionale
              </small>
              <h3>{person.name}</h3>
              <p>{person.role}</p>
            </div>
            <button
              type="button"
              className="st-icon"
              aria-label="Chiudi curriculum"
              onClick={() => setDetail(null)}
            >
              <X size={16} />
            </button>
          </header>
          {!person.id.startsWith("user:") && (
            <label>
              Autonomia predefinita
              <select
                aria-label={`Autonomia di ${person.name}`}
                value={person.autonomy || "stage"}
                onChange={(e) => onAutonomy(person.id, e.target.value as AutonomyMode)}
              >
                <option value="stage">In stage</option>
                <option value="review">Con revisione</option>
                <option value="autonomous">Autonomo</option>
              </select>
              <small>
                Si applica ai nuovi incarichi dopo Salva team. I lavori esistenti e le regole
                specifiche dell’attività restano invariati.
              </small>
            </label>
          )}
          <StudioMemberProfile member={person} />
        </section>
      )}
    </div>
  );
}
