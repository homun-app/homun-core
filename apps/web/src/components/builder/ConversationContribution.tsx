import { ConversationMemberPicker } from "./ConversationMemberPicker";
import type { MemberProfile } from "./conversation-members";
import { useRef, useState } from "react";
import type { Work } from "./conversation-types";

export function ConversationContribution({
  work,
  viewer,
  members,
  profiles,
  materials,
  onRequest,
  onDeliver,
  onOpen,
}: {
  work: Work;
  viewer: string;
  members: { name: string; role: string }[];
  profiles?: Record<string, MemberProfile> | undefined;
  materials: { id: string; name: string }[];
  onRequest: (to: string, need: string) => void;
  onDeliver: (text: string, files: File[], ids: string[]) => void;
  onOpen: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(work.requester || "Fabio");
  const [need, setNeed] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const request = work.request;
  const pending = request?.status === "pending";
  const canManage = viewer === (work.requester || "Fabio") || viewer === work.reviewer;
  const canReply = pending && viewer === request.to && !request.childId;
  return (
    <div className="cw-contribution">
      {pending ? (
        <>
          <strong>Serve da {request.to}</strong>
          <p>{request.need}</p>
          {canManage && !request.childId && (
            <details className="cw-details">
              <summary>Chiedi a un altro collaboratore</summary>
              <ConversationMemberPicker
                label="Riassegna contributo"
                people={members.map((m) => m.name)}
                profiles={profiles}
                selected={to ? [to] : []}
                onChange={(names) => setTo(names.find((n) => n !== to) || "")}
              />
              <button
                className="cw-secondary"
                disabled={to === request.to || !members.some((m) => m.name === to)}
                onClick={() => onRequest(to, request.need)}
              >
                Riassegna richiesta
              </button>
            </details>
          )}

          {request.childId ? (
            <button className="cw-secondary" onClick={() => onOpen(request.childId!)}>
              Apri il contributo dell’agente ↗
            </button>
          ) : canReply ? (
            <>
              <textarea
                aria-label="Risposta alla richiesta"
                placeholder="Scrivi le informazioni o un link…"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="cs-actions">
                <button className="cw-secondary" onClick={() => upload.current?.click()}>
                  Allega file
                </button>
                <button className="cw-secondary" onClick={() => folder.current?.click()}>
                  Allega cartella
                </button>
              </div>
              {files.map((f, i) => (
                <p key={i} className="cw-file">
                  {f.webkitRelativePath || f.name}
                  <button
                    aria-label={`Rimuovi allegato ${f.name}`}
                    onClick={() => setFiles(files.filter((_, j) => i !== j))}
                  >
                    ×
                  </button>
                </p>
              ))}
              <details className="cw-details">
                <summary>Usa materiali già presenti</summary>
                <input
                  aria-label="Cerca materiale richiesto"
                  placeholder="Cerca materiale…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div style={{ maxHeight: 150, overflowY: "auto" }}>
                  {materials
                    .filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
                    .map((m) => (
                      <label key={m.id}>
                        <input
                          type="checkbox"
                          checked={ids.includes(m.id)}
                          onChange={(e) =>
                            setIds(
                              e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id),
                            )
                          }
                        />
                        {m.name}
                      </label>
                    ))}
                </div>
              </details>
              <button
                className="cw-primary"
                disabled={!text.trim() && !files.length && !ids.length}
                onClick={() => {
                  onDeliver(text, files, ids);
                  setText("");
                  setFiles([]);
                  setIds([]);
                }}
              >
                Invia contributo
              </button>
            </>
          ) : (
            <p className="cw-hint">
              La richiesta è nelle notifiche di {request.to}. Il lavoro rimane in attesa.
            </p>
          )}
        </>
      ) : (
        <>
          {request?.status === "resolved" && (
            <p className="cw-hint">✓ Contributo ricevuto da {request.to}</p>
          )}
          {request?.status === "resolved" && request.childId && (
            <button className="cs-link" onClick={() => onOpen(request.childId!)}>
              Apri risultato del contributo ↗
            </button>
          )}
          {canManage &&
            ["ready", "waiting"].includes(work.phase) &&
            (editing ? (
              <>
                <label>
                  Cosa manca?
                  <textarea
                    aria-label="Contributo necessario"
                    placeholder="Es. il listino aggiornato, una decisione o un’analisi…"
                    value={need}
                    onChange={(e) => setNeed(e.target.value)}
                  />
                </label>
                <label>
                  A chi lo chiediamo?
                  <ConversationMemberPicker
                    label="Destinatario del contributo"
                    people={members.map((m) => m.name)}
                    profiles={profiles}
                    selected={to ? [to] : []}
                    onChange={(names) => setTo(names.find((n) => n !== to) || "")}
                  />
                </label>
                <div className="cs-actions">
                  <button className="cw-secondary" onClick={() => setEditing(false)}>
                    Annulla
                  </button>
                  <button
                    className="cw-primary"
                    disabled={!need.trim() || !members.some((m) => m.name === to)}
                    onClick={() => {
                      onRequest(to, need);
                      setEditing(false);
                      setNeed("");
                    }}
                  >
                    Chiedi contributo
                  </button>
                </div>
              </>
            ) : (
              <button className="cs-link" onClick={() => setEditing(true)}>
                Manca qualcosa? Chiedi un contributo
              </button>
            ))}
        </>
      )}
      <input
        ref={upload}
        hidden
        type="file"
        multiple
        onChange={(e) => {
          setFiles([...files, ...Array.from(e.target.files || [])]);
          e.target.value = "";
        }}
      />
      <input
        ref={folder}
        hidden
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          setFiles([...files, ...Array.from(e.target.files || [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
