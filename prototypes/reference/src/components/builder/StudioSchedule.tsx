import { StudioContribution } from "./StudioContribution";
import { StudioMemberPicker } from "./StudioMemberPicker";
import { StudioTaskOverview } from "./StudioTaskOverview";
import { moveIssue, moveWork } from "../../lib/studio-board";
import { reconcileProcedureTasks } from "../../lib/studio-pipelines";
import { StudioAssistedTask } from "./StudioAssistedTask";
import { StudioProjectPicker } from "./StudioProjectPicker";
import { StudioConversation } from "./StudioConversation";
import { hasDelivery, acceptDelivery } from "../../lib/studio-handoffs";
import { documentAccess } from "../../lib/studio-documents";
import { recordedCost, remainingBudget } from "../../lib/studio-costs";
import type { SharedDocument } from "./StudioDocuments";
import { StudioAutomation } from "./StudioAutomation";
import { useState, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Plus, LockKeyhole } from "lucide-react";
import type { AssignedWork, TodayProject } from "./StudioToday";
import { StudioWorkForm } from "./StudioWorkForm";

import { workStates, workDate, statusOf, dateKey, triggerLabel } from "../../lib/studio-work";
export function StudioSchedule({
  mode,
  people,
  users,
  projects,
  tasks,
  onSave,
  onChange,
  onPerson,
  target,
  onRemind,
  documents,
  onDocuments,
  onUpdateDocuments,
  onShareResult,
  onOpenTask,
  onWorkspaceChat,
  onProcedure,
  onRepeat,
  onCloseTask,
  onProject,
  onUpdateTasks,
  overlayOnly = false,
}: {
  onUpdateDocuments: (docs: SharedDocument[]) => void;
  mode: "calendar" | "kanban";
  people: { id: string; name: string }[];
  users: { id: string; name: string; status: string }[];
  projects: TodayProject[];
  tasks: AssignedWork[];
  onSave: (t: AssignedWork) => void;
  onChange: (t: AssignedWork) => void;
  onPerson: (id: string, taskId?: string) => void;
  target?: string;
  onRemind: (task: AssignedWork, step: NonNullable<AssignedWork["steps"]>[number]) => void;
  onOpenTask: (id: string) => void;
  onWorkspaceChat?: (id: string) => void;
  onProcedure: (id: string) => void;
  onRepeat: (id: string) => void;
  onCloseTask?: () => void;
  onProject: (id: string) => void;
  onUpdateTasks: (tasks: AssignedWork[]) => void;
  overlayOnly?: boolean;
  documents: SharedDocument[];
  onDocuments: () => void;
  onShareResult: (t: AssignedWork) => void;
}) {
  const [date, setDate] = useState(() => dateKey(new Date()));
  const [layout, setLayout] = useState("week");
  const [owner, setOwner] = useState("");
  const [project, setProject] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(target || "");
  const [dragging, setDragging] = useState("");
  const [boardMessage, setBoardMessage] = useState("");
  const [blockedMove, setBlockedMove] = useState("");
  const [fullDetails, setFullDetails] = useState(false);
  const [newStep, setNewStep] = useState("");
  useEffect(() => {
    setFullDetails(false);
    setSelected(target || "");
    setNewStep("");
  }, [target]);
  const task = tasks.find((t) => t.id === selected);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!selected || !drawer.current) return;
    const previous = document.activeElement as HTMLElement | null;
    drawer.current.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [selected]);
  function download(file: File) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function urgency(t: AssignedWork) {
    if (!t.due || statusOf(t) === "done") return "";
    const remaining = new Date(t.due).getTime() - Date.now();
    return remaining < 0
      ? "Scadenza superata"
      : remaining < 86400000
        ? statusOf(t) === "blocked"
          ? "Bloccato · scadenza entro 24 ore"
          : "Scade entro 24 ore"
        : "";
  }

  const filtered = tasks.filter(
    (t) => (!owner || t.person === owner) && (!project || t.project === project),
  );
  const monday = new Date(date + "T12:00");
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
  const actors = [
    ...people
      .filter((p) => !p.id.startsWith("user:"))
      .map((p) => ({ id: "bot:" + p.id, name: p.name + " · agente" })),
    ...users
      .filter((u) => u.status === "active")
      .map((u) => ({ id: "user:" + u.id, name: u.name + " · persona" })),
  ];
  const name = (id?: string) =>
    actors.find((a) => a.id === id)?.name || "Responsabile non più disponibile";
  const patch = (change: Partial<AssignedWork>) => {
    if (task) {
      const needsReview =
        (change.result !== undefined ||
          change.resultFiles !== undefined ||
          change.files !== undefined) &&
        ["done", "review"].includes(task.status || "");
      onChange({ ...task, ...change, ...(needsReview ? { status: "doing" as const } : {}) });
    }
  };
  function stepPatch(id: string, change: Partial<NonNullable<AssignedWork["steps"]>[number]>) {
    if (!task) return;
    const steps = (task.steps || []).map((s) => (s.id === id ? { ...s, ...change } : s));
    const blocked = steps.some((s) => !s.done && s.blocker);
    onChange({
      ...task,
      steps,
      status: blocked
        ? "blocked"
        : statusOf(task) === "blocked" ||
            (["done", "review"].includes(task.status || "") && steps.some((s) => !s.done))
          ? "todo"
          : task.status || "todo",
    });
  }
  function move(id: string, status: NonNullable<AssignedWork["status"]>, before?: string) {
    const moving = tasks.find((t) => t.id === id);
    if (!moving) return;
    if (statusOf(moving) === status && !before) {
      setDragging("");
      return;
    }
    const reason = statusOf(moving) === status ? "" : moveIssue(moving, status);
    if (reason) {
      setBoardMessage(reason);
      setBlockedMove(id);
      setDragging("");
      return;
    }
    const next =
      statusOf(moving) === status && before
        ? (() => {
            const all = tasks.filter((t) => t.id !== id);
            all.splice(
              Math.max(
                0,
                all.findIndex((t) => t.id === before),
              ),
              0,
              moving,
            );
            return all;
          })()
        : moveWork(tasks, id, status, before);
    onUpdateTasks(reconcileProcedureTasks(next));
    setBoardMessage(moving.title + " · " + workStates[status]);
    setBlockedMove("");
    setDragging("");
  }
  const card = (t: AssignedWork) => (
    <article
      className={`st-board-item ${dragging === t.id ? "is-dragging" : ""}`}
      key={t.id}
      draggable={mode === "kanban"}
      onDragStart={(e) => {
        setDragging(t.id);
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDragging("")}
      onDragOver={(e) => {
        if (dragging) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!dragging || dragging === t.id) return;
        e.preventDefault();
        e.stopPropagation();
        move(dragging, statusOf(t), t.id);
      }}
    >
      <button
        key={t.id}
        className="st-task-card"
        onClick={() => {
          setFullDetails(false);
          setSelected(t.id);
          setNewStep("");
        }}
      >
        <small>
          {people.find((p) => p.id === t.person)?.name}{" "}
          {t.project ? "· " + (projects.find((p) => p.id === t.project)?.name || "Progetto") : ""}
        </small>
        <strong>{t.title}</strong>
        <span>{workDate(t.due)}</span>
        {t.rule && <span className="st-card-next">{triggerLabel(t)}</span>}
        {urgency(t) && <span className="st-urgency">{urgency(t)}</span>}
        {statusOf(t) === "done" ? (
          <span className="st-card-next">
            {t.result ? "Apri il risultato →" : "Risultato da allegare"}
          </span>
        ) : (
          t.steps?.find((s) => !s.done) && (
            <span className="st-card-next">Ora: {t.steps.find((s) => !s.done)?.title}</span>
          )
        )}
        {!!t.steps?.length && (
          <progress
            aria-label="Avanzamento passaggi"
            max={t.steps.length}
            value={t.steps.filter((s) => s.done).length}
          />
        )}

        {!!t.steps?.length && (
          <small>
            {t.steps.filter((s) => s.done).length}/{t.steps.length} passaggi completati
          </small>
        )}
        {t.steps
          ?.filter((s) => !s.done && s.blocker)
          .map((s) => (
            <span className="st-blocked-label" key={s.id}>
              <LockKeyhole size={13} />
              <span>
                Aspetta {name(s.blocker)}
                <small>{s.reason || s.title}</small>
              </span>
            </span>
          ))}
        {mode === "calendar" && <small>{workStates[statusOf(t)]}</small>}
      </button>
      {mode === "kanban" && (
        <label className="st-board-move">
          <span>Sposta</span>
          <select
            aria-label={`Sposta ${t.title}`}
            value={statusOf(t)}
            onChange={(e) => move(t.id, e.target.value as NonNullable<AssignedWork["status"]>)}
          >
            {Object.entries(workStates).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
    </article>
  );
  return (
    <div className={overlayOnly ? "st-board-overlay-only" : "st-board-surface"}>
      <div className="st-today-header">
        <div>
          <span className="st-eyebrow">IL LAVORO DELLA SQUADRA</span>
          <h1>{mode === "calendar" ? "Calendario" : "Kanban"}</h1>
          <p>
            {mode === "calendar"
              ? "Quando devono essere pronti i risultati."
              : "Chi sta facendo cosa. Cosa serve per andare avanti."}
          </p>
        </div>
        <button className="st-btn dark" onClick={() => setCreating(true)}>
          <Plus size={16} />
          Assegna un lavoro
        </button>
      </div>
      {creating && (
        <StudioWorkForm
          key={date}
          date={date}
          people={people}
          projects={projects}
          onClose={() => setCreating(false)}
          onSave={(t) => {
            onSave(t);
            if (t.due) setDate(t.due.slice(0, 10));
            setOwner("");
            setProject("");
            setCreating(false);
            setFullDetails(false);
            setSelected(t.id);
          }}
        />
      )}
      <div className="st-schedule-toolbar">
        <StudioMemberPicker
          label="Filtra collaboratore"
          options={people}
          value={owner ? [owner] : []}
          emptyLabel="Tutta la squadra"
          onChange={(ids) => setOwner(ids.at(-1) || "")}
        />
        <StudioProjectPicker
          label="Filtra progetto"
          options={projects}
          value={project ? [project] : []}
          emptyLabel="Tutti i progetti"
          onChange={(ids) => setProject(ids.at(-1) || "")}
        />
        {mode === "calendar" && (
          <>
            <label>
              Data
              <input
                aria-label="Data del calendario"
                type="date"
                value={date}
                onChange={(e) => {
                  if (e.target.value) setDate(e.target.value);
                }}
              />
            </label>
            <label>
              Vista
              <select
                aria-label="Vista calendario"
                value={layout}
                onChange={(e) => setLayout(e.target.value)}
              >
                <option value="week">Settimana</option>
                <option value="agenda">Agenda · tutti gli incarichi</option>
              </select>
            </label>
          </>
        )}
      </div>
      {task && (
        <dialog
          ref={drawer}
          className="st-task-drawer"
          aria-labelledby="studio-task-title"
          onCancel={() => {
            setSelected("");
            onCloseTask?.();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              const r = e.currentTarget.getBoundingClientRect();
              if (
                e.clientX < r.left ||
                e.clientX > r.right ||
                e.clientY < r.top ||
                e.clientY > r.bottom
              )
                setSelected("");
              onCloseTask?.();
            }
          }}
        >
          <section className="st-paper st-task-detail" aria-label="Dettaglio incarico">
            <div className="st-section-head">
              <h2 id="studio-task-title">{task.title}</h2>
              <button
                className="st-btn"
                onClick={() => {
                  setSelected("");
                  onCloseTask?.();
                }}
              >
                Chiudi incarico
              </button>
            </div>
            {(task.requestFor &&
              tasks.some((t) => t.steps?.some((s) => `${t.id}:${s.id}` === task.requestFor))) ||
            tasks.some((t) => t.requestFor?.startsWith(task.id + ":") && t.status !== "done") ? (
              <StudioContribution
                key={task.id}
                task={task}
                tasks={tasks}
                people={people}
                documents={documents}
                onDocuments={onUpdateDocuments}
                onUpdate={onUpdateTasks}
                onOpen={onOpenTask}
              />
            ) : task.assisted && !fullDetails ? (
              <StudioAssistedTask
                task={task}
                tasks={tasks}
                people={people}
                onUpdate={onUpdateTasks}
                onDetails={() => setFullDetails(true)}
              />
            ) : !fullDetails ? (
              <>
                {onWorkspaceChat && (
                  <button
                    className="st-text-link st-chat-task-link"
                    onClick={() => onWorkspaceChat(task.id)}
                  >
                    Continua con Homun ↗
                  </button>
                )}
                <StudioTaskOverview
                  task={task}
                  people={people}
                  onChange={onChange}
                  onDetails={() => setFullDetails(true)}
                  onPerson={onPerson}
                />
              </>
            ) : (
              <>
                <button className="st-text-link" onClick={() => setFullDetails(false)}>
                  ← Torna al riepilogo
                </button>
                {task.requestFor &&
                  tasks.find((t) =>
                    t.steps?.some((step) => t.id + ":" + step.id === task.requestFor),
                  ) && (
                    <button
                      className="st-text-link"
                      onClick={() =>
                        onOpenTask(
                          tasks.find((t) =>
                            t.steps?.some((step) => t.id + ":" + step.id === task.requestFor),
                          )!.id,
                        )
                      }
                    >
                      Torna al lavoro che aspetta questa risposta →
                    </button>
                  )}
                {!task.procedureId && (
                  <button className="st-text-link" onClick={() => onRepeat(task.id)}>
                    Ripeti questo lavoro →
                  </button>
                )}
                {task.procedureId && (
                  <button className="st-text-link" onClick={() => onProcedure(task.procedureId!)}>
                    Automazione di origine →
                  </button>
                )}
                {task.dependsOn && (
                  <button className="st-text-link" onClick={() => onOpenTask(task.dependsOn!)}>
                    Apri il passaggio precedente →
                  </button>
                )}
                <button className="st-text-link" onClick={() => onPerson(task.person, task.id)}>
                  Parla con {people.find((p) => p.id === task.person)?.name} →
                </button>
                <p className="st-muted" style={{ marginTop: 12 }}>
                  {projects.find((p) => p.id === task.project)?.name || "Incarico diretto"} ·{" "}
                  {triggerLabel(task)}
                </p>
                {task.rule && task.rule.trigger !== "manual" && (
                  <p className="st-muted">
                    Programmato nella demo · nessuna esecuzione reale pianificata
                  </p>
                )}
                <details className="st-task-details">
                  <summary>Modifica incarico e responsabile</summary>
                  <label>
                    Titolo dell’incarico
                    <input
                      key={task.id}
                      defaultValue={task.title}
                      onBlur={(e) => {
                        if (e.target.value.trim()) patch({ title: e.target.value.trim() });
                        else e.target.value = task.title;
                      }}
                    />
                  </label>
                  <StudioMemberPicker
                    label="Responsabile dell’incarico"
                    options={people}
                    value={[task.person]}
                    onChange={(ids) => {
                      const id = ids.at(-1);
                      if (id)
                        patch({
                          person: id,
                          project: projects.find((p) => p.id === task.project)?.members.includes(id)
                            ? task.project
                            : "",
                        });
                    }}
                  />
                  <label>
                    Progetto collegato
                    <select
                      value={task.project}
                      onChange={(e) => patch({ project: e.target.value })}
                    >
                      <option value="">Incarico diretto</option>
                      {projects
                        .filter((p) => p.members.includes(task.person))
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  {task.procedureId && (
                    <p className="st-muted">
                      Le modifiche riguardano questa esecuzione. La procedura di origine resta
                      invariata.
                    </p>
                  )}
                </details>
                <div className="st-settings">
                  <label>
                    Scadenza
                    <input
                      aria-label="Scadenza incarico"
                      type="datetime-local"
                      value={task.due || ""}
                      min={task.start || undefined}
                      onChange={(e) => {
                        if (!task.start || !e.target.value || e.target.value >= task.start)
                          patch({ due: e.target.value });
                      }}
                    />
                  </label>
                  <label>
                    Stato
                    <select
                      aria-label="Stato incarico"
                      value={statusOf(task)}
                      onChange={(e) =>
                        patch({ status: e.target.value as NonNullable<AssignedWork["status"]> })
                      }
                    >
                      {Object.entries(workStates).map(([id, label]) => (
                        <option
                          value={id}
                          key={id}
                          disabled={
                            id !== statusOf(task) &&
                            !!moveIssue(task, id as NonNullable<AssignedWork["status"]>)
                          }
                        >
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="st-muted">
                  {task.start
                    ? "Inizio previsto: " + workDate(task.start)
                    : "Può iniziare appena disponibile."}{" "}
                  · Modifiche dimostrative, nessuna esecuzione.
                </p>
                {urgency(task) && <p className="st-urgency">{urgency(task)}</p>}
                {hasDelivery(task) && (
                  <div className="st-result">
                    <details open={["review", "done"].includes(statusOf(task))}>
                      <summary>Apri il risultato</summary>
                      <p style={{ whiteSpace: "pre-wrap" }}>{task.result}</p>
                      {task.resultFiles?.map((f, i) => (
                        <button key={i} className="st-message-file" onClick={() => download(f)}>
                          {f.name} · scarica risultato
                        </button>
                      ))}
                      <small>
                        Contenuto inserito nella demo. Modificarlo o cambiare i materiali richiede
                        una nuova verifica.
                      </small>
                    </details>
                    <button
                      className="st-btn"
                      disabled={!task.result?.trim()}
                      onClick={() => onShareResult(task)}
                    >
                      Condividi nei documenti
                    </button>
                    {task.status === "review" && (
                      <p className="st-muted">
                        In attesa di approvazione da{" "}
                        {people.find((p) => p.id === (task.approver || "user:fabio"))?.name ||
                          "responsabile"}
                      </p>
                    )}
                    {task.status === "review" && (
                      <div className="st-block-actions">
                        <button
                          className="st-btn dark"
                          disabled={!!task.approver && task.approver !== "user:fabio"}
                          onClick={() => patch({ status: "done" })}
                        >
                          Approva risultato · demo
                        </button>
                        <button className="st-btn" onClick={() => patch({ status: "doing" })}>
                          Richiedi modifiche · demo
                        </button>
                      </div>
                    )}
                    {!["review", "done"].includes(task.status || "") && (
                      <button
                        className="st-btn"
                        disabled={!hasDelivery(task) || !!task.steps?.some((s) => !s.done)}
                        onClick={() =>
                          patch({ status: task.rule?.approval === false ? "done" : "review" })
                        }
                      >
                        {task.rule?.approval === false
                          ? "Concludi incarico · demo"
                          : "Porta in revisione · demo"}
                      </button>
                    )}
                  </div>
                )}
                {!hasDelivery(task) && (
                  <p className="st-muted">
                    Per portare il lavoro in revisione o completarlo, aggiungi il risultato e
                    verifica i passaggi.
                  </p>
                )}
                <StudioAutomation task={task} tasks={tasks} onChange={onChange} />
                <details className="st-paper st-task-cost">
                  <summary>
                    Costi e limite ·{" "}
                    {recordedCost(task) === null
                      ? "consuntivo non disponibile"
                      : recordedCost(task)!.toLocaleString("it-IT", {
                          style: "currency",
                          currency: "EUR",
                        }) + " dimostrativi"}
                  </summary>
                  <p className="st-muted">
                    Questi importi sono dati di esempio o consumi del simulatore. Il costo del
                    modello locale non è stimato.
                  </p>
                  <label>
                    Limite di questo incarico (€)
                    <input
                      type="number"
                      min="0"
                      step="0.10"
                      value={task.costLimit ?? ""}
                      placeholder="Non definito"
                      onChange={(e) => {
                        const limit = Number(e.target.value);
                        if (e.target.value && Number.isFinite(limit) && limit >= 0)
                          patch({ costLimit: limit });
                        else if (!e.target.value) {
                          const next = { ...task };
                          delete next.costLimit;
                          onChange(next);
                        }
                      }}
                    />
                  </label>
                  <label>
                    Quando raggiunge il limite
                    <select
                      value={task.costPolicy || "ask"}
                      onChange={(e) => patch({ costPolicy: e.target.value as "pause" | "ask" })}
                    >
                      <option value="ask">Chiedi approvazione prima di proseguire</option>
                      <option value="pause">Metti in pausa</option>
                    </select>
                  </label>
                  <p>
                    Residuo:{" "}
                    {remainingBudget(task) === null
                      ? "non calcolabile"
                      : remainingBudget(task)!.toLocaleString("it-IT", {
                          style: "currency",
                          currency: "EUR",
                        })}
                  </p>
                  <p className="st-muted">
                    Regola proposta per il motore; non applicata alle esecuzioni reali. Il
                    simulatore ha un budget di prova separato.
                  </p>
                </details>
                <h3>Passaggi del lavoro</h3>
                {!task.steps?.length && (
                  <p className="st-muted">
                    Nessun passaggio definito. Puoi aggiungere la checklist qui sotto.
                  </p>
                )}
                {task.steps?.map((s, i) =>
                  s.id === "pipeline-gate" ? (
                    <div className="st-soft-note" key={s.id}>
                      {s.done
                        ? "Risultato precedente ricevuto. Puoi procedere."
                        : "In attesa del risultato verificato del passaggio precedente."}
                      <button className="st-text-link" onClick={() => onOpenTask(task.dependsOn!)}>
                        Apri il passaggio precedente →
                      </button>
                    </div>
                  ) : (
                    <div className="st-step-edit" key={s.id}>
                      <label className="st-step-check">
                        <input
                          type="checkbox"
                          checked={s.done}
                          disabled={!!s.blocker}
                          onChange={(e) => stepPatch(s.id, { done: e.target.checked })}
                        />
                        <span>
                          {i + 1}. {s.title}
                        </span>
                      </label>
                      {s.blocker && (
                        <div className="st-blocked-label">
                          <div>
                            Aspetta {name(s.blocker)} — {s.reason || s.title}
                            <div className="st-block-actions">
                              {tasks.find((t) => t.requestFor === task.id + ":" + s.id)?.status ===
                                "done" &&
                              tasks.find((t) => t.requestFor === task.id + ":" + s.id) &&
                              hasDelivery(
                                tasks.find((t) => t.requestFor === task.id + ":" + s.id)!,
                              ) ? (
                                <button
                                  className="st-btn"
                                  onClick={() => {
                                    const response = tasks.find(
                                      (t) => t.requestFor === task.id + ":" + s.id,
                                    )!;
                                    onChange(acceptDelivery(task, s.id, response));
                                  }}
                                >
                                  Usa la risposta e sblocca
                                </button>
                              ) : (
                                <button className="st-btn" onClick={() => onRemind(task, s)}>
                                  {tasks.some((t) => t.requestFor === task.id + ":" + s.id)
                                    ? "Sollecita richiesta"
                                    : s.blocker.startsWith("bot:")
                                      ? "Richiedi intervento all’agente"
                                      : "Assegna richiesta alla persona"}{" "}
                                  · demo
                                </button>
                              )}
                              {tasks.find((t) => t.requestFor === task.id + ":" + s.id) && (
                                <button
                                  className="st-text-link"
                                  onClick={() =>
                                    onOpenTask(
                                      tasks.find((t) => t.requestFor === task.id + ":" + s.id)!.id,
                                    )
                                  }
                                >
                                  Apri richiesta collegata →
                                </button>
                              )}

                              {s.blocker.startsWith("bot:") && (
                                <button
                                  className="st-text-link"
                                  onClick={() => onPerson(s.blocker!.slice(4))}
                                >
                                  Parla con {name(s.blocker).split(" · ")[0]}
                                </button>
                              )}
                              <button
                                className="st-text-link"
                                onClick={() => stepPatch(s.id, { blocker: "", reason: "" })}
                              >
                                Segna come sbloccato · demo
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      {!s.done && (
                        <details>
                          <summary>{s.blocker ? "Gestisci attesa" : "Segnala un’attesa"}</summary>
                          <StudioMemberPicker
                            label={"Chi deve intervenire: " + s.title}
                            options={actors
                              .filter((a) => a.id !== "bot:" + task.person && a.id !== task.person)
                              .map((a) => ({ ...a, id: a.id.replace(/^bot:/, "") }))}
                            value={s.blocker ? [s.blocker.replace(/^bot:/, "")] : []}
                            emptyLabel="Nessuna attesa"
                            onChange={(ids) => {
                              const id = ids.at(-1) || "";
                              stepPatch(s.id, {
                                blocker: id && !id.startsWith("user:") ? "bot:" + id : id,
                                reason: id ? s.reason || "" : "",
                              });
                            }}
                          />

                          <label>
                            Cosa manca?
                            <input
                              aria-label={"Cosa manca: " + s.title}
                              value={s.reason || ""}
                              onChange={(e) => stepPatch(s.id, { reason: e.target.value })}
                            />
                          </label>
                          <small>
                            Lo sblocco rende il passaggio disponibile; non lo segna come completato.
                          </small>
                        </details>
                      )}
                    </div>
                  ),
                )}
                <form
                  className="st-step-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newStep.trim()) return;
                    patch({
                      steps: [
                        ...(task.steps || []),
                        { id: crypto.randomUUID(), title: newStep.trim(), done: false },
                      ],
                      status: task.status === "done" ? "todo" : task.status || "todo",
                    });
                    setNewStep("");
                  }}
                >
                  <input
                    aria-label="Nuovo passaggio"
                    placeholder="Aggiungi un passaggio…"
                    value={newStep}
                    onChange={(e) => setNewStep(e.target.value)}
                    required
                  />
                  <button className="st-btn">Aggiungi passaggio</button>
                </form>
                <details className="st-result">
                  <summary>Partecipanti e approvazione</summary>
                  <p className="st-muted">
                    Fabio e il responsabile accedono alla discussione condivisa. Aggiungi altri
                    partecipanti esplicitamente.
                  </p>
                  <StudioMemberPicker
                    multiple
                    label="Partecipanti del compito"
                    options={people.filter((p) => p.id !== task.person && p.id !== "user:fabio")}
                    value={task.participants || []}
                    onChange={(ids) => patch({ participants: ids })}
                  />
                  <StudioMemberPicker
                    label="Chi approva"
                    options={people.filter((p) => p.id.startsWith("user:"))}
                    value={[task.approver || "user:fabio"]}
                    onChange={(ids) => {
                      if (ids.at(-1)) patch({ approver: ids.at(-1)! });
                    }}
                  />
                </details>
                <section className="st-task-materials">
                  <h3>Materiali dell’incarico</h3>
                  {documents
                    .filter((d) => d.taskIds.includes(task.id))
                    .map((d) => (
                      <button className="st-recent" key={d.id} onClick={onDocuments}>
                        <span>
                          <strong>{d.title}</strong>
                          <small>
                            {d.author} · v{d.version} ·{" "}
                            {task.person === "user:fabio" ||
                            documentAccess(
                              d,
                              documents,
                              projects,
                              people.map((p) => p.id),
                            ).includes(task.person)
                              ? "materiale accessibile al responsabile"
                              : "accesso del responsabile da autorizzare"}
                          </small>
                        </span>
                      </button>
                    ))}
                  <button className="st-btn" onClick={onDocuments}>
                    Collega un documento esistente
                  </button>
                  <label className="st-btn">
                    Aggiungi file
                    <input
                      className="sr-only"
                      type="file"
                      multiple
                      onChange={(e) => {
                        patch({
                          files: [...(task.files || []), ...Array.from(e.target.files || [])],
                        });
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {(task.files || []).map((file, i) => (
                    <div className="st-recent" key={i}>
                      <span>
                        {file.name}
                        <small>{Math.ceil(file.size / 1024)} KB · solo in questa sessione</small>
                      </span>
                      <button
                        aria-label={"Rimuovi " + file.name}
                        onClick={() => patch({ files: task.files!.filter((_, j) => i !== j) })}
                      >
                        Rimuovi
                      </button>
                    </div>
                  ))}
                  <p className="st-muted">
                    I file non vengono inviati o analizzati. Allegarli non sblocca automaticamente
                    un passaggio.
                  </p>
                </section>
                <section className="st-task-materials">
                  <h3>Consegna</h3>
                  <label className="st-btn">
                    Allega file al risultato
                    <input
                      className="sr-only"
                      type="file"
                      multiple
                      onChange={(e) => {
                        patch({
                          resultFiles: [
                            ...(task.resultFiles || []),
                            ...Array.from(e.target.files || []),
                          ],
                        });
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {(task.resultFiles || []).map((f, i) => (
                    <div className="st-message-file" key={i}>
                      <button onClick={() => download(f)}>{f.name} · scarica</button>
                      <button
                        onClick={() =>
                          patch({ resultFiles: task.resultFiles!.filter((_, j) => i !== j) })
                        }
                      >
                        Rimuovi file dal risultato
                      </button>
                    </div>
                  ))}
                  <p className="st-muted">
                    La consegna può contenere testo, file o entrambi. I file nei materiali sono
                    invece gli input del lavoro.
                  </p>
                  {task.deliveries?.map((d) => (
                    <button
                      key={d.taskId}
                      className="st-text-link"
                      onClick={() => onOpenTask(d.taskId)}
                    >
                      {tasks.find((t) => t.id === d.taskId)?.status === "done"
                        ? "Consegna accettata: "
                        : "Consegna precedente · da verificare: "}
                      {d.title} · {d.files.length} file →
                    </button>
                  ))}
                </section>
                <details className="st-result">
                  <summary>
                    {task.result ? "Modifica il risultato" : "Aggiungi il risultato"}
                  </summary>
                  <label>
                    Testo del risultato
                    <textarea
                      aria-label="Testo del risultato"
                      value={task.result || ""}
                      onChange={(e) => patch({ result: e.target.value })}
                    />
                  </label>
                  <small>
                    Inserimento manuale nella demo; lo stato resta modificabile separatamente.
                  </small>
                </details>
                <details className="st-result">
                  <summary>Cronologia e note precedenti</summary>
                  {task.notes?.map((n, i) => (
                    <p key={i} className="st-muted">
                      {n}
                    </p>
                  ))}
                </details>
                <p className="st-muted">
                  Discussione visibile a:{" "}
                  {[...new Set(["user:fabio", task.person, ...(task.participants || [])])]
                    .map((id) => people.find((p) => p.id === id)?.name || id)
                    .join(", ")}
                </p>
                {task.sourceMessage && (
                  <button
                    className="st-text-link"
                    onClick={() => onPerson(task.sourceMessage!.person)}
                  >
                    Apri conversazione di origine →
                  </button>
                )}
                <StudioConversation
                  key={task.id}
                  person={{ id: task.id, name: "partecipanti del compito" }}
                  shared
                  messages={task.messages || []}
                  onMessage={(m) =>
                    patch({
                      messages: [
                        ...(task.messages || []),
                        {
                          ...m,
                          taskIds: [task.id],
                          projectIds: task.project ? [task.project] : [],
                        },
                      ],
                    })
                  }
                  tasks={tasks}
                  projects={projects}
                  onTask={onOpenTask}
                  onProject={onProject}
                />
              </>
            )}
          </section>
        </dialog>
      )}
      <p className="st-muted st-board-hint">
        Trascina una scheda o usa Sposta. Scorri per vedere{" "}
        {mode === "kanban" ? "tutti gli stati" : "gli altri giorni"}.
      </p>
      {boardMessage && (
        <div className="st-board-feedback" role="status">
          {boardMessage}
          {blockedMove && (
            <button className="st-text-link" onClick={() => setSelected(blockedMove)}>
              Apri compito
            </button>
          )}
          <button
            className="st-text-link"
            onClick={() => {
              setBoardMessage("");
              setBlockedMove("");
            }}
          >
            Chiudi avviso
          </button>
        </div>
      )}
      {mode === "kanban" ? (
        <div className="st-kanban">
          {Object.entries(workStates).map(([id, label]) => (
            <section
              className={"st-kanban-column " + id}
              key={id}
              aria-label={label}
              onDragOver={(e) => {
                if (dragging) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) move(dragging, id as NonNullable<AssignedWork["status"]>);
              }}
            >
              <h2>
                {label}
                <span>{filtered.filter((t) => statusOf(t) === id).length}</span>
              </h2>
              {filtered.filter((t) => statusOf(t) === id).map(card)}
              {!filtered.some((t) => statusOf(t) === id) && (
                <p className="st-muted">Nessun incarico</p>
              )}
            </section>
          ))}
        </div>
      ) : layout === "week" ? (
        <>
          <div className="st-week-heading">
            <button
              className="st-btn"
              aria-label="Settimana precedente"
              onClick={() => {
                const d = new Date(monday);
                d.setDate(d.getDate() - 7);
                setDate(dateKey(d));
              }}
            >
              <ChevronLeft size={16} />
            </button>
            <h2>
              {monday.toLocaleDateString("it-IT", { day: "numeric", month: "long" })} –{" "}
              {days[6]!.toLocaleDateString("it-IT", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </h2>
            <button
              className="st-btn"
              aria-label="Settimana successiva"
              onClick={() => {
                const d = new Date(monday);
                d.setDate(d.getDate() + 7);
                setDate(dateKey(d));
              }}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="st-calendar-week">
            {days.map((d) => (
              <section
                key={dateKey(d)}
                className={dateKey(d) === dateKey(new Date()) ? "is-today" : ""}
              >
                <button
                  className="st-day-heading"
                  aria-label={"Assegna per " + dateKey(d)}
                  onClick={() => {
                    setDate(dateKey(d));
                    setCreating(true);
                  }}
                >
                  <span>{d.toLocaleDateString("it-IT", { weekday: "short" })}</span>
                  <strong>{d.getDate()}</strong>
                  <Plus size={13} />
                </button>
                {filtered
                  .filter((t) => t.due?.slice(0, 10) === dateKey(d))
                  .sort((a, b) => (a.due || "").localeCompare(b.due || ""))
                  .map(card)}
              </section>
            ))}
          </div>
          {!!filtered.filter((t) => !t.due).length && (
            <section className="st-paper st-today-section">
              <h2>Senza scadenza</h2>
              {filtered.filter((t) => !t.due).map(card)}
            </section>
          )}
        </>
      ) : (
        <div className="st-agenda">
          {filtered.length ? (
            [...filtered].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).map(card)
          ) : (
            <p>Nessun incarico per questi filtri.</p>
          )}
        </div>
      )}
      <p className="st-muted st-today-section">
        Incarichi e passaggi in memoria fino al ricaricamento. Le scadenze sono locali; nessuna
        routine o notifica attiva.
      </p>
    </div>
  );
}
