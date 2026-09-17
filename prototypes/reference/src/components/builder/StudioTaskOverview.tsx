import { StudioLinkedMaterials } from "./StudioMaterialContext";
import { useState } from "react";
import { StudioArtifactPreview } from "./StudioArtifactPreview";
import type { AssignedWork } from "./StudioToday";
import { statusOf, workDate, workStates } from "../../lib/studio-work";
import { moveIssue } from "../../lib/studio-board";
export function StudioTaskOverview({
  task,
  people,
  onChange,
  onDetails,
  onPerson,
}: {
  task: AssignedWork;
  people: { id: string; name: string }[];
  onChange: (task: AssignedWork) => void;
  onDetails: () => void;
  onPerson: (id: string, taskId?: string) => void;
}) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const status = statusOf(task);
  const waiting = task.steps?.filter((s) => s.blocker && !s.done) || [];
  const name = (id: string) =>
    people.find((p) => p.id === id.replace(/^bot:/, ""))?.name || "Collaboratore";
  const next =
    status === "review"
      ? "done"
      : status === "todo"
        ? "doing"
        : status === "doing"
          ? task.person.startsWith("user:")
            ? "done"
            : "review"
          : null;
  const issue = next ? moveIssue(task, next) : "";
  const action =
    next === "done"
      ? status === "review"
        ? "Approva risultato"
        : "Segna completato"
      : next === "doing"
        ? "Inizia lavoro"
        : "Porta in revisione";
  return (
    <section className="st-task-overview">
      <div className="st-task-summary-meta">
        <span>{name(task.person)}</span>
        <span>{workStates[status]}</span>
        <span>{workDate(task.due)}</span>
      </div>
      {task.supervisor && (
        <p className="st-muted">
          Supervisione: {name(task.supervisor)} · Approvazione finale:{" "}
          {name(task.approver || "user:fabio")}
        </p>
      )}
      <h3>
        {status === "blocked"
          ? "Cosa serve per proseguire"
          : status === "review"
            ? "Risultato da verificare"
            : status === "done"
              ? "Lavoro completato"
              : "Prossimo passo"}
      </h3>
      {waiting.length ? (
        waiting.map((s) => (
          <p key={s.id}>
            {name(s.blocker!)} · {s.reason || s.title}
          </p>
        ))
      ) : (
        <p>
          {status === "review"
            ? "Verifica il risultato. Approva oppure richiedi una modifica."
            : status === "done"
              ? "Risultato e cronologia restano disponibili nei dettagli."
              : task.steps?.find((s) => !s.done)?.title ||
                (task.training?.mode === "stage" &&
                !task.steps?.some((s) => s.id !== "input" && s.id !== "pipeline-gate")
                  ? "Concorda i passaggi con il collaboratore prima di iniziare."
                  : "Il responsabile può procedere con il lavoro affidato.")}
        </p>
      )}
      {!task.person.startsWith("user:") && (
        <p className="st-muted">
          Limite remoto:{" "}
          {task.costLimit === undefined
            ? "da concordare"
            : task.costLimit.toLocaleString("it-IT", { style: "currency", currency: "EUR" })}{" "}
          ·{" "}
          {task.demoCost === undefined
            ? "consumo reale non disponibile"
            : "consumo simulato: " +
              task.demoCost.toLocaleString("it-IT", { style: "currency", currency: "EUR" })}
        </p>
      )}
      {task.successCriteria && (
        <div className="st-soft-note">
          <strong>Risultato atteso</strong>
          <p>{task.successCriteria}</p>
        </div>
      )}
      {task.training && (
        <p className="st-muted">
          {task.training.mode === "stage"
            ? "In stage"
            : task.training.mode === "review"
              ? "Supervisione sul risultato"
              : "Autonomia delimitata"}{" "}
          · {task.training.activity} · {task.training.scope}
        </p>
      )}
      {(!!task.files?.length ||
        !!task.materialReferences?.length ||
        !!task.materialLinks?.length) && (
        <details className="st-result">
          <summary>
            Materiali e riferimenti ·{" "}
            {(task.files?.length || 0) +
              (task.materialReferences?.length || 0) +
              (task.materialLinks?.length || 0)}
          </summary>
          <StudioLinkedMaterials owner={task.person} links={task.materialLinks || []} />
          <StudioArtifactPreview files={task.files || []} label="Materiale" />
          {task.materialReferences?.map((r, i) => (
            <p key={i}>
              {r} <small>· accesso da verificare</small>
            </p>
          ))}
        </details>
      )}
      {task.result && (
        <details open={status === "review"} className="st-result">
          <summary>Risultato</summary>
          <p className="st-overview-result">{task.result}</p>
        </details>
      )}
      <StudioArtifactPreview files={task.resultFiles || []} label="Consegna" />
      {issue && <p className="st-muted">{issue}</p>}
      <div className="st-conversation-actions">
        {next && !issue && (
          <button
            className="st-btn dark"
            onClick={() =>
              onChange({
                ...task,
                status: next,
                notes: [
                  ...(task.notes || []),
                  next === "done"
                    ? "Fabio · risultato accettato. Autonomia invariata."
                    : "Fabio · avanzamento confermato",
                ],
              })
            }
          >
            {action}
          </button>
        )}
        {status === "review" && (!task.approver || task.approver === "user:fabio") && (
          <button className="st-btn" onClick={() => setRevising(true)}>
            Richiedi modifiche
          </button>
        )}
        <button
          className={"st-btn " + (issue || status === "blocked" ? "dark" : "")}
          onClick={onDetails}
        >
          {status === "blocked" ? "Gestisci attesa" : "Apri dettagli e conversazione"}
        </button>
        <button className="st-text-link" onClick={() => onPerson(task.person, task.id)}>
          Parla con {name(task.person)}
        </button>
      </div>
      {revising && (
        <form
          className="st-review-feedback"
          onSubmit={(e) => {
            e.preventDefault();
            if (!feedback.trim()) return;
            onChange({
              ...task,
              status: "doing",
              notes: [...(task.notes || []), "Fabio · revisione richiesta: " + feedback.trim()],
            });
            setRevising(false);
            setFeedback("");
          }}
        >
          <label>
            Cosa va corretto?
            <textarea
              autoFocus
              required
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Indica cosa non rispetta il risultato atteso e come verificarlo."
            />
          </label>
          <button className="st-btn dark" disabled={!feedback.trim()}>
            Invia correzione
          </button>{" "}
          <button className="st-btn" type="button" onClick={() => setRevising(false)}>
            Annulla
          </button>
          <p className="st-muted">
            Il feedback resta nel compito. Non modifica automaticamente formazione o permessi.
          </p>
        </form>
      )}
      {!!task.notes?.some((n) => n.includes("revisione richiesta:")) && (
        <details className="st-result">
          <summary>Correzioni richieste</summary>
          {task.notes
            .filter((n) => n.includes("revisione richiesta:"))
            .map((n, i) => (
              <p key={i}>{n}</p>
            ))}
        </details>
      )}
      <details className="st-result">
        <summary>
          Metodo · {task.steps?.filter((s) => s.done).length || 0}/{task.steps?.length || 0}{" "}
          passaggi
        </summary>
        {task.steps?.map((s) => (
          <p key={s.id}>
            {s.done ? "✓" : "○"} {s.title}
          </p>
        ))}
        {!task.steps?.length && (
          <p>
            {task.training?.mode === "stage"
              ? "Definisci i passaggi da verificare durante lo stage."
              : "Nessun metodo obbligatorio. Puoi aggiungere passaggi nei dettagli se servono."}
          </p>
        )}
      </details>
      <p className="st-muted">
        Prototipo locale · le azioni aggiornano il lavoro nella demo, senza esecuzioni esterne.
      </p>
    </section>
  );
}
