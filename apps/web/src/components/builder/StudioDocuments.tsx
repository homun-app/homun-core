import { StudioMemberPicker } from "./StudioMemberPicker";
import { StudioProjectPicker } from "./StudioProjectPicker";
import { useState, useRef } from "react";
import type { AssignedWork, TodayProject } from "./StudioToday";
import {
  documentAccess,
  importDocumentFiles,
  moveDocument,
  documentProjects,
  projectAudience,
} from "../../lib/studio-documents";
export type SharedDocument = {
  id: string;
  title: string;
  author: string;
  body: string;
  file?: File;
  version: number;
  taskIds: string[];
  history: string[];
  kind?: "note" | "file" | "folder";
  projectId?: string;
  projectIds?: string[];
  parentId?: string | null;
  accessIds?: string[];
};
export function StudioDocuments({
  documents,
  onChange,
  tasks,
  onTask,
  projects,
  members,
  projectScope,
}: {
  documents: SharedDocument[];
  onChange: (d: SharedDocument[]) => void;
  tasks: AssignedWork[];
  onTask: (id: string) => void;
  projects: TodayProject[];
  members: { id: string; name: string }[];
  projectScope?: string;
}) {
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [destination, setDestination] = useState<string[]>(projectScope ? [projectScope] : []);
  const [restricted, setRestricted] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const directory = useRef<HTMLInputElement>(null);
  const doc = documents.find((d) => d.id === selected);
  const current = documents.find((d) => d.id === folder && d.kind === "folder");
  const activeScope = projectScope ? [projectScope] : scope;
  const eligible = (ids: string[]) =>
    projectAudience(
      ids,
      projects,
      members.map((m) => m.id),
    );
  const names = (ids: string[]) =>
    ids.map((id) => members.find((m) => m.id === id)?.name || id).join(", ");
  const audience = (d: SharedDocument) => {
    const allowed = documentAccess(
      d,
      documents,
      projects,
      members.map((m) => m.id),
    );
    if (d.accessIds || allowed.length < eligible(documentProjects(d)).length)
      return "Solo " + (names(allowed.filter((id) => id !== "user:fabio")) || "Fabio");
    return documentProjects(d).length ? "Squadre dei progetti" : "Tutta la squadra";
  };
  const visible = documents.filter(
    (d) =>
      (!activeScope.length ||
        activeScope.some((id) =>
          id === "__general" ? !documentProjects(d).length : documentProjects(d).includes(id),
        )) &&
      (search
        ? d.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())
        : (d.parentId || null) === (current?.id || null)),
  );
  function patch(value: Partial<SharedDocument>) {
    if (doc) onChange(documents.map((d) => (d.id === doc.id ? { ...d, ...value } : d)));
  }
  function create(kind: "note" | "folder") {
    const d: SharedDocument = {
      id: crypto.randomUUID(),
      title: kind === "folder" ? "Nuova cartella" : "Nuova nota",
      author: "Fabio",
      body: "",
      version: 1,
      history: ["Creato da Fabio"],
      taskIds: [],
      kind,
      projectIds: current ? documentProjects(current) : destination,
      projectId: (current ? documentProjects(current) : destination)[0] || "",
      parentId: current?.id || null,
      ...(!current && restricted ? { accessIds: chosen } : {}),
    };
    onChange([...documents, d]);
    setSelected(d.id);
    setAdding(false);
    setNotice("Elemento aggiunto alla raccolta unica.");
  }
  function upload(files: File[]) {
    if (!files.length) return;
    onChange(
      importDocumentFiles(
        documents,
        files,
        current ? documentProjects(current) : destination,
        current?.id || null,
        restricted ? chosen : undefined,
      ),
    );
    setAdding(false);
    setNotice(`${files.length} file importati mantenendo la struttura delle cartelle.`);
  }
  const crumbs: SharedDocument[] = [];
  let parent = current;
  const seen = new Set<string>();
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    crumbs.unshift(parent);
    parent = documents.find((d) => d.id === parent!.parentId);
  }
  function download(d: SharedDocument) {
    const url = URL.createObjectURL(
      d.file || new Blob([d.body], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = d.file?.name || d.title + ".txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      {!projectScope && (
        <>
          <span className="st-eyebrow">LA RACCOLTA DELLO SPAZIO</span>
          <h1>Documenti</h1>
          <p className="st-intro">
            File, cartelle e note. Una sola raccolta, con destinazione e accessi espliciti.
          </p>
        </>
      )}
      <div className="st-doc-toolbar">
        <button
          className="st-btn dark"
          onClick={() => {
            setAdding(!adding);
            setDestination(
              current
                ? documentProjects(current)
                : projectScope
                  ? [projectScope]
                  : scope.filter((id) => id !== "__general"),
            );
          }}
        >
          Aggiungi
        </button>
        <input
          aria-label="Cerca documenti"
          placeholder="Cerca nella raccolta…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {!projectScope && (
          <StudioProjectPicker
            label="Filtra per progetti"
            options={[{ id: "__general", name: "Spazio generale" }, ...projects]}
            value={scope}
            emptyLabel="Tutti i documenti"
            onChange={(ids) => {
              setScope(ids);
              setFolder(null);
              setSelected("");
            }}
          />
        )}
      </div>
      {adding && (
        <section className="st-paper st-doc-add">
          <h2>Aggiungi alla raccolta</h2>
          {current ? (
            <p>Nella cartella {current.title}. I materiali ereditano i suoi accessi.</p>
          ) : (
            <>
              <StudioProjectPicker
                label="Progetti collegati"
                options={projects}
                value={destination}
                onChange={(ids) => {
                  setDestination(ids);
                  setChosen([]);
                }}
              />
              <p className="st-muted">
                {destination.length
                  ? "Un solo materiale nei progetti selezionati. L’accesso ereditato include le loro squadre; puoi limitarlo qui sotto."
                  : "Senza progetti selezionati, il materiale resta nello spazio generale."}
              </p>
              <label>
                Chi può usarlo
                <select
                  value={restricted ? "selected" : "inherit"}
                  onChange={(e) => setRestricted(e.target.value === "selected")}
                >
                  <option value="inherit">
                    {destination.length ? "Squadre dei progetti selezionati" : "Tutta la squadra"}
                  </option>
                  <option value="selected">Solo elementi selezionati della squadra</option>
                </select>
              </label>
              {restricted && (
                <>
                  <p className="st-muted">
                    Fabio, proprietario dello spazio, mantiene la gestione.
                  </p>
                  <StudioMemberPicker
                    multiple
                    label="Accesso ai materiali"
                    options={members.filter(
                      (m) => m.id !== "user:fabio" && eligible(destination).includes(m.id),
                    )}
                    value={chosen}
                    onChange={setChosen}
                  />
                </>
              )}
            </>
          )}
          <div className="st-sim-actions">
            <label className="st-btn">
              Carica file
              <input
                aria-label="Carica file nella raccolta"
                className="sr-only"
                type="file"
                multiple
                onChange={(e) => {
                  upload(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
            </label>
            <button className="st-btn" onClick={() => directory.current?.click()}>
              Carica cartella
            </button>
            <input
              ref={directory}
              aria-label="Carica cartella nella raccolta"
              className="sr-only"
              type="file"
              multiple
              {...{ webkitdirectory: "" }}
              onChange={(e) => {
                upload(Array.from(e.target.files || []));
                e.target.value = "";
              }}
            />
            <button className="st-btn" onClick={() => create("note")}>
              Scrivi una nota
            </button>
            <button className="st-btn" onClick={() => create("folder")}>
              Nuova cartella
            </button>
            <button className="st-btn" onClick={() => setAdding(false)}>
              Annulla
            </button>
          </div>
        </section>
      )}
      {notice && (
        <p role="status" className="st-muted">
          {notice}
        </p>
      )}
      <nav className="st-doc-crumbs" aria-label="Percorso cartella">
        <button
          onClick={() => {
            setFolder(null);
            setSearch("");
          }}
        >
          Raccolta
        </button>
        {crumbs.map((d) => (
          <button
            key={d.id}
            onClick={() => {
              setFolder(d.id);
              setSearch("");
            }}
          >
            {" "}
            / {d.title}
          </button>
        ))}
      </nav>
      {!visible.length && (
        <p className="st-paper st-muted">
          {search
            ? "Nessun materiale corrisponde alla ricerca."
            : "Non ci sono materiali qui. Usa Aggiungi per caricare file, cartelle o scrivere una nota."}
        </p>
      )}
      <div className="st-job-list">
        {visible.map((d) => (
          <div className="st-doc-row" key={d.id}>
            <button
              className="st-job"
              onClick={() =>
                d.kind === "folder"
                  ? (setFolder(d.id), setSearch(""), setSelected(""))
                  : setSelected(d.id)
              }
            >
              <span className="st-job-copy">
                <strong>{d.title}</strong>
                <small>
                  {d.kind === "folder" ? "Cartella" : d.file ? "File" : "Nota"} ·{" "}
                  {documentProjects(d).length
                    ? documentProjects(d)
                        .slice(0, 2)
                        .map(
                          (id) =>
                            projects.find((p) => p.id === id)?.name || "Progetto non disponibile",
                        )
                        .join(", ") +
                      (documentProjects(d).length > 2
                        ? ` +${documentProjects(d).length - 2} progetti`
                        : "")
                    : "Spazio generale"}{" "}
                  · {audience(d)}
                </small>
                <small>
                  {d.author} · versione {d.version}
                </small>
              </span>
              <span>Apri →</span>
            </button>
            {d.kind === "folder" && (
              <button
                className="st-text-link"
                aria-label={`Gestisci cartella ${d.title}`}
                onClick={() => setSelected(d.id)}
              >
                Gestisci
              </button>
            )}
          </div>
        ))}
      </div>
      {doc && (
        <section className="st-paper st-document-editor">
          <div className="st-section-head">
            <h2>{doc.title}</h2>
            <button onClick={() => setSelected("")}>Chiudi documento</button>
          </div>
          <p>
            {doc.author} · v{doc.version}
          </p>
          <form
            key={doc.id + ":" + doc.version}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              patch({
                title: String(f.get("title")).trim() || doc.title,
                body: doc.file || doc.kind === "folder" ? doc.body : String(f.get("body") || ""),
                version: doc.version + 1,
                history: [...doc.history, "Versione " + (doc.version + 1) + " salvata da Fabio"],
              });
            }}
          >
            <label>
              Titolo
              <input required name="title" defaultValue={doc.title} />
            </label>
            {!doc.file && doc.kind !== "folder" && (
              <label>
                Contenuto della nota
                <textarea name="body" defaultValue={doc.body} rows={8} />
              </label>
            )}
            <button className="st-btn">Salva nuova versione</button>
          </form>
          {doc.kind !== "folder" && (
            <button className="st-btn" onClick={() => download(doc)}>
              Scarica documento
            </button>
          )}
          <details open>
            <summary>Destinazione e accessi</summary>
            <StudioProjectPicker
              label="Progetti del materiale"
              options={projects}
              value={documentProjects(doc)}
              onChange={(ids) => {
                const moved = moveDocument(documents, doc.id, ids);
                onChange(
                  doc.parentId
                    ? moved.map((d) =>
                        d.id === doc.id
                          ? {
                              ...d,
                              accessIds: documentAccess(
                                doc,
                                documents,
                                projects,
                                members.map((m) => m.id),
                              ),
                            }
                          : d,
                      )
                    : moved,
                );
                setFolder(null);
                setNotice(
                  "Progetti aggiornati senza duplicare il materiale. Le restrizioni selezionate restano valide.",
                );
              }}
            />
            <p className="st-muted">
              Nessun progetto: spazio generale. Più progetti: accessi delle loro squadre, limitabili
              qui sotto. Le cartelle aggiornano anche i contenuti.
            </p>
            <label>
              Condivisione
              <select
                value={doc.accessIds ? "selected" : "inherit"}
                onChange={(e) => {
                  if (e.target.value === "selected") patch({ accessIds: [] });
                  else
                    onChange(
                      documents.map((d) => {
                        if (d.id !== doc.id) return d;
                        const next = { ...d };
                        delete next.accessIds;
                        return next;
                      }),
                    );
                }}
              >
                <option value="inherit">
                  {doc.parentId
                    ? "Eredita dalla cartella"
                    : documentProjects(doc).length
                      ? "Squadre dei progetti selezionati"
                      : "Tutta la squadra"}
                </option>
                <option value="selected">Solo elementi selezionati</option>
              </select>
            </label>
            {doc.accessIds && (
              <StudioMemberPicker
                multiple
                label="Accesso al documento"
                options={members.filter(
                  (m) => m.id !== "user:fabio" && eligible(documentProjects(doc)).includes(m.id),
                )}
                value={doc.accessIds}
                onChange={(ids) => patch({ accessIds: ids })}
              />
            )}
            <p className="st-muted">
              Accesso effettivo:{" "}
              {names(
                documentAccess(
                  doc,
                  documents,
                  projects,
                  members.map((m) => m.id),
                ).filter((id) => id !== "user:fabio"),
              ) || "nessun altro collaboratore"}
              . Fabio mantiene la gestione. Le restrizioni della cartella e del progetto prevalgono.
            </p>
          </details>
          {doc.kind !== "folder" && (
            <details>
              <summary>Collega agli incarichi</summary>
              <p className="st-muted">
                Collegare un materiale non estende i suoi permessi. Gli incarichi usano la versione
                corrente.
              </p>
              {tasks.map((t) => (
                <label className="st-step-check" key={t.id}>
                  <input
                    type="checkbox"
                    checked={doc.taskIds.includes(t.id)}
                    disabled={
                      !doc.taskIds.includes(t.id) &&
                      t.person !== "user:fabio" &&
                      !documentAccess(
                        doc,
                        documents,
                        projects,
                        members.map((m) => m.id),
                      ).includes(t.person)
                    }
                    onChange={(e) =>
                      patch({
                        taskIds: e.target.checked
                          ? [...doc.taskIds, t.id]
                          : doc.taskIds.filter((id) => id !== t.id),
                      })
                    }
                  />
                  {t.title}
                </label>
              ))}
            </details>
          )}
          {doc.taskIds.map((id) => (
            <button className="st-recent" key={id} onClick={() => onTask(id)}>
              Apri incarico: {tasks.find((t) => t.id === id)?.title || id} →
            </button>
          ))}
          <details>
            <summary>Cronologia</summary>
            {doc.history.map((h, i) => (
              <p key={i}>{h}</p>
            ))}
          </details>
        </section>
      )}
      <p className="st-muted">
        Prototipo locale: accessi simulati, nessun invio esterno. File, note e cartelle si perdono
        al ricaricamento. L’importazione di cartelle conserva i file e i percorsi, non sincronizza
        il disco; le cartelle vuote non sono incluse.
      </p>
    </>
  );
}
