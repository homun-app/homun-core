/** Compact, source-explicit summary of an engine-backed work. */
import { useState, type ReactNode } from "react";
import type { Work } from "./conversation-types";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import { EngineWorkObjectiveEditor } from "./EngineWorkObjectiveEditor";
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
      />
      <FinalDeliverySection work={work} busy={busy} onSubmitArtifact={onSubmitArtifact} />
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
}: {
  work: Work;
  agentNames?: Record<string, string> | undefined;
  busy: boolean;
  materialsCount: number;
  onStartWork?: (() => Promise<void>) | undefined;
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
