import type { MaterialLink } from "../../lib/studio-material-context";
import { StudioQuickWork } from "./StudioQuickWork";
import type { ConversationMessage } from "../../lib/studio-conversations";
import { summarizeCosts } from "../../lib/studio-costs";
import type { Rule, Simulation } from "../../lib/studio-simulation";
import { workStates, statusOf, workDate } from "../../lib/studio-work";
import { StudioWorkForm } from "./StudioWorkForm";
import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
export type TodayProject = {
  id: string;
  name: string;
  goal: string;
  members: string[];
  documentMembers?: string[];
};
export type AssignedWork = {
  id: string;
  needsMaterials?: boolean;
  assisted?: boolean;
  assistedIssue?: string;
  brief?: string;
  training?: { activity: string; scope: string; mode: "stage" | "review" | "autonomous" };
  successCriteria?: string;
  materialReferences?: string[];
  materialLinks?: MaterialLink[];
  messages?: ConversationMessage[];
  participants?: string[];
  approver?: string;
  supervisor?: string;
  resultFiles?: File[];
  sourceMessage?: { person: string; id: string };
  deliveries?: { taskId: string; title: string; files: File[]; acceptedAt: string }[];
  demoCost?: number;
  costLimit?: number;
  costPolicy?: "pause" | "ask";
  procedureId?: string;
  runId?: string;
  dependsOn?: string;
  title: string;
  person: string;
  project: string;
  rule?: Rule;
  simulation?: Simulation;
  requestFor?: string;
  files?: File[];
  notes?: string[];
  result?: string;
  due?: string;
  start?: string;
  status?: "todo" | "doing" | "blocked" | "review" | "done";
  steps?: { id: string; title: string; done: boolean; blocker?: string; reason?: string }[];
};
export type OpsStage = "waiting" | "context" | "ready";
type Person = { id: string; name: string; role: string; budget: string };
const eur = (n: number) => n.toLocaleString("it-IT", { style: "currency", currency: "EUR" });
export function StudioToday({
  people,
  projects,
  tasks,
  onPerson,
  onCreatePerson,
  onProject,
  onAssign,
  onAssignBatch,
  onMarta,
  onTask,
}: {
  people: Person[];
  projects: TodayProject[];
  tasks: AssignedWork[];
  stage: OpsStage;
  approved: string[];
  onJob: (id: string) => void;
  onCreatePerson: () => void;
  onPerson: (id: string) => void;
  onProject: (id: string) => void;
  onAssign: (task: AssignedWork) => void;
  onAssignBatch: (tasks: AssignedWork[]) => void;
  onMarta: () => void;
  onTask: (id: string) => void;
}) {
  const costs = summarizeCosts(tasks);
  const [quick, setQuick] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const today = new Date().toLocaleDateString("sv-SE");
  const attention = tasks.filter(
    (t) =>
      statusOf(t) !== "done" &&
      (!!t.assistedIssue ||
        (t.person === "user:fabio" && !!t.requestFor) ||
        (statusOf(t) === "review" && (!t.approver || t.approver === "user:fabio")) ||
        (t.due && t.due.slice(0, 10) <= today) ||
        t.steps?.some((s) => !s.done && s.blocker === "user:fabio")),
  );
  const active = tasks.filter((t) => statusOf(t) === "doing" && !attention.includes(t));
  const waiting = tasks.filter(
    (t) => (statusOf(t) === "blocked" || statusOf(t) === "review") && !attention.includes(t),
  );
  const planned = tasks.filter((t) => statusOf(t) === "todo" && !attention.includes(t));
  const finished = tasks.filter((t) => statusOf(t) === "done");
  const owner = (t: AssignedWork) => people.find((p) => p.id === t.person)?.name || "Da assegnare";
  function row(t: AssignedWork) {
    const waiting = t.steps?.find((s) => !s.done && s.blocker);
    return (
      <button className="st-recent st-overview-task" key={t.id} onClick={() => onTask(t.id)}>
        <span>
          <strong>{t.title}</strong>
          <small>
            {owner(t)} · {workStates[statusOf(t)]} · {workDate(t.due)}
          </small>
          {t.assistedIssue ? (
            <small>Serve una decisione: {t.assistedIssue}</small>
          ) : waiting ? (
            <small>
              Aspetta{" "}
              {people.find((p) => p.id === waiting.blocker?.replace(/^bot:/, ""))?.name ||
                "un collaboratore"}
              : {waiting.reason || waiting.title}
            </small>
          ) : statusOf(t) === "review" ? (
            <small>
              Approvazione richiesta a{" "}
              {people.find((p) => p.id === (t.approver || "user:fabio"))?.name || "responsabile"}
            </small>
          ) : statusOf(t) === "done" ? (
            <small>Apri il risultato</small>
          ) : (
            <small>{t.steps?.find((s) => !s.done)?.title || "Apri il lavoro"}</small>
          )}
        </span>
        <ArrowRight size={16} />
      </button>
    );
  }
  return (
    <>
      <div className="st-today-header">
        <div>
          <span className="st-eyebrow">IL TUO SPAZIO DI LAVORO</span>
          <h1>Oggi</h1>
          <p>
            {attention.length
              ? `${attention.length} ${attention.length === 1 ? "incarico richiede" : "incarichi richiedono"} attenzione.`
              : "Nessun intervento richiesto."}{" "}
            {tasks.filter((t) => statusOf(t) !== "done").length}{" "}
            {tasks.filter((t) => statusOf(t) !== "done").length === 1
              ? "lavoro aperto"
              : "lavori aperti"}
            .
          </p>
        </div>
        <button className="st-btn dark" onClick={() => setQuick(!quick)}>
          <Plus size={16} />
          Affida un risultato
        </button>
      </div>
      {quick && (
        <StudioQuickWork
          projects={projects}
          people={people}
          onClose={() => setQuick(false)}
          onSave={(items) => {
            onAssignBatch(items);
            setQuick(false);
            onTask(items[0]!.id);
          }}
        />
      )}
      {assigning && (
        <StudioWorkForm
          people={people}
          projects={projects}
          onClose={() => setAssigning(false)}
          onSave={(t) => {
            onAssign(t);
            setAssigning(false);
            onTask(t.id);
          }}
        />
      )}
      {!tasks.length && (
        <section className="st-paper st-welcome">
          <span className="st-eyebrow">COMINCIAMO DA UN BISOGNO</span>
          <h2>Chi ti darebbe una mano?</h2>
          <p>
            Descrivi una responsabilità e crea il primo agente. Potrai affidargli un lavoro o
            iniziare assegnandolo a te stesso.
          </p>
          <button className="st-btn dark" onClick={onCreatePerson}>
            Crea un collaboratore
          </button>
          <p className="st-muted">
            Progetti, strumenti e automazioni si aggiungono quando servono.
          </p>
        </section>
      )}
      {(tasks.length > 0 || projects.length > 0) && (
        <div className="st-home-overview">
          <section className="st-paper">
            <h2>
              Richiede te <span className="st-muted">{attention.length}</span>
            </h2>
            {attention.length ? (
              attention.map(row)
            ) : (
              <p className="st-muted">Nessun blocco personale, approvazione o scadenza urgente.</p>
            )}
          </section>
          <section className="st-paper">
            <h2>
              In corso <span className="st-muted">{active.length}</span>
            </h2>
            {active.length ? (
              active.map(row)
            ) : (
              <p className="st-muted">Assegna il primo lavoro alla tua squadra.</p>
            )}
          </section>
          <section className="st-paper">
            <h2>Appena concluso</h2>
            {finished.length ? (
              finished.slice(-5).reverse().map(row)
            ) : (
              <p className="st-muted">Qui troverai i risultati degli incarichi completati.</p>
            )}
          </section>
          <section className="st-paper">
            <h2>
              In attesa di altri <span className="st-muted">{waiting.length}</span>
            </h2>
            {waiting.length ? waiting.map(row) : <p className="st-muted">Nessuna attesa.</p>}
          </section>
          {planned.length > 0 && (
            <section className="st-paper">
              <h2>Da iniziare</h2>
              {planned.map(row)}
            </section>
          )}
          <section className="st-paper">
            <h2>Progetti</h2>
            {projects.map((p) => (
              <button className="st-recent" key={p.id} onClick={() => onProject(p.id)}>
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {tasks.filter((t) => t.project === p.id && statusOf(t) !== "done").length}{" "}
                    aperti ·{" "}
                    {tasks.filter((t) => t.project === p.id && statusOf(t) === "blocked").length} in
                    attesa ·{" "}
                    {tasks.filter((t) => t.project === p.id && statusOf(t) === "done").length}{" "}
                    completati
                  </small>
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          </section>
        </div>
      )}
      {tasks.some((t) => t.person === "user:fabio" && statusOf(t) !== "done") && (
        <section className="st-paper st-deadlines">
          <h2>Assegnati a me</h2>
          {tasks.filter((t) => t.person === "user:fabio" && statusOf(t) !== "done").map(row)}
        </section>
      )}
      {tasks.length > 0 && (
        <details className="st-paper st-home-costs">
          <summary>
            Costi della squadra <strong>{eur(costs.total)}</strong>
            <span>totale rilevato · demo</span>
          </summary>
          <p className="st-muted">
            Importi dimostrativi attribuiti agli incarichi, incluse le simulazioni. {costs.unknown}{" "}
            incarichi senza consuntivo; costo locale non stimato.
          </p>
          {people
            .filter((p) => !p.id.startsWith("user:"))
            .map((p) => (
              <div className="st-cost-overview-row" key={p.id}>
                <button onClick={() => onPerson(p.id)}>{p.name}</button>
                <span>
                  {eur(summarizeCosts(tasks.filter((t) => t.person === p.id)).total)} rilevati ·{" "}
                  {summarizeCosts(tasks.filter((t) => t.person === p.id)).unknown} senza consuntivo
                </span>
                <span>
                  {Number(p.budget) > 0
                    ? `Budget proposto: ${eur(Number(p.budget))}/mese`
                    : "Budget non definito"}
                </span>
              </div>
            ))}
        </details>
      )}
      {people.some((p) => p.id === "marta") && (
        <details className="st-home-setup">
          <summary>Preparazione dello spazio</summary>
          <p>Per usare la posta con Marta, configura il collegamento nei suoi strumenti.</p>
          <button className="st-btn" onClick={onMarta}>
            Configura la posta
          </button>
        </details>
      )}
    </>
  );
}
