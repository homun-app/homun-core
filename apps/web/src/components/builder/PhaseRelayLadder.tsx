import { useState } from "react";
import type { Work } from "./conversation-types";
import { defaultLocalActor } from "@/lib/engine-domain-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { Check, ArrowRight, Clock, AlertCircle, Play, FileText, FileSpreadsheet, Bot, User, Layers } from "lucide-react";

const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "In attesa",
  running: "In esecuzione",
  waiting_input: "Richiede il tuo via libera",
  waiting_approval: "Da approvare",
  succeeded: "Completata",
  failed: "Non riuscita",
  cancelled: "Annullata",
  superseded: "Sostituita",
};

function capabilityMeta(cap: string) {
  switch (cap) {
    case "compare_csv":
      return { label: "Confronto CSV", icon: FileSpreadsheet, color: "#166534" };
    case "read_material":
      return { label: "Lettura Vault", icon: FileText, color: "#1e40af" };
    case "synthesize":
      return { label: "Sintesi Documento", icon: Layers, color: "#854d0e" };
    case "agent_run":
      return { label: "Esecuzione Agente", icon: Bot, color: "#6b21a8" };
    default:
      return { label: "Passaggio Umano", icon: User, color: "#374151" };
  }
}

/** The accepted plan as a collaborative relay of agents and capabilities. */
export function PhaseRelayLadder({
  work,
  agentNames,
  busy,
  materialsCount,
  onStartWork,
  onRevisePlan,
  agents,
}: {
  work: Work;
  agentNames?: Record<string, string> | undefined;
  busy: boolean;
  materialsCount: number;
  onStartWork?: (() => Promise<void>) | undefined;
  onRevisePlan?: ((action: {
    insertAfterStepId?: string | null;
    newStep?: { title: string; assigneeId: string; capability?: string; outputExpected?: string };
    removeStepId?: string;
  }) => Promise<void>) | undefined;
  agents: Array<{ id: string; name: string; status: string }>;
}) {
  const steps = work.enginePlan;
  if (!steps?.length) return null;

  const firstPending = steps.find((step) => step.status === "pending");
  const completedCount = steps.filter((s) => s.status === "succeeded").length;
  const startable =
    !!onStartWork &&
    work.engineStatus === "ready" &&
    !!firstPending &&
    (firstPending.capability !== "compare_csv" || materialsCount >= 2) &&
    (firstPending.capability !== "read_material" || materialsCount >= 1);

  return (
    <section className="cw-engine-summary__phases" aria-label="Staffetta operativa del lavoro">
      <div className="cw-engine-summary__section-heading">
        <h3>Staffetta del lavoro</h3>
        <span className="cw-intake-note">
          {completedCount} di {steps.length} completati
        </span>
      </div>

      <ol className="cw-relay-ladder">
        {steps.map((step, index) => {
          const isCurrent = step.status === "running" || (step === firstPending && work.engineStatus === "ready");
          const isDone = step.status === "succeeded";
          const isWaitingAuth = step.status === "waiting_approval" || step.status === "waiting_input";
          const meta = capabilityMeta(step.capability);
          const Icon = meta.icon;
          const assigneeName = agentNames?.[step.assignee_id] ?? (step.assignee_id === defaultLocalActor().id ? (step.capability === "general" ? "Tu" : "Homun") : "Collaboratore");
          const nextStep = steps[index + 1];

          return (
            <li key={step.id} className={`cw-relay-step cw-relay-step--${step.status} ${isCurrent ? "cw-relay-step--active" : ""}`}>
              <div className="cw-relay-step__header">
                <span className={`cw-relay-step__badge ${isDone ? "is-done" : isCurrent ? "is-active" : ""}`}>
                  {isDone ? <Check size={12} strokeWidth={3} /> : index + 1}
                </span>
                <span className="cw-relay-step__title">{step.title}</span>
                <span className={`cw-relay-step__status-pill status-${step.status}`}>
                  {STEP_STATUS_LABELS[step.status] ?? step.status}
                </span>
              </div>

              <div className="cw-relay-step__details">
                <div className="cw-relay-step__assignee">
                  <span className="cw-relay-step__agent-pill">
                    <Icon size={12} />
                    <strong>{assigneeName}</strong>
                    <small>· {meta.label}</small>
                  </span>
                </div>

                {step.output_expected && (
                  <div className="cw-relay-step__output">
                    <span className="cw-relay-step__output-label">
                      {isDone ? "Consegnato:" : "Output previsto:"}
                    </span>
                    <span>{step.output_expected}</span>
                  </div>
                )}
              </div>

              {nextStep && isDone && (
                <div className="cw-relay-handoff">
                  <ArrowRight size={12} />
                  <span>Passaggio di consegne a <strong>{agentNames?.[nextStep.assignee_id] ?? "prossimo bot"}</strong></span>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {startable && firstPending ? (
        <div className="cs-actions cw-relay-start-action">
          <button
            className="cw-primary"
            disabled={busy}
            onClick={() => void onStartWork!()}
          >
            <Play size={13} />
            Autorizza ed esegui: {firstPending.title}
          </button>
          <p className="cw-engine-summary__hint">
            Nessuna esecuzione senza il tuo via: il passaggio parte sotto la tua supervisione.
          </p>
        </div>
      ) : (
        work.engineStatus === "ready" &&
        firstPending && (
          <p className="cw-engine-summary__hint">
            {firstPending.capability === "compare_csv"
              ? `Servono due CSV nel progetto per la fase «${firstPending.title}»: ora ne hai ${materialsCount}.`
              : firstPending.capability === "read_material"
                ? `Serve almeno un materiale nel progetto per la fase «${firstPending.title}»: ora ne hai ${materialsCount}.`
                : `La fase «${firstPending.title}» parte con il tuo via: chiedi un contributo o avvia dalla chat.`}
          </p>
        )
      )}

      <PhaseReviseControls
        work={work}
        busy={busy}
        steps={steps}
        agents={agents}
        onRevisePlan={onRevisePlan}
      />
    </section>
  );
}

/** Add or remove pending phases; succeeded phases are history and stay. */
function PhaseReviseControls({
  work,
  busy,
  steps,
  agents,
  onRevisePlan,
}: {
  work: Work;
  busy: boolean;
  steps: NonNullable<Work["enginePlan"]>;
  agents: Array<{ id: string; name: string; status: string }>;
  onRevisePlan?: ((action: {
    insertAfterStepId?: string | null;
    newStep?: { title: string; assigneeId: string; capability?: string; outputExpected?: string };
    removeStepId?: string;
  }) => Promise<void>) | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [capability, setCapability] = useState("general");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!onRevisePlan) return null;
  const revisable = ["draft", "ready", "running", "review", "paused"].includes(work.engineStatus ?? "");
  if (!revisable) return null;
  const pendingSteps = steps.filter((step) => step.status === "pending");
  const activeAgents = agents.filter((agent) => agent.status === "active");

  type ReviseAction = {
    insertAfterStepId?: string | null;
    newStep?: { title: string; assigneeId: string; capability?: string; outputExpected?: string };
    removeStepId?: string;
  };
  async function run(action: ReviseAction) {
    if (saving || !onRevisePlan) return;
    setSaving(true);
    setError(null);
    try {
      await onRevisePlan(action);
      setTitle("");
      setAssigneeId("");
      setCapability("general");
      setAdding(false);
      setRemovingId(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cw-engine-summary__revise" aria-label="Modifica fasi">
      {removingId ? (
        <div className="cs-actions">
          <button type="button" className="cw-secondary" disabled={saving}
            onClick={() => void run({ removeStepId: removingId })}>
            {saving ? "Sto rimuovendo…" : "Sì, rimuovi la fase"}
          </button>
          <button type="button" className="cs-link" disabled={saving} onClick={() => setRemovingId(null)}>
            Annulla
          </button>
        </div>
      ) : adding ? (
        <form
          className="cw-phase-add"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && assigneeId) {
              void run({
                insertAfterStepId: steps[steps.length - 1]?.id ?? null,
                newStep: { title: title.trim(), assigneeId, capability },
              });
            }
          }}
        >
          <label>
            Nuova fase
            <input value={title} maxLength={120} disabled={saving}
              onChange={(event) => setTitle(event.target.value)} placeholder="Es. Rileggere la sintesi" />
          </label>
          <div className="cw-agent-editor__row">
            <label>
              Chi la esegue
              <select aria-label="Assegnatario della nuova fase" value={assigneeId} disabled={saving}
                onChange={(event) => setAssigneeId(event.target.value)}>
                <option value="">Scegli…</option>
                {activeAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
            <label>
              Capacità
              <select aria-label="Capacità della nuova fase" value={capability} disabled={saving}
                onChange={(event) => setCapability(event.target.value)}>
                <option value="general">Generale / Umano</option>
                <option value="agent_run">Esecuzione Agente</option>
                <option value="compare_csv">Confronto CSV</option>
                <option value="read_material">Lettura materiale</option>
                <option value="synthesize">Sintesi</option>
              </select>
            </label>
          </div>
          <div className="cs-actions">
            <button className="cw-primary" disabled={saving || !title.trim() || !assigneeId}>
              {saving ? "Aggiunta…" : "Aggiungi al piano"}
            </button>
            <button type="button" className="cw-secondary" disabled={saving} onClick={() => setAdding(false)}>
              Annulla
            </button>
          </div>
        </form>
      ) : (
        <div className="cw-engine-summary__revise-links">
          {pendingSteps.length > 0 && (
            <details>
              <summary>Rimuovi una fase in attesa…</summary>
              <ul>
                {pendingSteps.map((step) => (
                  <li key={step.id}>
                    <span>{step.title}</span>
                    <button type="button" className="cs-link" disabled={saving || busy} onClick={() => setRemovingId(step.id)}>
                      Rimuovi
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button type="button" className="cs-link" disabled={busy || saving} onClick={() => setAdding(true)}>
            + Aggiungi una fase
          </button>
        </div>
      )}
      <HomunErrorNotice error={error} />
    </div>
  );
}
