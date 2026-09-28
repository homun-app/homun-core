import { ArrowRight, CheckCircle2 } from "lucide-react";
import type { Work } from "../conversation-types";

type Props = {
  projectId: string;
  projectName: string;
  works: Work[];
  onOpenWork: (id: string) => void;
  onNewWork: () => void;
};

export function ProjectHubOverviewTab({
  works,
  onOpenWork,
  onNewWork,
}: Props) {
  const activeWorks = works.filter((w) => w.phase !== "approved" && !w.archived);
  const completedWorks = works.filter((w) => w.phase === "approved");

  return (
    <div className="ph-tab-content">
      {/* Quick Stats */}
      <div className="ph-overview-stats">
        <div className="ph-stat-metric">
          <span className="ph-stat-metric-label">In corso</span>
          <div className="ph-stat-metric-val">{activeWorks.length}</div>
        </div>
        <div className="ph-stat-metric">
          <span className="ph-stat-metric-label">Completati</span>
          <div className="ph-stat-metric-val">{completedWorks.length}</div>
        </div>
        <div className="ph-stat-metric">
          <span className="ph-stat-metric-label">Stato</span>
          <div className="ph-stat-metric-sub">
            {activeWorks.length ? "Operativo" : "In attesa"}
          </div>
        </div>
      </div>

      {/* Works list */}
      <div className="ph-card">
        <div className="ph-card-header">
          <h3 className="ph-card-title">Incarichi</h3>
          <button className="ph-btn-ghost" onClick={onNewWork}>
            + Nuovo lavoro
          </button>
        </div>

        {works.length === 0 ? (
          <div className="ph-empty">
            <p className="ph-empty-title">Nessun incarico ancora.</p>
            <button className="ph-btn-ghost" onClick={onNewWork}>
              + Avvia il primo lavoro
            </button>
          </div>
        ) : (
          <div className="ph-work-list">
            {works.map((work) => {
              const isApproved = work.phase === "approved";
              return (
                <div
                  key={work.id}
                  className="ph-work-row"
                  onClick={() => onOpenWork(work.id)}
                >
                  <div className="ph-work-row__left">
                    {isApproved ? (
                      <CheckCircle2 size={14} className="ph-work-row__icon--done" />
                    ) : (
                      <span className="ph-work-row__dot" />
                    )}
                    <div>
                      <div className="ph-work-row__title">{work.title}</div>
                      <div className="ph-work-row__meta">
                        {work.phase}{work.due ? ` · ${work.due}` : ""}
                      </div>
                    </div>
                  </div>
                  <span className="ph-work-row__action">
                    Apri <ArrowRight size={12} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
