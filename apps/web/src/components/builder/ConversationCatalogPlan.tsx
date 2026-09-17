import { useRef, useState } from "react";
import { Check, ChevronUp, ChevronDown, Plus, GripVertical } from "lucide-react";
import { ConversationAvatar } from "./ConversationAvatar";
import { ConversationMemberPicker } from "./ConversationMemberPicker";
import { isHumanMember, type MemberProfile } from "./conversation-members";
export type PlanStep = {
  id: string;
  title: string;
  agent: string;
  childId?: string;
  result?: string;
};
export type CatalogPlan = { completed: number; steps: PlanStep[] };
export function ConversationCatalogPlan({
  plan,
  reviewer,
  count,
  inputLabel,
  inputHelp,
  contribution,
  onContribution,
  proposal,
  approved,
  blocked,
  people,
  profiles,
  onChange,
  onFiles,
  onLibrary,
  onChild,
  onCreate,
}: {
  plan: CatalogPlan;
  reviewer: string;
  count: number;
  inputLabel: string;
  inputHelp: string;
  contribution: string;
  onContribution: (value: string) => void;
  proposal: boolean;
  approved: boolean;
  blocked: boolean;
  people: string[];
  profiles: Record<string, MemberProfile> | undefined;
  onChange: (plan: CatalogPlan) => void;
  onFiles: (files: File[]) => void;
  onLibrary: () => void;
  onChild: (id: string) => void;
  onCreate: (name: string, role: string) => boolean;
}) {
  const folder = useRef<HTMLInputElement>(null),
    files = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<PlanStep | null>(null);
  const [position, setPosition] = useState(0);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(""),
    [role, setRole] = useState("");
  const [error, setError] = useState("");
  function insert(index: number) {
    setPosition(index);
    setEditing({ id: crypto.randomUUID(), title: "", agent: "" });
    setCreating(false);
    setError("");
  }
  function move(from: number, to: number) {
    if (approved || from < plan.completed || to < plan.completed || to >= plan.steps.length) return;
    const steps = [...plan.steps];
    const [step] = steps.splice(from, 1);
    steps.splice(to, 0, step!);
    onChange({ ...plan, steps });
  }
  return (
    <div className="cc-catalog-plan cc-step-plan">
      <div className="cc-plan-heading">
        <strong>Piano di lavoro</strong>
        <small>
          {plan.completed + Number(approved)} / {plan.steps.length + 1} completati
        </small>
      </div>
      <div className="cc-progress">
        <span
          style={{
            width: ((plan.completed + Number(approved)) / (plan.steps.length + 1)) * 100 + "%",
          }}
        />
      </div>
      <ol>
        {plan.steps.map((step, i) => (
          <li
            key={step.id}
            className={
              i < plan.completed ? "done" : !proposal && i === plan.completed ? "current" : ""
            }
          >
            {!approved && i >= plan.completed && (
              <button
                className="cc-insert"
                aria-label={"Inserisci passaggio prima di " + step.title}
                onClick={() => insert(i)}
              >
                <Plus size={12} />
              </button>
            )}
            <div
              className="cc-step-line"
              draggable={!approved && i >= plan.completed}
              onDragStart={(e) => e.dataTransfer.setData("application/homun-step", step.id)}
              onDragOver={(e) => {
                if (i >= plan.completed && e.dataTransfer.types.includes("application/homun-step"))
                  e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                move(
                  plan.steps.findIndex(
                    (s) => s.id === e.dataTransfer.getData("application/homun-step"),
                  ),
                  i,
                );
              }}
            >
              <span className="cc-step-state">
                {i < plan.completed ? <Check size={15} /> : i + 1}
              </span>
              <button
                className="cc-step-label"
                aria-label={"Dettagli passaggio: " + step.title}
                onClick={() => {
                  setEditing(step);
                  setPosition(i);
                  setCreating(false);
                }}
              >
                <strong>{step.title}</strong>
                <small>
                  {step.agent || "Da assegnare"} ·{" "}
                  {i < plan.completed
                    ? "Concluso nella demo"
                    : !proposal && i === plan.completed
                      ? blocked
                        ? "Aspetta una risposta"
                        : "In corso · demo"
                      : "Da fare"}
                </small>
              </button>
              {step.agent && (
                <ConversationAvatar name={step.agent} human={isHumanMember(step.agent, profiles)} />
              )}
              {!approved && i >= plan.completed && (
                <div className="cc-step-move">
                  <GripVertical size={12} />
                  <button
                    disabled={i === plan.completed}
                    aria-label={"Sposta su " + step.title}
                    onClick={() => move(i, i - 1)}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    disabled={i === plan.steps.length - 1}
                    aria-label={"Sposta giù " + step.title}
                    onClick={() => move(i, i + 1)}
                  >
                    <ChevronDown size={13} />
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {!approved && (
        <button className="cc-add-step" onClick={() => insert(plan.steps.length)}>
          <Plus size={14} />
          Aggiungi passaggio
        </button>
      )}
      <div className="cc-final">
        <span className="cc-step-state">
          {approved ? <Check size={15} /> : plan.steps.length + 1}
        </span>
        <span>
          <strong>Approvazione finale</strong>
          <small>
            {reviewer} ·{" "}
            {approved
              ? "Approvato"
              : plan.completed === plan.steps.length
                ? "Tocca a te"
                : "Dopo tutti i passaggi"}
          </small>
        </span>
      </div>
      {editing && (
        <div className="cc-step-editor">
          <strong>
            {plan.steps.some((s) => s.id === editing.id)
              ? "Dettaglio passaggio"
              : "Nuovo passaggio"}
          </strong>
          {position < plan.completed || approved ? (
            <>
              <p>{editing.title}</p>
              <p>{editing.result || "Passaggio concluso nella simulazione."}</p>
              {editing.childId && (
                <button className="cs-link" onClick={() => onChild(editing.childId!)}>
                  Apri risultato del passaggio ↗
                </button>
              )}
              <p className="cw-hint">
                Lo storico è conservato. Per rifare questo lavoro, aggiungi un nuovo passaggio.
              </p>
            </>
          ) : (
            <>
              <input
                aria-label="Titolo del passaggio"
                placeholder="Cosa deve ottenere?"
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              />
              <ConversationMemberPicker
                people={people}
                profiles={profiles}
                selected={editing.agent ? [editing.agent] : []}
                onChange={(names) =>
                  setEditing({ ...editing, agent: names.find((n) => n !== editing.agent) || "" })
                }
              />
              <button
                className="cs-link"
                onClick={() => {
                  setCreating(!creating);
                  setName("");
                  setRole("");
                }}
              >
                + Crea collaboratore qui
              </button>
              {creating && (
                <div className="cc-create-agent">
                  <input
                    aria-label="Nome del nuovo agente"
                    placeholder="Nome"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <input
                    aria-label="Specializzazione del nuovo agente"
                    placeholder="Di cosa si occupa?"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  />
                  <button
                    className="cw-secondary"
                    disabled={!name.trim() || !role.trim()}
                    onClick={() => {
                      if (onCreate(name.trim(), role.trim())) {
                        setEditing({ ...editing, agent: name.trim() });
                        setCreating(false);
                        setError("");
                      } else setError("Questo nome è già in uso.");
                    }}
                  >
                    Crea e seleziona
                  </button>
                  {error && <p role="alert">{error}</p>}
                </div>
              )}
              <div className="cs-actions">
                {plan.steps.some((s) => s.id === editing.id) && (
                  <button
                    className="cs-link"
                    onClick={() => {
                      onChange({ ...plan, steps: plan.steps.filter((s) => s.id !== editing.id) });
                      setEditing(null);
                    }}
                  >
                    Rimuovi passaggio
                  </button>
                )}
                <button
                  className="cw-secondary"
                  disabled={!editing.title.trim()}
                  onClick={() => {
                    const steps = plan.steps.some((s) => s.id === editing.id)
                      ? plan.steps.map((s) => (s.id === editing.id ? editing : s))
                      : [...plan.steps.slice(0, position), editing, ...plan.steps.slice(position)];
                    onChange({ ...plan, steps });
                    setEditing(null);
                  }}
                >
                  Salva passaggio
                </button>
              </div>
            </>
          )}
          <button className="cs-link" onClick={() => setEditing(null)}>
            Chiudi
          </button>
        </div>
      )}
      {proposal && (
        <div className="cc-material-request">
          <strong>
            {count || contribution.trim()
              ? "Pronto per iniziare"
              : "Per iniziare: " + inputLabel.toLowerCase()}
          </strong>
          <p className="cw-hint">{inputHelp}</p>
          <textarea
            aria-label="Indicazioni per iniziare"
            placeholder="Scrivi le indicazioni o aggiungi un link…"
            value={contribution}
            onChange={(e) => onContribution(e.target.value)}
          />
          {count > 0 && <p className="cw-hint">{count} materiali collegati</p>}
          <div>
            <button className="cw-secondary" onClick={() => folder.current?.click()}>
              Carica cartella
            </button>
            <button className="cs-link" onClick={() => files.current?.click()}>
              Carica file
            </button>
            <button className="cs-link" onClick={onLibrary}>
              Dalla raccolta
            </button>
          </div>
          <input
            ref={folder}
            hidden
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              onFiles(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
          <input
            ref={files}
            hidden
            type="file"
            multiple
            onChange={(e) => {
              onFiles(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
        </div>
      )}
      <p className="cc-plan-note">
        Riordina i passaggi futuri trascinandoli o usando le frecce. Quelli conclusi restano nello
        storico.
      </p>
    </div>
  );
}
