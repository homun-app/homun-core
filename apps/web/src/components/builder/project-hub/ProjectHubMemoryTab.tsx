import { useState } from "react";
import { BookMarked, Globe, Plus, Search, Sparkles, Trash2, Edit2, Check, AlertCircle } from "lucide-react";
import type { EngineMemoryNote } from "@/lib/engine-memory-client";

type Props = {
  projectId: string;
  projectName: string;
  globalMemories: EngineMemoryNote[];
  projectMemories: EngineMemoryNote[];
  onAddProjectMemory: (text: string) => Promise<void>;
  onPromoteToGlobal: (note: EngineMemoryNote) => Promise<void>;
  onDeleteMemory: (memoryId: string) => Promise<void>;
};

export function ProjectHubMemoryTab({
  projectId,
  projectName,
  globalMemories,
  projectMemories,
  onAddProjectMemory,
  onPromoteToGlobal,
  onDeleteMemory,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [promoteCandidate, setPromoteCandidate] = useState<EngineMemoryNote | null>(null);

  const filteredProjectMemories = projectMemories.filter((m) =>
    search ? m.text.toLowerCase().includes(search.toLowerCase()) : true,
  );

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await onAddProjectMemory(draft.trim());
      setDraft("");
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPromote() {
    if (!promoteCandidate) return;
    setBusy(true);
    try {
      await onPromoteToGlobal(promoteCandidate);
      setPromoteCandidate(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ph-tab-content">
      {/* Top Banner and Actions */}
      <div className="ph-card">
        <div className="ph-card-header">
          <div>
            <h3 className="ph-card-title">
              <BookMarked size={16} className="text-[#157a6e]" />
              Memoria & Vincoli di Progetto
            </h3>
            <p className="ph-card-subtitle">
              Regole contestuali e preferenze approvate che gli agenti applicano automaticamente ai lavori di {projectName}.
            </p>
          </div>
          <button className="ph-btn-primary" onClick={() => setAdding(!adding)}>
            <Plus size={14} />
            Nuovo Vincolo
          </button>
        </div>

        {/* Add Memory Form */}
        {adding && (
          <form
            onSubmit={handleAdd}
            style={{
              padding: "16px",
              background: "#ffffff",
              border: "1px solid #dce4d5",
              borderRadius: 10,
              marginBottom: 16,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <strong style={{ fontSize: 13, color: "#1c2d22" }}>Nuova regola o preferenza di progetto</strong>
            <textarea
              placeholder="Es. 'Questo cliente vuole tutti i report con tabelle riassuntive e importi in Euro con IVA scorporata.'"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              required
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
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="ph-btn-secondary"
                onClick={() => setAdding(false)}
                disabled={busy}
              >
                Annulla
              </button>
              <button type="submit" className="ph-btn-primary" disabled={busy}>
                Approva Vincolo
              </button>
            </div>
          </form>
        )}

        {/* Search */}
        <div style={{ position: "relative", marginBottom: 18 }}>
          <Search
            size={14}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: "#647a6d",
            }}
          />
          <input
            type="text"
            placeholder="Cerca nei vincoli di progetto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              background: "#ffffff",
              border: "1px solid #dce4d5",
              borderRadius: 8,
              padding: "8px 12px 8px 34px",
              color: "#1c2d22",
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>

        {/* Global Policies (Inherited from Space) */}
        <div className="ph-memory-section">
          <div className="ph-memory-section-title">
            <Globe size={14} className="text-[#203c32]" />
            Policy Ereditate dallo Spazio Globale (Azienda)
          </div>
          {globalMemories.length === 0 ? (
            <p style={{ fontSize: 12, color: "#7d918c", fontStyle: "italic", margin: "4px 0 12px" }}>
              Nessuna policy globale non negoziabile definita a livello aziendale.
            </p>
          ) : (
            globalMemories.map((note) => (
              <div key={note.id} className="ph-memory-item ph-memory-item--global">
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flex: 1 }}>
                  <Globe size={16} className="text-[#157a6e]" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div className="ph-memory-text">{note.text}</div>
                    <div className="ph-memory-meta">
                      <span>Valida per tutti i progetti</span>
                      <span>·</span>
                      <span>Configurata nei Settings Aziendali</span>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Project Specific Memories */}
        <div className="ph-memory-section">
          <div className="ph-memory-section-title">
            <BookMarked size={14} className="text-amber-400" />
            Vincoli Specifici di {projectName}
          </div>
          {filteredProjectMemories.length === 0 ? (
            <div className="ph-empty" style={{ padding: "32px 16px" }}>
              <BookMarked className="ph-empty-icon" />
              <h4 className="ph-empty-title">Nessun vincolo specifico salvato</h4>
              <p className="ph-empty-desc">
                Aggiungi preferenze e requisiti del cliente che gli agenti devono rispettare in ogni risposta.
              </p>
            </div>
          ) : (
            filteredProjectMemories.map((note) => (
              <div key={note.id} className="ph-memory-item">
                <div className="ph-memory-text">
                  <div>{note.text}</div>
                  <div className="ph-memory-meta">
                    <span>Approvata</span>
                    <span>·</span>
                    <span>Applicata solo in {projectName}</span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className="ph-btn-promote"
                    onClick={() => setPromoteCandidate(note)}
                    title="Rendi questa regola una policy valida per l'intera azienda"
                  >
                    <Globe size={12} />
                    Promuovi a Globale
                  </button>
                  <button
                    className="ph-btn-secondary"
                    onClick={() => onDeleteMemory(note.id)}
                    style={{ padding: "5px 8px" }}
                    title="Elimina vincolo"
                  >
                    <Trash2 size={13} className="text-red-400" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Promotion Confirmation Modal */}
      {promoteCandidate && (
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
          onClick={() => setPromoteCandidate(null)}
        >
          <div
            style={{
              background: "#fbfbf8",
              border: "1px solid #dce4d5",
              borderRadius: 14,
              boxShadow: "0 24px 60px rgba(32, 60, 50, 0.18)",
              padding: 24,
              maxWidth: 520,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Globe size={20} className="text-[#203c32]" />
              <h3 style={{ margin: 0, fontSize: 16, color: "#1c2d22" }}>
                Promuovi a Policy Globale Aziendale
              </h3>
            </div>
            <p style={{ fontSize: 13, color: "#556c5e", margin: 0, lineHeight: 1.45 }}>
              Vuoi rendere questa regola una linea guida permanente dello spazio? Sarà applicata
              automaticamente a <strong>tutti i progetti correnti e futuri</strong> da tutta la squadra.
            </p>
            <div
              style={{
                background: "#f4f7f0",
                border: "1px solid #e2e8dc",
                padding: "12px 14px",
                borderRadius: 8,
                fontSize: 13,
                color: "#263832",
                borderLeft: "3px solid #203c32",
              }}
            >
              {promoteCandidate.text}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
              <button
                className="ph-btn-secondary"
                onClick={() => setPromoteCandidate(null)}
                disabled={busy}
              >
                Annulla
              </button>
              <button
                className="ph-btn-primary"
                onClick={confirmPromote}
                disabled={busy}
              >
                Conferma Promozione
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
