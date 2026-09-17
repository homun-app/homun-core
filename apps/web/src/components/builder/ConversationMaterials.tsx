import { materialType, materialTypes, readMaterialDrop } from "./conversation-material-files";
import { Popover, PopoverTrigger, PopoverContent } from "@homun/ui/components/popover";
import type { ReactNode } from "react";
import { ConversationMemberPicker } from "./ConversationMemberPicker";
import type { MemberProfile } from "./conversation-members";
import {
  FileText,
  ArrowUpRight,
  CalendarDays,
  Folder,
  Users,
  Eye,
  ChevronDown,
  X,
} from "lucide-react";
import { ConversationMaterialLinker, type MaterialDestination } from "./ConversationMaterialLinker";
import { ConversationSelect } from "./ConversationSelect";
import { useRef, useState } from "react";
import type { SpaceProject } from "./ConversationSpace";
export type ConversationMaterial = {
  id: string;
  addedAt?: string;
  name: string;
  file?: File;
  body?: string;
  path?: string;
  projectIds: string[];
  visibility?: string;
  allowedPeople?: string[];
};
export function ConversationMaterials({
  onBatchRemove,
  onBatchLink,
  contextWork,
  people,
  profiles,
  onBack,
  onReveal,
  items,
  projects,
  works,
  onAdd,
  onUpdate,
  onRemove,
  onLink,
  initialId,
}: {
  onBatchRemove: (ids: string[]) => void;
  onBatchLink: (ids: string[], destinations: MaterialDestination[]) => void;
  contextWork?: { id: string; title: string } | undefined;
  people: string[];
  profiles?: Record<string, MemberProfile> | undefined;
  onBack: (id: string) => void;
  onReveal: () => void;
  items: ConversationMaterial[];
  projects: SpaceProject[];
  works: {
    id: string;
    title: string;
    projectId?: string;
    agent?: string;
    materialIds?: string[];
    files: File[];
  }[];
  onAdd: (items: ConversationMaterial[]) => void;
  onUpdate: (item: ConversationMaterial) => void;
  onRemove: (id: string) => void;
  onLink: (id: string, workId: string) => void;
  initialId?: string;
}) {
  const [types, setTypes] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const dragDepth = useRef(0);
  const importLock = useRef(false);
  const [query, setQuery] = useState("");
  const [selected, setSelectedValue] = useState(initialId || "");
  function setSelected(id: string) {
    setSelectedValue(id);
    if (id) onReveal();
  }
  const [checked, setChecked] = useState<string[]>([]);
  const [linking, setLinking] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [limit, setLimit] = useState(30);
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [personFilter, setPersonFilter] = useState<string[]>([]);
  const [permission, setPermission] = useState("Tutte le visibilità");
  const [projectSearch, setProjectSearch] = useState("");
  const [deleting, setDeleting] = useState<string[]>([]);
  const linkedWorks = (i: ConversationMaterial) =>
    works.filter((w) => w.materialIds?.includes(i.id) || (!!i.file && w.files.includes(i.file)));
  const activeFilters =
    Number(!!types.length) +
    Number(!!from || !!until) +
    Number(!!projectFilter.length) +
    Number(!!personFilter.length) +
    Number(permission !== "Tutte le visibilità");
  const dateInvalid = !!from && !!until && from > until;
  const filtered = items.filter((i) => {
    const linked = linkedWorks(i);
    const projectIds = [
      ...i.projectIds,
      ...linked.flatMap((w) => (w.projectId ? [w.projectId] : [])),
    ];
    const associated = [
      ...(i.allowedPeople || []),
      ...linked.flatMap((w) => (w.agent ? [w.agent] : [])),
    ];
    const date = i.addedAt ? new Date(i.addedAt).toLocaleDateString("en-CA") : "";
    return (
      (i.name + " " + (i.path || "") + " " + (i.body || ""))
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!types.length || types.includes(materialType(i))) &&
      !dateInvalid &&
      (!from || (!!date && date >= from)) &&
      (!until || (!!date && date <= until)) &&
      (!projectFilter.length || projectFilter.some((id) => projectIds.includes(id))) &&
      (!personFilter.length ||
        personFilter.some((n) => associated.includes(n) || i.visibility === "Tutta la squadra")) &&
      (permission === "Tutte le visibilità" ||
        (i.visibility || "Nei lavori collegati") === permission)
    );
  });
  const folders = [
    ...new Set(
      items
        .map((i) => (i.path?.includes("/") ? i.path.slice(0, i.path.lastIndexOf("/")) : ""))
        .filter(Boolean),
    ),
  ];
  const destinations: MaterialDestination[] = [
    ...projects.map((p) => ({
      id: p.id,
      name: p.name,
      kind: "project" as const,
      detail: p.brief || "Progetto",
    })),
    ...works.map((w) => ({
      id: w.id,
      name: w.title,
      kind: "work" as const,
      detail: [projects.find((p) => p.id === w.projectId)?.name || "Senza progetto", w.agent]
        .filter(Boolean)
        .join(" · "),
    })),
  ];
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState("");
  const [note, setNote] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [removing, setRemoving] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const item = items.find((i) => i.id === selected);
  function importFiles(files: { file: File; path: string }[]) {
    if (!files.length) return;
    const additions = files.map(({ file, path }) => ({
      id: crypto.randomUUID(),
      addedAt: new Date().toISOString(),
      name: file.name,
      file,
      path,
      projectIds: [],
    }));
    onAdd(additions);
    setSelected(additions[0]!.id);
    setNote(false);
    setNotice(files.length + " file aggiunti.");
  }
  function add(files: FileList | null) {
    if (!files?.length) return;
    importFiles(
      Array.from(files).map((file) => ({ file, path: file.webkitRelativePath || file.name })),
    );
    setNotice(files.length + " file aggiunti. I percorsi delle cartelle sono conservati.");
  }
  async function drop(data: DataTransfer) {
    dragDepth.current = 0;
    setDragging(false);
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    try {
      const result = await readMaterialDrop(data);
      importFiles(result.files);
      setNotice(
        result.files.length +
          " file aggiunti." +
          (result.failed ? " " + result.failed + " elementi non leggibili." : "") +
          (result.empty ? " " + result.empty + " cartelle vuote non importate." : ""),
      );
    } catch {
      setNotice("Importazione non riuscita. Riprova con Carica file o Carica cartella.");
    } finally {
      importLock.current = false;
      setImporting(false);
    }
  }
  function download() {
    if (!item) return;
    const url = URL.createObjectURL(
      item.file || new Blob([item.body || ""], { type: "text/plain" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="cw-stage with-panel cs-stage cm-materials">
      <section
        className={"cw-conversation cm-drop-target" + (dragging ? " is-dragging" : "")}
        aria-busy={importing}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = importing ? "none" : "copy";
          }
        }}
        onDragLeave={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setDragging(false);
          }
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            void drop(e.dataTransfer);
          }
        }}
      >
        {dragging && (
          <div className="cm-drop-overlay">
            <strong>Rilascia file o cartelle</strong>
            <span>
              {contextWork
                ? "Saranno collegati a " + contextWork.title
                : "Saranno aggiunti alla raccolta"}
            </span>
          </div>
        )}
        <div className="cw-history">
          <div className="cm-page-heading">
            <h1 className="cs-title">Materiali</h1>
            <span>{items.length} elementi</span>
          </div>
          {contextWork ? (
            <div className="cm-context">
              <button className="cs-link" onClick={() => onBack(contextWork.id)}>
                ← {contextWork.title}
              </button>
              <span>I nuovi materiali saranno collegati qui.</span>
            </div>
          ) : (
            <p className="cs-intro">La raccolta dei tuoi lavori.</p>
          )}
          <input
            className="cs-member-search"
            aria-label="Cerca materiali"
            placeholder="Cerca nome, percorso o contenuto delle note…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(30);
            }}
          />
          <div className="cm-filterbar">
            <MaterialFilter
              label="Tipo"
              icon={<FileText size={14} />}
              active={!!types.length}
              count={types.length}
            >
              <strong>Tipo di materiale</strong>
              <div className="cm-filter-projects">
                {materialTypes.map((t) => (
                  <label key={t}>
                    <input
                      type="checkbox"
                      checked={types.includes(t)}
                      onChange={() => {
                        setTypes(types.includes(t) ? types.filter((v) => v !== t) : [...types, t]);
                        setLimit(30);
                      }}
                    />
                    {t}
                  </label>
                ))}
              </div>
            </MaterialFilter>
            <MaterialFilter
              label="Data"
              icon={<CalendarDays size={14} />}
              active={!!from || !!until}
            >
              <strong>Data di aggiunta</strong>
              <div className="cm-date-presets">
                {[
                  ["Oggi", 0],
                  ["Ultimi 7 giorni", 6],
                  ["Ultimi 30 giorni", 29],
                ].map(([name, days]) => (
                  <button
                    key={name}
                    onClick={() => {
                      const end = new Date(),
                        start = new Date();
                      start.setDate(start.getDate() - Number(days));
                      const date = (d: Date) =>
                        [
                          d.getFullYear(),
                          String(d.getMonth() + 1).padStart(2, "0"),
                          String(d.getDate()).padStart(2, "0"),
                        ].join("-");
                      setFrom(date(start));
                      setUntil(date(end));
                      setLimit(30);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="cm-date-range">
                <label>
                  Dal
                  <input
                    type="date"
                    aria-label="Aggiunti dal"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      setLimit(30);
                    }}
                  />
                </label>
                <label>
                  Al
                  <input
                    type="date"
                    aria-label="Aggiunti fino al"
                    value={until}
                    onChange={(e) => {
                      setUntil(e.target.value);
                      setLimit(30);
                    }}
                  />
                </label>
              </div>
              {dateInvalid && <p role="alert">Controlla l’ordine delle date.</p>}
            </MaterialFilter>
            <MaterialFilter
              label="Progetto"
              icon={<Folder size={14} />}
              active={!!projectFilter.length}
              count={projectFilter.length}
            >
              <strong>Progetti</strong>
              <input
                aria-label="Cerca progetti da filtrare"
                placeholder="Cerca progetto…"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
              />
              <div className="cm-filter-projects">
                {projects
                  .filter((p) => p.name.toLowerCase().includes(projectSearch.toLowerCase()))
                  .map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={projectFilter.includes(p.id)}
                        onChange={() => {
                          setProjectFilter(
                            projectFilter.includes(p.id)
                              ? projectFilter.filter((id) => id !== p.id)
                              : [...projectFilter, p.id],
                          );
                          setLimit(30);
                        }}
                      />
                      {p.name}
                    </label>
                  ))}
              </div>
              {!projects.some((p) =>
                p.name.toLowerCase().includes(projectSearch.toLowerCase()),
              ) && <p>Nessun progetto trovato.</p>}
            </MaterialFilter>
            <MaterialFilter
              label="Collaboratore"
              icon={<Users size={14} />}
              active={!!personFilter.length}
              count={personFilter.length}
            >
              <strong>Collaboratori</strong>
              <ConversationMemberPicker
                people={people}
                profiles={profiles}
                selected={personFilter}
                onChange={(names) => {
                  setPersonFilter(names);
                  setLimit(30);
                }}
                label="Filtra per collaboratore"
              />
              <p>Destinatari e responsabili dei lavori collegati.</p>
            </MaterialFilter>
            <MaterialFilter
              label="Visibilità"
              icon={<Eye size={14} />}
              active={permission !== "Tutte le visibilità"}
            >
              <strong>Chi può usare il materiale</strong>
              <div className="cm-permission-options">
                {[
                  "Tutte le visibilità",
                  "Nei lavori collegati",
                  "Tutta la squadra",
                  "Solo persone selezionate",
                ].map((v) => (
                  <label key={v}>
                    <input
                      type="radio"
                      name="material-visibility-filter"
                      checked={permission === v}
                      onChange={() => {
                        setPermission(v);
                        setLimit(30);
                      }}
                    />
                    {v}
                  </label>
                ))}
              </div>
            </MaterialFilter>
          </div>
          {activeFilters > 0 && (
            <div className="cm-active-filters">
              {types.map((t) => (
                <button key={t} onClick={() => setTypes(types.filter((v) => v !== t))}>
                  {t}
                  <X size={12} />
                </button>
              ))}
              {(from || until) && (
                <button
                  onClick={() => {
                    setFrom("");
                    setUntil("");
                  }}
                >
                  Data: {from || "inizio"} → {until || "oggi"} <X size={12} />
                </button>
              )}
              {projectFilter.map((id) => (
                <button
                  key={id}
                  onClick={() => setProjectFilter(projectFilter.filter((p) => p !== id))}
                >
                  {projects.find((p) => p.id === id)?.name}
                  <X size={12} />
                </button>
              ))}
              {personFilter.map((n) => (
                <button
                  key={n}
                  onClick={() => setPersonFilter(personFilter.filter((p) => p !== n))}
                >
                  {n}
                  <X size={12} />
                </button>
              ))}
              {permission !== "Tutte le visibilità" && (
                <button onClick={() => setPermission("Tutte le visibilità")}>
                  {permission}
                  <X size={12} />
                </button>
              )}
              <button
                className="cm-reset"
                onClick={() => {
                  setFrom("");
                  setUntil("");
                  setProjectFilter([]);
                  setTypes([]);
                  setPersonFilter([]);
                  setPermission("Tutte le visibilità");
                }}
              >
                Azzera filtri
              </button>
            </div>
          )}
          <p className="cm-drop-hint" role="status">
            {importing
              ? "Importazione in corso…"
              : "Trascina qui file o cartelle, oppure caricali dai pulsanti."}
          </p>
          <div className="cs-actions cm-upload-actions">
            <button
              className="cw-secondary"
              disabled={importing}
              onClick={() => upload.current?.click()}
            >
              Carica file
            </button>
            <button
              className="cw-secondary"
              disabled={importing}
              onClick={() => folder.current?.click()}
            >
              Carica cartella
            </button>
            <button
              className="cw-secondary"
              onClick={() => {
                setEditingId("");
                onReveal();
                setNote(true);
                setTitle("");
                setBody("");
                setSelected("");
              }}
            >
              Scrivi nota
            </button>
          </div>
          <input
            ref={upload}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={folder}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="cm-bulk-bar">
            <label>
              <input
                type="checkbox"
                aria-label="Seleziona tutti i risultati"
                checked={filtered.length > 0 && filtered.every((i) => checked.includes(i.id))}
                onChange={(e) =>
                  setChecked(
                    e.target.checked
                      ? [...new Set([...checked, ...filtered.map((i) => i.id)])]
                      : checked.filter((id) => !filtered.some((i) => i.id === id)),
                  )
                }
              />
              Tutti ({filtered.length})
            </label>
            <span>
              {checked.length ? checked.length + " selezionati" : "Seleziona per collegare"}
            </span>
            <button
              className="cw-secondary"
              disabled={!checked.length}
              onClick={() => setLinking(checked)}
            >
              Collega a…
            </button>
            {checked.length > 0 && (
              <button className="cs-link" onClick={() => setDeleting(checked)}>
                Elimina selezionati
              </button>
            )}
            {checked.length > 0 && (
              <button className="cs-link" onClick={() => setChecked([])}>
                Deseleziona
              </button>
            )}
          </div>
          {deleting.length > 0 && (
            <div
              className="cm-delete-confirm"
              role="alertdialog"
              aria-label="Conferma eliminazione materiali"
            >
              <strong>Eliminare {deleting.length} materiali?</strong>
              <p>
                Saranno rimossi dalla raccolta e da{" "}
                {
                  works.filter((w) =>
                    items.some(
                      (i) =>
                        deleting.includes(i.id) &&
                        (w.materialIds?.includes(i.id) || (!!i.file && w.files.includes(i.file))),
                    ),
                  ).length
                }{" "}
                conversazioni di lavoro. I file originali sul disco non vengono cancellati.
              </p>
              <p>
                {deleting.filter((id) => !filtered.some((i) => i.id === id)).length} selezionati
                sono fuori dai filtri attuali.
              </p>
              <div className="cs-actions">
                <button className="cw-secondary" onClick={() => setDeleting([])}>
                  Annulla eliminazione
                </button>
                <button
                  className="cw-primary"
                  onClick={() => {
                    onBatchRemove(deleting);
                    setChecked(checked.filter((id) => !deleting.includes(id)));
                    if (deleting.includes(selected)) setSelected("");
                    setNotice(deleting.length + " materiali eliminati.");
                    setDeleting([]);
                  }}
                >
                  Conferma eliminazione
                </button>
              </div>
            </div>
          )}
          {!!items.length && !filtered.length && (
            <p role="status" className="cw-hint">
              Nessun materiale corrisponde ai filtri.
            </p>
          )}
          {folders.length > 0 && (
            <details className="cm-folder-select">
              <summary>Seleziona una cartella</summary>
              <p>Seleziona i file già importati. I futuri caricamenti non sono inclusi.</p>
              {folders
                .filter((f) => !query || f.toLowerCase().includes(query.toLowerCase()))
                .map((f) => (
                  <button
                    className="cs-link"
                    key={f}
                    onClick={() =>
                      setChecked([
                        ...new Set([
                          ...checked,
                          ...items.filter((i) => i.path?.startsWith(f + "/")).map((i) => i.id),
                        ]),
                      ])
                    }
                  >
                    {f}
                  </button>
                ))}
            </details>
          )}
          <div className="cs-collection">
            {filtered.slice(0, limit).map((i) => (
              <div className="cm-material-row" key={i.id}>
                <input
                  type="checkbox"
                  aria-label={"Seleziona " + i.name}
                  checked={checked.includes(i.id)}
                  onChange={() =>
                    setChecked(
                      checked.includes(i.id)
                        ? checked.filter((id) => id !== i.id)
                        : [...checked, i.id],
                    )
                  }
                />
                <button
                  key={i.id}
                  className={selected === i.id ? "active" : ""}
                  onClick={() => {
                    setSelected(i.id);
                    setNote(false);
                    setRemoving(false);
                    setNotice("");
                  }}
                >
                  <FileText size={18} aria-hidden="true" />
                  <span>
                    <strong title={i.name}>{i.name}</strong>
                    <small>
                      {i.file ? i.name.split(".").pop()?.toUpperCase() || "File" : "Nota"} ·{" "}
                      {works.some(
                        (w) =>
                          w.materialIds?.includes(i.id) || (!!i.file && w.files.includes(i.file)),
                      )
                        ? "Collegato a un lavoro"
                        : i.projectIds.length
                          ? `${i.projectIds.length} progetti`
                          : "Nella raccolta"}
                    </small>
                  </span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          {filtered.length > limit && (
            <button className="cw-secondary" onClick={() => setLimit(limit + 30)}>
              Mostra altri · {filtered.length - limit} rimanenti
            </button>
          )}
          {linking.length > 0 && (
            <ConversationMaterialLinker
              count={linking.length}
              destinations={destinations}
              recent={recent}
              contextId={contextWork?.id}
              restricted={items.some(
                (i) => linking.includes(i.id) && i.visibility === "Solo persone selezionate",
              )}
              onClose={() => setLinking([])}
              onConfirm={(targets) => {
                onBatchLink(linking, targets);
                setRecent(targets.map((t) => t.kind + ":" + t.id));
                setNotice(
                  linking.length + " materiali collegati a " + targets.length + " destinazioni.",
                );
                setLinking([]);
                setChecked([]);
              }}
            />
          )}
          {!items.length && (
            <p className="cw-hint">
              Aggiungi un file o una nota, oppure allegali a una conversazione.
            </p>
          )}
          {notice && (
            <p role="status" className="cw-hint">
              {notice}
            </p>
          )}
        </div>
      </section>
      <aside className="cw-workspace cs-panel">
        {note ? (
          <>
            <h2>Una nota per la squadra</h2>
            <label>
              Titolo
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Testo
              <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            <div className="cs-actions">
              <button className="cs-link" onClick={() => setNote(false)}>
                Annulla
              </button>
              <button
                className="cw-primary"
                disabled={!title.trim() || !body.trim()}
                onClick={() => {
                  const id = editingId || crypto.randomUUID();
                  if (editingId && item) onUpdate({ ...item, name: title.trim(), body });
                  else
                    onAdd([
                      {
                        id,
                        addedAt: new Date().toISOString(),
                        name: title.trim(),
                        body,
                        projectIds: [],
                      },
                    ]);
                  setSelected(id);
                  setNote(false);
                }}
              >
                Salva nota
              </button>
            </div>
          </>
        ) : item ? (
          <>
            <span className="cw-overline">
              <FileText size={16} /> {item.file ? "FILE" : "NOTA"}
            </span>
            <h2 title={item.name}>{item.name}</h2>
            {item.path && item.path !== item.name && <p className="cw-hint">{item.path}</p>}
            {item.body && <p style={{ whiteSpace: "pre-wrap" }}>{item.body}</p>}
            <button className="cw-secondary" onClick={download}>
              Scarica {item.file ? "file" : "nota"}
            </button>
            {!item.file && (
              <button
                className="cs-link"
                onClick={() => {
                  setEditingId(item.id);
                  setTitle(item.name);
                  setBody(item.body || "");
                  onReveal();
                  setNote(true);
                }}
              >
                Modifica nota
              </button>
            )}
            <div className="cm-associations">
              <h3>Collegato a</h3>
              {works
                .filter(
                  (w) =>
                    w.materialIds?.includes(item.id) ||
                    (!!item.file && w.files.includes(item.file)),
                )
                .map((w) => (
                  <button className="cs-link" key={w.id} onClick={() => onBack(w.id)}>
                    {w.title} ↗
                  </button>
                ))}
              {contextWork &&
                !works.some(
                  (w) =>
                    w.id === contextWork.id &&
                    (w.materialIds?.includes(item.id) ||
                      (!!item.file && w.files.includes(item.file))),
                ) && (
                  <button className="cw-primary" onClick={() => onLink(item.id, contextWork.id)}>
                    Aggiungi a {contextWork.title}
                  </button>
                )}
            </div>
            <button className="cw-secondary" onClick={() => setLinking([item.id])}>
              Collega a…
            </button>
            {item.projectIds.map((id) => (
              <p className="cw-hint" key={id}>
                {projects.find((p) => p.id === id)?.name}
                <button
                  className="cs-link"
                  aria-label={
                    "Scollega progetto " + (projects.find((p) => p.id === id)?.name || id)
                  }
                  onClick={() =>
                    onUpdate({ ...item, projectIds: item.projectIds.filter((p) => p !== id) })
                  }
                >
                  {" "}
                  ×
                </button>
              </p>
            ))}
            <div className="cm-sharing">
              <h3>Chi può usarlo</h3>
              <ConversationSelect
                label="Visibilità del materiale"
                value={item.visibility || "Nei lavori collegati"}
                options={["Nei lavori collegati", "Tutta la squadra", "Solo persone selezionate"]}
                onChange={(visibility) => onUpdate({ ...item, visibility })}
              />
              {item.visibility === "Solo persone selezionate" && (
                <ConversationMemberPicker
                  people={people}
                  profiles={profiles}
                  selected={item.allowedPeople || []}
                  onChange={(allowedPeople) => onUpdate({ ...item, allowedPeople })}
                  label="Cerca persone per accesso"
                />
              )}
              <p className="cw-hint">
                Visibilità simulata nella demo; il motore applicherà i permessi.
              </p>
            </div>
            <div className="cs-management">
              {removing ? (
                <>
                  <p>Rimuovere dalla raccolta e dai lavori collegati?</p>
                  <div className="cs-actions">
                    <button className="cs-link" onClick={() => setRemoving(false)}>
                      Annulla
                    </button>
                    <button
                      className="cw-secondary"
                      onClick={() => {
                        onRemove(item.id);
                        setSelected("");
                        setRemoving(false);
                      }}
                    >
                      Conferma rimozione materiale
                    </button>
                  </div>
                </>
              ) : (
                <button className="cs-link" onClick={() => setRemoving(true)}>
                  Rimuovi materiale
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h2>Materiali condivisi</h2>
            <p className="cw-hint">
              Seleziona un elemento per collegarlo a più progetti o utilizzarlo in una
              conversazione.
            </p>
            <p className="cw-hint">
              Le cartelle vengono importate come copie. Il salvataggio dei file e delle note segue
              lo stato indicato nelle impostazioni; nessuna sincronizzazione del disco.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}

function MaterialFilter({
  label,
  icon,
  active,
  count,
  children,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  count?: number;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="cm-filter-chip" data-active={active}>
          {icon}
          {label}
          {!!count && <small>{count}</small>}
          <ChevronDown size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="cm-filter-popover cw"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
