import { StudioChatInput } from "./StudioChatInput";
import { Message } from "../ai-elements/message";
import { useState, useEffect } from "react";
import { Paperclip, SlidersHorizontal } from "lucide-react";
import { StudioProjectPicker } from "./StudioProjectPicker";
import type { AssignedWork, TodayProject } from "./StudioToday";
import {
  filterConversation,
  messageProjectIds,
  type ConversationMessage,
} from "../../lib/studio-conversations";
export type ConversationContext = { person: string; taskId: string; nonce: number };
export function StudioConversation({
  person,
  messages,
  onMessage,
  tasks,
  projects,
  onTask,
  onProject,
  onAssign,
  context,
  shared = false,
  compact = false,
  onShare,
  people = [],
}: {
  person: { id: string; name: string };
  messages: ConversationMessage[];
  onMessage: (m: ConversationMessage) => void;
  tasks: AssignedWork[];
  projects: TodayProject[];
  onTask: (id: string) => void;
  onProject: (id: string) => void;
  onAssign?: (message: ConversationMessage) => void;
  shared?: boolean;
  compact?: boolean;
  onShare?: (message: ConversationMessage, taskId: string) => void;
  people?: { id: string; name: string }[];
  context?: ConversationContext | null;
}) {
  const [sharing, setSharing] = useState<string | null>(null);
  const [shareTask, setShareTask] = useState<string[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [refs, setRefs] = useState(false);
  const [filters, setFilters] = useState(false);
  const [taskFilter, setTaskFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [general, setGeneral] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (context?.person === person.id) {
      setTaskIds([context.taskId]);
      setProjectIds([]);
      setTaskFilter([context.taskId]);
      setProjectFilter([]);
      setGeneral(false);
      setRefs(true);
      setFilters(true);
    }
  }, [context, person.id]);
  const visible = filterConversation(messages, {
    taskIds: taskFilter,
    projectIds: projectFilter,
    general,
  });
  const hasFilter = general || !!taskFilter.length || !!projectFilter.length;
  const allTasks = tasks.map((t) => ({ id: t.id, name: t.title }));
  function download(file: File) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function send(text: string, files: File[]) {
    if (!text.trim() && !files.length) return;
    const message: ConversationMessage = {
      id: crypto.randomUUID(),
      text: text.trim(),
      files: [...files],
      taskIds: [...taskIds],
      projectIds: messageProjectIds(projectIds, taskIds, tasks),
      createdAt: new Date().toISOString(),
    };
    onMessage(message);
    setTaskIds([]);
    setProjectIds([]);
    setRefs(false);
    setNotice("Messaggio aggiunto alla conversazione locale.");
    if (
      !filterConversation([message], { taskIds: taskFilter, projectIds: projectFilter, general })
        .length
    ) {
      setTaskFilter([]);
      setProjectFilter([]);
      setGeneral(false);
      setNotice("Messaggio aggiunto. Filtri rimossi per mostrarlo.");
    }
  }
  return (
    <section className="st-conversation" aria-label={`Conversazione con ${person.name}`}>
      <div className="st-conversation-head">
        <h2>
          {shared
            ? "Discussione condivisa"
            : compact
              ? `Chat con ${person.name}`
              : "Conversazione privata"}
        </h2>
        <button
          className={`st-squad-filter-toggle ${hasFilter ? "has-filter" : ""}`}
          aria-label="Filtra conversazione"
          aria-expanded={filters}
          onClick={() => setFilters(!filters)}
        >
          <SlidersHorizontal size={16} />
          {hasFilter && <span className="st-filter-dot" />}
        </button>
      </div>
      <p className="st-muted">
        {shared
          ? "Messaggi visibili ai partecipanti del compito."
          : "I riferimenti a compiti e progetti non condividono questa chat."}
      </p>
      {filters && (
        <div className="st-conversation-filters">
          <StudioProjectPicker
            label="Filtra messaggi per compiti"
            options={allTasks}
            value={taskFilter}
            emptyLabel="Tutti i compiti"
            onChange={(ids) => {
              setTaskFilter(ids);
              setGeneral(false);
            }}
          />
          <StudioProjectPicker
            label="Filtra messaggi per progetti"
            options={projects}
            value={projectFilter}
            emptyLabel="Tutti i progetti"
            onChange={(ids) => {
              setProjectFilter(ids);
              setGeneral(false);
            }}
          />
          <label className="st-step-check">
            <input
              type="checkbox"
              checked={general}
              onChange={(e) => {
                setGeneral(e.target.checked);
                setTaskFilter([]);
                setProjectFilter([]);
              }}
            />
            Solo conversazione generale
          </label>
          {hasFilter && (
            <button
              className="st-text-link"
              onClick={() => {
                setTaskFilter([]);
                setProjectFilter([]);
                setGeneral(false);
              }}
            >
              Azzera filtri
            </button>
          )}
          <p className="st-muted">
            {visible.length} di {messages.length} messaggi. Compiti e progetti selezionati devono
            entrambi corrispondere.
          </p>
        </div>
      )}
      {!shared && !compact && (
        <details className="st-result">
          <summary>Discussioni condivise dei compiti</summary>
          {tasks
            .filter((t) => t.person === person.id || t.participants?.includes(person.id))
            .map((t) => (
              <button className="st-recent" key={t.id} onClick={() => onTask(t.id)}>
                <span>
                  {t.title}
                  <small>{t.messages?.length || 0} messaggi condivisi · apri discussione</small>
                </span>
              </button>
            ))}
        </details>
      )}
      <div className="st-conversation-messages">
        {!visible.length && (
          <p className="st-muted">
            {messages.length
              ? "Nessun messaggio per questi filtri."
              : "Inizia una conversazione. Puoi allegare file o collegare il messaggio a un lavoro."}
          </p>
        )}
        {visible.map((m) => (
          <Message from="user" className="st-note-bubble" key={m.id}>
            <small>
              Fabio ·{" "}
              {new Date(m.createdAt).toLocaleString("it-IT", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              · locale
            </small>
            {m.text && <p className="st-message-text">{m.text}</p>}
            <div className="st-message-context">
              {m.taskIds.map((id) => (
                <button key={id} onClick={() => onTask(id)}>
                  Compito · {tasks.find((t) => t.id === id)?.title || "non disponibile"} ↗
                </button>
              ))}
              {m.projectIds.map((id) => (
                <button key={id} onClick={() => onProject(id)}>
                  Progetto · {projects.find((p) => p.id === id)?.name || "non disponibile"} ↗
                </button>
              ))}
            </div>
            {m.files.map((file, i) => (
              <button key={i} className="st-message-file" onClick={() => download(file)}>
                <Paperclip size={14} />
                {file.name}
                <small>{Math.ceil(file.size / 1024)} KB · scarica</small>
              </button>
            ))}
            {onAssign && (
              <button className="st-text-link" onClick={() => onAssign(m)}>
                Trasforma in incarico →
              </button>
            )}
            {onShare && (
              <button
                className="st-text-link"
                onClick={() => {
                  setSharing(m.id);
                  setShareTask(m.taskIds.slice(0, 1));
                }}
              >
                Condividi nel compito…
              </button>
            )}
            {sharing === m.id && onShare && (
              <div className="st-conversation-references">
                <StudioProjectPicker
                  label="Compito in cui condividere"
                  options={allTasks}
                  value={shareTask}
                  onChange={(ids) => setShareTask(ids.slice(-1))}
                  emptyLabel="Scegli un compito"
                />
                <p>
                  Visibile a:{" "}
                  {[
                    ...new Set([
                      "user:fabio",
                      ...(tasks.find((t) => t.id === shareTask[0])?.participants || []),
                      tasks.find((t) => t.id === shareTask[0])?.person || "",
                    ]),
                  ]
                    .filter(Boolean)
                    .map((id) => people.find((p) => p.id === id)?.name || id)
                    .join(", ")}
                  . Verranno condivisi questo messaggio e i suoi {m.files.length} allegati.
                </p>
                <button
                  className="st-btn dark"
                  disabled={!shareTask.length}
                  onClick={() => {
                    onShare(m, shareTask[0]!);
                    setSharing(null);
                    setNotice("Messaggio condiviso nel compito. La chat resta privata.");
                  }}
                >
                  Conferma condivisione
                </button>
                <button className="st-btn" onClick={() => setSharing(null)}>
                  Annulla
                </button>
              </div>
            )}
            {m.source && (
              <small>Condiviso da una conversazione privata · solo questo messaggio</small>
            )}
          </Message>
        ))}
      </div>
      <StudioChatInput label={`Messaggio a ${person.name}`} onSend={send}>
        <button
          hidden={shared}
          type="button"
          className="st-btn"
          aria-expanded={refs}
          onClick={() => setRefs(!refs)}
        >
          Collega compito o progetto
          {taskIds.length + projectIds.length ? ` (${taskIds.length + projectIds.length})` : ""}
        </button>
        {refs && (
          <div className="st-conversation-references">
            <StudioProjectPicker
              label="Compiti del messaggio"
              options={allTasks}
              value={taskIds}
              onChange={setTaskIds}
              emptyLabel="Nessun compito"
            />
            <StudioProjectPicker
              label="Progetti del messaggio"
              options={projects}
              value={projectIds}
              onChange={setProjectIds}
              emptyLabel="Nessun progetto aggiuntivo"
            />
            <p className="st-muted">
              Il progetto di un compito viene collegato automaticamente. I riferimenti non concedono
              nuovi permessi.
            </p>
          </div>
        )}
      </StudioChatInput>
      {notice && (
        <p role="status" className="st-muted">
          {notice}
        </p>
      )}
    </section>
  );
}
