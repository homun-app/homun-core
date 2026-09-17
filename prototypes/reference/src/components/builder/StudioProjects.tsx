import { StudioProjectChat } from "./StudioProjectChat";
import { StudioMemberPicker } from "./StudioMemberPicker";
import type { ChatProjectRequest } from "./StudioHomeChat";
import { StudioWorkForm } from "./StudioWorkForm";
import { workStates, statusOf, workDate } from "../../lib/studio-work";
import type { TodayProject, OpsStage, AssignedWork } from "./StudioToday";
import { StudioDocuments, type SharedDocument } from "./StudioDocuments";
import { ProjectSharing, type ProjectGrant, type SpaceUser } from "./StudioAccess";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Plus, Users } from "lucide-react";
type Member = { id: string; name: string; responsibility: string };
type Project = {
  id: string;
  name: string;
  goal: string;
  members: string[];
  assignments: Record<string, string>;
  notes: string[];
  demo: boolean;
  delivered: boolean;
  grants: Record<string, ProjectGrant>;
};
export function StudioProjects({
  createRequest,
  onWorkspaceChat,
  people,
  documents,
  onDocuments,
  documentProjects,
  emptyStart = false,
  onPerson,
  users,
  onSummaries,
  target,
  onActiveChange,
  tasks,
  onTask,
  onAssign,
}: {
  createRequest?: ChatProjectRequest | null;
  onWorkspaceChat?: (id: string) => void;
  emptyStart?: boolean;
  documents: SharedDocument[];
  onDocuments: (docs: SharedDocument[]) => void;
  documentProjects: TodayProject[];
  people: Member[];
  users: SpaceUser[];
  onSummaries: (projects: TodayProject[]) => void;
  target: { id: string; nonce: number } | null;
  onActiveChange: (id: string | null) => void;
  opsStage: OpsStage;
  onOpsStage: (stage: OpsStage) => void;
  opsApproved: boolean;
  onPlan: () => void;
  tasks: AssignedWork[];
  onAssign: (task: AssignedWork) => void;
  onTask: (id: string) => void;
  onPerson: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>(
    emptyStart
      ? []
      : [
          {
            id: "ops",
            name: "Qualità e backlog",
            goal: "Ridurre gli errori e preparare i task con contesto, priorità e piano di lavoro.",
            members: ["elio", "vera"],
            assignments: {
              elio: "Analizzare i log e preparare priorità e piano.",
              vera: "Raccogliere il contesto da Trello, Mattermost e wiki.",
            },
            notes: [],
            demo: true,
            delivered: false,
            grants: {},
          },
        ],
  );
  const [projectTab, setProjectTab] = useState("chat");
  const [assigning, setAssigning] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!createRequest) return;
    setProjects((all) =>
      all.some((p) => p.id === createRequest.id)
        ? all
        : [
            ...all,
            {
              ...createRequest,
              assignments: {},
              notes: [],
              demo: false,
              delivered: false,
              grants: {},
            },
          ],
    );
  }, [createRequest]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    setProjectTab("chat");
    setAssigning(false);
    setSharing(false);
  }, [active]);
  useEffect(() => {
    onSummaries(
      projects.map(({ id, name, goal, members, grants }) => ({
        id,
        name,
        goal,
        members,
        documentMembers: [
          ...members.filter((id) => !id.startsWith("user:")),
          ...users
            .filter(
              (u) =>
                u.status === "active" &&
                (u.role === "owner" || (grants[u.id]?.documents && grants[u.id]?.level !== "none")),
            )
            .map((u) => "user:" + u.id),
        ],
      })),
    );
  }, [projects, users, onSummaries]);
  useEffect(() => {
    if (target) {
      setActive(["all", "new"].includes(target.id) ? null : target.id);
      setCreating(target.id === "new");
      setEditing(false);
    }
  }, [target]);
  useEffect(() => {
    onActiveChange(creating ? null : active);
  }, [active, creating, onActiveChange]);
  const project = projects.find((p) => p.id === active);
  function patch(patch: Partial<Project>) {
    setProjects((ps) => ps.map((p) => (p.id === active ? { ...p, ...patch } : p)));
  }
  function create() {
    if (!name.trim() || !goal.trim() || !members.length) return;
    const id = `project-${Date.now()}`;
    setProjects((ps) => [
      ...ps,
      {
        id,
        name: name.trim(),
        goal: goal.trim(),
        members,
        assignments: {},
        notes: [],
        demo: false,
        delivered: false,
        grants: {},
      },
    ]);
    setActive(id);
    setCreating(false);
    setEditing(true);
    setName("");
    setGoal("");
    setMembers([]);
  }
  return (
    <>
      {creating ? (
        <>
          <button className="st-back" onClick={() => setCreating(false)}>
            ← Annulla
          </button>
          <h1>Un obiettivo. Una squadra.</h1>
          <p className="st-intro">
            Scegli chi partecipa. Poi definisci le responsabilità di ciascuno.
          </p>
          <form
            className="st-paper"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label>
              Nome del progetto
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Es. Qualità del servizio"
              />
            </label>
            <label>
              Cosa deve ottenere la squadra?
              <textarea required value={goal} onChange={(e) => setGoal(e.target.value)} />
            </label>
            <StudioMemberPicker
              multiple
              label="Squadra del progetto"
              options={people}
              value={members}
              onChange={setMembers}
            />
            <button
              disabled={!members.length || !name.trim() || !goal.trim()}
              className="st-btn dark"
            >
              Crea progetto demo <ArrowRight size={16} />
            </button>
            <p className="st-muted" style={{ marginTop: 12 }}>
              Nessuna assegnazione automatica: il motore verrà collegato in seguito.
            </p>
          </form>
        </>
      ) : !project ? (
        <>
          <div className="st-section-head">
            <div>
              <span className="st-eyebrow">PROGETTI</span>
              <h1>Progetti</h1>
            </div>
            <button className="st-btn dark" onClick={() => setCreating(true)}>
              <Plus size={16} /> Nuovo progetto
            </button>
          </div>
          <p className="st-intro">
            Un obiettivo condiviso, responsabilità distinte. Ogni collaboratore può partecipare a
            più progetti.
          </p>
          <div className="st-job-list">
            {projects.map((p) => (
              <button
                key={p.id}
                className="st-job"
                onClick={() => {
                  setActive(p.id);
                  setEditing(false);
                }}
              >
                <Users size={23} />
                <span className="st-job-copy">
                  <strong>{p.name}</strong>
                  <small>{p.goal}</small>
                  <span className="st-project-members">
                    {p.members
                      .map((id) => people.find((person) => person.id === id)?.name)
                      .join(" + ")}
                  </span>
                </span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button
            className="st-back"
            onClick={() => {
              setActive(null);
              setEditing(false);
            }}
          >
            ← Tutti i progetti
          </button>
          <div className="st-project-heading">
            <div>
              <h1>{project.name}</h1>
              <p className="st-intro">{project.goal}</p>
            </div>
            <button
              className="st-text-link"
              aria-expanded={sharing}
              onClick={() => setSharing(!sharing)}
            >
              <Users size={14} /> Persone e accessi
            </button>
          </div>
          {sharing && (
            <div id="project-sharing">
              <ProjectSharing
                users={users}
                grants={project.grants}
                onChange={(grants) => patch({ grants })}
              />
            </div>
          )}
          {editing && (
            <section className="st-paper st-project-section">
              <h2>Chi fa cosa</h2>
              <p className="st-muted">Aggiungi collaboratori e assegna un incarico concreto.</p>
              <StudioMemberPicker
                multiple
                label="Membri del progetto"
                options={people}
                value={project.members}
                onChange={(ids) => patch({ members: ids })}
              />
              {people
                .filter((p) => project.members.includes(p.id))
                .map((p) => (
                  <div key={p.id} className="st-assignment">
                    {project.members.includes(p.id) && (
                      <label>
                        Responsabilità di {p.name}
                        <textarea
                          value={project.assignments[p.id] || ""}
                          placeholder="Di cosa si occupa in questo progetto?"
                          onChange={(e) =>
                            patch({
                              assignments: { ...project.assignments, [p.id]: e.target.value },
                            })
                          }
                        />
                      </label>
                    )}
                  </div>
                ))}
              <button className="st-btn dark" onClick={() => setEditing(false)}>
                Fatto <Check size={16} />
              </button>
            </section>
          )}
          <nav className="st-tabs" aria-label="Sezioni del progetto">
            {[
              ["chat", "Chat"],
              ["tasks", "Compiti"],
              ["files", "Materiali"],
            ].map(([id, label]) => (
              <button
                key={id}
                className={projectTab === id ? "active" : ""}
                aria-current={projectTab === id ? "page" : undefined}
                onClick={() => setProjectTab(id!)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div hidden={projectTab !== "tasks"}>
            <button className="st-btn dark" onClick={() => setAssigning(!assigning)}>
              <Plus size={16} />
              Assegna un lavoro al progetto
            </button>
            {assigning && (
              <StudioWorkForm
                people={people.filter((p) => project.members.includes(p.id))}
                projects={[project]}
                defaultProject={project.id}
                onClose={() => setAssigning(false)}
                onSave={(t) => {
                  onAssign(t);
                  setAssigning(false);
                  onTask(t.id);
                }}
              />
            )}
            {!tasks.some((t) => t.project === project.id) && (
              <p className="st-muted" style={{ marginTop: 20 }}>
                Nessun incarico. Assegna il primo lavoro alla squadra del progetto.
              </p>
            )}
            {tasks.some((t) => t.project === project.id) && (
              <section className="st-paper st-project-section">
                <h2>Incarichi del progetto</h2>
                {tasks
                  .filter((t) => t.project === project.id)
                  .map((t) => (
                    <button className="st-recent" key={t.id} onClick={() => onTask(t.id)}>
                      <span>
                        <strong>{t.title}</strong>
                        <small>
                          {people.find((p) => p.id === t.person)?.name} · {workStates[statusOf(t)]}{" "}
                          · {workDate(t.due)}
                        </small>
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  ))}
              </section>
            )}
          </div>
          <div hidden={projectTab !== "files"}>
            <StudioDocuments
              key={project.id}
              projectScope={project.id}
              documents={documents}
              onChange={onDocuments}
              tasks={tasks}
              onTask={onTask}
              projects={documentProjects}
              members={people}
            />
          </div>
          <div hidden={projectTab !== "chat"}>
            <StudioProjectChat
              tasks={tasks}
              onAssign={onAssign}
              onTask={onTask}
              key={project.id}
              project={project}
              people={people}
              documents={documents}
              onDocuments={onDocuments}
              onChange={patch}
              onFiles={() => setProjectTab("files")}
            />
          </div>
        </>
      )}
    </>
  );
}
