/** Compact, source-explicit summary of an engine-backed work. */
import { useEffect, useState, type ReactNode } from "react";
import type { Work } from "./conversation-types";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import { EngineWorkObjectiveEditor } from "./EngineWorkObjectiveEditor";
import { engineWorkPanelMessage } from "@/lib/engine-project-projection";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { listEngineMaterials, type EngineMaterial } from "@/lib/engine-projects-client";
import { resolveEngineProjectForWork } from "@/lib/engine-work-project";
import "./engine-work-summary.css";

const statusLabels: Record<string, string> = {
  draft: "Da definire",
  ready: "Pronto",
  running: "In corso",
  review: "Da rivedere",
  completed: "Completato",
  failed: "Da verificare",
  paused: "In pausa",
  cancelled: "Annullato",
  waiting_input: "In attesa del tuo contributo",
  waiting_approval: "In attesa di approvazione",
};

export function EngineWorkspaceWorkPanel({
  work,
  spaceData,
  busy,
  contributionPanel,
  ownerName,
  onRename,
  onOpenSpace,
  onApplyObjectivePatch,
}: {
  work: Work;
  spaceData: SpaceData;
  busy: boolean;
  contributionPanel: ReactNode;
  ownerName?: string | undefined;
  onRename?: ((title: string) => Promise<void>) | undefined;
  onOpenSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  onApplyObjectivePatch?: ((objective: string) => Promise<void>) | undefined;
}) {
  const materials = useWorkMaterials(work);
  return (
    <aside className="cw-workspace cw-engine-summary" aria-label="Riepilogo del lavoro">
      <div className="cw-panel-top">
        <span className="cw-overline">IL LAVORO, ADESSO</span>
        <span className={`cw-status ${work.phase}`}>
          {statusLabels[work.engineStatus ?? ""] ?? "Stato da verificare"}
        </span>
      </div>
      <h2 title={work.title}>{work.title}</h2>
      {onRename && (
        <WorkTitleEditor key={`title:${work.id}`} title={work.title} busy={busy} onRename={onRename} />
      )}
      <EngineWorkObjectiveEditor
        key={`objective:${work.id}`}
        currentObjective={work.engineObjective || ""}
        busy={busy}
        onPreviewApply={onApplyObjectivePatch}
      />
      {!work.engineObjective && (
        <p className="cw-engine-summary__hint">
          L'obiettivo arriva dalla proposta di lavoro in chat: Homun la sta preparando o è in attesa
          della tua conferma.
        </p>
      )}
      <dl className="cw-engine-summary__facts">
        <div>
          <dt>Responsabile</dt>
          <dd>
            {ownerName || "Homun"}
            {!ownerName && <span className="cw-engine-summary__hint"> coordina finché non confermi un collaboratore</span>}
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
        <p>{engineWorkPanelMessage(work.engineStatus ?? "")}</p>
      </section>
      {contributionPanel}
      <p className="cw-engine-summary__source">Fonte: motore</p>
    </aside>
  );
}

function useWorkMaterials(work: Work) {
  const [state, setState] = useState<{ items: EngineMaterial[]; count: number }>({
    items: [],
    count: 0,
  });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const projectId = await resolveEngineProjectForWork(work, work.title);
        const items = (await listEngineMaterials({ projectId })).filter(
          (material) => material.status === "active",
        );
        if (live) setState({ items: items.slice(0, 5), count: items.length });
      } catch {
        if (live) setState({ items: [], count: 0 });
      }
    })();
    return () => {
      live = false;
    };
  }, [work.id, work.projectId, work.title]);
  return state;
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
