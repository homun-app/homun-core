import type { Work } from "./conversation-types";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { EngineMaterialRead } from "./EngineMaterialRead";
import { EngineAgentRun } from "./EngineAgentRun";
import { EngineSynthesis } from "./EngineSynthesis";
import { EnginePriceComparison } from "./EnginePriceComparison";
import { EngineArtifactReview } from "./EngineArtifactReview";
import { EngineWorkNeedsCard } from "./EngineWorkNeedsCard";
import { PLACEHOLDER_WORK_TITLE } from "@/lib/engine-intake-display";
import "./engine-work-intake.css";

export function EngineWorkIntake({
  work,
  intake,
  onChanged,
}: {
  work: Work;
  intake: WorkIntakeState;
  onChanged: () => Promise<void>;
}) {
  const p = intake.proposal;
  if (!intake.loaded)
    return (
      <p className="cw-hint" role="status">
        Recupero della proposta…
      </p>
    );
  if (intake.error && !p) return <HomunErrorNotice error={intake.error} />;
  if (!p) {
    if (work.title === PLACEHOLDER_WORK_TITLE) {
      if (work.engineIntakePending || intake.busy) {
        return (
          <section className="cw-intake-card" aria-label="Elaborazione proposta">
            <p className="cw-hint" role="status">
              Homun sta preparando la proposta di lavoro…
            </p>
          </section>
        );
      }
      return null;
    }
    return work.engineStatus === "review" && work.engineLatestArtifact ? (
      <EngineArtifactReview work={work} onChanged={onChanged} />
    ) : (
      <EnginePriceComparison work={work} onChanged={onChanged} />
    );
  }
  const confirmed = p.status === "confirmed";
  const failed = p.status === "failed";

  if (!confirmed) {
    if (failed) {
      return (
        <section className="cw-intake-card cw-intake-card--failed" aria-label="Proposta da riprendere">
          <div className="cw-intake-eyebrow">DA RIPRENDERE</div>
          <h3>
            {p.error_code === "intake_interrupted"
              ? "La proposta è da completare"
              : p.error_code === "budget_exhausted"
                ? "Il budget del lavoro è esaurito"
                : "Riprendiamo la tua richiesta"}
          </h3>
          {p.error_code === "budget_exhausted" ? (
            <p>
              Questo lavoro ha esaurito il budget di chiamate al modello concordato col motore.
              Nulla è stato eseguito. Il budget si alza solo con un comando esplicito
              (work.set_budget), mai automaticamente.
            </p>
          ) : (
            <p>
              La richiesta è conservata e il lavoro non è stato affidato. Se la preparazione si è
              interrotta, puoi riprovare; se il modello non risponde, controlla le impostazioni dei
              modelli.
            </p>
          )}
          <button
            className="cw-secondary"
            disabled={intake.busy}
            onClick={() =>
              void intake.refine("Riprova la proposta con le informazioni già fornite.")
            }
          >
            Riprova la proposta
          </button>
          <HomunErrorNotice error={intake.error} />
        </section>
      );
    }
    return (
      <aside className="cw-intake-chat-notice" aria-label="Proposta di lavoro pronta">
        <div className="cw-intake-chat-notice__badge">PROPOSTA DI LAVORO</div>
        <p className="cw-intake-chat-notice__title">
          Ho predisposto la proposta per <strong>{p.title}</strong>
          {(p.plan_steps?.length ?? 0) > 0 && ` con ${p.plan_steps!.length} fasi operative`}.
        </p>
        <p className="cw-intake-chat-notice__hint">
          Trovi la scheda completa dell'accordo e i passaggi nel pannello a destra: confermala per iniziare, oppure chiedimi qui se vuoi apportare modifiche.
        </p>
        {intake.busy && <p className="cw-intake-note" role="status">Sto aggiornando la proposta…</p>}
        <HomunErrorNotice error={intake.error} />
      </aside>
    );
  }

  return (
    <>
      {work.engineStatus === "draft" && p.capability === "general" && p.missing_information.length > 0 && (
        <EngineWorkNeedsCard work={work} items={p.missing_information} onChanged={onChanged} />
      )}
      {work.engineStatus === "review" && work.engineLatestArtifact
        && ["general", "agent_run"].includes(lastSucceededCapability(work) ?? "") && (
        <EngineArtifactReview variant="inline" work={work} onChanged={onChanged} />
      )}
      <PhaseTool work={work} onChanged={onChanged} />
      {p.capability === "compare_csv" && (
        <EnginePriceComparison initiallyOpen work={work} onChanged={onChanged} />
      )}
      {p.capability === "read_material" && (
        <EngineMaterialRead initiallyOpen work={work} onChanged={onChanged} />
      )}
      {p.capability === "agent_run" && !work.enginePlan?.length && (
        <EngineAgentRun work={work} onChanged={onChanged} />
      )}
      {p.capability === "synthesize" && (
        <EngineSynthesis initiallyOpen work={work} onChanged={onChanged} />
      )}
      <HomunErrorNotice error={intake.error} />
    </>
  );
}

/** Capability of the phase that produced the current artifact: its review owner. */
function lastSucceededCapability(work: Parameters<typeof EngineWorkIntake>[0]["work"]): string | null {
  const succeeded = work.enginePlan?.filter((step) => step.status === "succeeded") ?? [];
  return succeeded.length ? succeeded[succeeded.length - 1]!.capability : null;
}

/** Capability of the phase in play: the running one, else the first waiting. */
function currentPhaseCapability(work: Parameters<typeof EngineWorkIntake>[0]["work"]): string {
  const steps = work.enginePlan;
  if (work.engineStatus === "ready" && work.engineRevisionRequested && lastSucceededCapability(work) === "agent_run") return "agent_run";
  if (!steps?.length) return "general";
  const running = steps.find((step) => step.status === "running");
  const current = running ?? steps.find((step) => step.status === "pending");
  return current?.capability ?? (work.engineStatus === "ready" && lastSucceededCapability(work) === "agent_run" ? "agent_run" : "general");
}

/** The dedicated tool flow drives its phase: comparison or authorized read. */
function PhaseTool({ work, onChanged }: {
  work: Parameters<typeof EngineWorkIntake>[0]["work"];
  onChanged: () => Promise<void>;
}) {
  const capability = currentPhaseCapability(work);
  if (capability === "compare_csv")
    return <EnginePriceComparison work={work} onChanged={onChanged} />;
  if (capability === "read_material")
    return <EngineMaterialRead work={work} onChanged={onChanged} />;
  if (capability === "agent_run")
    return <EngineAgentRun work={work} onChanged={onChanged} />;
  if (capability === "synthesize")
    return <EngineSynthesis work={work} onChanged={onChanged} />;
  return null;
}
