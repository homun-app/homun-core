import type { AssignedWork } from "./StudioToday";
import { workDate } from "../../lib/studio-work";
export function StudioAssistedTask({
  task,
  tasks,
  people,
  onUpdate,
  onDetails,
}: {
  task: AssignedWork;
  tasks: AssignedWork[];
  people: { id: string; name: string }[];
  onUpdate: (tasks: AssignedWork[]) => void;
  onDetails: () => void;
}) {
  const issue = task.assistedIssue;
  const setIssue = (value: boolean) =>
    onUpdate(
      tasks.map((t) =>
        t.id === task.id
          ? { ...t, assistedIssue: value ? "Il materiale richiesto non è disponibile." : "" }
          : t,
      ),
    );
  const request = tasks.find((t) => t.requestFor === task.id + ":material");
  const name = (id: string) => people.find((p) => p.id === id)?.name || "Collaboratore";
  function draft(file?: File) {
    const result =
      "BOZZA DIMOSTRATIVA — " +
      task.title +
      "\n\nRichiesta: " +
      (task.brief || task.title) +
      "\n" +
      (file ? "Materiale ricevuto: " + file.name + "\n" : "") +
      "\nDa completare: dettagli della prestazione, importi, condizioni e validità. Il file non è stato analizzato. Nessun preventivo reale è stato generato.";
    onUpdate([
      ...tasks.map((t) =>
        t.id === task.id
          ? {
              ...t,
              status: "review" as const,
              assistedIssue: "",
              result,
              files: file ? [...(t.files || []), file] : t.files || [],
              steps: t.steps?.map((s) => ({ ...s, done: true, blocker: "", reason: "" })) || [],
              notes: [
                ...(t.notes || []),
                file
                  ? "Risposta ricevuta e materiale collegato. Bozza dimostrativa pronta."
                  : "Bozza dimostrativa pronta.",
              ],
            }
          : t.id === request?.id
            ? {
                ...t,
                status: "done" as const,
                resultFiles: file ? [file] : [],
                result: "Materiale consegnato nella simulazione.",
              }
            : t,
      ),
    ]);
  }
  return (
    <section className="st-assisted-summary">
      <p className="st-muted">
        {name(task.person)} · {workDate(task.due)}
      </p>
      <h3>
        {task.status === "done"
          ? "Risultato approvato"
          : task.status === "review"
            ? "Pronto per la tua verifica"
            : issue
              ? "Serve una decisione"
              : request?.status !== "done" && request
                ? "La squadra sta aspettando il materiale"
                : "Il lavoro è affidato"}
      </h3>
      {task.status === "done" ? (
        <p>Hai approvato la bozza della simulazione. Nessun documento è stato inviato.</p>
      ) : task.status === "review" ? (
        <>
          <p>
            {name(task.person)} ha preparato una bozza dimostrativa. Controlla il risultato prima di
            approvarlo.
          </p>
          <pre className="st-assisted-result">{task.result}</pre>
          <div className="st-conversation-actions">
            <button
              className="st-btn dark"
              onClick={() =>
                onUpdate(tasks.map((t) => (t.id === task.id ? { ...t, status: "done" } : t)))
              }
            >
              Approva bozza demo
            </button>
            <button
              className="st-btn"
              onClick={() => {
                onUpdate(tasks.map((t) => (t.id === task.id ? { ...t, status: "doing" } : t)));
              }}
            >
              Richiedi una revisione
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            {request?.status !== "done" && request
              ? `La richiesta è già negli incarichi di ${name(request.person)}. Alla consegna, ${name(task.person)} può continuare senza un tuo sblocco manuale.`
              : `${name(task.person)} prepara il risultato. Ti chiederà di verificarlo quando sarà pronto.`}
          </p>
          {issue ? (
            <div className="st-soft-note">
              Simulazione: il materiale non è disponibile. Il lavoro resta in attesa. Puoi
              modificare la richiesta nei dettagli o riprendere la prova.
              <button className="st-btn" onClick={() => setIssue(false)}>
                Riprendi prova
              </button>
            </div>
          ) : null}
          <details className="st-result">
            <summary>Prova il seguito · simulazione</summary>
            <p className="st-muted">
              Questi controlli rappresentano eventi esterni nella demo. Non sono passaggi richiesti
              al titolare nel prodotto.
            </p>
            {request && request.status !== "done" ? (
              <>
                <label className="st-btn">
                  {name(request.person)} risponde con un file
                  <input
                    type="file"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        draft(file);
                      }
                      e.target.value = "";
                    }}
                  />
                </label>
                <button className="st-text-link" onClick={() => setIssue(true)}>
                  Simula materiale non disponibile
                </button>
              </>
            ) : (
              <button className="st-btn" onClick={() => draft()}>
                Simula risultato pronto
              </button>
            )}
          </details>
        </>
      )}
      <details className="st-result">
        <summary>Metodo e attività</summary>
        <ol>
          <li>
            {request
              ? "Chiedere il materiale a " + name(request.person)
              : "Raccogliere il contesto del lavoro"}
          </li>
          <li>Preparare una bozza</li>
          <li>Chiedere la verifica a Fabio</li>
        </ol>
        {task.notes?.map((n, i) => (
          <p className="st-muted" key={i}>
            {n}
          </p>
        ))}
      </details>
      <button className="st-text-link" onClick={onDetails}>
        Apri tutti i dettagli del compito →
      </button>
    </section>
  );
}
