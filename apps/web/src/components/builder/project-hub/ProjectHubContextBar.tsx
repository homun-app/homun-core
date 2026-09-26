import { useState } from "react";
import { Plus } from "lucide-react";
import { SettingsCustomSelect, type SelectOption } from "../SettingsCustomSelect";

type Props = {
  projectName: string;
  isEngine: boolean;
  currentProjectId: string;
  projectOptions: SelectOption[];
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string, brief: string) => Promise<void>;
};

export function ProjectHubContextBar({
  projectName,
  isEngine,
  currentProjectId,
  projectOptions,
  onSelectProject,
  onCreateProject,
}: Props) {
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBrief, setNewProjectBrief] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setBusy(true);
    try {
      await onCreateProject(newProjectName.trim(), newProjectBrief.trim());
      setNewProjectName("");
      setNewProjectBrief("");
      setCreatingProject(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ph-context-bar">
      <div className="ph-breadcrumb">
        <span className="ph-breadcrumb-link" onClick={() => onSelectProject("")}>
          Spazio
        </span>
        <span className="ph-breadcrumb-sep">/</span>
        <span className="ph-breadcrumb-link" onClick={() => onSelectProject("")}>
          Progetti
        </span>
        <span className="ph-breadcrumb-sep">/</span>
        <strong style={{ color: "#f4f1ee" }}>{projectName}</strong>
      </div>

      <div className="ph-switcher-container">
        <span
          className={
            isEngine
              ? "ph-source-badge ph-source-badge--engine"
              : "ph-source-badge ph-source-badge--simulation"
          }
        >
          Fonte: {isEngine ? "motore" : "simulazione"}
        </span>

        {projectOptions.length > 0 && (
          <div style={{ minWidth: 220 }}>
            <SettingsCustomSelect
              value={currentProjectId}
              onChange={(val) => onSelectProject(val)}
              options={projectOptions}
              placeholder="Passa a un altro progetto..."
            />
          </div>
        )}

        <button className="ph-btn-secondary" onClick={() => setCreatingProject(true)}>
          <Plus size={14} />
          Nuovo Progetto
        </button>
      </div>

      {creatingProject && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20, 38, 31, 0.45)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 20,
          }}
          onClick={() => setCreatingProject(false)}
        >
          <div
            style={{
              background: "#fbfbf8",
              border: "1px solid #dce4d5",
              borderRadius: 14,
              boxShadow: "0 24px 60px rgba(32, 60, 50, 0.18)",
              padding: 24,
              maxWidth: 480,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: 0, fontSize: 16, color: "#1c2d22", fontFamily: "Manrope, sans-serif" }}>Crea Nuovo Progetto</h3>
            <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#263832", fontWeight: 500 }}>
                Nome Progetto
                <input
                  type="text"
                  placeholder="Es. Campagna Marketing Q4"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  required
                  style={{
                    background: "#ffffff",
                    border: "1px solid #dce4d5",
                    borderRadius: 8,
                    padding: "8px 12px",
                    color: "#1c2d22",
                    fontSize: 13,
                    outline: "none",
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#263832", fontWeight: 500 }}>
                Descrizione / Obiettivo
                <textarea
                  placeholder="Obiettivi e perimetro di lavoro per la squadra..."
                  rows={3}
                  value={newProjectBrief}
                  onChange={(e) => setNewProjectBrief(e.target.value)}
                  style={{
                    background: "#ffffff",
                    border: "1px solid #dce4d5",
                    borderRadius: 8,
                    padding: "8px 12px",
                    color: "#1c2d22",
                    fontSize: 13,
                    resize: "vertical",
                    outline: "none",
                  }}
                />
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                <button
                  type="button"
                  className="ph-btn-secondary"
                  onClick={() => setCreatingProject(false)}
                  disabled={busy}
                >
                  Annulla
                </button>
                <button type="submit" className="ph-btn-primary" disabled={busy}>
                  Crea Progetto
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
