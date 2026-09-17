import { useState, useContext } from "react";
import { Plus, GripVertical, ArrowDown, ChevronUp, ChevronDown } from "lucide-react";
import { StudioChatInput, type ChatReference } from "./StudioChatInput";
import { Message } from "../ai-elements/message";
import { StudioMemberPicker } from "./StudioMemberPicker";
import { StudioProjectPicker } from "./StudioProjectPicker";
import { procedureTrigger, type Procedure, type ProcedureStep } from "../../lib/studio-pipelines";
import { StudioMembersContext, type StudioMember } from "../../lib/studio-members";
import type { TodayProject } from "./StudioToday";
import { StudioMemberCard } from "./StudioMemberCard";
type Entry = { id: string; text: string; user?: boolean };
const newStep = (title = "Nuovo passaggio"): ProcedureStep => ({
  id: crypto.randomUUID(),
  title,
  person: "",
  materials: "",
  approval: true,
});
export function StudioAutomationCanvas({
  draft,
  people,
  projects,
  onChange,
  onInspect,
}: {
  draft: Procedure;
  people: StudioMember[];
  projects: TodayProject[];
  onChange: (p: Partial<Procedure>) => void;
  onInspect: (id: string) => void;
}) {
  const directory = useContext(StudioMembersContext);
  const [showFlow, setShowFlow] = useState(false);
  const references: ChatReference[] = [
    ...people.map((p) => {
      const full = directory.find((m) => m.id === p.id) || p;
      return {
        id: p.id,
        name: p.name,
        kind: "member" as const,
        description: full.responsibility || full.role || "Collaboratore",
        profile: <StudioMemberCard member={full} />,
      };
    }),
    ...projects.map((p) => ({
      id: p.id,
      name: p.name,
      kind: "project" as const,
      description: "Progetto condiviso",
    })),
  ];
  const [entries, setEntries] = useState<Entry[]>([]);
  const [proposal, setProposal] = useState<{
    text: string;
    files: File[];
    refs?: ChatReference[];
  } | null>(null);
  const [selection, setSelection] = useState<"member" | "project" | null>(null);
  const [active, setActive] = useState<string>("");
  const eligible = draft.project
    ? people.filter((p) => projects.find((x) => x.id === draft.project)?.members.includes(p.id))
    : people;
  function say(text: string) {
    setEntries((all) => [...all, { id: crypto.randomUUID(), text }]);
  }
  function add() {
    const step = newStep();
    onChange({ steps: [...draft.steps, step] });
    setActive(step.id);
    setSelection("member");
    say("Nuovo passaggio aggiunto. Chi deve occuparsene?");
  }
  function move(id: string, index: number) {
    const next = draft.steps.filter((s) => s.id !== id);
    const step = draft.steps.find((s) => s.id === id);
    if (!step) return;
    next.splice(Math.max(0, index), 0, step);
    onChange({ steps: next });
  }
  function apply() {
    if (!proposal) return;
    const memberRefs = (proposal.refs || []).filter((r) => r.kind === "member");
    const occurrences = memberRefs
      .flatMap((ref) =>
        Array.from(
          proposal.text.matchAll(
            new RegExp(`@${ref.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|[.,;]|$)`, "g"),
          ),
          (match) => ({ ref, index: match.index! }),
        ),
      )
      .sort((a, b) => a.index - b.index);
    const steps: ProcedureStep[] = occurrences.map((item, i) => {
      const text = proposal.text
        .slice(item.index + item.ref.name.length + 1, occurrences[i + 1]?.index)
        .replace(/^[\s,]*(?:di\s+)?/, "")
        .replace(/(?:[,.;]?\s*(?:poi|quindi|e))?\s*$/, "")
        .replace(/[;,.]$/, "");
      return {
        ...newStep(text || "Descrivi il compito"),
        person: item.ref.id,
        files: [...proposal.files],
      };
    });
    if (!steps.length)
      steps.push(
        ...proposal.text
          .split(/\n|;|\s+(?:poi|quindi)\s+/i)
          .filter(Boolean)
          .map((text) => ({ ...newStep(text.trim()), files: [...proposal.files] })),
      );
    const time = proposal.text.match(/alle\s+(\d{1,2})(?:[:.](\d{2}))?/i);
    const schedule =
      /ogni (?:mattina|giorno)/i.test(proposal.text) &&
      time &&
      Number(time[1]) < 24 &&
      Number(time[2] || 0) < 60
        ? {
            trigger: "schedule" as const,
            time: `${time[1]!.padStart(2, "0")}:${time[2] || "00"}`,
            days: ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"],
          }
        : {};
    onChange({
      name: draft.name || "Nuova automazione",
      project: proposal.refs?.find((r) => r.kind === "project")?.id || draft.project,
      ...schedule,
      steps: [...draft.steps, ...steps],
    });
    setActive(steps.find((s) => !s.person)?.id || steps[0]?.id || "");
    setSelection(steps.some((s) => !s.person) ? "member" : null);
    say(
      "Bozza pronta da verificare. Controlla avvio, responsabili e passaggi prima di salvare. Questa demo riconosce riferimenti selezionati e la formula ‘ogni mattina alle…’. Altre richieste richiedono il motore AI.",
    );
    setProposal(null);
  }
  return (
    <div className="st-automation-workspace">
      <section className="st-automation-chat" aria-label="Chat dell’automazione">
        <h2>Costruiamola insieme</h2>
        <p className="st-muted">
          Scrivi cosa vuoi ottenere. Usa @ per collegare collaboratori e progetti.
        </p>
        <div className="st-automation-messages">
          {!entries.length && (
            <p>
              Quale lavoro vuoi ripetere? Puoi allegare materiali e scegliere collaboratori qui
              nella chat.
            </p>
          )}
          {entries.map((e) => (
            <Message key={e.id} from={e.user ? "user" : "assistant"}>
              <p>{e.text}</p>
            </Message>
          ))}
        </div>
        {proposal && (
          <div className="st-automation-proposal">
            <strong>Proposta da verificare</strong>
            <p>{proposal.text}</p>
            {!!proposal.files.length && (
              <small>{proposal.files.map((file) => file.name).join(" · ")}</small>
            )}
            <small>
              Demo: righe separate, “poi” e “quindi” diventano passaggi. I riferimenti selezionati
              collegano i responsabili; verifica sempre la bozza.
            </small>
            <div className="st-sim-actions">
              <button className="st-btn" onClick={() => setProposal(null)}>
                Scarta
              </button>
              <button className="st-btn dark" onClick={apply}>
                Prepara la bozza
              </button>
            </div>
          </div>
        )}
        {selection === "member" && (
          <div className="st-automation-question">
            <label>
              Passaggio da assegnare
              <select
                aria-label="Passaggio da assegnare"
                value={active}
                onChange={(e) => setActive(e.target.value)}
              >
                <option value="">Scegli un passaggio</option>
                {draft.steps.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
            {active && draft.steps.some((s) => s.id === active) && (
              <StudioMemberPicker
                label="Collaboratore del passaggio"
                options={eligible}
                value={
                  draft.steps.find((s) => s.id === active)?.person
                    ? [draft.steps.find((s) => s.id === active)!.person]
                    : []
                }
                onChange={(ids) => {
                  const id = ids.at(-1) || "";
                  onChange({
                    steps: draft.steps.map((s) =>
                      s.id === active ? { ...s, person: id, training: undefined } : s,
                    ),
                  });
                }}
              />
            )}
          </div>
        )}
        {selection === "project" && (
          <StudioProjectPicker
            label="Progetto dell’automazione"
            options={projects}
            value={draft.project ? [draft.project] : []}
            onChange={(ids) => onChange({ project: ids.at(-1) || "" })}
          />
        )}
        {selection && (
          <button className="st-text-link" onClick={() => setSelection(null)}>
            Chiudi scelta
          </button>
        )}
        <div className="st-chat-followups">
          <button
            onClick={() => {
              setSelection("member");
              setActive(draft.steps[0]?.id || "");
            }}
          >
            ＠ Collaboratore
          </button>
          <button onClick={() => setSelection("project")}>＋ Progetto</button>
          <button onClick={() => onInspect("trigger")}>Quando parte</button>
        </div>
        <StudioChatInput
          references={references}
          label="Descrivi l’automazione"
          onSend={(text, files, refs) => {
            setEntries((all) => [...all, { id: crypto.randomUUID(), text, user: true }]);
            if (!files.length && text.trim() === "@") {
              setSelection("member");
              setActive(draft.steps[0]?.id || "");
              say("Scegli il passaggio e cerca il collaboratore per nome o competenze.");
            } else if (!files.length && text.trim() === "/progetto") {
              setSelection("project");
            } else if (text.trim()) {
              setProposal({ text, files, refs: refs || [] });
              say("Ti propongo una bozza modificabile, prima di aggiungerla al flusso.");
            } else {
              setProposal({ text: "Lavorare sui materiali allegati", files });
            }
          }}
        />
      </section>
      {!!draft.steps.length && (
        <section className="st-automation-summary" aria-label="Riepilogo automazione">
          <button className="st-text-link" onClick={() => onInspect("trigger")}>
            {procedureTrigger(draft)} · Modifica
          </button>
          {draft.trigger === "schedule" && (
            <div className="st-chat-followups">
              <span>Quali giorni?</span>
              <button
                aria-pressed={draft.days.length === 5}
                onClick={() => onChange({ days: ["Lun", "Mar", "Mer", "Gio", "Ven"] })}
              >
                Lunedì–venerdì
              </button>
              <button
                aria-pressed={draft.days.length === 7}
                onClick={() =>
                  onChange({ days: ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"] })
                }
              >
                Tutti i giorni
              </button>
            </div>
          )}
          {draft.steps.map((s, i) => (
            <button key={s.id} onClick={() => onInspect(s.id)}>
              <span>{i + 1}</span>
              <strong>
                {people.find((p) => p.id === s.person)?.name || "Scegli collaboratore"}
              </strong>
              <span>{s.title}</span>
              {draft.project && !eligible.some((p) => p.id === s.person) && (
                <small className="st-procedure-error">
                  Non è nel progetto · clicca per cambiare responsabile
                </small>
              )}
            </button>
          ))}
        </section>
      )}
      <button
        className="st-text-link"
        aria-expanded={showFlow}
        onClick={() => setShowFlow(!showFlow)}
      >
        {showFlow ? "Nascondi passaggi" : "Mostra passaggi e riordina"}
      </button>
      <section
        hidden={!showFlow}
        className="st-automation-flow"
        aria-label="Flusso dell’automazione"
      >
        <div className="st-section-head">
          <h2>Il flusso</h2>
          <small>{draft.steps.length} passaggi</small>
        </div>
        <p className="st-muted">Trascina per riordinare. Clicca un blocco per modificarlo.</p>
        <div className="st-flow-palette">
          <button
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/homun-block", "work")}
            onClick={add}
          >
            <Plus size={14} />
            Lavoro
          </button>
          <button onClick={() => onInspect("trigger")}>Avvio</button>
          <button
            disabled={!draft.steps.length}
            onClick={() =>
              onInspect(
                draft.steps.some((s) => s.id === active) ? active : draft.steps[0]?.id || "trigger",
              )
            }
          >
            Revisione e risultato
          </button>
        </div>
        <button className="st-flow-node trigger" onClick={() => onInspect("trigger")}>
          <small>AVVIO</small>
          <strong>{procedureTrigger(draft)}</strong>
        </button>
        {draft.steps.map((s, i) => (
          <div
            key={s.id}
            className="st-flow-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/homun-step");
              if (id) move(id, i);
              else if (e.dataTransfer.getData("text/homun-block") === "work") {
                const step = newStep();
                const next = [...draft.steps];
                next.splice(i, 0, step);
                onChange({ steps: next });
                setActive(step.id);
                setSelection("member");
              }
            }}
          >
            <ArrowDown className="st-flow-arrow" size={16} />
            <div
              className="st-flow-node"
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/homun-step", s.id)}
            >
              <GripVertical size={15} />
              <button
                className="st-flow-node-main"
                onClick={() => {
                  setActive(s.id);
                  onInspect(s.id);
                }}
              >
                <small>
                  PASSAGGIO {i + 1} ·{" "}
                  {people.find((p) => p.id === s.person)?.name || "Scegli collaboratore"}
                </small>
                <strong>{s.title || "Descrivi il lavoro"}</strong>
                <span>
                  {s.approval ? "Risultato da verificare" : "Risultato al passaggio successivo"}
                </span>
              </button>
              <div>
                <button
                  aria-label={`Sposta su passaggio ${i + 1}`}
                  disabled={!i}
                  onClick={() => move(s.id, i - 1)}
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  aria-label={`Sposta giù passaggio ${i + 1}`}
                  disabled={i === draft.steps.length - 1}
                  onClick={() => move(s.id, i + 1)}
                >
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>
          </div>
        ))}
        <button
          className="st-flow-add"
          onClick={add}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/homun-step");
            if (id) move(id, draft.steps.length - 1);
            else if (e.dataTransfer.getData("text/homun-block") === "work") add();
          }}
        >
          ＋ Aggiungi un passaggio
        </button>
        <p className="st-muted">
          Il risultato di ogni passaggio alimenta il successivo. Condizioni e rami paralleli non
          sono ancora disponibili nella demo.
        </p>
      </section>
    </div>
  );
}
