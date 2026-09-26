import { ArrowRight, CheckCircle2, Clock, MessageSquare, Plus } from "lucide-react";
import type { Work } from "../conversation-types";

type Props = {
  projectId: string;
  projectName: string;
  works: Work[];
  onOpenWork: (id: string) => void;
  onNewWork: () => void;
};

export function ProjectHubOverviewTab({
  projectName,
  works,
  onOpenWork,
  onNewWork,
}: Props) {
  const activeWorks = works.filter((w) => w.phase !== "approved" && !w.archived);
  const completedWorks = works.filter((w) => w.phase === "approved");

  return (
    <div className="ph-tab-content">
      {/* Quick Stats Banner */}
      <div className="ph-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          <div>
            <span style={{ fontSize: 11, color: "#8c9e99", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
              Lavori in corso
            </span>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#8fe3d0", marginTop: 4 }}>
              {activeWorks.length}
            </div>
          </div>
          <div>
            <span style={{ fontSize: 11, color: "#8c9e99", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
              Deliverable completati
            </span>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#f4f1ee", marginTop: 4 }}>
              {completedWorks.length}
            </div>
          </div>
          <div>
            <span style={{ fontSize: 11, color: "#8c9e99", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
              Stato complessivo
            </span>
            <div style={{ fontSize: 14, fontWeight: 600, color: activeWorks.length ? "#8fe3d0" : "#9db3ad", marginTop: 8 }}>
              {activeWorks.length ? "Operativo · Task attivi" : "In attesa di nuovi compiti"}
            </div>
          </div>
        </div>
      </div>

      {/* Active Tasks List */}
      <div className="ph-card">
        <div className="ph-card-header">
          <div>
            <h3 className="ph-card-title">
              <Clock size={16} className="text-[#8fe3d0]" />
              Incarichi e Conversazioni del Progetto
            </h3>
            <p className="ph-card-subtitle">
              Tutte le sessioni e attività coordinate dal team per {projectName}.
            </p>
          </div>
          <button className="ph-btn-primary" onClick={onNewWork}>
            <Plus size={15} />
            Nuovo Lavoro
          </button>
        </div>

        {works.length === 0 ? (
          <div className="ph-empty">
            <MessageSquare className="ph-empty-icon" />
            <h4 className="ph-empty-title">Nessun incarico presente in questo progetto</h4>
            <p className="ph-empty-desc">
              Avvia la prima conversazione di lavoro o affida un compito agli agenti assegnati.
            </p>
            <button className="ph-btn-primary" onClick={onNewWork} style={{ marginTop: 8 }}>
              <Plus size={15} />
              Avvia Primo Lavoro
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {works.map((work) => {
              const isApproved = work.phase === "approved";
              return (
                <div
                  key={work.id}
                  onClick={() => onOpenWork(work.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    background: "#ffffff",
                    border: "1px solid #dce4d5",
                    borderRadius: 10,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "#97ac68";
                    e.currentTarget.style.background = "#f7f9f5";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "#dce4d5";
                    e.currentTarget.style.background = "#ffffff";
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {isApproved ? (
                      <CheckCircle2 size={18} className="text-[#203c32]" />
                    ) : (
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "#203c32",
                          boxShadow: "0 0 6px rgba(32, 60, 50, 0.4)",
                        }}
                      />
                    )}
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#1c2d22" }}>
                        {work.title}
                      </div>
                      <div style={{ fontSize: 12, color: "#647a6d", marginTop: 2 }}>
                        Fase: <span style={{ color: "#263832", fontWeight: 500 }}>{work.phase}</span>
                        {work.due ? ` · Scadenza: ${work.due}` : ""}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#647a6d", fontSize: 12 }}>
                    <span>Apri conversazione</span>
                    <ArrowRight size={14} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
