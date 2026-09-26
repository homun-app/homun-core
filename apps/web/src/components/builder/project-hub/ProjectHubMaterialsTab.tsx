import { useState, useRef } from "react";
import { FileText, Plus, Upload, Trash2, Eye, ExternalLink, CheckCircle2, AlertCircle, FileCode } from "lucide-react";
import type { EngineMaterial } from "@/lib/engine-projects-client";

type Props = {
  projectId: string;
  projectName: string;
  materials: EngineMaterial[];
  onAddTextMaterial: (title: string, text: string) => Promise<void>;
  onUploadFileMaterial: (file: File) => Promise<void>;
  onArchiveMaterial: (materialId: string) => Promise<void>;
};

export function ProjectHubMaterialsTab({
  projectId,
  projectName,
  materials,
  onAddTextMaterial,
  onUploadFileMaterial,
  onArchiveMaterial,
}: Props) {
  const [addingNote, setAddingNote] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [previewMaterial, setPreviewMaterial] = useState<EngineMaterial | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleCreateNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteTitle.trim() || !noteContent.trim()) return;
    setBusy(true);
    try {
      await onAddTextMaterial(noteTitle.trim(), noteContent.trim());
      setNoteTitle("");
      setNoteContent("");
      setAddingNote(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await onUploadFileMaterial(file);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="ph-tab-content">
      <div className="ph-card">
        <div className="ph-card-header">
          <div>
            <h3 className="ph-card-title">
              <FileText size={16} className="text-[#157a6e]" />
              Documenti & Materiali di {projectName}
            </h3>
            <p className="ph-card-subtitle">
              File sorgente, note e contratti ingeriti specifici per il grounding e la consultazione degli agenti.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: "none" }}
              onChange={handleFileChange}
            />
            <button
              className="ph-btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <Upload size={14} />
              Carica File
            </button>
            <button
              className="ph-btn-primary"
              onClick={() => setAddingNote(!addingNote)}
              disabled={busy}
            >
              <Plus size={14} />
              Nuova Nota
            </button>
          </div>
        </div>

        {/* New Note Form */}
        {addingNote && (
          <form
            onSubmit={handleCreateNote}
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
            <strong style={{ fontSize: 13, color: "#1c2d22" }}>Aggiungi materiale di testo o linea guida</strong>
            <input
              type="text"
              placeholder="Titolo del documento (es. Brief di progetto o Condizioni commerciali)"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
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
            <textarea
              placeholder="Incolla il contenuto o testo di riferimento per gli agenti..."
              rows={4}
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
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
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                className="ph-btn-secondary"
                onClick={() => setAddingNote(false)}
                disabled={busy}
              >
                Annulla
              </button>
              <button type="submit" className="ph-btn-primary" disabled={busy}>
                Salva Materiale
              </button>
            </div>
          </form>
        )}

        {/* Materials List */}
        {materials.length === 0 ? (
          <div className="ph-empty">
            <FileText className="ph-empty-icon" />
            <h4 className="ph-empty-title">Nessun documento caricato nel progetto</h4>
            <p className="ph-empty-desc">
              Carica PDF, specifiche o contratti per dare contesto operativo ai task di questo progetto.
            </p>
          </div>
        ) : (
          <table className="ph-table">
            <thead>
              <tr>
                <th>Titolo / Documento</th>
                <th>Tipo</th>
                <th>Grounding Status</th>
                <th style={{ textAlign: "right" }}>Azioni</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <FileCode size={16} className="text-[#157a6e]" />
                      <div>
                        <div style={{ fontWeight: 600, color: "#1c2d22" }}>{m.title}</div>
                        {m.origin_name && (
                          <div style={{ fontSize: 11, color: "#647a6d" }}>{m.origin_name}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span style={{ fontSize: 12, textTransform: "capitalize", color: "#556c5e" }}>
                      {m.kind || "documento"}
                    </span>
                  </td>
                  <td>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        padding: "3px 8px",
                        borderRadius: 999,
                        background: "#edf2e7",
                        color: "#203c32",
                        fontWeight: 600,
                      }}
                    >
                      <CheckCircle2 size={12} className="text-[#157a6e]" />
                      Ingerito & Pronto
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        className="ph-btn-secondary"
                        onClick={() => setPreviewMaterial(m)}
                        style={{ padding: "4px 8px" }}
                        title="Visualizza estratto"
                      >
                        <Eye size={13} />
                      </button>
                      <button
                        className="ph-btn-secondary"
                        onClick={() => onArchiveMaterial(m.id)}
                        style={{ padding: "4px 8px" }}
                        title="Rimuovi materiale"
                      >
                        <Trash2 size={13} className="text-red-400" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Preview Dialog */}
      {previewMaterial && (
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
          onClick={() => setPreviewMaterial(null)}
        >
          <div
            style={{
              background: "#fbfbf8",
              border: "1px solid #dce4d5",
              borderRadius: 14,
              boxShadow: "0 24px 60px rgba(32, 60, 50, 0.18)",
              padding: 24,
              maxWidth: 640,
              width: "100%",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 16, color: "#1c2d22", fontFamily: "Manrope, sans-serif" }}>{previewMaterial.title}</h3>
              <button className="ph-btn-secondary" onClick={() => setPreviewMaterial(null)}>
                Chiudi
              </button>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                background: "#f4f7f0",
                border: "1px solid #e2e8dc",
                padding: 14,
                borderRadius: 8,
                fontSize: 13,
                color: "#263832",
                whiteSpace: "pre-wrap",
                fontFamily: "monospace",
              }}
            >
              {previewMaterial.text || "Nessun contenuto testuale visualizzabile."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
