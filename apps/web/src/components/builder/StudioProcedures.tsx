import { StudioRoutineList } from "./StudioRoutineActivity";
import { StudioSimpleDelegation } from "./StudioSimpleDelegation";
import { StudioAutomationSimulation } from "./StudioAutomationSimulation";
import { StudioAutomationCanvas } from "./StudioAutomationCanvas";
import { StudioMemberPicker } from "./StudioMemberPicker";
import { StudioMaterialPicker } from "./StudioMaterialContext";
import type { TrainingActivity } from "./StudioTraining";
import { StudioProjectPicker } from "./StudioProjectPicker";
import { useState, useEffect, useRef } from "react";
import { Plus, ArrowRight, ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import type { AssignedWork, TodayProject } from "./StudioToday";
import { workStates, statusOf } from "../../lib/studio-work";
import {
  createProcedureRun,
  procedureIssue,
  procedureTrigger,
  type Procedure,
  type ProcedureStep,
} from "../../lib/studio-pipelines";
const fresh = (): Procedure => ({
  id: crypto.randomUUID(),
  name: "",
  project: "",
  trigger: "manual",
  time: "09:00",
  days: ["Lun", "Mar", "Mer", "Gio", "Ven"],
  interval: 60,
  event: "",
  active: false,
  steps: [],
});
export function StudioProcedures({
  people,
  projects,
  tasks,
  onRun,
  onTask,
  target,
}: {
  people: { id: string; name: string; activities?: TrainingActivity[] }[];
  projects: TodayProject[];
  tasks: AssignedWork[];
  onRun: (tasks: AssignedWork[]) => void;
  onTask: (id: string) => void;
  target?: { id: string; nonce: number; fromTask?: boolean } | null;
}) {
  const [planningSimulation, setPlanningSimulation] = useState(false);
  const [simulation, setSimulation] = useState(false);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [draft, setDraft] = useState<Procedure | null>(null);
  const [tab, setTab] = useState("canvas");
  const [selectedStep, setSelectedStep] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState("");
  const openedTarget = useRef<number | null>(null);
  useEffect(() => {
    if (target && openedTarget.current !== target.nonce) {
      openedTarget.current = target.nonce;
      if (target.fromTask) {
        const task = tasks.find((t) => t.id === target.id);
        if (task) {
          setDraft({
            ...fresh(),
            name: task.title,
            project: task.project,
            steps: [
              {
                id: crypto.randomUUID(),
                title: task.title,
                method:
                  task.steps
                    ?.filter((s) => !s.blocker && s.id !== "pipeline-gate")
                    .map((s) => s.title) || [],
                person: task.person,
                materials: "",
                files: task.files,
                materialLinks: task.materialLinks,
                materialReferences: task.materialReferences,
                training: task.training,
                successCriteria: task.successCriteria,
                costLimit: task.costLimit,
                costPolicy: task.costPolicy,
                approver: task.approver,
                approval: true,
              },
            ],
          });
          setTab("canvas");
          setError("");
          setMessage(
            "Scegli quando ripetere il lavoro e verifica i responsabili. Le attese di questo singolo incarico non vengono ripetute: aggiungi eventuali contributi come passaggi della procedura.",
          );
        }
        return;
      }
      const p = procedures.find((p) => p.id === target.id);
      if (p) {
        setDraft(structuredClone(p));
        setTab("runs");
        setError("");
      }
    }
  }, [target, procedures, tasks]);
  function patch(p: Partial<Procedure>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setMessage("");
    setError("");
  }
  function stepPatch(id: string, p: Partial<ProcedureStep>) {
    patch({ steps: draft!.steps.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  }
  function open(p: Procedure) {
    setDraft(structuredClone(p));
    setTab("canvas");
    setError("");
    setMessage("");
  }
  function save() {
    if (!draft) return false;
    const project = projects.find((p) => p.id === draft.project);
    const invalidOwner = draft.steps.some(
      (s) =>
        !people.some((p) => p.id === s.person) || (project && !project.members.includes(s.person)),
    );
    const issue =
      procedureIssue(draft) ||
      (draft.project && !project
        ? "Il progetto non è più disponibile."
        : invalidOwner
          ? "Ogni responsabile deve essere attivo e appartenere alla squadra del progetto scelto."
          : "");
    if (issue) {
      setError(issue);
      return false;
    }
    setProcedures((all) =>
      all.some((p) => p.id === draft.id)
        ? all.map((p) => (p.id === draft.id ? structuredClone(draft) : p))
        : [...all, structuredClone(draft)],
    );
    setError("");
    setMessage("Procedura salvata nella sessione demo.");
    return true;
  }
  function run() {
    if (!draft || !save()) return;
    if (tasks.some((t) => t.procedureId === draft.id && statusOf(t) !== "done")) {
      setError("C’è già una prova aperta. Completa gli incarichi prima di avviarne un’altra.");
      return;
    }
    onRun(createProcedureRun(draft, crypto.randomUUID()));
    setTab("runs");
    setMessage(
      "Prova creata. Gli incarichi sono disponibili anche in Home, Kanban e nel progetto.",
    );
  }
  const runs = tasks.filter((t) => t.procedureId === draft?.id);
  const runIds = Array.from(new Set(runs.map((t) => t.runId)));
  if (planningSimulation)
    return <StudioSimpleDelegation onClose={() => setPlanningSimulation(false)} />;
  if (simulation) return <StudioAutomationSimulation onClose={() => setSimulation(false)} />;
  return (
    <>
      {!draft ? (
        <>
          <div className="st-section-head">
            <div>
              <span className="st-eyebrow">IL METODO DELLA SQUADRA</span>
              <h1>Automazioni</h1>
            </div>
            <button className="st-btn dark" onClick={() => open(fresh())}>
              <Plus size={16} />
              Nuova procedura
            </button>
          </div>
          <button className="st-btn dark" onClick={() => setSimulation(true)}>
            Prova la nuova esperienza · Email con Vera
          </button>
          <button className="st-btn" onClick={() => setPlanningSimulation(true)}>
            Prova la chat semplice con Elio
          </button>
          <p className="st-intro">
            Definisci un metodo, scegli quando parte e segui ogni esecuzione.
          </p>
          <div className="st-settings-demo">
            Prototipo locale: orari ed eventi non avviano azioni reali. Le prove generano incarichi
            dimostrativi; tutto si azzera al ricaricamento.
          </div>
          {!procedures.length && (
            <div className="st-paper st-procedure-empty">
              <h2>Un lavoro ripetibile, al tuo modo.</h2>
              <p>Puoi iniziare da zero o riutilizzare i passaggi di un incarico.</p>
            </div>
          )}
          <StudioRoutineList />
          <div className="st-job-list">
            {procedures.map((p) => (
              <button className="st-job" key={p.id} onClick={() => open(p)}>
                <span className="st-job-copy">
                  <strong>{p.name}</strong>
                  <small>
                    {procedureTrigger(p)} · {p.active ? "Attiva nella demo" : "In pausa"}
                  </small>
                  <small>
                    {p.steps
                      .map((s) => people.find((x) => x.id === s.person)?.name || "Da assegnare")
                      .join(" → ")}{" "}
                    ·{" "}
                    {new Set(tasks.filter((t) => t.procedureId === p.id).map((t) => t.runId)).size}{" "}
                    prove
                  </small>
                </span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
          <details className="st-paper st-home-costs">
            <summary>Parti da un incarico esistente</summary>
            <label>
              Incarico
              <select
                aria-label="Incarico da trasformare in procedura"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">Scegli un incarico</option>
                {tasks
                  .filter((t) => !t.procedureId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="st-btn"
              disabled={!source}
              onClick={() => {
                const t = tasks.find((t) => t.id === source)!;
                open({
                  ...fresh(),
                  name: t.title,
                  project: t.project,
                  steps: (t.steps?.length ? t.steps : [{ title: t.title }]).map((s) => ({
                    id: crypto.randomUUID(),
                    title: s.title,
                    person: t.person,
                    materials: "",
                    approval: true,
                  })),
                });
              }}
            >
              Usa come punto di partenza
            </button>
          </details>
        </>
      ) : (
        <>
          <button
            className="st-back"
            onClick={() => {
              if (
                JSON.stringify(draft) !==
                  JSON.stringify(procedures.find((p) => p.id === draft.id)) &&
                !window.confirm("La bozza contiene modifiche non salvate. Vuoi scartarle?")
              )
                return;
              setDraft(null);
              setError("");
              setMessage("");
            }}
          >
            ← Tutte le automazioni
          </button>
          <h1>{draft.name || "Nuova procedura"}</h1>
          <div className="st-automation-header">
            <p className="st-muted">
              Bozza locale · risposte simulate, nessuna esecuzione esterna.
            </p>
            <div className="st-chat-followups">
              <button aria-pressed={tab !== "runs"} onClick={() => setTab("canvas")}>
                Componi
              </button>
              <button aria-pressed={tab === "runs"} onClick={() => setTab("runs")}>
                Prove
              </button>
              <button className="st-btn dark" onClick={save}>
                Salva
              </button>
              <button onClick={run}>Prova manuale</button>
            </div>
          </div>
          {error && (
            <p role="alert" className="st-procedure-error">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="st-muted">
              {message}
            </p>
          )}
          <div hidden={tab === "runs"}>
            <StudioAutomationCanvas
              key={draft.id}
              draft={draft}
              people={people}
              projects={projects}
              onChange={patch}
              onInspect={(id) => {
                setSelectedStep(id);
                setTab(id === "trigger" ? "trigger" : "steps");
                setTimeout(
                  () =>
                    document
                      .getElementById("automation-inspector")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" }),
                  0,
                );
              }}
            />
          </div>
          {(tab === "trigger" || tab === "steps") && (
            <div id="automation-inspector" className="st-automation-inspector-heading">
              <h2>{tab === "trigger" ? "Quando parte" : "Dettagli del passaggio"}</h2>
              <button className="st-text-link" onClick={() => setTab("canvas")}>
                Chiudi dettagli
              </button>
            </div>
          )}
          {tab === "trigger" && (
            <div className="st-paper st-preferences">
              <label>
                Nome della procedura
                <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
              </label>
              <StudioProjectPicker
                label="Progetto della procedura"
                options={projects}
                value={draft.project ? [draft.project] : []}
                emptyLabel="Senza progetto"
                onChange={(ids) => patch({ project: ids.at(-1) || "" })}
              />
              <label>
                Avvio
                <select
                  value={draft.trigger}
                  onChange={(e) => patch({ trigger: e.target.value as Procedure["trigger"] })}
                >
                  <option value="manual">Su richiesta</option>
                  <option value="schedule">Giorni e orario</option>
                  <option value="interval">A intervalli</option>
                  <option value="event">Quando accade qualcosa</option>
                </select>
              </label>
              {(draft.trigger === "schedule" || draft.trigger === "interval") && (
                <>
                  {draft.trigger === "schedule" && (
                    <label>
                      Alle ore
                      <input
                        type="time"
                        value={draft.time}
                        onChange={(e) => patch({ time: e.target.value })}
                      />
                    </label>
                  )}
                  <fieldset className="st-procedure-days">
                    <legend>Giorni della settimana</legend>
                    {["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((d) => (
                      <label key={d}>
                        <input
                          type="checkbox"
                          checked={draft.days.includes(d)}
                          onChange={() =>
                            patch({
                              days: draft.days.includes(d)
                                ? draft.days.filter((x) => x !== d)
                                : [...draft.days, d],
                            })
                          }
                        />
                        {d}
                      </label>
                    ))}
                  </fieldset>
                  <p className="st-muted">
                    Orario del dispositivo: {Intl.DateTimeFormat().resolvedOptions().timeZone}.
                  </p>
                </>
              )}
              {draft.trigger === "interval" && (
                <label>
                  Ogni quanti minuti
                  <input
                    type="number"
                    min="5"
                    value={draft.interval}
                    onChange={(e) => patch({ interval: Number(e.target.value) })}
                  />
                </label>
              )}
              {draft.trigger === "interval" && (
                <div className="st-rule-grid">
                  <label>
                    Dalle
                    <input
                      type="time"
                      value={draft.from || "09:00"}
                      onChange={(e) => patch({ from: e.target.value })}
                    />
                  </label>
                  <label>
                    Alle
                    <input
                      type="time"
                      value={draft.until || "18:00"}
                      onChange={(e) => patch({ until: e.target.value })}
                    />
                  </label>
                </div>
              )}
              <p className="st-muted">
                Se una precedente esecuzione è ancora aperta, non viene avviata una nuova prova.
                Completa quella in corso prima di ripetere.
              </p>
              {draft.trigger === "event" && (
                <label>
                  Evento da attendere
                  <input
                    placeholder="Es. nuova richiesta nella casella commerciale"
                    value={draft.event}
                    onChange={(e) => patch({ event: e.target.value })}
                  />
                  <small>
                    Descrizione dimostrativa: il collegamento alla fonte sarà configurato con il
                    motore.
                  </small>
                </label>
              )}
              <label>
                Stato nella demo
                <select
                  value={draft.active ? "active" : "paused"}
                  onChange={(e) => patch({ active: e.target.value === "active" })}
                >
                  <option value="paused">In pausa</option>
                  <option value="active">Attiva nella demo</option>
                </select>
              </label>
              <p className="st-muted">
                Prossimo avvio reale: non pianificato. Puoi provare manualmente anche una procedura
                in pausa.
              </p>
            </div>
          )}
          {tab === "steps" && (
            <>
              <p className="st-muted">
                Ogni passaggio attende il risultato verificato del precedente. Persone e agenti
                usano gli stessi incarichi.
              </p>
              {draft.steps.map((s, i) =>
                s.id !== selectedStep ? null : (
                  <section className="st-paper st-procedure-step" key={s.id}>
                    <div className="st-section-head">
                      <h2>Passaggio {i + 1}</h2>
                      <div className="st-procedure-actions">
                        <button
                          aria-label={`Sposta su passaggio ${i + 1}`}
                          disabled={!i}
                          onClick={() => {
                            const steps = [...draft.steps];
                            [steps[i - 1], steps[i]] = [steps[i]!, steps[i - 1]!];
                            patch({ steps });
                          }}
                        >
                          <ChevronUp size={17} />
                        </button>
                        <button
                          aria-label={`Sposta giù passaggio ${i + 1}`}
                          disabled={i === draft.steps.length - 1}
                          onClick={() => {
                            const steps = [...draft.steps];
                            [steps[i], steps[i + 1]] = [steps[i + 1]!, steps[i]!];
                            patch({ steps });
                          }}
                        >
                          <ChevronDown size={17} />
                        </button>
                        <button
                          aria-label={`Rimuovi passaggio ${i + 1}`}
                          onClick={() => patch({ steps: draft.steps.filter((x) => x.id !== s.id) })}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    <label>
                      Attività
                      <input
                        value={s.title}
                        onChange={(e) => stepPatch(s.id, { title: e.target.value })}
                      />
                    </label>
                    <StudioMemberPicker
                      label={`Responsabile passaggio ${i + 1}`}
                      options={people}
                      value={s.person ? [s.person] : []}
                      emptyLabel="Scegli persona o agente"
                      onChange={(ids) =>
                        stepPatch(s.id, {
                          person: ids.at(-1) || "",
                          training: undefined,
                          materialLinks: [],
                        })
                      }
                    />
                    {!s.person.startsWith("user:") && (
                      <label>
                        Responsabilità da applicare
                        <select
                          value={s.training ? JSON.stringify(s.training) : ""}
                          onChange={(e) =>
                            stepPatch(s.id, {
                              training: e.target.value ? JSON.parse(e.target.value) : undefined,
                            })
                          }
                        >
                          <option value="">Nuova attività · in stage</option>
                          {s.training && (
                            <option value={JSON.stringify(s.training)}>
                              {s.training.activity} · regola salvata
                            </option>
                          )}
                          {(people.find((p) => p.id === s.person)?.activities || []).map((a) => (
                            <option
                              key={a.id}
                              value={JSON.stringify({
                                activity: a.title,
                                scope: a.scope,
                                mode: a.mode,
                              })}
                            >
                              {a.title} ·{" "}
                              {a.mode === "stage"
                                ? "in stage"
                                : a.mode === "review"
                                  ? "verifica risultato"
                                  : "autonomia delimitata"}
                            </option>
                          ))}
                        </select>
                        <small>Lo stage e la supervisione richiedono comunque una revisione.</small>
                      </label>
                    )}
                    <StudioMaterialPicker
                      owner={s.person}
                      value={s.materialLinks || []}
                      onChange={(materialLinks) => stepPatch(s.id, { materialLinks })}
                    />
                    {!!s.files?.length && (
                      <p className="st-muted">
                        File mantenuti dall’incarico: {s.files.map((f) => f.name).join(", ")}
                      </p>
                    )}
                    <label>
                      Risultato atteso
                      <input
                        value={s.successCriteria || ""}
                        onChange={(e) => stepPatch(s.id, { successCriteria: e.target.value })}
                      />
                    </label>
                    <label>
                      Limite remoto per esecuzione · €
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={s.costLimit ?? ""}
                        onChange={(e) =>
                          stepPatch(s.id, {
                            costLimit: e.target.value === "" ? undefined : Number(e.target.value),
                            costPolicy: "pause",
                          })
                        }
                      />
                    </label>
                    <label>
                      Materiali richiesti
                      <textarea
                        value={s.materials}
                        placeholder="Es. listino aggiornato e richiesta del cliente"
                        onChange={(e) => stepPatch(s.id, { materials: e.target.value })}
                      />
                    </label>
                    <label>
                      Verifica del risultato
                      <select
                        value={s.approval ? "yes" : "no"}
                        onChange={(e) => stepPatch(s.id, { approval: e.target.value === "yes" })}
                      >
                        <option value="yes">Richiedi approvazione</option>
                        <option value="no">Non richiedere approvazione aggiuntiva</option>
                      </select>
                    </label>
                    {(s.approval ||
                      (!s.person.startsWith("user:") && s.training?.mode !== "autonomous")) && (
                      <StudioMemberPicker
                        label={`Chi approva il passaggio ${i + 1}`}
                        options={people.filter((p) => p.id.startsWith("user:"))}
                        value={[s.approver || "user:fabio"]}
                        onChange={(ids) => {
                          if (ids.at(-1)) stepPatch(s.id, { approver: ids.at(-1)! });
                        }}
                      />
                    )}
                  </section>
                ),
              )}
            </>
          )}
          {tab === "runs" && (
            <div className="st-paper">
              <h2>Prove della procedura</h2>
              {!runIds.length && (
                <p className="st-muted">
                  Nessuna prova. “Prova manuale” crea gli incarichi senza eseguirli.
                </p>
              )}
              {runIds.map((id, i) => (
                <section key={id} className="st-procedure-step">
                  <h3>
                    Prova {i + 1} ·{" "}
                    {runs.filter((t) => t.runId === id).every((t) => statusOf(t) === "done")
                      ? "Completata"
                      : "Aperta"}
                  </h3>
                  {runs
                    .filter((t) => t.runId === id)
                    .map((t) => (
                      <button className="st-recent" key={t.id} onClick={() => onTask(t.id)}>
                        <span>
                          <strong>{t.title}</strong>
                          <small>
                            {people.find((p) => p.id === t.person)?.name} ·{" "}
                            {workStates[statusOf(t)]}
                          </small>
                        </span>
                        <ArrowRight size={16} />
                      </button>
                    ))}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
