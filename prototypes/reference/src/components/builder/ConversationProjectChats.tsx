import { ConversationActions } from "./ConversationActions";
import { useState } from "react";
import { StudioChatInput } from "./StudioChatInput";
import type { SpaceProject, SpaceWork } from "./ConversationSpace";

export type ProjectChat = {
  id: string;
  title: string;
  messages: { text: string; files: File[]; workId?: string }[];
};
export function ConversationProjectChats({
  projects,
  onMoveChat,
  initialChat,
  project,
  works,
  people,
  materials,
  onChange,
  onWork,
  onAssign,
  onMaterial,
}: {
  projects: SpaceProject[];
  onMoveChat: (id: string, destination: string, create?: boolean) => void;
  initialChat: string;
  project: SpaceProject;
  works: SpaceWork[];
  people: string[];
  materials: { id: string; name: string; projectIds: string[] }[];
  onChange: (project: SpaceProject) => void;
  onWork: (id: string) => void;
  onAssign: (name: string, text: string, files: File[], projectId: string) => string | undefined;
  onMaterial: (id: string) => void;
}) {
  const [tab, setTab] = useState("Chat");
  const [active, setActive] = useState(initialChat);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const chats = project.chats || [];
  const chat = chats.find((c) => c.id === active);
  const tasks = works.filter((w) => w.projectId === project.id);
  function update(next: ProjectChat) {
    onChange({
      ...project,
      chats: chats.some((c) => c.id === next.id)
        ? chats.map((c) => (c.id === next.id ? next : c))
        : [...chats, next],
    });
  }
  return (
    <>
      <div className="cw-history">
        <h1 className="cs-title">{project.name}</h1>
        <p className="cs-intro">{project.brief}</p>
        <div className="cs-actions" role="tablist" aria-label="Contenuti progetto">
          {["Chat", "Compiti", "Materiali"].map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "cw-secondary" : "cs-link"}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === "Chat" && (
          <>
            <div className="cp-chat-tabs">
              <button
                className="cw-secondary"
                onClick={() => {
                  setActive("");
                  setAssigning(null);
                }}
              >
                + Nuova conversazione
              </button>
              {chats.map((c) => (
                <button
                  key={c.id}
                  aria-pressed={active === c.id}
                  onClick={() => {
                    setActive(c.id);
                    setAssigning(null);
                  }}
                >
                  {c.title}
                </button>
              ))}
            </div>
            {!chat && (
              <p className="cw-hint">
                Di cosa vuoi parlare? Il primo messaggio apre una chat separata in questo progetto.
              </p>
            )}
            {chat && (
              <ConversationActions
                title={chat.title}
                projects={projects}
                current={project.id}
                onMove={(id) => onMoveChat(chat.id, id)}
                onCreate={() => onMoveChat(chat.id, "", true)}
              />
            )}
            {chat && (
              <input
                className="cp-chat-title"
                aria-label="Titolo conversazione"
                value={chat.title}
                onChange={(e) => update({ ...chat, title: e.target.value })}
              />
            )}
            {chat?.messages.map((m, i) => (
              <article className="cw-message you" key={i}>
                <p>{m.text}</p>
                {m.files.map((f, j) => (
                  <small key={j}>{f.name} · </small>
                ))}
                <div className="cs-actions">
                  {m.workId ? (
                    <button className="cs-link" onClick={() => onWork(m.workId!)}>
                      Apri compito ↗
                    </button>
                  ) : (
                    <button
                      className="cs-link"
                      onClick={() => {
                        setAssigning(i);
                        setQuery("");
                      }}
                    >
                      Crea compito da questo messaggio
                    </button>
                  )}
                </div>
                {assigning === i && (
                  <div className="cp-assign">
                    <input
                      aria-label="Cerca collaboratore per il compito"
                      placeholder="Cerca collaboratore…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {people
                      .filter((n) => n.toLowerCase().includes(query.toLowerCase()))
                      .map((n) => (
                        <button
                          className="cw-secondary"
                          key={n}
                          onClick={() => {
                            const id = onAssign(n, m.text, m.files, project.id);
                            if (!id) return;
                            update({
                              ...chat,
                              messages: chat.messages.map((item, j) =>
                                j === i ? { ...item, workId: id } : item,
                              ),
                            });
                            setAssigning(null);
                          }}
                        >
                          {n}
                        </button>
                      ))}
                    <button className="cs-link" onClick={() => setAssigning(null)}>
                      Annulla
                    </button>
                  </div>
                )}
              </article>
            ))}
            {tasks.length > 0 && (
              <details>
                <summary>Conversazioni dei compiti · {tasks.length}</summary>
                <div className="cs-collection">
                  {tasks.map((w) => (
                    <button key={w.id} onClick={() => onWork(w.id)}>
                      {w.title} ↗
                    </button>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
        {tab === "Compiti" && (
          <div className="cs-collection">
            {!tasks.length && <p>Nessun compito. Puoi crearlo da un messaggio della chat.</p>}
            {tasks.map((w) => (
              <button key={w.id} onClick={() => onWork(w.id)}>
                <span>
                  {w.title}
                  <small>{w.status}</small>
                </span>
                ↗
              </button>
            ))}
          </div>
        )}
        {tab === "Materiali" && (
          <div className="cs-collection">
            {materials
              .filter((m) => m.projectIds.includes(project.id))
              .map((m) => (
                <button key={m.id} onClick={() => onMaterial(m.id)}>
                  {m.name} ↗
                </button>
              ))}
            {chats.flatMap((c) =>
              c.messages.flatMap((m, i) =>
                m.files.map((f, j) => (
                  <div key={c.id + i + ":" + j}>
                    {f.name}
                    <small> · {c.title}</small>
                  </div>
                )),
              ),
            )}
            {!materials.some((m) => m.projectIds.includes(project.id)) &&
              !chats.some((c) => c.messages.some((m) => m.files.length)) && (
                <p>Allega file in una chat oppure collega materiali dalla raccolta.</p>
              )}
          </div>
        )}
      </div>
      {tab === "Chat" && (
        <div className="cw-composer">
          <StudioChatInput
            key={active || "new"}
            label="Scrivi nella chat del progetto"
            onSend={(text, files) => {
              const next = chat || {
                id: crypto.randomUUID(),
                title: text.trim().slice(0, 55) || "Materiali",
                messages: [],
              };
              update({ ...next, messages: [...next.messages, { text, files }] });
              setActive(next.id);
            }}
          />
          <div className="cw-composer-caption">
            Chat separate · demo locale, nessun modello collegato
          </div>
        </div>
      )}
    </>
  );
}
