import { ConversationSelectField } from "./ConversationSelect";
import { ConversationMemberPicker } from "./ConversationMemberPicker";
import { ConversationProjectChats, type ProjectChat } from "./ConversationProjectChats";
import { ConversationMember } from "./ConversationMember";
import { memberProfile, isHumanMember, type MemberProfile } from "./conversation-members";
import { useState } from "react";
import { StudioChatInput } from "./StudioChatInput";
import { ArrowUpRight, Plus, Check, Pause, Play } from "lucide-react";
export const spacePeople = ["Marta", "Vera", "Elio", "Giulia", "Fabio"];
export type SpaceTeam = {
  notes?: string[];
  id: string;
  name: string;
  members: string[];
  leader: string;
  brief: string;
};
export type SpaceProject = {
  chats?: ProjectChat[];
  notes?: string[];
  id: string;
  name: string;
  teamId: string;
  brief: string;
};
export type SpaceRoutine = {
  notes?: string[];
  id: string;
  name: string;
  workId: string;
  schedule: string;
  active: boolean;
};
export type SpaceData = {
  detachedChats?: ProjectChat[];
  installedPlugins?: string[];
  removedPeople?: string[];
  profiles?: Record<string, MemberProfile>;
  teams: SpaceTeam[];
  projects: SpaceProject[];
  routines: SpaceRoutine[];
};
export type SpaceView =
  | "Squadra"
  | "Progetti"
  | "Automazioni"
  | "Plugin"
  | "Materiali"
  | "Compiti"
  | "Nuovo collaboratore";
export type SpaceWork = {
  routineId?: string;
  startedAt?: string;
  runNumber?: number;
  status?: string;
  unavailable?: boolean;
  id: string;
  title: string;
  projectId?: string;
  phase: string;
};
export function ConversationSpace({
  onCreateMember,
  onAssign,
  onReveal,
  view,
  data,
  onChange,
  works,
  onWork,
  onProjectWork,
  projectMaterials,
  onMaterial,
  onRun,
  initial,
  selectedId,
}: {
  onCreateMember: () => void;
  onAssign: (name: string) => void;
  onReveal: () => void;
  view: "Squadra" | "Progetti" | "Automazioni";
  data: SpaceData;
  onChange: (data: SpaceData) => void;
  works: SpaceWork[];
  onWork: (id: string) => void;
  onProjectWork: (
    name: string,
    text: string,
    files: File[],
    projectId: string,
  ) => string | undefined;
  projectMaterials: { id: string; name: string; projectIds: string[] }[];
  onMaterial: (id: string) => void;
  onRun: (routine: SpaceRoutine) => void;
  initial?: string;
  selectedId?: string;
}) {
  const people = [...new Set([...spacePeople, ...Object.keys(data.profiles || {})])].filter(
    (n) => !data.removedPeople?.includes(n),
  );
  const [request, setRequest] = useState<{ text: string; files: File[]; projectId: string } | null>(
    null,
  );
  const [recipientQuery, setRecipientQuery] = useState("");
  const [draft, setDraft] = useState(initial || "");
  const [name, setName] = useState(
    initial?.match(/[«“"]([^»”"]+)[»”"]/)?.[1] ||
      (initial
        ? view === "Squadra"
          ? "Nuovo team"
          : view === "Progetti"
            ? "Nuovo progetto"
            : "Controllo ricorrente"
        : ""),
  );
  const [members, setMembers] = useState<string[]>(
    initial
      ? people.filter(
          (n) =>
            memberProfile(n, data.profiles).invitation !== "pending" &&
            initial.toLowerCase().includes(n.toLowerCase()),
        )
      : ["Marta", "Vera", "Giulia"].filter((n) => people.includes(n)),
  );
  const [leader, setLeader] = useState(members.includes("Marta") ? "Marta" : members[0] || "");
  const [teamId, setTeamId] = useState(data.teams[0]?.id || "");
  const [workId, setWorkId] = useState(works[0]?.id || "");
  const [schedule, setSchedule] = useState("Ogni lunedì alle 09:00 · Europe/Rome");
  const [selected, setSelectedValue] = useState(selectedId || "");
  function setSelected(id: string) {
    setSelectedValue(id);
    if (id) onReveal();
  }
  const [editingId, setEditingId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [returnTo, setReturnTo] = useState("");
  const [feedback, setFeedback] = useState("");
  const hasDraft = !!draft || !!editingId;
  const person = selected.startsWith("person:") ? selected.slice(7) : "";
  const team = data.teams.find((t) => t.id === selected);
  const detached = selected.startsWith("loose:");
  const project = detached
    ? {
        id: "",
        name: "Conversazioni senza progetto",
        brief: "",
        teamId: "",
        chats: data.detachedChats || [],
      }
    : data.projects.find((p) => p.id === selected);
  function moveChat(chatId: string, destination: string, create = false) {
    const chat = project?.chats?.find((c) => c.id === chatId);
    if (!chat) return;
    const id = create ? crypto.randomUUID() : destination;
    const projects = data.projects.map((p) => ({
      ...p,
      chats: (p.chats || []).filter((c) => c.id !== chatId),
    }));
    if (create) projects.push({ id, name: chat.title, brief: "", teamId: "", chats: [chat] });
    else if (id) {
      const target = projects.find((p) => p.id === id);
      if (!target) return;
      target.chats = [...(target.chats || []), chat];
    }
    onChange({
      ...data,
      projects,
      detachedChats: [
        ...(data.detachedChats || []).filter((c) => c.id !== chatId),
        ...(!id ? [chat] : []),
      ],
    });
    setSelected(id || "loose:" + chatId);
  }
  const routine = data.routines.find((r) => r.id === selected);
  const routineSource = routine ? works.find((w) => w.id === routine.workId) : undefined;
  function propose(text: string) {
    if (!text.trim()) return;
    setEditingId("");
    setDeleting(false);
    onReveal();
    setDraft(text);
    setSelected("");
    setFeedback("");
    setName(
      text.match(/[«“"]([^»”"]+)[»”"]/)?.[1] ||
        (view === "Squadra"
          ? "Squadra commerciale"
          : view === "Progetti"
            ? "Nuovo progetto"
            : "Controllo ricorrente"),
    );
    const found = people.filter(
      (n) =>
        memberProfile(n, data.profiles).invitation !== "pending" &&
        text.toLowerCase().includes(n.toLowerCase()),
    );
    if (found.length) {
      setMembers(found);
      setLeader(found.includes("Marta") ? "Marta" : found[0]!);
    }
  }
  function addNote(text: string) {
    const update = <T extends { id: string; notes?: string[] }>(items: T[]) =>
      items.map((item) =>
        item.id === selected ? { ...item, notes: [...(item.notes || []), text] } : item,
      );
    onChange({
      ...data,
      teams: update(data.teams),
      projects: update(data.projects),
      routines: update(data.routines),
    });
    setFeedback(
      "Messaggio conservato in questo spazio. In questa prova, modifica le impostazioni dal pannello destro.",
    );
  }
  function edit() {
    const item = team || project || routine;
    if (!item) return;
    setEditingId(item.id);
    setName(item.name);
    setDraft("brief" in item ? item.brief || "Modifica i dettagli" : "Modifica la ricorrenza");
    if (team) {
      setMembers(team.members);
      setLeader(team.leader);
    }
    if (project) setTeamId(project.teamId);
    if (routine) {
      setWorkId(routine.workId);
      setSchedule(routine.schedule);
    }
    setDeleting(false);
    setFeedback("");
  }
  function remove() {
    onChange({
      ...data,
      teams: data.teams.filter((t) => t.id !== selected),
      projects: data.projects
        .filter((p) => p.id !== selected)
        .map((p) => (p.teamId === selected ? { ...p, teamId: "" } : p)),
      routines: data.routines.filter((r) => r.id !== selected),
    });
    setSelected("");
    setDeleting(false);
    setFeedback("Elemento eliminato. Gli incarichi e i membri sono conservati.");
  }
  function save() {
    if (!name.trim()) return;
    const id = editingId || crypto.randomUUID();
    if (view === "Squadra")
      onChange({
        ...data,
        teams: editingId
          ? data.teams.map((t) =>
              t.id === id ? { ...t, name: name.trim(), members, leader, brief: draft } : t,
            )
          : [...data.teams, { id, name: name.trim(), members, leader, brief: draft }],
      });
    if (view === "Progetti")
      onChange({
        ...data,
        projects: editingId
          ? data.projects.map((p) =>
              p.id === id ? { ...p, name: name.trim(), teamId, brief: draft } : p,
            )
          : [...data.projects, { id, name: name.trim(), teamId, brief: draft }],
      });
    if (view === "Automazioni")
      onChange({
        ...data,
        routines: editingId
          ? data.routines.map((r) =>
              r.id === id ? { ...r, name: name.trim(), workId, schedule } : r,
            )
          : [...data.routines, { id, name: name.trim(), workId, schedule, active: true }],
      });
    setEditingId("");
    setSelected(id);
    setDraft("");
    setFeedback("Confermato. Lo ritrovi qui e nella ricerca globale.");
  }
  const examples: Record<"Squadra" | "Progetti" | "Automazioni", string> = {
    Squadra: "Crea il team “Commerciale” con Marta, Vera e Giulia. Marta coordina.",
    Progetti: "Crea il progetto “Lancio catalogo”: preparare il catalogo e studiare il mercato.",
    Automazioni: "Ripeti questo lavoro ogni lunedì alle 9 e chiedimi di verificare il risultato.",
  };
  return (
    <div className="cw-stage with-panel cs-stage">
      <section className="cw-conversation">
        {project && !hasDraft ? (
          <ConversationProjectChats
            key={selected}
            initialChat={detached ? selected.slice(6) : ""}
            projects={data.projects}
            onMoveChat={moveChat}
            project={project}
            works={works}
            people={people.filter((n) => memberProfile(n, data.profiles).invitation !== "pending")}
            materials={projectMaterials}
            onWork={onWork}
            onAssign={onProjectWork}
            onMaterial={onMaterial}
            onChange={(next) =>
              onChange({
                ...data,
                ...(detached
                  ? { detachedChats: next.chats || [] }
                  : { projects: data.projects.map((p) => (p.id === next.id ? next : p)) }),
              })
            }
          />
        ) : (
          <>
            <div className="cw-conversation-head">
              <span className="cw-avatar sage">h</span>
              <div>
                <strong>Homun</strong>
                <span>Organizziamo il tuo spazio</span>
              </div>
            </div>
            <div className="cw-history">
              <span className="cw-overline">{view.toUpperCase()}</span>
              <h1 className="cs-title">
                {view === "Squadra"
                  ? "Le persone giuste, insieme."
                  : view === "Progetti"
                    ? "Un obiettivo condiviso."
                    : "Un lavoro che continua."}
              </h1>
              <p className="cs-intro">
                {view === "Squadra"
                  ? "Persone e agenti nella stessa squadra, con un coordinatore riconoscibile."
                  : view === "Progetti"
                    ? "Collega una squadra e ritrova qui le sue conversazioni di lavoro."
                    : "Parti da un lavoro esistente. Le nuove esecuzioni avranno una propria conversazione."}
              </p>
              {view === "Squadra" && (
                <div className="cs-actions cs-create-actions" aria-label="Crea nella squadra">
                  <button
                    className="cw-secondary"
                    onClick={() => {
                      propose("Creiamo un nuovo team.");
                      setName("");
                      setMembers([]);
                      setLeader("");
                      setMemberQuery("");
                    }}
                  >
                    <Plus size={16} /> Crea team
                  </button>
                  <button className="cw-primary" onClick={onCreateMember}>
                    <Plus size={16} /> Crea collaboratore
                  </button>
                </div>
              )}
              {!hasDraft && !selected && (
                <button className="cs-example" onClick={() => propose(examples[view])}>
                  {examples[view]}
                  <ArrowUpRight size={17} />
                </button>
              )}
              {hasDraft && (
                <>
                  <article className="cw-message you">
                    <small>Tu</small>
                    <p>{draft}</p>
                  </article>
                  <article className="cw-message agent">
                    <small>Homun</small>
                    <p>
                      Ti propongo questa configurazione. Controlla i dettagli a destra prima di
                      confermare.
                    </p>
                    <small>
                      Interpretazione guidata: nomi espliciti; orari da verificare nel riepilogo.
                    </small>
                  </article>
                </>
              )}
              {feedback && (
                <div className="cw-closed">
                  <Check size={17} />
                  {feedback}
                </div>
              )}
              {(team?.notes || project?.notes || routine?.notes || []).map((note, i) => (
                <article className="cw-message you" key={i}>
                  <small>Tu</small>
                  <p>{note}</p>
                </article>
              ))}
              {view !== "Squadra" && (
                <div className="cs-actions">
                  <button
                    className="cs-link"
                    onClick={() => {
                      setSelected("");
                      setDraft("");
                      setEditingId("");
                      setDeleting(false);
                      setFeedback("");
                    }}
                  >
                    + Nuovo {view === "Progetti" ? "progetto" : "automazione"}
                  </button>
                </div>
              )}
              {view === "Squadra" && (
                <>
                  <div className="cs-heading">
                    <h3>Collaboratori</h3>
                  </div>
                  <input
                    className="cs-member-search"
                    aria-label="Cerca collaboratori"
                    placeholder="Cerca per nome, ruolo o competenza…"
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                  />
                  <div className="cs-collection">
                    {people
                      .filter((n) =>
                        (n + " " + JSON.stringify(memberProfile(n, data.profiles)))
                          .toLowerCase()
                          .includes(memberQuery.toLowerCase()),
                      )
                      .map((n) => (
                        <button
                          key={n}
                          onClick={() => {
                            setReturnTo("");
                            setSelected("person:" + n);
                            setDraft("");
                            setDeleting(false);
                          }}
                        >
                          <span>
                            <strong>{n}</strong>
                            <small>
                              {memberProfile(n, data.profiles).role}
                              {memberProfile(n, data.profiles).invitation === "pending"
                                ? " · invito in attesa"
                                : ""}
                            </small>
                          </span>
                          <ArrowUpRight size={17} />
                        </button>
                      ))}
                  </div>
                  <h3>Team</h3>
                </>
              )}
              <div className="cs-collection">
                {(view === "Squadra"
                  ? data.teams
                  : view === "Progetti"
                    ? data.projects
                    : data.routines
                ).map((item) => (
                  <button
                    key={item.id}
                    className={selected === item.id ? "active" : ""}
                    onClick={() => {
                      setDeleting(false);
                      setEditingId("");
                      setFeedback("");
                      setSelected(item.id);
                      setDraft("");
                    }}
                  >
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {"members" in item
                          ? `${item.members.length} membri · coordina ${item.leader || "da scegliere"}`
                          : "teamId" in item
                            ? data.teams.find((t) => t.id === item.teamId)?.name ||
                              "Nessuna squadra collegata"
                            : `${item.active ? "Attiva nella demo" : "In pausa"} · ${item.schedule}`}
                      </small>
                    </span>
                    <ArrowUpRight size={17} />
                  </button>
                ))}
              </div>
            </div>
            <div className="cw-composer">
              {request && request.projectId === project?.id && (
                <div className="cs-project-request">
                  <strong>A chi lo affidiamo?</strong>
                  <p>{request.text}</p>
                  {request.files.length > 0 && (
                    <small>{request.files.length} allegati pronti</small>
                  )}
                  <input
                    aria-label="Cerca destinatario"
                    placeholder="Nome, ruolo o specializzazione…"
                    value={recipientQuery}
                    onChange={(e) => setRecipientQuery(e.target.value)}
                  />
                  <div className="cs-roster">
                    {people
                      .filter(
                        (n) =>
                          memberProfile(n, data.profiles).invitation !== "pending" &&
                          (n + " " + JSON.stringify(memberProfile(n, data.profiles)))
                            .toLocaleLowerCase()
                            .includes(recipientQuery.toLocaleLowerCase()),
                      )
                      .map((n) => (
                        <button
                          className="cs-member-row"
                          key={n}
                          onClick={() =>
                            onProjectWork(n, request.text, request.files, request.projectId)
                          }
                        >
                          <span className="cw-tiny-avatar sage">{n[0]}</span>
                          <span>
                            {n}
                            <small>{memberProfile(n, data.profiles).role}</small>
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                  </div>
                  <button className="cs-link" onClick={() => setRequest(null)}>
                    Annulla richiesta
                  </button>
                </div>
              )}
              <StudioChatInput
                label={
                  project
                    ? `Affida un lavoro in ${project.name}`
                    : `Scrivi per ${view.toLowerCase()}`
                }
                onSend={(text, files) => {
                  if (project && !editingId) {
                    const mentioned = people.filter((n) => {
                      const tail = text.toLocaleLowerCase().split("@" + n.toLocaleLowerCase())[1];
                      return (
                        tail !== undefined &&
                        (!tail || /^[\s,.;:!?]/.test(tail)) &&
                        memberProfile(n, data.profiles).invitation !== "pending"
                      );
                    });
                    if (mentioned.length === 1)
                      onProjectWork(mentioned[0]!, text, files, project.id);
                    else {
                      setRequest({ text, files, projectId: project.id });
                      setFeedback(
                        "Scegli chi si occupa di questo lavoro. Messaggio e allegati sono conservati qui sotto.",
                      );
                    }
                    return;
                  }
                  if (files.length) {
                    setFeedback(
                      "Qui descrivi l’organizzazione. Allega i materiali nella conversazione del lavoro.",
                    );
                    return;
                  }
                  if (editingId) {
                    setDraft(text);
                    return;
                  }
                  if (person) {
                    setFeedback(
                      "Per aggiornare curriculum e strumenti usa Modifica curriculum o Collega nella scheda.",
                    );
                    return;
                  }
                  if (selected && text.trim()) addNote(text);
                  else propose(text);
                }}
                references={people.map((n) => ({
                  id: n,
                  name: n,
                  kind: "member",
                  description:
                    memberProfile(n, data.profiles).role +
                    " · " +
                    memberProfile(n, data.profiles).skills.join(", "),
                }))}
              />
              <div className="cw-composer-caption">Proposta guidata · nessuna azione esterna</div>
            </div>
          </>
        )}
      </section>
      <aside className="cw-workspace cs-panel">
        <span className="cw-overline">{hasDraft ? "DA CONFERMARE" : "NEL TUO SPAZIO"}</span>
        {hasDraft ? (
          <>
            <h2>
              {view === "Squadra"
                ? "Il tuo team"
                : view === "Progetti"
                  ? "Il progetto"
                  : "La ricorrenza"}
            </h2>
            <label>
              Nome
              <input
                aria-label="Nome proposta"
                value={name}
                placeholder={view === "Squadra" ? "Commerciale" : "Dai un nome"}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {editingId && view !== "Automazioni" && (
              <label>
                Obiettivo e responsabilità
                <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
              </label>
            )}
            {view === "Squadra" ? (
              <>
                <ConversationMemberPicker
                  people={people}
                  profiles={data.profiles}
                  selected={members}
                  label="Cerca membri da aggiungere"
                  onChange={(next) => {
                    setMembers(next);
                    if (!next.includes(leader)) setLeader(next[0] || "");
                  }}
                />
                <label>
                  Coordina
                  <ConversationSelectField
                    aria-label="Coordinatore"
                    value={leader}
                    onChange={(e) => setLeader(e.target.value)}
                  >
                    {members.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </ConversationSelectField>
                </label>
              </>
            ) : view === "Progetti" ? (
              <label>
                Squadra
                <ConversationSelectField
                  aria-label="Squadra del progetto"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">La sceglierò dopo</option>
                  {data.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </ConversationSelectField>
              </label>
            ) : (
              <>
                <label>
                  Lavoro da ripetere
                  <ConversationSelectField
                    aria-label="Lavoro da ripetere"
                    value={workId}
                    onChange={(e) => setWorkId(e.target.value)}
                  >
                    <option value="">Scegli un lavoro</option>
                    {works
                      .filter((w) => !w.unavailable)
                      .map((w) => (
                        <option value={w.id} key={w.id}>
                          {w.title}
                        </option>
                      ))}
                  </ConversationSelectField>
                </label>
                <label>
                  Quando
                  <ConversationSelectField
                    aria-label="Frequenza"
                    value={
                      [
                        "Ogni lunedì alle 09:00 · Europe/Rome",
                        "Ogni giorno alle 08:00 · Europe/Rome",
                        "Lunedì–venerdì alle 09:00 · Europe/Rome",
                        "Ogni 2 ore · Europe/Rome",
                      ].includes(schedule)
                        ? schedule
                        : "custom"
                    }
                    onChange={(e) => setSchedule(e.target.value === "custom" ? "" : e.target.value)}
                  >
                    {[
                      "Ogni lunedì alle 09:00 · Europe/Rome",
                      "Ogni giorno alle 08:00 · Europe/Rome",
                      "Lunedì–venerdì alle 09:00 · Europe/Rome",
                      "Ogni 2 ore · Europe/Rome",
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                    <option value="custom">Scrivi una regola personalizzata</option>
                  </ConversationSelectField>
                </label>
                {![
                  "Ogni lunedì alle 09:00 · Europe/Rome",
                  "Ogni giorno alle 08:00 · Europe/Rome",
                  "Lunedì–venerdì alle 09:00 · Europe/Rome",
                  "Ogni 2 ore · Europe/Rome",
                ].includes(schedule) && (
                  <label>
                    Quando deve partire?
                    <input
                      aria-label="Regola di avvio"
                      maxLength={240}
                      placeholder="Es. quando arriva un’email da un cliente, oppure martedì alle 10"
                      value={schedule}
                      onChange={(e) => setSchedule(e.target.value)}
                    />
                    <small>
                      Descrizione da interpretare con il futuro motore, non un trigger già attivo.
                    </small>
                  </label>
                )}
                <p className="cw-hint">
                  Nella demo le esecuzioni partono solo con “Simula esecuzione”.
                </p>
              </>
            )}
            <button
              className="cw-primary"
              disabled={
                !name.trim() ||
                (view === "Squadra" && (!members.length || !leader)) ||
                (view === "Automazioni" &&
                  (!workId || !schedule.trim() || works.find((w) => w.id === workId)?.unavailable))
              }
              onClick={save}
            >
              {editingId ? "Salva" : "Conferma"}{" "}
              {view === "Squadra" ? "team" : view === "Progetti" ? "progetto" : "automazione"}
              <Check size={16} />
            </button>
            <button
              className="cs-link"
              onClick={() => {
                setDraft("");
                setEditingId("");
              }}
            >
              Annulla proposta
            </button>
          </>
        ) : person ? (
          <ConversationMember
            key={person}
            name={person}
            profile={memberProfile(person, data.profiles)}
            onChange={(profile) =>
              onChange({
                ...data,
                installedPlugins: [
                  ...new Set([...(data.installedPlugins || []), ...profile.plugins]),
                ],
                profiles: { ...data.profiles, [person]: profile },
              })
            }
            impact={`${data.teams.filter((t) => t.members.includes(person)).length} team coinvolti. Le conversazioni restano nello storico; le automazioni dell’agente vengono messe in pausa. I team che coordina richiederanno un nuovo coordinatore.`}
            onDelete={() => {
              onChange({
                ...data,
                removedPeople: [...(data.removedPeople || []), person],
                profiles: {
                  ...data.profiles,
                  [person]: { ...memberProfile(person, data.profiles), plugins: [] },
                },
                teams: data.teams.map((t) => ({
                  ...t,
                  members: t.members.filter((n) => n !== person),
                  leader: t.leader === person ? "" : t.leader,
                })),
              });
              setSelected("");
              setFeedback(`${person} eliminato dalla squadra. Lo storico è conservato.`);
            }}
            onAssign={() => onAssign(person)}
            onBack={() => setSelected(returnTo)}
          />
        ) : team ? (
          <>
            <h2>{team.name}</h2>
            <p>{team.brief}</p>
            <div className="cs-roster">
              {team.members.map((n) => (
                <button
                  className="cs-member-row"
                  key={n}
                  onClick={() => {
                    setReturnTo(team.id);
                    setSelected("person:" + n);
                  }}
                >
                  <span className={`cw-tiny-avatar ${n === "Marta" ? "peach" : "sage"}`}>
                    {n[0]}
                  </span>
                  <span>
                    {n}
                    <small>
                      {isHumanMember(n, data.profiles) ? "Persona" : "Agente AI"}
                      {n === team.leader ? " · Coordina" : ""}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
            <label>
              Coordinatore
              <ConversationSelectField
                value={team.leader}
                aria-label="Cambia coordinatore"
                onChange={(e) =>
                  onChange({
                    ...data,
                    teams: data.teams.map((t) =>
                      t.id === team.id ? { ...t, leader: e.target.value } : t,
                    ),
                  })
                }
              >
                {!team.leader && <option value="">Scegli coordinatore</option>}
                {team.members.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </ConversationSelectField>
            </label>
            <p className="cw-hint">
              Coordinare non concede nuovi permessi né autonomia agli agenti.
            </p>
          </>
        ) : project ? (
          <>
            <h2>{project.name}</h2>
            <p>{project.brief}</p>
            <p className="cw-hint">
              Squadra: {data.teams.find((t) => t.id === project.teamId)?.name || "Da scegliere"}
            </p>
            <label>
              Squadra
              <ConversationSelectField
                aria-label="Cambia squadra"
                value={project.teamId}
                onChange={(e) =>
                  onChange({
                    ...data,
                    projects: data.projects.map((p) =>
                      p.id === project.id ? { ...p, teamId: e.target.value } : p,
                    ),
                  })
                }
              >
                <option value="">Nessuna</option>
                {data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </ConversationSelectField>
            </label>
            <h3>Compiti del progetto</h3>
            {works
              .filter((w) => w.projectId === project.id)
              .map((w) => (
                <button className="cs-example" key={w.id} onClick={() => onWork(w.id)}>
                  {w.title}
                  <ArrowUpRight size={15} />
                </button>
              ))}
            {!works.some((w) => w.projectId === project.id) && (
              <p className="cw-hint">
                Nessun lavoro ancora. Scrivi nella chat cosa vuoi ottenere e usa @ per scegliere il
                collaboratore.
              </p>
            )}
            <h3>Materiali del progetto</h3>
            {projectMaterials
              .filter((m) => m.projectIds.includes(project.id))
              .map((m) => (
                <button className="cs-example" key={m.id} onClick={() => onMaterial(m.id)}>
                  {m.name}
                  <ArrowUpRight size={15} />
                </button>
              ))}
            <p className="cw-hint">
              I materiali collegati al progetto saranno disponibili nei nuovi incarichi. Puoi anche
              allegare file al messaggio.
            </p>
          </>
        ) : routine ? (
          <>
            <h2>{routine.name}</h2>
            <p>{routine.schedule}</p>
            {(!routineSource || routineSource.unavailable) && (
              <p className="cw-hint">
                Il lavoro di origine è archiviato, eliminato o non ha un agente disponibile.
                Modifica la ricorrenza scegliendo un lavoro attivo.
              </p>
            )}
            <p className="cw-hint">
              {routine.active ? "Attiva nella demo" : "In pausa"} · ogni prova crea un lavoro
              distinto
            </p>
            <button
              className="cw-secondary"
              disabled={!routineSource}
              onClick={() => onWork(routine.workId)}
            >
              Apri lavoro di origine
              <ArrowUpRight size={15} />
            </button>
            <button
              className="cw-primary"
              disabled={!routine.active || !routineSource || routineSource.unavailable}
              onClick={() => onRun(routine)}
            >
              <Play size={15} />
              Simula esecuzione
            </button>
            <button
              className="cs-link"
              disabled={!routineSource || routineSource.unavailable}
              onClick={() =>
                onChange({
                  ...data,
                  routines: data.routines.map((r) =>
                    r.id === routine.id ? { ...r, active: !r.active } : r,
                  ),
                })
              }
            >
              {routine.active ? (
                <>
                  <Pause size={14} />
                  Metti in pausa
                </>
              ) : (
                "Riattiva nella demo"
              )}
            </button>
            <small>Nessun timer o processo reale.</small>
            <h3>Esecuzioni</h3>
            {works
              .filter((w) => w.routineId === routine.id)
              .sort((a, b) => (b.runNumber || 0) - (a.runNumber || 0))
              .map((w) => (
                <button className="cs-example" key={w.id} onClick={() => onWork(w.id)}>
                  <span>
                    Esecuzione {w.runNumber}
                    <small style={{ display: "block" }}>
                      {w.status || w.phase} ·{" "}
                      {w.startedAt ? new Date(w.startedAt).toLocaleString("it-IT") : ""}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            {!works.some((w) => w.routineId === routine.id) && (
              <p className="cw-hint">
                Nessuna esecuzione. Avvia una prova per seguirne il risultato.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>{view}</h2>
            <p className="cw-hint">
              Descrivi quello che vuoi organizzare oppure apri un elemento esistente.
            </p>
            <button className="cw-secondary" onClick={() => propose(examples[view])}>
              <Plus size={16} />
              Prova un esempio
            </button>
          </>
        )}
        {!hasDraft && (team || project || routine) && (
          <div className="cs-management" hidden={detached}>
            {deleting ? (
              <div className="cs-delete-confirm">
                <h3>{team ? "Sciogliere il team?" : "Eliminare questo elemento?"}</h3>
                <p className="cw-hint">
                  {team
                    ? "I membri restano nella squadra. I progetti collegati perderanno l’associazione a questo team."
                    : project
                      ? "Gli incarichi e le loro conversazioni restano disponibili, senza progetto. Le chat libere del progetto e i loro allegati vengono eliminati."
                      : "Le esecuzioni già create restano disponibili. La ricorrenza viene rimossa."}
                </p>
                <div className="cs-actions">
                  <button className="cs-link" onClick={() => setDeleting(false)}>
                    Annulla
                  </button>
                  <button className="cw-primary" onClick={remove}>
                    Conferma eliminazione
                  </button>
                </div>
              </div>
            ) : (
              <div className="cs-actions">
                <button className="cs-link" onClick={() => setDeleting(true)}>
                  {team ? "Sciogli team" : "Elimina"}
                </button>
                <button className="cw-secondary" onClick={edit}>
                  Modifica
                </button>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
