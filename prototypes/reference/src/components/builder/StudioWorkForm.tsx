import { StudioMemberPicker } from "./StudioMemberPicker";
import { Paperclip, FolderUp } from "lucide-react";
import { autonomyDescriptions } from "../../lib/studio-autonomy";
import type { AutonomyMode } from "../../lib/studio-supervision";
import { StudioMaterialPicker } from "./StudioMaterialContext";
import type { MaterialLink } from "../../lib/studio-material-context";
import type { TrainingActivity } from "./StudioTraining";
import { StudioProjectPicker } from "./StudioProjectPicker";
import { useRef, useState } from "react";
import type { AssignedWork, TodayProject } from "./StudioToday";
export function StudioWorkForm({
  people,
  projects,
  date = "",
  defaultProject = "",
  person = "",
  initialTitle = "",
  initialFiles = [],
  onSave,
  onClose,
}: {
  people: { id: string; name: string; activities?: TrainingActivity[]; autonomy?: AutonomyMode }[];
  projects: TodayProject[];
  date?: string;
  defaultProject?: string;
  person?: string;
  initialTitle?: string;
  initialFiles?: File[];
  onSave: (task: AssignedWork) => void;
  onClose: () => void;
}) {
  const [materialLinks, setMaterialLinks] = useState<MaterialLink[]>([]);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [materials, setMaterials] = useState<File[]>(initialFiles);
  const [owner, setOwner] = useState(person || people[0]?.id || "");
  const [helper, setHelper] = useState("");
  const [waitingFor, setWaitingFor] = useState("");
  const [modeOverride, setModeOverride] = useState<AutonomyMode | "">("");
  const [activityId, setActivityId] = useState("");
  const activity = people.find((p) => p.id === owner)?.activities?.find((a) => a.id === activityId);
  const mode =
    modeOverride || activity?.mode || people.find((p) => p.id === owner)?.autonomy || "stage";
  const [project, setProject] = useState(defaultProject);
  return (
    <form
      className="st-paper st-assign-work"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        if (
          !owner ||
          !people.some((p) => p.id === owner) ||
          !String(data.get("title") || "").trim()
        )
          return;
        const start = String(data.get("start") || "");
        const due = String(data.get("due") || "");
        if (start && due && start > due) {
          e.currentTarget
            .querySelector<HTMLInputElement>('[name="start"]')
            ?.setCustomValidity("L’inizio deve precedere la scadenza.");
          e.currentTarget.reportValidity();
          return;
        }
        onSave({
          id: crypto.randomUUID(),
          title: String(data.get("title")).trim(),
          person: owner,
          project,
          due,
          start,
          status: helper && helper !== owner ? "blocked" : "todo",
          ...(data.get("costLimit") ? { costLimit: Number(data.get("costLimit")) } : {}),
          costPolicy: "pause",
          files: materials,
          materialLinks,
          ...(!owner.startsWith("user:")
            ? {
                training: {
                  activity: activity?.title || "Nuova attività",
                  scope: activity?.scope || "Da definire insieme al supervisore",
                  mode,
                },
              }
            : {}),
          successCriteria: String(data.get("criteria") || "").trim(),
          materialReferences: String(data.get("references") || "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          steps: [
            ...(helper && helper !== owner
              ? [
                  {
                    id: "input",
                    title: waitingFor.trim() || "Ricevere il contributo",
                    done: false,
                    blocker: helper.startsWith("user:") ? helper : "bot:" + helper,
                    reason: waitingFor.trim() || "Contributo necessario",
                  },
                ]
              : []),
            ...String(data.get("steps") || "")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((title) => ({ id: crypto.randomUUID(), title, done: false })),
          ],
        });
      }}
    >
      {initialFiles.length > 0 && (
        <p className="st-muted">
          Allegati dalla conversazione: {initialFiles.map((f) => f.name).join(", ")}
        </p>
      )}
      <div className="st-section-head">
        <h2>Assegna un lavoro</h2>
        <button type="button" aria-label="Chiudi nuovo incarico" onClick={onClose}>
          Chiudi
        </button>
      </div>
      <label>
        Cosa deve ottenere?
        <textarea
          name="title"
          defaultValue={initialTitle}
          required
          placeholder="Preparare il preventivo per il cliente Rossi"
        />
      </label>
      <label>
        Quando consideri riuscito il lavoro? <span className="st-muted">Facoltativo</span>
        <textarea
          name="criteria"
          placeholder="Es. una proposta con fonti, priorità motivate e punti ancora da chiarire"
        />
      </label>
      <div className="st-assignment-owner">
        <StudioMemberPicker
          label="Responsabile"
          options={people}
          value={owner ? [owner] : []}
          emptyLabel="Scegli un responsabile"
          onChange={(ids) => {
            setOwner(ids.at(-1) || "");
            setProject("");
            setActivityId("");
            setModeOverride("");
            setMaterialLinks([]);
          }}
        />
      </div>
      {!owner.startsWith("user:") && (
        <div className="st-soft-note" style={{ display: "block" }}>
          <label>
            Responsabilità da applicare
            <select
              value={activityId}
              onChange={(e) => {
                setActivityId(e.target.value);
                setModeOverride("");
              }}
            >
              <option value="">Nessuna regola specifica</option>
              {(people.find((p) => p.id === owner)?.activities || [])
                .filter((a) => a.title.trim())
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Modalità per questo compito
            <select
              aria-label="Modalità per questo compito"
              value={mode}
              onChange={(e) => setModeOverride(e.target.value as AutonomyMode)}
            >
              <option value="stage">In stage</option>
              <option value="review">Con revisione</option>
              <option value="autonomous">Autonomo</option>
            </select>
          </label>
          <p>
            {autonomyDescriptions[mode]} {activity?.scope}
          </p>
          <small>
            Regola salvata per questo incarico. Le modifiche future al profilo non cambiano il
            lavoro già affidato.
          </small>
        </div>
      )}
      <details open={!!defaultProject || !!date} className="st-work-options">
        <summary>
          Progetto e scadenze <span className="st-muted">Facoltativi</span>
        </summary>
        <div className="st-assignment-schedule">
          <div className="st-assignment-project">
            <StudioProjectPicker
              label="Progetto dell’incarico"
              options={projects.filter((p) => p.members.includes(owner))}
              value={project ? [project] : []}
              emptyLabel="Incarico diretto"
              onChange={(ids) => setProject(ids.at(-1) || "")}
            />
          </div>
          <div className="st-assignment-dates">
            <label>
              Inizia il
              <input
                aria-label="Inizia il"
                type="datetime-local"
                name="start"
                onInput={(e) => e.currentTarget.setCustomValidity("")}
              />
            </label>
            <label>
              Pronto entro
              <input
                aria-label="Pronto entro"
                type="datetime-local"
                name="due"
                onInput={(e) =>
                  e.currentTarget.form
                    ?.querySelector<HTMLInputElement>('[name="start"]')
                    ?.setCustomValidity("")
                }
                defaultValue={date ? date + "T15:00" : ""}
              />
            </label>
          </div>
          <p className="st-field-help">
            Senza una data di inizio, il compito può partire appena disponibile.
          </p>
        </div>
        {!owner.startsWith("user:") && (
          <label>
            Limite remoto per questo incarico · €
            <input type="number" name="costLimit" min="0" step="0.01" placeholder="Da concordare" />
            <small>
              Al limite il lavoro si ferma. Il budget mensile del collaboratore resta un vincolo
              separato.
            </small>
          </label>
        )}
      </details>
      <details className="st-work-materials">
        <summary>
          Materiali{" "}
          <span className="st-muted">
            File, cartelle e riferimenti
            {materials.length + materialLinks.length > 0
              ? ` · ${materials.length + materialLinks.length} collegati`
              : ""}
          </span>
        </summary>
        <div className="st-materials-content">
          <StudioMaterialPicker owner={owner} value={materialLinks} onChange={setMaterialLinks} />
          <div className="st-material-upload-actions">
            <button type="button" className="st-btn" onClick={() => fileInput.current?.click()}>
              <Paperclip size={15} />
              Carica file
            </button>
            <button className="st-btn" type="button" onClick={() => folderInput.current?.click()}>
              <FolderUp size={15} />
              Carica cartella
            </button>
          </div>
          <input
            hidden
            ref={fileInput}
            aria-label="Carica file per il compito"
            type="file"
            name="materials"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              setMaterials((all) => [...all, ...files]);
              e.target.value = "";
            }}
          />
          <input
            hidden
            ref={folderInput}
            type="file"
            multiple
            {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              setMaterials((all) => [...all, ...files]);
              e.target.value = "";
            }}
          />
          {!!materials.length && (
            <ul className="st-material-list">
              {materials.map((f, i) => (
                <li key={i}>
                  <span>{f.webkitRelativePath || f.name}</span>
                  <button
                    type="button"
                    aria-label={"Rimuovi " + f.name}
                    onClick={() => setMaterials((all) => all.filter((_, n) => n !== i))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label>
            Link o percorsi esterni
            <textarea
              name="references"
              placeholder="Incolla un link o indica una cartella, una pagina wiki, una risorsa. Un riferimento per riga."
            />
          </label>
          <p className="st-muted">
            Le cartelle caricate sono copie. Link e percorsi saranno verificati prima dell’uso.
          </p>
        </div>
      </details>
      <details>
        <summary>Serve il contributo di qualcuno?</summary>
        <StudioMemberPicker
          label="Chi deve aiutare"
          options={people.filter((p) => p.id !== owner)}
          value={helper && helper !== owner ? [helper] : []}
          emptyLabel="Nessuna attesa"
          onChange={(ids) => setHelper(ids.at(-1) || "")}
        />
        {helper && helper !== owner && (
          <label>
            Cosa serve?
            <input required value={waitingFor} onChange={(e) => setWaitingFor(e.target.value)} />
            <small>Verrà creato un incarico collegato. Il lavoro aspetta la sua consegna.</small>
          </label>
        )}
      </details>
      <details>
        <summary>Definisci i passaggi</summary>
        <label>
          Un passaggio per riga
          <textarea
            name="steps"
            placeholder={"Raccogliere il listino\nPreparare la bozza\nVerificare il preventivo"}
          />
        </label>
      </details>
      <p className="st-muted">
        La scadenza indica quando serve il risultato. Lascia l’inizio vuoto se può partire appena
        disponibile. Bozza locale, nessuna esecuzione.
      </p>
      {!people.length && (
        <p className="st-muted">Aggiungi prima un collaboratore alla squadra del progetto.</p>
      )}
      <div className="st-sim-actions">
        <button className="st-btn dark" disabled={!owner || !people.some((p) => p.id === owner)}>
          Salva incarico
        </button>
      </div>
    </form>
  );
}
