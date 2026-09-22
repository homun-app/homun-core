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
      <CloseWorkSection work={work} busy={busy} onCloseWork={onCloseWork} />
      <HomunErrorNotice error={sources.error} />
      {contributionPanel}
    </aside>
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
