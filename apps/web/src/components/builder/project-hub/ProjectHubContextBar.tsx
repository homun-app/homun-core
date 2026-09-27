import { useState } from "react";
import { FolderGit2, X } from "lucide-react";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (name: string, brief: string) => Promise<void>;
};

export function ProjectCreateModal({ isOpen, onClose, onCreateProject }: Props) {
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBrief, setNewProjectBrief] = useState("");
  const [busy, setBusy] = useState(false);

  if (!isOpen) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setBusy(true);
    try {
      await onCreateProject(newProjectName.trim(), newProjectBrief.trim());
      setNewProjectName("");
      setNewProjectBrief("");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(11, 20, 18, 0.75)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #dce4d5",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(32, 60, 50, 0.15)",
          padding: 24,
          maxWidth: 480,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          color: "#1c2d22",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "#edf2e7",
                color: "#157a6e",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FolderGit2 size={18} />
            </div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1c2d22" }}>
              Crea Nuovo Progetto
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#647a6d",
              cursor: "pointer",
              padding: 4,
              borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#556c5e", fontWeight: 600 }}>
            Nome del Progetto
            <input
              type="text"
              placeholder="Es. Campagna Marketing Q4, Audit Sicurezza..."
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              required
              autoFocus
              style={{
                background: "#ffffff",
                border: "1px solid #dce4d5",
                borderRadius: 8,
                padding: "9px 12px",
                color: "#1c2d22",
                fontSize: 13,
                outline: "none",
              }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#556c5e", fontWeight: 600 }}>
            Obiettivo / Brief Contestuale
            <textarea
              placeholder="Descrivi il perimetro e le istruzioni salienti per gli agenti e il team..."
              rows={3}
              value={newProjectBrief}
              onChange={(e) => setNewProjectBrief(e.target.value)}
              style={{
                background: "#ffffff",
                border: "1px solid #dce4d5",
                borderRadius: 8,
                padding: "9px 12px",
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
              onClick={onClose}
              disabled={busy}
            >
              Annulla
            </button>
            <button
              type="submit"
              className="ph-btn-primary"
              disabled={busy || !newProjectName.trim()}
            >
              {busy ? "Creazione in corso..." : "Crea Progetto"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Deprecated alias for backwards compatibility
export function ProjectHubContextBar() {
  return null;
}
