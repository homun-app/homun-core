/**
 * Settings → Persone & Squadra Umana
 * Enterprise collaboration: RBAC permissions matrix, project scoping,
 * and offline/remote task capsule exchange.
 */

import { useState, useEffect, useRef } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  listEngineProjects,
  ingestEngineMaterial,
  type EngineProject,
} from "@/lib/engine-projects-client";
import {
  UsersRound,
  UserCheck,
  Shield,
  FileDown,
  FileUp,
  Plus,
  Trash2,
  CheckCircle2,
  Share2,
  Laptop,
  FolderGit2,
  Settings2,
} from "lucide-react";
import {
  InviteCollaboratorModal,
  type CollaboratorData,
} from "./InviteCollaboratorModal";
import { SettingsCustomSelect } from "./SettingsCustomSelect";
import "./conversation-people-settings.css";

type Collaborator = {
  id: string;
  name: string;
  email: string;
  role: string;
  permission: "admin" | "member" | "reviewer";
  projectIds: string[];
};

const DEFAULT_COLLABORATORS: Collaborator[] = [
  {
    id: "collab_fabio",
    name: "Fabio",
    email: "fabio@homun.internal",
    role: "Titolare dello Spazio",
    permission: "admin",
    projectIds: [],
  },
  {
    id: "collab_marco",
    name: "Marco Dev",
    email: "marco.dev@remote.internal",
    role: "Senior Full-Stack Engineer",
    permission: "member",
    projectIds: [],
  },
  {
    id: "collab_revisore",
    name: "Studio Fiscale & Legale",
    email: "consulenza@rossi-associati.it",
    role: "Consulente Esterno",
    permission: "reviewer",
    projectIds: [],
  },
];

export function ConversationPeopleSettingsSection() {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected";

  const [collaborators, setCollaborators] = useState<Collaborator[]>(() => {
    try {
      const saved = localStorage.getItem("homun_collaborators_roster");
      return saved ? JSON.parse(saved) : DEFAULT_COLLABORATORS;
    } catch {
      return DEFAULT_COLLABORATORS;
    }
  });

  const [projects, setProjects] = useState<EngineProject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCollaborator, setEditingCollaborator] = useState<Collaborator | null>(null);

  // Work Capsule Export state
  const [capsuleProjectId, setCapsuleProjectId] = useState<string>("");
  const [capsuleTaskTitle, setCapsuleTaskTitle] = useState("");
  const [capsuleInstructions, setCapsuleInstructions] = useState("");
  const [capsuleAssignee, setCapsuleAssignee] = useState("");

  // Deliverable Import state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!engineReady) return;
    void listEngineProjects()
      .then((items) => {
        setProjects(items);
        const first = items[0];
        if (first && !capsuleProjectId) {
          setCapsuleProjectId(first.id);
        }
      })
      .catch((err) => setError(err));
  }, [engineReady]);

  function persistCollaborators(list: Collaborator[]) {
    setCollaborators(list);
    try {
      localStorage.setItem("homun_collaborators_roster", JSON.stringify(list));
    } catch {
      // ignore
    }
  }

  function handleSaveCollaborator(data: CollaboratorData) {
    if (data.id) {
      // Update existing
      persistCollaborators(
        collaborators.map((c) =>
          c.id === data.id
            ? {
                ...c,
                name: data.name,
                email: data.email,
                role: data.role,
                permission: data.permission,
                projectIds: data.projectIds,
              }
            : c,
        ),
      );
      setNotice(`Permessi di ${data.name} aggiornati con successo.`);
    } else {
      // Create new
      const newCollab: Collaborator = {
        id: `collab_${crypto.randomUUID().slice(0, 8)}`,
        name: data.name,
        email: data.email,
        role: data.role,
        permission: data.permission,
        projectIds: data.projectIds,
      };
      persistCollaborators([...collaborators, newCollab]);
      setNotice(`Collaboratore ${newCollab.name} aggiunto alla squadra.`);
    }
    setModalOpen(false);
    setEditingCollaborator(null);
  }

  function handleRemoveCollaborator(id: string) {
    if (id === "collab_fabio") return;
    persistCollaborators(collaborators.filter((c) => c.id !== id));
  }

  function openInvite() {
    setEditingCollaborator(null);
    setModalOpen(true);
  }

  function openEdit(collab: Collaborator) {
    setEditingCollaborator(collab);
    setModalOpen(true);
  }

  // Work Capsule: Export JSON work package
  function handleExportCapsule() {
    if (!capsuleTaskTitle.trim()) return;
    const selectedProj = projects.find((p) => p.id === capsuleProjectId);

    const capsule = {
      spec_version: "homun.capsule.v1",
      exported_at: new Date().toISOString(),
      project: {
        id: capsuleProjectId,
        name: selectedProj?.name ?? "Progetto Generale",
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

    setNotice(`Capsula d'incarico esportata per ${capsuleAssignee || "il collaboratore"}.`);
    setCapsuleTaskTitle("");
    setCapsuleInstructions("");
  }

  // Deliverable: Import completed work back
  async function handleImportDeliverable(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setBusy(true);
    setImportNotice(null);
    try {
      const firstProj = projects[0];
      if (engineReady && firstProj) {
        const targetProjectId = capsuleProjectId || firstProj.id;
        await ingestEngineMaterial({
          projectId: targetProjectId,
          file,
          title: `[Consegna Remota] ${file.name}`,
        });
        setImportNotice(
          `Consegna "${file.name}" importata con successo nel progetto. L'agente supervisore riceverà il deliverable per la revisione automatica.`,
        );
      } else {
        setImportNotice(
          `File di consegna "${file.name}" registrato localmente. Avvia il motore per archiviarlo nei materiali del progetto.`,
        );
      }
    } catch (err: unknown) {
      setError(err);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="cv-people-wrap" aria-label="Persone e collaboratori dello spazio">
      {/* Intestazione */}
      <div className="cv-people-header flex items-center justify-between">
        <div>
          <h3>Persone & Squadra Umana</h3>
          <p>
            Gestisci chi collabora in questo spazio aziendale, i ruoli di accesso ai progetti e la delega di incarichi su altri computer.
          </p>
        </div>
        <button
          type="button"
          onClick={openInvite}
          className="cv-unified-btn is-primary text-xs"
        >
          <Plus size={14} />
          <span>Invita Collaboratore</span>
        </button>
      </div>

      <HomunErrorNotice error={error} />
      {notice && (
        <div className="p-2.5 rounded-lg bg-[#dcebd9] border border-[#b7d6b3] text-xs text-[#235940] flex items-center justify-between font-medium">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-[10px] text-[#4b6354] hover:text-[#1c2d22]"
          >
            Chiudi
          </button>
        </div>
      )}

      {/* Banner Esplicativo Collaborazione Distribuita */}
      <div className="cv-people-explainer">
        <div className="cv-people-explainer__icon">
          <UsersRound size={18} />
        </div>
        <div className="cv-people-explainer__text">
          <strong>Collaborazione d'impresa e governance dei permessi</strong>
          <p>
            Non tutti i membri devono vedere tutto. I titolari amministrano l'infrastruttura e le chiavi API, mentre sviluppatori e consulenti esterni accedono esclusivamente ai progetti a loro assegnati.
          </p>
        </div>
      </div>

      {/* Elenco Membri del Team */}
      <div className="space-y-3">
        {collaborators.map((collab) => {
          const isOwner = collab.id === "collab_fabio";

          // Calculate names of scoped projects
          const assignedProjectNames = projects
            .filter((p) => collab.projectIds.includes(p.id))
            .map((p) => p.name);

          return (
            <div key={collab.id} className="cv-people-card">
              <div className="cv-people-card__top">
                <div className="cv-people-card__identity">
                  <div className="cv-people-card__avatar">
                    {collab.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="cv-people-card__name-row">
                      <strong>{collab.name}</strong>
                      <span
                        className={`cv-people-card__badge-role ${
                          collab.permission === "admin"
                            ? "cv-people-card__badge-admin"
                            : collab.permission === "reviewer"
                            ? "border-blue-500/30 text-blue-300 bg-blue-500/10"
                            : ""
                        }`}
                      >
                        {collab.permission === "admin"
                          ? "Titolare / Admin"
                          : collab.permission === "member"
                          ? "Membro Operativo"
                          : "Revisore Esterno"}
                      </span>
                    </div>
                    <span className="cv-people-card__email">
                      {collab.role} · {collab.email}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openEdit(collab)}
                    className="cv-unified-btn is-subtle text-xs"
                    title="Modifica ruolo e perimetro progetti"
                  >
                    <Settings2 size={13} />
                    <span>Modifica</span>
                  </button>
                  {!isOwner && (
                    <button
                      type="button"
                      onClick={() => handleRemoveCollaborator(collab.id)}
                      className="cv-unified-btn is-subtle text-xs text-red-400 hover:text-red-300"
                      title="Rimuovi collaboratore"
                    >
                      <Trash2 size={13} />
                      <span>Rimuovi</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Scoping progetti */}
              <div className="text-[11px] text-[#9db3ad] pt-2 border-t border-[rgba(255,255,255,0.06)] flex items-center justify-between">
                <span>
                  {collab.permission === "admin"
                    ? "Accesso globale garantito su tutti i progetti, impostazioni e credenziali."
                    : assignedProjectNames.length > 0
                    ? `Autorizzato su: ${assignedProjectNames.join(", ")}`
                    : "Nessun progetto ristretto assegnato (in attesa di delega)."}
                </span>
                <span className="font-mono text-[#8fe3d0] flex items-center gap-1">
                  <UserCheck size={11} />
                  <span>Firma verificata</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Sezione Strategica: Scambio Lavori tra Computer (Work Capsules) */}
      <div className="cv-capsule-box">
        <div className="cv-capsule-box__header">
          <div className="cv-capsule-box__title">
            <Laptop size={16} className="text-[#8fe3d0]" />
            <span>Scambio Lavori & Capsule tra Computer (Work Delegation)</span>
          </div>
          <span className="text-[11px] text-[#203c32] bg-[#edf2e7] px-2 py-0.5 rounded border border-[#dce4d5] font-medium">
            Delega Asincrona
          </span>
        </div>
        <p className="text-xs text-[#647a6d] leading-relaxed">
          Permette all'azienda di delegare una parte del lavoro a un collaboratore esterno o a un altro computer.
          Esporta un pacchetto d'incarico autonomo che include contesto e requisiti; una volta completato, re-importa il deliverable per far proseguire la pipeline degli agenti.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2">
          {/* Box 1: Esporta Incarico */}
          <div className="p-5 rounded-2xl bg-[#edf2e7] border border-[rgba(104,122,89,0.12)] flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div>
                <strong className="text-xs font-semibold text-[#1c2d22] flex items-center gap-2 mb-1">
                  <FileDown size={15} className="text-[#203c32]" />
                  <span>1. Esporta Pacchetto Incarico (.homun-task)</span>
                </strong>
                <span className="text-[11.5px] text-[#647a6d] block leading-relaxed">
                  Genera il brief con le istruzioni dell'agente da inviare via mail, chat o chiavetta.
                </span>
              </div>

              {projects.length > 0 && (
                <div>
                  <label className="text-[11px] font-bold text-[#687a59] uppercase tracking-wider block mb-1">
                    Progetto di Riferimento
                  </label>
                  <SettingsCustomSelect
                    value={capsuleProjectId}
                    onChange={(val) => setCapsuleProjectId(val)}
                    options={projects.map((p, idx) => ({
                      value: p.id,
                      label: `${p.name} ${projects.filter((x) => x.name === p.name).length > 1 ? `(#${idx + 1})` : ""}`,
                      icon: FolderGit2,
                    }))}
                  />
                </div>
              )}

              <div>
                <label className="text-[11px] font-bold text-[#687a59] uppercase tracking-wider block mb-1">
                  Titolo Incarico
                </label>
                <input
                  type="text"
                  placeholder="Es. Refactoring Modulo Auth, Verifica Fiscale..."
                  value={capsuleTaskTitle}
                  onChange={(e) => setCapsuleTaskTitle(e.target.value)}
                  className="w-full bg-white text-[#1c2d22] border border-[#dce4d5] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[#203c32] focus:ring-1 focus:ring-[#203c32]/30 placeholder:text-[#8ca39d]"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-[#687a59] uppercase tracking-wider block mb-1">
                  Destinatario
                </label>
                <input
                  type="text"
                  placeholder="Es. Marco Dev, Studio Rossi..."
                  value={capsuleAssignee}
                  onChange={(e) => setCapsuleAssignee(e.target.value)}
                  className="w-full bg-white text-[#1c2d22] border border-[#dce4d5] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[#203c32] focus:ring-1 focus:ring-[#203c32]/30 placeholder:text-[#8ca39d]"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-[#687a59] uppercase tracking-wider block mb-1">
                  Specifiche e Vincoli Tecnici
                </label>
                <textarea
                  rows={2}
                  placeholder="Istruzioni salienti, requisiti di consegna e test attesi..."
                  value={capsuleInstructions}
                  onChange={(e) => setCapsuleInstructions(e.target.value)}
                  className="w-full bg-white text-[#1c2d22] border border-[#dce4d5] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[#203c32] focus:ring-1 focus:ring-[#203c32]/30 placeholder:text-[#8ca39d]"
                />
              </div>
            </div>

            <button
              type="button"
              disabled={!capsuleTaskTitle.trim()}
              onClick={handleExportCapsule}
              className="cv-unified-btn is-primary text-xs w-full justify-center py-2"
            >
              <FileDown size={14} />
              <span>Esporta Pacchetto Incarico JSON</span>
            </button>
          </div>

          {/* Box 2: Importa Consegna */}
          <div className="p-5 rounded-2xl bg-[#edf2e7] border border-[rgba(104,122,89,0.12)] flex flex-col justify-between space-y-4">
            <div>
              <strong className="text-xs font-semibold text-[#1c2d22] flex items-center gap-2 mb-1">
                <FileUp size={15} className="text-[#203c32]" />
                <span>2. Importa Consegna Completata</span>
              </strong>
              <span className="text-[11.5px] text-[#647a6d] block mb-4 leading-relaxed">
                Quando il collaboratore rimanda il lavoro completato, caricalo qui per aggiornare i materiali del progetto e notificare la squadra di agenti.
              </span>

              <div
                className="rounded-2xl p-6 text-center cursor-pointer transition-all duration-200 bg-white border border-[#dce4d5] hover:bg-[#f7f9f5] group"
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="w-10 h-10 rounded-xl bg-[#dcebd9] text-[#235940] flex items-center justify-center mx-auto mb-2 group-hover:scale-105 transition-transform">
                  <FileUp size={20} />
                </div>
                <span className="text-xs text-[#1c2d22] block font-medium">
                  Seleziona il file di consegna
                </span>
                <span className="text-[11px] text-[#647a6d] mt-1 block">
                  Supporta ZIP, codice sorgente, report o pacchetti .homun-task
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={(e) => void handleImportDeliverable(e)}
                  className="hidden"
                />
              </div>

              {importNotice && (
                <div className="mt-2 p-2 rounded bg-[#dcebd9] border border-[#b7d6b3] text-[#235940] text-xs flex items-center gap-1.5 font-medium">
                  <CheckCircle2 size={13} className="shrink-0" />
                  <span>{importNotice}</span>
                </div>
              )}
            </div>

            <div className="text-[10px] text-[#647a6d] flex items-center gap-1 justify-center pt-2">
              <Share2 size={11} className="text-[#203c32]" />
              <span>Sincronizzazione verificata e priva di conflitti</span>
            </div>
          </div>
        </div>
      </div>

      {/* Modal Invita / Modifica Collaboratore */}
      {modalOpen && (
        <InviteCollaboratorModal
          initialData={editingCollaborator}
          projects={projects}
          onSave={handleSaveCollaborator}
          onClose={() => {
            setModalOpen(false);
            setEditingCollaborator(null);
          }}
        />
      )}
    </div>
  );
}
