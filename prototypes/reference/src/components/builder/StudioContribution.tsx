import { useRef, useState } from "react";
import type { AssignedWork } from "./StudioToday";
import type { SharedDocument } from "./StudioDocuments";
import { importDocumentFiles } from "../../lib/studio-documents";

export function StudioContribution({
  task,
  tasks,
  people,
  documents,
  onDocuments,
  onUpdate,
  onOpen,
}: {
  task: AssignedWork;
  tasks: AssignedWork[];
  people: { id: string; name: string }[];
  documents: SharedDocument[];
  onDocuments: (docs: SharedDocument[]) => void;
  onUpdate: (tasks: AssignedWork[]) => void;
  onOpen: (id: string) => void;
}) {
  const request = task.requestFor
    ? task
    : tasks.find((t) => t.requestFor?.startsWith(task.id + ":") && t.status !== "done");
  const parent =
    request && tasks.find((t) => t.steps?.some((s) => `${t.id}:${s.id}` === request.requestFor));
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [delivered, setDelivered] = useState(false);
  const name = (id: string) => people.find((p) => p.id === id)?.name || "Collaboratore";
  if (!request || !parent) return <p>Richiesta non disponibile.</p>;
  const done = request.status === "done" || delivered;
  function submit() {
    if (done || (!text.trim() && !files.length)) return;
    const next = importDocumentFiles(documents, files, parent!.project, null, [
      request!.person,
      parent!.person,
    ]);
    const imported = next.filter((d) => !documents.some((old) => old.id === d.id));
    if (files.length) onDocuments(next);
    onUpdate(
      tasks.map((t) => {
        if (t.id === request!.id)
          return {
            ...t,
            status: "done",
            result: text.trim() || "Materiali consegnati",
            resultFiles: files,
          };
        if (t.id !== parent!.id) return t;
        const steps =
          t.steps?.map((s) =>
            `${t.id}:${s.id}` === request!.requestFor ? { ...s, blocker: "", reason: "" } : s,
          ) || [];
        return {
          ...t,
          needsMaterials: false,
          steps,
          status: steps.some((s) => s.blocker && !s.done) ? "blocked" : "todo",
          files: [...(t.files || []), ...files],
          materialLinks: [
            ...(t.materialLinks || []),
            ...imported.map((d) => ({ id: d.id, title: d.title, version: d.version })),
          ],
          notes: [
            ...(t.notes || []),
            `Contributo di ${name(request!.person)}: ${text.trim() || files.map((f) => f.name).join(", ")}`,
          ],
          deliveries: [
            ...(t.deliveries || []),
            {
              taskId: request!.id,
              title: text.trim() || request!.title,
              files,
              acceptedAt: new Date().toISOString(),
            },
          ],
        };
      }),
    );
    setDelivered(true);
  }
  return (
    <section className="st-contribution">
      <p className="st-muted">
        Richiesto a {name(request.person)} · per {name(parent.person)}
      </p>
      <h3>{done ? "Contributo consegnato" : "Cosa serve"}</h3>
      <p>
        Serve per: <strong>{parent.title}</strong>
      </p>
      {done ? (
        <>
          <p>
            La risposta è collegata al lavoro. L’attesa relativa a questa richiesta è risolta; il
            lavoro deve ancora essere eseguito e verificato.
          </p>
          <button className="st-btn dark" onClick={() => onOpen(parent.id)}>
            Apri lavoro →
          </button>
        </>
      ) : (
        <>
          <p>
            {(request.brief !== request.title ? request.brief : "") ||
              "Fornisci ciò che è richiesto qui sopra: puoi scrivere una risposta, indicare dove trovare le informazioni oppure allegarle."}
          </p>
          <label>
            La tua risposta
            <textarea
              aria-label="Risposta alla richiesta"
              placeholder="Scrivi le informazioni richieste o incolla un link…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="st-contribution-actions">
            <button className="st-btn" onClick={() => picker.current?.click()}>
              Allega file
            </button>
            <button className="st-btn" onClick={() => folder.current?.click()}>
              Carica cartella
            </button>
          </div>
          {files.map((f, i) => (
            <div className="st-contribution-file" key={i}>
              <span>{f.webkitRelativePath || f.name}</span>
              <button
                className="st-text-link"
                onClick={() => setFiles(files.filter((_, index) => index !== i))}
                aria-label={`Rimuovi ${f.name}`}
              >
                Rimuovi
              </button>
            </div>
          ))}
          <div className="st-contribution-actions">
            <button
              className="st-btn dark"
              disabled={!text.trim() && !files.length}
              onClick={submit}
            >
              Consegna contributo
            </button>
          </div>
          <small className="st-muted">
            Demo: consegna locale, nessuna verifica automatica del contenuto. Le cartelle sono
            copie.
          </small>
          <input
            ref={picker}
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
        </>
      )}
    </section>
  );
}
