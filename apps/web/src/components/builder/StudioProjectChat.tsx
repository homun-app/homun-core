import { useContext, useRef, useState } from "react";
import { StudioChatInput } from "./StudioChatInput";
import { StudioMemberPicker } from "./StudioMemberPicker";
import type { StudioMember } from "../../lib/studio-members";
import { documentAccess, documentProjects, importDocumentFiles } from "../../lib/studio-documents";
import { StudioMaterialContext } from "../../lib/studio-material-context";
import { workStates, statusOf } from "../../lib/studio-work";
import type { AssignedWork } from "./StudioToday";
import type { SharedDocument } from "./StudioDocuments";

type Draft = {
  title: string;
  person: string;
  brief: string;
  due: string;
  materialIds: string[];
  later: boolean;
  stage: "materials" | "date" | "plan";
  steps: string[];
};
export function StudioProjectChat({
  project,
  people,
  documents,
  onDocuments,
  onChange,
  onFiles,
  tasks,
  onAssign,
  onTask,
}: {
  project: { id: string; goal: string; members: string[]; notes: string[] };
  people: StudioMember[];
  documents: SharedDocument[];
  onDocuments: (docs: SharedDocument[]) => void;
  onChange: (patch: { goal?: string; members?: string[]; notes?: string[] }) => void;
  onFiles: () => void;
  tasks: AssignedWork[];
  onAssign: (task: AssignedWork) => void;
  onTask: (id: string) => void;
}) {
  const folder = useRef<HTMLInputElement>(null);
  const materialContext = useContext(StudioMaterialContext);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [feedback, setFeedback] = useState("");
  const [chooseMaterials, setChooseMaterials] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const submitted = useRef(false);
  const linked = documents.filter((d) => draft?.materialIds.includes(d.id));
  const available = documents.filter(
    (d) =>
      documentProjects(d).includes(project.id) &&
      !d.parentId &&
      (!draft?.person ||
        documentAccess(d, documents, materialContext.projects, materialContext.members).includes(
          draft.person,
        )),
  );
  function upload(files: File[]) {
    if (!files.length) return;
    const next = importDocumentFiles(documents, files, project.id, null);
    onDocuments(next);
    const ids = next.filter((d) => !documents.some((old) => old.id === d.id)).map((d) => d.id);
    setDraft((current) =>
      current
        ? {
            ...current,
            materialIds: [...current.materialIds, ...ids],
            later: false,
            stage: current.stage === "materials" ? "date" : current.stage,
          }
        : null,
    );
    setFeedback(`${files.length} file aggiunti ai materiali del progetto.`);
  }
  function confirm() {
    if (!draft || !draft.person || !draft.title.trim() || submitted.current) return;
    submitted.current = true;
    const task: AssignedWork = {
      id: crypto.randomUUID(),
      title: draft.title,
      person: draft.person,
      project: project.id,
      brief: draft.brief,
      needsMaterials: draft.later,
      due: draft.due,
      status: draft.later ? "blocked" : "todo",
      notes: [
        "Creato dalla chat del progetto",
        ...(draft.later ? ["In attesa dei materiali di partenza."] : []),
      ],
      materialLinks: linked.map((d) => ({ id: d.id, title: d.title, version: d.version })),
      steps: draft.steps.map((title, index) => ({
        id: draft.later && index === 0 ? "input" : crypto.randomUUID(),
        title,
        done: false,
        ...(draft.later && index === 0
          ? { blocker: "user:fabio", reason: "Fornire i listini per il catalogo" }
          : {}),
      })),
      ...(!draft.person.startsWith("user:")
        ? {
            training: {
              activity: draft.title,
              scope: "Preparare una bozza da verificare",
              mode: "stage" as const,
            },
          }
        : {}),
      successCriteria: "Una prima bozza da verificare prima di pubblicare o inviare.",
    };
    onChange({ members: [...new Set([...project.members, draft.person])] });
    onAssign(task);
    setDraft(null);
    setFeedback("");
    setEditing(false);
  }
  return (
    <section className="st-project-chat">
      <div className="st-project-chat-history" aria-live="polite">
        {!project.notes.length && (
          <div className="st-project-chat-welcome">
            <h2>Cosa vogliamo realizzare insieme?</h2>
            <p>Descrivi il lavoro e coinvolgi un collaboratore con @.</p>
            <small>Prova guidata: «Prepariamo il nuovo catalogo con @Marta e i listini».</small>
          </div>
        )}
        {project.notes.map((note, i) => (
          <div className="st-note-bubble" key={i}>
            {note}
            <small>Tu · progetto</small>
          </div>
        ))}
        {!draft &&
          tasks
            .filter(
              (t) =>
                t.project === project.id && t.notes?.includes("Creato dalla chat del progetto"),
            )
            .map((t) => (
              <div className="st-project-chat-proposal" key={t.id}>
                <strong>{t.title}</strong>
                <p>
                  {people.find((p) => p.id === t.person)?.name} · {workStates[statusOf(t)]}
                </p>
                <p>
                  {t.status === "blocked"
                    ? "Hai una richiesta per fornire i materiali. Caricali qui per sbloccare il lavoro."
                    : "Il compito è pronto nella demo. Nessun agente è in esecuzione."}
                </p>
                <button className="st-btn dark" onClick={() => onTask(t.id)}>
                  {t.needsMaterials ? "Carica materiali →" : "Apri compito →"}
                </button>
              </div>
            ))}
        {draft && (
          <div className="st-project-chat-proposal">
            <strong>
              {draft.title}
              {draft.person ? ` · ${people.find((p) => p.id === draft.person)?.name}` : ""}
            </strong>
            {!draft.person ? (
              <>
                <p>Chi deve occuparsene?</p>
                <StudioMemberPicker
                  label="Responsabile"
                  options={people}
                  value={[]}
                  onChange={(ids) => setDraft({ ...draft, person: ids[0] || "" })}
                />
              </>
            ) : draft.stage === "materials" ? (
              <>
                <p>
                  Collega i materiali da cui partire. Per il catalogo, carica la cartella dei
                  listini.
                </p>
                <div className="st-project-chat-actions">
                  <button className="st-btn dark" onClick={() => folder.current?.click()}>
                    Scegli cartella
                  </button>
                  <button className="st-btn" onClick={() => setChooseMaterials(!chooseMaterials)}>
                    Usa materiali del progetto
                  </button>
                  <button
                    className="st-text-link"
                    onClick={() => setDraft({ ...draft, later: true, stage: "date" })}
                  >
                    Li aggiungerò dopo
                  </button>
                </div>
                {chooseMaterials && (
                  <div>
                    {!available.length && (
                      <p>
                        Nessun materiale disponibile per questo collaboratore. Puoi allegare un file
                        con la graffetta.
                      </p>
                    )}
                    {available.map((d) => (
                      <button
                        key={d.id}
                        className="st-recent"
                        onClick={() => {
                          setDraft({ ...draft, materialIds: [d.id], stage: "date", later: false });
                          setChooseMaterials(false);
                        }}
                      >
                        {d.title} →
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : draft.stage === "date" ? (
              <>
                <p>
                  {draft.later
                    ? "Il compito resterà in attesa dei materiali."
                    : "Materiali collegati."}{" "}
                  Hai una scadenza?
                </p>
                <div className="st-project-chat-actions">
                  <button className="st-btn" onClick={() => setDateOpen(true)}>
                    Scegli data
                  </button>
                  <button
                    className="st-btn"
                    onClick={() => setDraft({ ...draft, due: "", stage: "plan" })}
                  >
                    Non ancora
                  </button>
                </div>
                {dateOpen && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setDraft({ ...draft, stage: "plan" });
                    }}
                  >
                    <label>
                      Pronto entro
                      <input
                        aria-label="Scadenza del piano"
                        type="datetime-local"
                        required
                        value={draft.due}
                        onChange={(e) => setDraft({ ...draft, due: e.target.value })}
                      />
                    </label>
                    <button className="st-btn dark">Continua</button>
                  </form>
                )}
              </>
            ) : (
              <>
                <p>
                  {people.find((p) => p.id === draft.person)?.name} seguirà questi passaggi. La
                  prima bozza sarà da verificare.
                </p>
                <ol>
                  {draft.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
                <p>
                  {draft.later
                    ? "In attesa dei materiali"
                    : `Materiali: ${
                        linked
                          .filter((d) => d.kind !== "folder")
                          .map((d) => d.title)
                          .join(", ") || linked.map((d) => d.title).join(", ")
                      }`}{" "}
                  · {draft.due ? new Date(draft.due).toLocaleString("it-IT") : "Senza scadenza"}
                </p>
                {editing && (
                  <>
                    <label>
                      Compito
                      <input
                        value={draft.title}
                        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                      />
                    </label>
                    <StudioMemberPicker
                      label="Responsabile del piano"
                      options={people}
                      value={[draft.person]}
                      onChange={(ids) =>
                        setDraft({
                          ...draft,
                          person: ids[0] || "",
                          materialIds: [],
                          stage: "materials",
                        })
                      }
                    />
                    <label>
                      Passaggi, uno per riga
                      <textarea
                        value={draft.steps.join("\n")}
                        onChange={(e) => setDraft({ ...draft, steps: e.target.value.split("\n") })}
                      />
                    </label>
                    <button
                      className="st-text-link"
                      onClick={() => setDraft({ ...draft, stage: "date" })}
                    >
                      Cambia scadenza
                    </button>
                  </>
                )}
                <div className="st-project-chat-actions">
                  <button className="st-text-link" onClick={() => setEditing(!editing)}>
                    Modifica piano
                  </button>
                  <button className="st-btn dark" disabled={!draft.title.trim()} onClick={confirm}>
                    Conferma il piano
                  </button>
                </div>
              </>
            )}
            <button
              className="st-text-link"
              onClick={() => {
                setDraft(null);
                setFeedback("Proposta annullata. Nessun compito creato.");
              }}
            >
              Annulla proposta
            </button>
          </div>
        )}
        {feedback && <p role="status">{feedback}</p>}
      </div>
      <StudioChatInput
        label="Scrivi nel progetto"
        references={people.map((p) => ({
          id: p.id,
          name: p.name,
          kind: "member",
          description: p.responsibility || "",
        }))}
        onSend={(text, files, refs) => {
          if (text.trim()) onChange({ notes: [...project.notes, text.trim()] });
          if (draft) {
            upload(files);
            if (text.trim())
              setFeedback(
                "Indicazione conservata nella conversazione. In questa prova modifica il piano con i controlli della proposta; le correzioni libere richiedono il motore AI.",
              );
            return;
          }
          if (!text.trim()) {
            upload(files);
            return;
          }
          if (!/catalogo/i.test(text)) {
            upload(files);
            setFeedback(
              "Questa prova guidata prepara un catalogo con i listini. Il messaggio è conservato; l’interpretazione di altri lavori arriverà con il motore AI.",
            );
            return;
          }
          const named = people.filter((p) =>
            text.toLocaleLowerCase().includes(`@${p.name.toLocaleLowerCase()}`),
          );
          const person =
            refs?.find((r) => r.kind === "member")?.id ||
            (named.length === 1 ? named[0]?.id : "") ||
            "";
          submitted.current = false;
          setDateOpen(false);
          setEditing(false);
          setChooseMaterials(false);
          setFeedback("");
          setDraft({
            title: "Preparare la prima bozza del catalogo",
            brief: text,
            person,
            due: "",
            materialIds: [],
            later: false,
            stage: "materials",
            steps: [
              "Controllare i listini e segnalare le informazioni mancanti",
              "Preparare la prima bozza del catalogo",
              "Consegnare la bozza per la verifica",
            ],
          });
          upload(files);
        }}
      >
        <div className="st-project-composer-tools">
          <button type="button" className="st-text-link" onClick={() => folder.current?.click()}>
            Carica cartella
          </button>
          <button type="button" className="st-text-link" onClick={onFiles}>
            Materiali del progetto
          </button>
        </div>
      </StudioChatInput>
      <input
        hidden
        ref={folder}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          upload(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <small className="st-muted">
        Scenario guidato · nessuna esecuzione AI · cartelle importate come copie · dati fino al
        ricaricamento.
      </small>
    </section>
  );
}
