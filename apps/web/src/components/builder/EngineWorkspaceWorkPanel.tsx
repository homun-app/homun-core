import { EngineWorkOutputs } from "./EngineWorkOutputs";
import { EngineAskPerson } from "./EngineAskPerson";
import { EngineContributionInvitations } from "./EngineContributionInvitations";
import { EngineWorkProposalPanel } from "./EngineWorkProposalPanel";
import { WorkTitleEditor } from "./WorkTitleEditor";
import { PhaseRelayLadder } from "./PhaseRelayLadder";
/** Compact, source-explicit summary of an engine-backed work. */
import { useState, type ReactNode } from "react";
import type { Work } from "./conversation-types";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import { EngineWorkObjectiveEditor } from "./EngineWorkObjectiveEditor";
import { EngineRoutineCreator } from "./EngineRoutines";
import { ExternalToolsSection } from "./ExternalToolsSection";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { engineWorkPanelMessage } from "@/lib/engine-project-projection";
import { defaultLocalActor } from "@/lib/engine-domain-client";
import { intakeConfirmLabel } from "@/lib/engine-intake-display";
import { engineDraftStatusLabel, engineStatusLabel } from "@/lib/engine-work-status";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useProjectMaterials } from "@/hooks/useProjectMaterials";
import "./engine-work-summary.css";

export function EngineWorkspaceWorkPanel({
  work,
  onRefreshEngine,
  spaceData,
  busy,
  intake,
  contributionPanel,
  ownerName,
  onRename,
  onOpenSpace,
  onApplyObjectivePatch,
  onCloseWork,
  onStartWork,
  onSubmitArtifact,
  onCreateRoutine,
  onSetBudget,
  onSetDue,
  onRevisePlan,
  agents,
  agentNames,
}: {
  work: Work;
  onRefreshEngine?: (() => Promise<void>) | undefined;
  spaceData: SpaceData;
  busy: boolean;
  intake: WorkIntakeState;
  contributionPanel: ReactNode;
  ownerName?: string | undefined;
  onRename?: ((title: string) => Promise<void>) | undefined;
  onOpenSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  onApplyObjectivePatch?: ((objective: string) => Promise<void>) | undefined;
  onCloseWork?: (() => Promise<void>) | undefined;
  onStartWork?: (() => Promise<void>) | undefined;
  onSubmitArtifact?: ((title: string, content: string) => Promise<void>) | undefined;
  onCreateRoutine?: ((input: { name: string; cron: string }) => Promise<void>) | undefined;
  onSetBudget?: ((modelAttempts: number) => Promise<void>) | undefined;
  onSetDue?: ((dueDate: string | null) => Promise<void>) | undefined;
  onRevisePlan?: ((action: {
    insertAfterStepId?: string | null;
    newStep?: { title: string; assigneeId: string; capability?: string; outputExpected?: string };
    removeStepId?: string;
  }) => Promise<void>) | undefined;
  agents?: Array<{ id: string; name: string; status: string }> | undefined;
  agentNames?: Record<string, string> | undefined;
}) {
  const sources = useProjectMaterials(work, (material) => material.status === "active");
  const materials = { items: sources.materials.slice(0, 5), count: sources.materials.length };
  const proposal = intake.proposal;
  const awaitingConfirmation = work.engineIntakePending && proposal;

  if (awaitingConfirmation && proposal) {
    return (
      <EngineWorkProposalPanel
        work={work}
        proposal={proposal}
        intake={intake}
        busy={busy}
        onRename={onRename}
      />
    );
  }

  return (
    <aside className="cw-workspace cw-engine-summary" aria-label="Riepilogo del lavoro">
      <div className="cw-panel-top">
        <span className="cw-overline">IL LAVORO, ADESSO</span>
        <span className={`cw-status ${work.phase}`}>
          {work.engineStatus === "draft"
            ? engineDraftStatusLabel(Boolean(work.engineIntakeConfirmed))
            : engineStatusLabel(work.engineStatus)}
        </span>
      </div>
      <h2 title={work.title}>{work.title}</h2>
      {onRename && (
        <WorkTitleEditor key={`title:${work.id}`} title={work.title} busy={busy} onRename={onRename} />
      )}
      {work.engineObjectiveProposed ? (
        <section className="cw-engine-objective">
          <div className="cw-engine-summary__section-heading">
            <h3>Risultato atteso</h3>
          </div>
          <div className="cw-engine-objective__reading">
            <p>{work.engineObjective}</p>
          </div>
        </section>
      ) : (
        <EngineWorkObjectiveEditor
          key={`objective:${work.id}`}
          currentObjective={work.engineObjective || ""}
          busy={busy}
          onPreviewApply={onApplyObjectivePatch}
        />
      )}
      {!work.engineObjective && !work.engineObjectiveProposed && (
        <p className="cw-engine-summary__hint">
          L'obiettivo concordato comparirà qui una volta avviato il lavoro.
        </p>
      )}
      <dl className="cw-engine-summary__facts">
        <div>
          <dt>Responsabile</dt>
          <dd>
            {work.engineProposedAgentName ? (
              <>
                {work.engineProposedAgentName}
                <span className="cw-engine-summary__hint"> · da confermare</span>
              </>
            ) : (
              <>
                {ownerName || "Homun"}
                {!ownerName && <span className="cw-engine-summary__hint"> lavora direttamente con te</span>}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Progetto</dt>
          <dd>
            {work.projectId ? (
              <button
                className="cs-link"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#157a6e",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
                onClick={() => onOpenSpace("Progetti", "", work.projectId)}
                title="Apri nel Project Hub"
              >
                <span>{spaceData.projects.find((project) => project.id === work.projectId)?.name || "Caricamento…"}</span>
                <span style={{ fontSize: 11, color: "#8a9a86" }}>↗ Hub</span>
              </button>
            ) : (
              <button
                className="cs-link"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12,
                  color: "#8a9a86",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
                onClick={() => onOpenSpace("Progetti")}
                title="Assegna a un progetto nel Project Hub"
              >
                <span>Nessuno · Assegna a progetto ↗</span>
              </button>
            )}
          </dd>
        </div>
      </dl>
      {materials.items.length > 0 && (
        <section className="cw-engine-summary__materials">
          <h3>Materiali del lavoro</h3>
          <ul>
            {materials.items.map((material) => (
              <li key={material.id} title={material.content_hash ?? undefined}>
                {material.origin_name ?? material.title} · v{material.version}
              </li>
            ))}
          </ul>
          {materials.count > materials.items.length && (
            <p className="cw-intake-note">+{materials.count - materials.items.length} altri nel progetto</p>
          )}
        </section>
      )}
      <section className="cw-engine-summary__next">
        <h3>Prossimo passo</h3>
        <p>{engineWorkPanelMessage(work.engineStatus ?? "", proposal)}</p>
      </section>
      <PhaseRelayLadder
        work={work}
        agentNames={agentNames}
        busy={busy}
        materialsCount={sources.materials.length}
        onStartWork={onStartWork}
        onRevisePlan={onRevisePlan}
        agents={agents ?? []}
      />
      {work.source === "engine" && work.id && (
        <><EngineWorkOutputs key={work.id} workId={work.id} />
        <ExternalToolsSection workId={work.id} runnable={!awaitingConfirmation && work.engineStatus !== "completed" && work.engineStatus !== "cancelled" && work.engineStatus !== "review"} /></>
      )}
      <FinalDeliverySection work={work} busy={busy} onSubmitArtifact={onSubmitArtifact} />
      {work.engineStatus === "completed" && onCreateRoutine && (
        <EngineRoutineCreator defaultName={work.title} onCreateRoutine={onCreateRoutine} />
      )}
      {work.engineIntakeConfirmed && (
        <details className="cw-engine-summary__advanced">
          <summary>Opzioni avanzate (scadenza e budget)</summary>
          <WorkDueSection work={work} busy={busy} onSetDue={onSetDue} />
          <WorkBudgetSection work={work} busy={busy} onSetBudget={onSetBudget} />
        </details>
      )}
      <CloseWorkSection work={work} busy={busy} onCloseWork={onCloseWork} />
      <HomunErrorNotice error={sources.error} />
      {contributionPanel}
      {work.engineStatus === "running" && <EngineAskPerson work={work} onChanged={onRefreshEngine} />}
      {work.engineStatus === "waiting_input" && <EngineContributionInvitations workId={work.id} />}
    </aside>
  );
}

/** Last phase done, result not delivered yet: the person hands over the outcome. */
function FinalDeliverySection({
  work,
  busy,
  onSubmitArtifact,
}: {
  work: Work;
  busy: boolean;
  onSubmitArtifact?: ((title: string, content: string) => Promise<void>) | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const steps = work.enginePlan;
  // Deliverable when every earlier phase succeeded and what's left is the final
  // human phase (still waiting or already running): delivering is the go.
  const last = steps?.[steps.length - 1];
  const earlierDone = !!steps?.length && steps.slice(0, -1).every((step) => step.status === "succeeded");
  const finalHuman = !!last && last.capability === "general"
    && (last.status === "pending" || last.status === "running");
  const deliverable =
    !!onSubmitArtifact &&
    earlierDone &&
    finalHuman &&
    (work.engineStatus === "ready" || work.engineStatus === "running");
  if (!deliverable) return null;
  return (
    <section className="cw-engine-summary__delivery" aria-label="Consegna del risultato">
      <h3>Consegna il risultato</h3>
      <p className="cw-engine-summary__hint">
        Tutte le fasi hanno il loro esito: consegna il risultato finale per la verifica.
        Dopo l'approvazione il lavoro risulta completato.
      </p>
      <textarea
        className="cw-input"
        aria-label="Risultato finale del lavoro"
        placeholder="Incolla o scrivi qui il risultato finale (riepilogo, bozza, report)…"
        value={draft}
        maxLength={20000}
        disabled={busy || sending}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="cs-actions">
        <button
          className="cw-primary"
          disabled={busy || sending || draft.trim().length < 1}
          onClick={() => {
            setSending(true);
            setError(null);
            onSubmitArtifact!(work.title, draft.trim())
              .then(() => setDraft(""))
              .catch(setError)
              .finally(() => setSending(false));
          }}
        >
          {sending ? "Sto consegnando…" : "Consegna per la verifica"}
        </button>
      </div>
      {sending && <p role="status">Consegna in corso…</p>}
      <HomunErrorNotice error={error} />
    </section>
  );
}

/** States where the person may end an agreed work without executing it. */
const CLOSABLE_ENGINE_STATUSES = new Set(["ready", "paused", "waiting_input", "failed"]);

function CloseWorkSection({
  work,
  busy,
  onCloseWork,
}: {
  work: Work;
  busy: boolean;
  onCloseWork?: (() => Promise<void>) | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const awaitingConfirmation = work.engineIntakePending;
  const agreedDraft = work.engineStatus === "draft" && work.engineIntakeConfirmed;
  const closable =
    !awaitingConfirmation && (agreedDraft || CLOSABLE_ENGINE_STATUSES.has(work.engineStatus ?? ""));
  if (!onCloseWork || !closable) return null;
  if (!confirming)
    return (
      <section className="cw-engine-summary__close">
        <button
          type="button"
          className="cs-link"
          disabled={busy || closing}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Chiudi il lavoro
        </button>
        <p className="cw-engine-summary__hint">
          Nessuna esecuzione: l'accordo resta nello storico della conversazione.
        </p>
      </section>
    );
  return (
    <section className="cw-engine-summary__close" aria-label="Conferma chiusura del lavoro">
      <p className="cw-engine-summary__hint">
        Chiudere il lavoro senza eseguirlo? L'accordo e la conversazione restano salvati.
      </p>
      <div className="cs-actions">
        <button
          type="button"
          className="cw-secondary"
          disabled={busy || closing}
          onClick={() => {
            setClosing(true);
            setError(null);
            onCloseWork()
              .then(() => setConfirming(false))
              .catch(setError)
              .finally(() => setClosing(false));
          }}
        >
          {closing ? "Sto chiudendo…" : "Sì, chiudi"}
        </button>
        <button
          type="button"
          className="cs-link"
          disabled={closing}
          onClick={() => setConfirming(false)}
        >
          Annulla
        </button>
      </div>
      {closing && <p role="status">Chiusura in corso…</p>}
      <HomunErrorNotice error={error} />
    </section>
  );
}

/** The person's deadline for a work; overdue is said out loud. */
function WorkDueSection({
  work,
  busy,
  onSetDue,
}: {
  work: Work;
  busy: boolean;
  onSetDue?: ((dueDate: string | null) => Promise<void>) | undefined;
}) {
  const [draft, setDraft] = useState(work.engineDue ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!onSetDue) return null;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !!work.engineDue && work.engineDue < today && !["completed", "cancelled"].includes(work.engineStatus ?? "");
  const changed = draft !== (work.engineDue ?? "");
  return (
    <section className="cw-engine-summary__due" aria-label="Scadenza">
      <h3>Scadenza</h3>
      {overdue && (
        <p className="cw-hint" role="alert">
          Scaduto il {work.engineDue}: decidi se rinnovarla o chiudere il lavoro.
        </p>
      )}
      <div className="cs-actions">
        <label>
          Entro il
          <input type="date" value={draft} disabled={busy || saving}
            onChange={(event) => setDraft(event.target.value)} />
        </label>
        <button type="button" className="cw-secondary" disabled={busy || saving || !changed}
          onClick={() => {
            setSaving(true);
            setError(null);
            onSetDue(draft || null)
              .catch(setError)
              .finally(() => setSaving(false));
          }}>
          {saving ? "Sto salvando…" : draft ? "Salva scadenza" : "Togli scadenza"}
        </button>
      </div>
      {saving && <p role="status">Salvataggio in corso…</p>}
      <HomunErrorNotice error={error} />
    </section>
  );
}

/** Per-work model budget: honest counters, explicit changes only. */
function WorkBudgetSection({
  work,
  busy,
  onSetBudget,
}: {
  work: Work;
  busy: boolean;
  onSetBudget?: ((modelAttempts: number) => Promise<void>) | undefined;
  onSetDue?: ((dueDate: string | null) => Promise<void>) | undefined;
}) {
  const budget = work.engineBudget;
  const [draft, setDraft] = useState(String(budget?.caps.model_attempts ?? 40));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!budget && !onSetBudget) return null;
  const attempts = budget?.caps.model_attempts ?? 40;
  const spent = budget?.spent.attempts ?? 0;
  const parsed = Number(draft);
  const changed = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100000 && parsed !== attempts;
  return (
    <section className="cw-engine-summary__budget" aria-label="Budget del lavoro">
      <h3>Budget del lavoro</h3>
      <p className="cw-engine-summary__hint">
        Tentativi del modello usati dal lavoro: {spent} di {attempts}. Il limite si alza solo
        da qui, mai in automatico.
      </p>
      {onSetBudget && (
        <div className="cs-actions">
          <label>
            Limite tentativi
            <input
              type="number"
              min={1}
              max={100000}
              value={draft}
              disabled={busy || saving}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="cw-secondary"
            disabled={busy || saving || !changed}
            onClick={() => {
              setSaving(true);
              setError(null);
              onSetBudget(parsed)
                .catch(setError)
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "Sto salvando…" : "Aggiorna limite"}
          </button>
        </div>
      )}
      {saving && <p role="status">Aggiornamento in corso…</p>}
      <HomunErrorNotice error={error} />
    </section>
  );
}
