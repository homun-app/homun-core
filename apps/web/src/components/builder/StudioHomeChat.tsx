import { StudioMemberPicker } from "./StudioMemberPicker";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import { useState } from "react";
import { StudioChatInput } from "./StudioChatInput";
import { Message } from "../ai-elements/message";
import { StudioProjectPicker } from "./StudioProjectPicker";
import type { AssignedWork, TodayProject } from "./StudioToday";
import { statusOf, workStates } from "../../lib/studio-work";
export type ChatProjectRequest = { id: string; name: string; goal: string; members: string[] };
type Kind = "agent" | "project" | "task";
type Entry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  files?: File[];
  kind?: Kind;
  result?: { kind: Kind; id: string };
  scope?: string;
  related?: string[];
};
export function StudioHomeChat({
  people,
  projects,
  tasks,
  context,
  onContext,
  onAgent,
  onProject,
  onTask,
  onOpenTask,
  onOpenProject,
  onOpenPerson,
}: {
  people: { id: string; name: string }[];
  projects: TodayProject[];
  tasks: AssignedWork[];
  context: string;
  onContext: (id: string) => void;
  onAgent: (name: string, responsibility: string) => string;
  onProject: (name: string, goal: string, members: string[]) => string;
  onTask: (task: AssignedWork) => void;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenPerson: (id: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);

  const [showContext, setShowContext] = useState(false);
  const scopeTask = tasks.find((t) => "task:" + t.id === context);
  const scopeProject =
    projects.find((p) => "project:" + p.id === context) ||
    projects.find((p) => p.id === scopeTask?.project);
  const scopeName = scopeTask?.title || scopeProject?.name || "Tutto lo spazio";
  function send(value = "", kind?: Kind, attachments: File[] = []) {
    if (!value.trim() && !attachments.length) return;
    const lower = value.toLowerCase();
    const intent =
      kind ||
      (/\b(crea|creare|nuovo|nuova|aggiungi|voglio|serve)\b/.test(lower)
        ? /progett/.test(lower)
          ? "project"
          : /agent|collaborator|bot/.test(lower)
            ? "agent"
            : /incaric|compit|prepara|analizz|ricerc|lavor/.test(lower)
              ? "task"
              : undefined
        : /prepara|analizza|scrivi|controlla|organizza/.test(lower)
          ? "task"
          : undefined);
    const scopedTasks = scopeTask
      ? [scopeTask]
      : scopeProject
        ? tasks.filter((t) => t.project === scopeProject.id)
        : tasks;
    let related: string[] = [];
    let answer =
      "Posso aiutarti a impostare un lavoro, creare un collaboratore o organizzare un progetto. Scegli un’azione qui sotto per provare il percorso.";
    if (intent)
      answer =
        intent === "agent"
          ? "Definiamo il collaboratore. Conferma nome e responsabilità: inizierà in stage."
          : intent === "project"
            ? "Ecco la proposta di progetto. Scegli chi coinvolgere prima di crearlo."
            : "Trasformiamo la richiesta in un incarico. Scegli chi se ne occupa; gli allegati seguiranno il lavoro.";
    else if (/cost|spes|budget/.test(lower)) {
      const known = scopedTasks.filter((t) => t.demoCost !== undefined);
      const sum = known.reduce((a, t) => a + (t.demoCost || 0), 0);
      answer = `Spesa simulata registrata: ${sum.toLocaleString("it-IT", { style: "currency", currency: "EUR" })}. ${scopedTasks.length - known.length} incarichi senza consuntivo. I costi reali non sono ancora collegati.`;
    } else if (/attesa|blocc|approv|lavor|situazione|compit|task/.test(lower)) {
      const found = /attesa|blocc/.test(lower)
        ? scopedTasks.filter((t) => statusOf(t) === "blocked")
        : /approv/.test(lower)
          ? scopedTasks.filter((t) => statusOf(t) === "review")
          : scopedTasks;
      related = found.map((t) => t.id);
      answer = found.length
        ? `${found.length} incarichi corrispondono alla richiesta. Apri un lavoro per vedere risultato, attese e prossimi passi.`
        : "Nessun incarico corrisponde alla richiesta in questo contesto.";
    } else if (attachments.length)
      answer =
        "Ho mantenuto gli allegati nella conversazione. Per provarne la delega, scegli «Affida un lavoro». In questa demo i file non vengono analizzati da un modello.";
    setEntries((all) => [
      ...all,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: value.trim(),
        files: [...attachments],
        scope: scopeName,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: answer,
        related,
        ...(intent ? { kind: intent } : {}),
        files: [...attachments],
        scope: scopeProject?.id || "",
      },
    ]);
  }
  const suggestions = [
    ["Crea un collaboratore", "agent"],
    ["Crea un progetto", "project"],
    ["Affida un lavoro", "task"],
  ] as const;
  return (
    <section className="st-home-chat" aria-label="Chat con Homun">
      <div className="st-chat-contextbar">
        <button className="st-text-link" onClick={() => setShowContext(!showContext)}>
          {scopeName} ▾
        </button>
      </div>
      {showContext && (
        <StudioProjectPicker
          label="Contesto della chat"
          options={[
            ...projects.map((p) => ({ id: "project:" + p.id, name: "Progetto · " + p.name })),
            ...tasks.map((t) => ({ id: "task:" + t.id, name: "Compito · " + t.title })),
          ]}
          value={context ? [context] : []}
          emptyLabel="Tutto lo spazio"
          onChange={(ids) => onContext(ids.at(-1) || "")}
        />
      )}
      <Conversation className="st-home-chat-history">
        <ConversationContent className="st-sdk-history-content">
          {!entries.length && (
            <div className="st-chat-welcome">
              <h1>Da cosa cominciamo?</h1>
              <p>Un’idea, una domanda, un lavoro da affidare.</p>
              <div className="st-chat-suggestions">
                {suggestions.map(([label, kind]) => (
                  <button key={kind} onClick={() => send(label, kind)}>
                    {label}
                    <span>↗</span>
                  </button>
                ))}
                <button onClick={() => send("Quali lavori richiedono attenzione?")}>
                  Fai il punto sul lavoro<span>↗</span>
                </button>
              </div>
            </div>
          )}
          {entries.map((entry) => (
            <Message from={entry.role} key={entry.id} className={"st-homun-message " + entry.role}>
              <small>
                {entry.role === "user" ? "Tu" : "Homun"}
                {entry.role === "user" && entry.scope !== "Tutto lo spazio"
                  ? " · " + entry.scope
                  : ""}
              </small>
              <p>{entry.text}</p>
              {entry.role === "user" &&
                entry.files?.map((f, i) => (
                  <span className="st-chat-file" key={i}>
                    {f.name}
                  </span>
                ))}
              {entry.related?.map((id) => {
                const task = tasks.find((t) => t.id === id);
                return task ? (
                  <button key={id} className="st-chat-result" onClick={() => onOpenTask(id)}>
                    <span>
                      {task.title}
                      <small>{workStates[statusOf(task)]}</small>
                    </span>
                    <span>Apri ↗</span>
                  </button>
                ) : null;
              })}
              {entry.kind && !entry.result && (
                <Proposal
                  kind={entry.kind}
                  prompt={entries[entries.indexOf(entry) - 1]?.text || ""}
                  people={people}
                  projects={projects}
                  defaultProject={entry.scope || ""}
                  files={entry.files || []}
                  onConfirm={(draft) => {
                    let id = "";
                    if (entry.kind === "agent") id = onAgent(draft.title, draft.description);
                    if (entry.kind === "project")
                      id = onProject(draft.title, draft.description, draft.members);
                    if (entry.kind === "task") {
                      id = crypto.randomUUID();
                      onTask({
                        id,
                        title: draft.title,
                        brief: draft.description,
                        person: draft.members[0]!,
                        project: draft.project,
                        status: "todo",
                        files: entry.files || [],
                        ...(draft.due ? { due: draft.due } : {}),
                        ...(draft.cost !== ""
                          ? { costLimit: Number(draft.cost), costPolicy: "pause" as const }
                          : {}),
                      });
                    }
                    setEntries((all) =>
                      all.map((e) =>
                        e.id === entry.id ? { ...e, result: { kind: entry.kind!, id } } : e,
                      ),
                    );
                  }}
                />
              )}
              {entry.result && (
                <button
                  className="st-chat-result"
                  onClick={() =>
                    entry.result!.kind === "task"
                      ? onOpenTask(entry.result!.id)
                      : entry.result!.kind === "project"
                        ? onOpenProject(entry.result!.id)
                        : onOpenPerson(entry.result!.id)
                  }
                >
                  <span>
                    ✓{" "}
                    {entry.result.kind === "task"
                      ? tasks.find((t) => t.id === entry.result!.id)?.title || "Incarico creato"
                      : entry.result.kind === "project"
                        ? projects.find((p) => p.id === entry.result!.id)?.name || "Progetto creato"
                        : people.find((p) => p.id === entry.result!.id)?.name ||
                          "Collaboratore creato"}
                    <small>
                      {entry.result.kind === "task"
                        ? workStates[
                            statusOf(
                              tasks.find((t) => t.id === entry.result!.id) ||
                                ({ status: "todo" } as AssignedWork),
                            )
                          ]
                        : "Disponibile nello spazio"}
                    </small>
                  </span>
                  <span>Apri ↗</span>
                </button>
              )}
            </Message>
          ))}
          {!!entries.length && (
            <div className="st-chat-followups">
              {suggestions.map(([label, kind]) => (
                <button key={kind} onClick={() => send(label, kind, entries.at(-1)?.files || [])}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Ultimo messaggio" />
      </Conversation>
      <StudioChatInput
        label="Scrivi a Homun"
        onSend={(text, files) => send(text, undefined, files)}
      />
    </section>
  );
}
function Proposal({
  kind,
  prompt,
  people,
  projects,
  defaultProject,
  files,
  onConfirm,
}: {
  kind: Kind;
  prompt: string;
  people: { id: string; name: string }[];
  projects: TodayProject[];
  defaultProject: string;
  files: File[];
  onConfirm: (draft: {
    title: string;
    description: string;
    members: string[];
    project: string;
    due: string;
    cost: string;
  }) => void;
}) {
  const [title, setTitle] = useState(
    kind === "task" && prompt !== "Affida un lavoro" ? prompt : "",
  );
  const [description, setDescription] = useState(prompt);
  const [members, setMembers] = useState<string[]>([]);
  const [project, setProject] = useState(defaultProject);
  const [due, setDue] = useState("");
  const [cost, setCost] = useState("");
  const eligible =
    kind === "task" && project
      ? people.filter((p) => projects.find((x) => x.id === project)?.members.includes(p.id))
      : people;
  return (
    <form
      className="st-chat-proposal"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !description.trim() || (kind !== "agent" && !members.length)) return;
        onConfirm({
          title: title.trim(),
          description: description.trim(),
          members,
          project,
          due,
          cost,
        });
      }}
    >
      <label>
        {kind === "agent"
          ? "Nome del collaboratore"
          : kind === "project"
            ? "Nome del progetto"
            : "Risultato da ottenere"}
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            kind === "agent"
              ? "Come lo chiamiamo?"
              : kind === "project"
                ? "Un nome per questo obiettivo"
                : "Descrivi il risultato"
          }
        />
      </label>
      {kind !== "task" && (
        <label>
          {kind === "agent" ? "Di cosa si occupa" : "Obiettivo"}
          <textarea required value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      )}
      {kind !== "agent" && (
        <StudioMemberPicker
          multiple={kind !== "task"}
          label={kind === "task" ? "A chi lo affidi" : "Chi coinvolgere"}
          options={eligible}
          value={members}
          emptyLabel="Scegli dalla squadra"
          onChange={(ids) => setMembers(kind === "task" ? ids.slice(-1) : ids)}
        />
      )}
      {kind === "task" && (
        <details>
          <summary>Scadenza, progetto e budget</summary>
          <StudioProjectPicker
            label="Progetto"
            options={projects}
            value={project ? [project] : []}
            emptyLabel="Nessun progetto"
            onChange={(ids) => {
              setProject(ids.at(-1) || "");
              setMembers([]);
            }}
          />
          <label>
            Pronto entro
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label>
            Limite remoto · €
            <input
              type="number"
              min="0"
              step="0.01"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
        </details>
      )}
      {!!files.length && (
        <small>
          {files.length} allegati{" "}
          {kind === "task" ? "saranno collegati all’incarico" : "restano nella conversazione"}
        </small>
      )}
      <button
        className="st-btn dark"
        disabled={!title.trim() || !description.trim() || (kind !== "agent" && !members.length)}
      >
        {kind === "agent"
          ? "Crea collaboratore"
          : kind === "project"
            ? "Crea progetto"
            : "Affida incarico"}
      </button>
    </form>
  );
}
