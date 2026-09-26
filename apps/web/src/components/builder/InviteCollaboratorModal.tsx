/**
 * Modal to invite or edit a human collaborator with RBAC permissions
 * and project scoping, using custom visual selection cards and spacious layout.
 */

import { useState } from "react";
import {
  X,
  UserPlus,
  Shield,
  ShieldCheck,
  Eye,
  Check,
  FolderGit2,
} from "lucide-react";
import type { EngineProject } from "@/lib/engine-projects-client";

export type CollaboratorData = {
  id?: string;
  name: string;
  email: string;
  role: string;
  permission: "admin" | "member" | "reviewer";
  projectIds: string[];
};

type Props = {
  initialData?: CollaboratorData | null;
  projects: EngineProject[];
  onSave: (data: CollaboratorData) => void;
  onClose: () => void;
};

const PERMISSION_OPTIONS = [
  {
    id: "admin" as const,
    title: "Titolare / Amministratore",
    badge: "Accesso Globale",
    badgeClass: "bg-amber-500/15 text-amber-300",
    desc: "Pieno controllo su tutti i progetti, impostazioni, modelli LLM, canali e credenziali dello spazio.",
    icon: Shield,
  },
  {
    id: "member" as const,
    title: "Membro Operativo",
    badge: "Progetti Assegnati",
    badgeClass: "bg-[rgba(21,122,110,0.25)] text-[#8fe3d0]",
    desc: "Può interagire con gli agenti, avviare task e caricare materiali nei soli progetti autorizzati.",
    icon: ShieldCheck,
  },
  {
    id: "reviewer" as const,
    title: "Revisore Esterno / Ospite",
    badge: "Sola Lettura & Consegna",
    badgeClass: "bg-blue-500/15 text-blue-300",
    desc: "Può consultare i deliverable e inviare file di consegna, senza accesso alla configurazione della squadra.",
    icon: Eye,
  },
];

export function InviteCollaboratorModal({
  initialData,
  projects,
  onSave,
  onClose,
}: Props) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [email, setEmail] = useState(initialData?.email ?? "");
  const [role, setRole] = useState(initialData?.role ?? "");
  const [permission, setPermission] = useState<"admin" | "member" | "reviewer">(
    initialData?.permission ?? "member",
  );
  const [projectIds, setProjectIds] = useState<string[]>(initialData?.projectIds ?? []);

  function toggleProject(projId: string) {
    setProjectIds((prev) =>
      prev.includes(projId) ? prev.filter((id) => id !== projId) : [...prev, projId],
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;

    const payload: CollaboratorData = {
      name: name.trim(),
      email: email.trim(),
      role: role.trim() || (permission === "admin" ? "Amministratore" : "Collaboratore"),
      permission,
      projectIds: permission === "admin" ? [] : projectIds,
    };
    if (initialData?.id) {
      payload.id = initialData.id;
    }
    onSave(payload);
  }

  // Deduplicate projects and build distinct display labels
  const projectLabels = projects.map((p, index) => {
    const duplicates = projects.filter((other) => other.name === p.name);
    const label =
      duplicates.length > 1 ? `${p.name} (#${p.id.slice(0, 6)})` : p.name;
    return { ...p, displayLabel: label };
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/45 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-[#fbfbf8] rounded-2xl max-w-4xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-[#dce4d5] overflow-hidden">
        {/* Header - Stile Homun 2 Sidebar Palette */}
        <div className="px-8 py-6 flex items-center justify-between bg-[#203c32]">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-[#dcebd9] text-[#235940] flex items-center justify-center shrink-0">
              <UserPlus size={20} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white m-0 tracking-tight" style={{ fontFamily: "Manrope, sans-serif" }}>
                {initialData ? "Modifica Collaboratore" : "Invita un Membro nel Team"}
              </h3>
              <p className="text-xs text-[#a2b7a9] m-0 mt-0.5 leading-relaxed">
                Assegna credenziali, livello di autorizzazione e perimetro di lavoro.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[#a2b7a9] hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form Body - Griglia a due colonne ariosa */}
        <form onSubmit={handleSubmit} className="px-8 py-6 overflow-y-auto flex-1 space-y-6 bg-[#fbfbf8]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
            {/* Colonna Sinistra: Dati anagrafici e perimetro progetti */}
            <div className="space-y-4">
              <div>
                <span className="text-[11px] font-bold text-[#687a59] uppercase tracking-wider block mb-3">
                  Informazioni del Collaboratore
                </span>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-[#263832] block mb-1.5">
                      Nome Completo
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="Es. Giulia Bianchi"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full bg-white text-[#1c2d22] border border-[#dce4d5] rounded-lg px-3.5 py-2.5 text-xs focus:outline-none focus:border-[#203c32] focus:ring-1 focus:ring-[#203c32]/30 transition-all placeholder:text-[#8ca39d]"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-[#263832] block mb-1.5">
                      Email Aziendale o di Contatto
                    </label>
                    <input
                      type="email"
                      required
                      placeholder="giulia@azienda.it"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full bg-white text-[#1c2d22] border border-[#dce4d5] rounded-lg px-3.5 py-2.5 text-xs focus:outline-none focus:border-[#203c32] focus:ring-1 focus:ring-[#203c32]/30 transition-all placeholder:text-[#8ca39d]"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-[#263832] block mb-1.5">
                      Ruolo Professionale
                    </label>
                    <input
                      type="text"
                      placeholder="Es. Senior Full-Stack Dev, Consulente Fiscale..."
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className="w-full bg-white text-[#1c2d22] border border-[#dce4d5] rounded-lg px-3.5 py-2.5 text-xs focus:outline-none focus:border-[#203c32] focus:ring-1 focus:ring-[#203c32]/30 transition-all placeholder:text-[#8ca39d]"
                    />
                  </div>
                </div>
              </div>

              {/* Perimetro Progetti Autorizzati */}
              {permission !== "admin" && (
                <div className="pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold text-[#687a59] uppercase tracking-wider block">
                      Progetti Autorizzati
                    </span>
                    <span className="text-[11px] text-[#203c32] font-semibold">
                      {projectIds.length} selezionat{projectIds.length === 1 ? "o" : "i"}
                    </span>
                  </div>

                  {projectLabels.length === 0 ? (
                    <div className="p-4 rounded-xl bg-[#edf2e7] text-center text-xs text-[#647a6d]">
                      Nessun progetto creato nello spazio. Potrai assegnare i progetti in seguito.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                      {projectLabels.map((proj) => {
                        const isChecked = projectIds.includes(proj.id);
                        return (
                          <div
                            key={proj.id}
                            onClick={() => toggleProject(proj.id)}
                            className={`p-3 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-all duration-150 ${
                              isChecked
                                ? "bg-[#edf2e7] text-[#1c2d22] border border-[#203c32] shadow-sm"
                                : "bg-white text-[#263832] border border-[#dce4d5] hover:bg-[#f7f9f5]"
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0 pr-2">
                              <FolderGit2
                                size={15}
                                className={isChecked ? "text-[#203c32]" : "text-[#647a6d]"}
                              />
                              <span className="truncate font-medium">{proj.displayLabel}</span>
                            </div>
                            <div
                              className={`w-4 h-4 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                                isChecked
                                  ? "bg-[#203c32] text-white"
                                  : "border border-[#dce4d5]"
                              }`}
                            >
                              {isChecked && <Check size={11} />}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Colonna Destra: Livello di Autorizzazione (RBAC) */}
            <div>
              <span className="text-[11px] font-bold text-[#687a59] uppercase tracking-wider block mb-3">
                Livello di Autorizzazione (RBAC)
              </span>

              <div className="space-y-2.5">
                {PERMISSION_OPTIONS.map((opt) => {
                  const isSelected = permission === opt.id;
                  const Icon = opt.icon;
                  return (
                    <div
                      key={opt.id}
                      onClick={() => setPermission(opt.id)}
                      className={`p-4 rounded-xl cursor-pointer transition-all duration-150 ${
                        isSelected
                          ? "bg-white border-2 border-[#203c32] shadow-sm"
                          : "bg-[#edf2e7] border border-[rgba(104,122,89,0.15)] hover:bg-[#e6ece0]"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors ${
                              isSelected
                                ? "bg-[#203c32]"
                                : "border border-[#dce4d5] bg-white"
                            }`}
                          >
                            {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                          </div>
                          <Icon
                            size={16}
                            className={isSelected ? "text-[#203c32]" : "text-[#647a6d]"}
                          />
                          <strong className="text-xs font-semibold text-[#1c2d22]">
                            {opt.title}
                          </strong>
                        </div>
                        <span
                          className={`text-[10px] font-medium px-2 py-0.5 rounded ${opt.badgeClass}`}
                        >
                          {opt.badge}
                        </span>
                      </div>
                      <p className="text-[11.5px] text-[#647a6d] pl-6 m-0 leading-relaxed">
                        {opt.desc}
                      </p>
                    </div>
                  );
                })}
              </div>

              {permission === "admin" && (
                <div className="mt-4 p-3.5 rounded-xl bg-[#fef3c7] text-[#92400e] border border-[#fde68a] text-xs leading-relaxed">
                  L'amministratore gode di accesso incondizionato a tutti i progetti, impostazioni di sicurezza, credenziali dei modelli LLM e canali di comunicazione dello spazio.
                </div>
              )}
            </div>
          </div>

          {/* Footer - Azioni Spaziose */}
          <div className="pt-6 flex items-center justify-end gap-3 border-t border-[#dce4d5]">
            <button
              type="button"
              onClick={onClose}
              className="cv-unified-btn is-subtle text-xs px-4"
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !email.trim()}
              className="cv-unified-btn is-primary text-xs px-5"
            >
              <Check size={14} />
              <span>{initialData ? "Salva Modifiche" : "Conferma e Invita"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
