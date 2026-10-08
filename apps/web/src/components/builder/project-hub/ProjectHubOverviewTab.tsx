import { ArrowRight, CheckCircle2, Clock, AlertCircle, Circle } from "lucide-react";
import type { Work } from "../conversation-types";

type Props = {
  projectId: string;
  projectName: string;
  works: Work[];
  onOpenWork: (id: string) => void;
  onNewWork: () => void;
};

function WorkRow({ work, onOpen }: { work: Work; onOpen: (id: string) => void }) {
  return (
    <div className="ph-work-row" onClick={() => onOpen(work.id)}>
      <div className="ph-work-row__left">
        <span className="ph-work-row__dot" />
        <div>
          <div className="ph-work-row__title">{work.title}</div>
          {work.due && <div className="ph-work-row__meta">Scadenza: {work.due}</div>}
        </div>
      </div>
      <span className="ph-work-row__action">
        Apri <ArrowRight size={12} />
      </span>
    </div>
  );
}

function WorkGroup({
  label,
  works,
  onOpen,
  icon,
  muted,
}: {
  label: string;
  works: Work[];
  onOpen: (id: string) => void;
  icon?: React.ReactNode;
  muted?: boolean;
}) {
  if (works.length === 0) return null;
  return (
    <div className={`ph-work-group ${muted ? "ph-work-group--muted" : ""}`}>
      <div className="ph-work-group__label">
        {icon}
        {label}
        <span className="ph-work-group__count">{works.length}</span>
      </div>
      <div className="ph-work-list">
        {works.map((w) => (
          <WorkRow key={w.id} work={w} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

export function ProjectHubOverviewTab({ works, onOpenWork, onNewWork }: Props) {
  const active = works.filter((w) => !w.archived);
  const proposal = active.filter((w) => w.phase === "proposal");
  const inProgress = active.filter((w) => w.phase === "waiting" || w.phase === "ready");
  const review = active.filter((w) => w.phase === "review");
  const done = active.filter((w) => w.phase === "approved");
  const archived = works.filter((w) => w.archived);

  if (works.length === 0) {
    return (
      <div className="ph-overview-empty">
        <span>Nessun lavoro. Scrivi nel prompt qui sotto per iniziare.</span>
      </div>
    );
  }

  return (
    <div className="ph-overview">
      <WorkGroup
        label="Da fare"
        works={proposal}
        onOpen={onOpenWork}
        icon={<Circle size={11} />}
      />
      <WorkGroup
        label="In lavorazione"
        works={inProgress}
        onOpen={onOpenWork}
        icon={<Clock size={11} />}
      />
      <WorkGroup
        label="Da approvare"
        works={review}
        onOpen={onOpenWork}
        icon={<AlertCircle size={11} />}
      />
      <WorkGroup
        label="Completati"
        works={done}
        onOpen={onOpenWork}
        icon={<CheckCircle2 size={11} />}
        muted
      />
      {archived.length > 0 && (
        <WorkGroup
          label="Archiviati"
          works={archived}
          onOpen={onOpenWork}
          muted
        />
      )}
    </div>
  );
}
