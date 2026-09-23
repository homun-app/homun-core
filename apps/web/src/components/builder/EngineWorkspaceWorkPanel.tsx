/** Compact, source-explicit summary of an engine-backed work. */
import { useState, type ReactNode } from "react";
import type { Work } from "./conversation-types";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import { EngineWorkObjectiveEditor } from "./EngineWorkObjectiveEditor";
import { EngineRoutineCreator } from "./EngineRoutines";
import { ExternalToolsSection } from "./ExternalToolsSection";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { engineWorkPanelMessage } from "@/lib/engine-project-projection";
import { intakeConfirmLabel } from "@/lib/engine-intake-display";
import { engineDraftStatusLabel, engineStatusLabel } from "@/lib/engine-work-status";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useProjectMaterials } from "@/hooks/useProjectMaterials";
import "./engine-work-summary.css";

export function EngineWorkspaceWorkPanel({
  work,
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
  return (
    <aside className="cw-workspace cw-engine-summary" aria-label="Riepilogo del lavoro">
      <div className="cw-panel-top">
        <span className="cw-overline">IL LAVORO, ADESSO</span>
        <span className={`cw-status ${work.phase}`}>
          {awaitingConfirmation
            ? "In attesa della tua conferma"
            : work.engineStatus === "draft"
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
          <p className="cw-engine-summary__hint">
            Dalla proposta in chat: diventa l’esito concordato quando confermi.
          </p>
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
          L'obiettivo arriva dalla proposta di lavoro in chat: Homun la sta preparando o è in attesa
          della tua conferma.
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
                {!ownerName && <span className="cw-engine-summary__hint"> coordina finché non confermi un collaboratore</span>}
              </>
            )}
          </dd>
        </div>
        {work.projectId && (
          <div>
            <dt>Progetto</dt>
            <dd>
              <button
                className="cs-link"
                onClick={() => onOpenSpace("Progetti", "", work.projectId)}
              >
                {spaceData.projects.find((project) => project.id === work.projectId)?.name ||
                  "Caricamento…"}{" "}
                ↗
              </button>
            </dd>
          </div>
        )}
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
        {awaitingConfirmation ? (
          <>
            <p>{engineWorkPanelMessage(work.engineStatus ?? "", proposal)}</p>
            <div className="cs-actions">
              <button
                className="cw-primary"
                disabled={intake.busy}
                onClick={() => void intake.confirm()}
              >
                {intakeConfirmLabel(proposal)}
              </button>
            </div>
            <p className="cw-engine-summary__hint">
              Vuoi cambiarla? Scrivi in chat cosa correggere: la proposta si aggiorna.
            </p>
            {intake.busy && <p role="status">Sto confermando la proposta…</p>}
          </>
        ) : (
          <p>{engineWorkPanelMessage(work.engineStatus ?? "", proposal)}</p>
        )}
      </section>
      <PhaseLadder
        work={work}
        agentNames={agentNames}
        busy={busy}
        materialsCount={sources.materials.length}
        onStartWork={onStartWork}
        onRevisePlan={onRevisePlan}
        agents={agents ?? []}
      />
      {work.source === "engine" && work.id && (
        <ExternalToolsSection workId={work.id} runnable={!awaitingConfirmation && work.engineStatus !== "completed" && work.engineStatus !== "cancelled" && work.engineStatus !== "review"} />
      )}
      <FinalDeliverySection work={work} busy={busy} onSubmitArtifact={onSubmitArtifact} />
      {work.engineStatus === "completed" && onCreateRoutine && (
        <EngineRoutineCreator defaultName={work.title} onCreateRoutine={onCreateRoutine} />
      )}
      <WorkDueSection work={work} busy={busy} onSetDue={onSetDue} />
      <WorkBudgetSection work={work} busy={busy} onSetBudget={onSetBudget} />
      <CloseWorkSection work={work} busy={busy} onCloseWork={onCloseWork} />
      <HomunErrorNotice error={sources.error} />
      {contributionPanel}
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

const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "In attesa",
  running: "In corso",
  waiting_input: "Tocca a te",
  waiting_approval: "Da approvare",
  succeeded: "Completata",
  failed: "Non riuscita",
  cancelled: "Annullata",
  superseded: "Sostituita",
};

/** The accepted plan as a ladder of phases with their people and statuses. */
function PhaseLadder({
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
  const startable =
    !!onStartWork &&
    work.engineStatus === "ready" &&
    !!firstPending &&
    (firstPending.capability !== "compare_csv" || materialsCount >= 2) &&
    (firstPending.capability !== "read_material" || materialsCount >= 1);
  return (
    <section className="cw-engine-summary__phases" aria-label="Fasi del lavoro">
      <h3>Fasi del lavoro</h3>
      <ol>
        {steps.map((step, index) => (
          <li key={step.id} data-status={step.status}>
            <span>
              {index + 1}. {step.title}
            </span>
            <small>
              {STEP_STATUS_LABELS[step.status] ?? step.status} ·{" "}
              {agentNames?.[step.assignee_id] ?? "Collaboratore"}
            </small>
          </li>
        ))}
      </ol>
      {startable && firstPending ? (
        <div className="cs-actions">
          <button
            className="cw-primary"
            disabled={busy}
            onClick={() => void onStartWork!()}
          >
            Avvia: {firstPending.title}
          </button>
          <p className="cw-engine-summary__hint">
            Nessuna esecuzione senza il tuo via: il passaggio parte solo adesso.
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
              Tipo
              <select aria-label="Tipo della nuova fase" value={capability} disabled={saving}
                onChange={(event) => setCapability(event.target.value)}>
                <option value="general">Passaggio umano</option>
                <option value="compare_csv">Confronto CSV</option>
                <option value="read_material">Lettura materiale</option>
                <option value="synthesize">Sintesi (modello del collaboratore)</option>
              </select>
            </label>
          </div>
          <div className="cs-actions">
            <button className="cw-secondary" disabled={saving || !title.trim() || !assigneeId}>
              {saving ? "Aggiungo…" : "Aggiungi fase"}
            </button>
            <button type="button" className="cs-link" disabled={saving} onClick={() => setAdding(false)}>
              Annulla
            </button>
          </div>
        </form>
      ) : (
        <div className="cs-actions">
          <button type="button" className="cs-link" disabled={busy || saving}
            onClick={() => setAdding(true)}>
            + Aggiungi una fase
          </button>
          {pendingSteps.length > 1 && (
            <button type="button" className="cs-link" disabled={busy || saving}
              onClick={() => setRemovingId(pendingSteps[pendingSteps.length - 1]!.id)}>
              Rimuovi l’ultima fase in attesa
            </button>
          )}
        </div>
      )}
      <p className="cw-engine-summary__hint">
        Le fasi completate restano nella storia del lavoro: non si cancellano.
      </p>
      {saving && <p role="status">Modifica fasi in corso…</p>}
      <HomunErrorNotice error={error} />
    </div>
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

function WorkTitleEditor({
  title,
  busy,
  onRename,
}: {
  title: string;
  busy: boolean;
  onRename: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!editing)
    return (
      <button
        type="button"
        className="cs-link"
        disabled={busy}
        onClick={() => {
          setDraft(title);
          setError(null);
          setEditing(true);
        }}
      >
        Rinomina
      </button>
    );
  return (
    <form
      className="cw-engine-summary__rename"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        void onRename(draft.trim())
          .then(() => setEditing(false))
          .catch(setError)
          .finally(() => setSaving(false));
      }}
    >
      <label>
        Titolo
        <input
          value={draft}
          maxLength={120}
          disabled={busy || saving}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="cs-actions">
        <button
          className="cw-primary"
          disabled={busy || saving || !draft.trim() || draft.trim() === title}
        >
          Salva titolo
        </button>
        <button
          type="button"
          className="cw-secondary"
          disabled={saving}
          onClick={() => setEditing(false)}
        >
          Annulla
        </button>
      </div>
      <HomunErrorNotice error={error} />
    </form>
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
