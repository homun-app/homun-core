import type { Work } from "./conversation-types";
import { defaultLocalActor } from "@/lib/engine-domain-client";
import { Check, ArrowRight, Play, Bot, FileText, FileSpreadsheet, Layers, User } from "lucide-react";
import "./engine-plan-relay.css";

function capabilityMeta(cap: string) {
  switch (cap) {
    case "compare_csv":
      return { label: "Confronto CSV", icon: FileSpreadsheet };
    case "read_material":
      return { label: "Vault / File", icon: FileText };
    case "synthesize":
      return { label: "Sintesi Documento", icon: Layers };
    case "agent_run":
      return { label: "Esecuzione Agente", icon: Bot };
    default:
      return { label: "Passaggio Umano", icon: User };
  }
}

export function EnginePlanRelayTimeline({
  work,
  agentNames,
  busy,
  onStartWork,
}: {
  work: Work;
  agentNames?: Record<string, string> | undefined;
  busy: boolean;
  onStartWork?: (() => Promise<void>) | undefined;
}) {
  const steps = work.enginePlan;
  if (!steps?.length) return null;

  const succeededSteps = steps.filter((step) => step.status === "succeeded");
  const runningStep = steps.find((step) => step.status === "running");
  const firstPending = steps.find((step) => step.status === "pending");
  const waitingApproval = steps.find((step) => step.status === "waiting_approval" || step.status === "waiting_input");

  // Show authorization checkpoint if firstPending is ready to run or waiting approval
  const needsAuth = waitingApproval || (work.engineStatus === "ready" && firstPending && !!onStartWork);
  const authStep = waitingApproval || firstPending;

  return (
    <div className="cw-relay-timeline" id="cw-relay-timeline" aria-label="Staffetta collaborativa nel flusso">
      {/* Succeeded Phases - Visible milestones of the handoff */}
      {succeededSteps.map((step, idx) => {
        const meta = capabilityMeta(step.capability);
        const Icon = meta.icon;
        const assignee = agentNames?.[step.assignee_id] ?? (step.assignee_id === defaultLocalActor().id ? "Homun" : "Collaboratore");
        const nextStep = steps.find((s, i) => i === steps.indexOf(step) + 1);
        const nextAssignee = nextStep ? (agentNames?.[nextStep.assignee_id] ?? "collaboratore") : null;

        return (
          <div key={step.id} className="cw-relay-timeline__milestone">
            <div className="cw-relay-timeline__icon is-done">
              <Check size={13} strokeWidth={2.5} />
            </div>
            <div className="cw-relay-timeline__body">
              <div className="cw-relay-timeline__title">
                <strong>{step.title}</strong>
                <span className="cw-relay-timeline__pill">
                  <Icon size={11} /> {assignee} · {meta.label}
                </span>
              </div>
              {step.output_expected && (
                <div className="cw-relay-timeline__asset">
                  <span>Consegnato: <em>{step.output_expected}</em></span>
                </div>
              )}
              {nextStep && (
                <div className="cw-relay-timeline__handoff-arrow">
                  <ArrowRight size={11} />
                  <span>Passaggio di consegne a <strong>{nextAssignee}</strong></span>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Running Phase */}
      {runningStep && (
        <div className="cw-relay-timeline__milestone is-running">
          <div className="cw-relay-timeline__icon is-running">
            <span className="cw-relay-timeline__pulse" />
          </div>
          <div className="cw-relay-timeline__body">
            <div className="cw-relay-timeline__title">
              <strong>In corso: {runningStep.title}</strong>
              <span className="cw-relay-timeline__pill is-active">
                {agentNames?.[runningStep.assignee_id] ?? "Homun"} al lavoro
              </span>
            </div>
            {runningStep.output_expected && (
              <p className="cw-relay-timeline__hint">
                In produzione: {runningStep.output_expected}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Failed Phase Notice */}
      {steps.find((s) => s.status === "failed") && (
        <div className="cw-relay-timeline__milestone is-failed">
          <div className="cw-relay-timeline__icon is-failed">
            !
          </div>
          <div className="cw-relay-timeline__body">
            <div className="cw-relay-timeline__title">
              <strong>Interruzione: {steps.find((s) => s.status === "failed")?.title}</strong>
              <span className="cw-relay-timeline__pill is-failed">
                Richiede intervento
              </span>
            </div>
            <p className="cw-relay-timeline__hint">
              La fase ha riscontrato un errore. Puoi riavviarla o modificare il piano dal pannello laterale.
            </p>
          </div>
        </div>
      )}

      {/* Human Gatekeeper Checkpoint */}
      {needsAuth && authStep && (
        <div className="cw-relay-timeline__checkpoint" id="cw-relay-checkpoint" role="region" aria-label="Cancello di controllo umano">
          <div className="cw-relay-timeline__checkpoint-header">
            <span className="cw-relay-timeline__checkpoint-badge">SUPERVISIONE RICHIESTA</span>
            <span className="cw-relay-timeline__checkpoint-phase">Fase: {authStep.title}</span>
          </div>
          <p className="cw-relay-timeline__checkpoint-desc">
            Assegnata a <strong>{agentNames?.[authStep.assignee_id] ?? (authStep.assignee_id === defaultLocalActor().id ? "Homun" : "Collaboratore")}</strong>.
            Nessuna operazione o scrittura sul sistema verrà eseguita senza il tuo esplicito via libera.
          </p>
          {onStartWork && work.engineStatus === "ready" && (
            <button
              type="button"
              className="cw-primary cw-relay-checkpoint-btn"
              disabled={busy}
              onClick={() => void onStartWork()}
            >
              <Play size={13} />
              Autorizza ed esegui fase
            </button>
          )}
        </div>
      )}
    </div>
  );
}
