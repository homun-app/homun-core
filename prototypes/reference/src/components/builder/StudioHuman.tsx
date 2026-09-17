import { StudioConversation, type ConversationContext } from "./StudioConversation";
import type { ConversationMessage } from "../../lib/studio-conversations";
import { useState } from "react";
import type { AssignedWork, TodayProject } from "./StudioToday";
import { StudioWorkForm } from "./StudioWorkForm";
import { workStates, statusOf } from "../../lib/studio-work";
export function StudioHuman({
  person,
  tasks,
  projects,
  members,
  messages,
  onMessage,
  onTask,
  onAssign,
  onProject,
  context,
  onShare,
}: {
  person: { id: string; name: string };
  tasks: AssignedWork[];
  projects: TodayProject[];
  members: { id: string; name: string }[];
  messages: ConversationMessage[];
  onMessage: (v: ConversationMessage) => void;
  onTask: (id: string) => void;
  onProject: (id: string) => void;
  context?: ConversationContext | null;
  onShare: (m: ConversationMessage, id: string) => void;
  onAssign: (t: AssignedWork) => void;
}) {
  const [source, setSource] = useState<ConversationMessage | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <span className="st-eyebrow">PERSONA · SPAZIO CONDIVISO</span>
      <h1>{person.name}</h1>
      <p className="st-intro">
        Conversazione e incarichi con {person.name}. Questa è un’anteprima locale: nessun messaggio
        viene recapitato.
      </p>
      <button className="st-btn dark" onClick={() => setAdding(!adding)}>
        Assegna un incarico
      </button>
      {adding && (
        <StudioWorkForm
          people={members}
          projects={projects}
          person={person.id}
          initialTitle={source?.text || ""}
          initialFiles={source?.files || []}
          defaultProject={
            source?.projectIds.find((id) =>
              projects.some((p) => p.id === id && p.members.includes(person.id)),
            ) || ""
          }
          onClose={() => setAdding(false)}
          onSave={(t) => {
            onAssign({
              ...t,
              ...(source ? { sourceMessage: { person: person.id, id: source.id } } : {}),
            });
            setSource(null);
            setAdding(false);
          }}
        />
      )}
      <section className="st-paper st-today-section">
        <h2>Incarichi assegnati a {person.name}</h2>
        {tasks
          .filter((t) => t.person === person.id)
          .map((t) => (
            <button key={t.id} className="st-recent" onClick={() => onTask(t.id)}>
              <span>
                <strong>{t.title}</strong>
                <small>
                  {workStates[statusOf(t)]} ·{" "}
                  {t.requestFor ? "Richiesta collegata" : "Incarico diretto"}
                </small>
              </span>
              <span>Apri →</span>
            </button>
          ))}
        {!tasks.some((t) => t.person === person.id) && (
          <p className="st-muted">Nessun incarico assegnato.</p>
        )}
      </section>
      <section className="st-paper st-today-section">
        <StudioConversation
          person={person}
          messages={messages}
          onMessage={onMessage}
          tasks={tasks}
          projects={projects}
          onTask={onTask}
          onProject={onProject}
          context={context ?? null}
          people={members}
          onShare={onShare}
          onAssign={(m) => {
            setSource(m);
            setAdding(true);
          }}
        />
      </section>
    </>
  );
}
