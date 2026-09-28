import { useState, useRef } from "react";
import { UsersRound, Shield, ShieldCheck, Eye, Plus, Download, Upload, Trash2, CheckCircle2, Laptop } from "lucide-react";
import { SettingsCustomSelect, type SelectOption } from "../SettingsCustomSelect";
import { InviteCollaboratorModal, type CollaboratorData } from "../InviteCollaboratorModal";
import type { EngineProject } from "@/lib/engine-projects-client";

export type ProjectMember = {
  id: string;
  name: string;
  email: string;
  permission: "admin" | "member" | "reviewer";
};

type Props = {
  projectId: string;
  projectName: string;
  members: ProjectMember[];
  onUpdateMemberPermission: (memberId: string, permission: "admin" | "member" | "reviewer") => void;
  onRemoveMember: (memberId: string) => void;
  onAddMember: (member: ProjectMember) => void;
  onImportDeliverable?: (file: File) => Promise<void>;
};

export function ProjectHubRbacTab({
  projectId,
  projectName,
  members,
  onUpdateMemberPermission,
  onRemoveMember,
  onAddMember,
  onImportDeliverable,
}: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [capsuleTaskTitle, setCapsuleTaskTitle] = useState("");
  const [capsuleInstructions, setCapsuleInstructions] = useState("");
  const [capsuleAssignee, setCapsuleAssignee] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const permissionOptions: SelectOption[] = [
    {
      value: "admin",
      label: "Amministratore (Admin)",
      desc: "Pieno controllo sul progetto, membri, materiali e regole.",
      badge: "Pieno Accesso",
    },
    {
      value: "member",
      label: "Scrittura & Esecuzione (Member)",
      desc: "Può interagire con gli agenti, avviare task e caricare materiali.",
      badge: "Scrittura",
    },
    {
      value: "reviewer",
      label: "Sola Lettura (Reviewer)",
      desc: "Può consultare i deliverable e inviare file di consegna.",
      badge: "Lettura",
    },
  ];

  function handleExportCapsule() {
    if (!capsuleTaskTitle.trim()) return;

    const capsule = {
      spec_version: "homun.capsule.v1",
      exported_at: new Date().toISOString(),
      project: {
        id: projectId,
        name: projectName,
      },
      task: {
        title: capsuleTaskTitle.trim(),
        instructions: capsuleInstructions.trim(),
        assigned_to: capsuleAssignee.trim() || "Collaboratore Remoto",
        expected_output: "Deliverable completato (codice sorgente, documento o archivio)",
      },
      origin_workspace: "Homun Local Studio",
    };

    const blob = new Blob([JSON.stringify(capsule, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `homun-capsula-${capsuleTaskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);

    setNotice(`Capsula d'incarico per ${projectName} esportata con successo.`);
    setCapsuleTaskTitle("");
    setCapsuleInstructions("");
  }

  async function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !onImportDeliverable) return;
    setBusy(true);
    try {
      await onImportDeliverable(file);
      setNotice(`Consegna "${file.name}" importata con successo nel progetto.`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="ph-tab-content">
      <div className="ph-card">
        <div className="ph-card-header">
          <div className="section-label">
            Squadra Umana & Permessi ({members.length})
          </div>
          <button className="ph-btn-ghost" onClick={() => setModalOpen(true)}>
            <Plus size={13} />
            Aggiungi Membro
          </button>
        </div>

        {notice && (
          <div
            style={{
              padding: "10px 14px",
              background: "#edf2e7",
              border: "1px solid #dce4d5",
              borderRadius: 8,
              fontSize: 13,
              color: "#203c32",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <CheckCircle2 size={16} className="text-[#157a6e]" />
            {notice}
          </div>
        )}

        {/* Member Table */}
        <table className="ph-table">
          <thead>
            <tr>
              <th>Collaboratore</th>
              <th>Livello Permesso</th>
              <th style={{ textAlign: "right" }}>Azioni</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: "#edf2e7",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#203c32",
                      }}
                    >
                      {m.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, color: "#1c2d22" }}>{m.name}</div>
                      <div style={{ fontSize: 11, color: "#647a6d" }}>{m.email}</div>
                    </div>
                  </div>
                </td>
                <td style={{ width: 280 }}>
                  <SettingsCustomSelect
                    value={m.permission}
                    onChange={(val) => onUpdateMemberPermission(m.id, val as any)}
                    options={permissionOptions}
                  />
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="ph-btn-secondary"
                    onClick={() => onRemoveMember(m.id)}
                    style={{ padding: "4px 8px" }}
                    title="Rimuovi accesso al progetto"
                  >
                    <Trash2 size={13} className="text-red-400" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Work Capsules Section */}
        <div className="ph-capsule-box">
          <div className="ph-capsule-text">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <Laptop size={16} className="text-[#157a6e]" />
              <h4 style={{ margin: 0 }}>Deleghe Remote: Homun Work Capsules</h4>
            </div>
            <p>
              Esporta il contesto operativo e le istruzioni di questo progetto in un pacchetto cifrato per
              lavorare offline o delegare task su un altro computer senza condividere l'intero database.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: "none" }}
              onChange={handleFileInput}
            />
            <button
              className="ph-btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <Upload size={14} />
              Importa Consegna
            </button>
            <button
              className="ph-btn-primary"
              onClick={() => {
                const title = prompt("Titolo dell'incarico da delegare nella Work Capsule:", "Analisi deliverable");
                if (title) {
                  setCapsuleTaskTitle(title);
                  setCapsuleInstructions("Istruzioni per il collaboratore");
                  handleExportCapsule();
                }
              }}
            >
              <Download size={14} />
              Esporta Capsula (.json)
            </button>
          </div>
        </div>
      </div>

      {modalOpen && (
        <InviteCollaboratorModal
          projects={[{ id: projectId, name: projectName } as EngineProject]}
          onClose={() => setModalOpen(false)}
          onSave={(data: CollaboratorData) => {
            onAddMember({
              id: data.id || `collab_${crypto.randomUUID().slice(0, 8)}`,
              name: data.name,
              email: data.email,
              permission: data.permission,
            });
            setModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
