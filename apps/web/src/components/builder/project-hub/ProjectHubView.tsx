import { useState, useEffect } from "react";
import { MessageSquare, Bot, FileText, BookMarked, UsersRound, Plus, ArrowUp, PanelRightClose } from "lucide-react";
import "./project-hub.css";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { SettingsCustomSelect, type SelectOption } from "../SettingsCustomSelect";
import { ProjectCreateModal } from "./ProjectHubContextBar";
import { ProjectHubOverviewTab } from "./ProjectHubOverviewTab";
import { ProjectHubAgentsTab, type ProjectAgentConfig } from "./ProjectHubAgentsTab";
import { ProjectHubMaterialsTab } from "./ProjectHubMaterialsTab";
import { ProjectHubMemoryTab } from "./ProjectHubMemoryTab";
import { ProjectHubRbacTab, type ProjectMember } from "./ProjectHubRbacTab";
import type { SpaceProject } from "../ConversationSpace";
import type { Work } from "../conversation-types";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  listEngineProjects, createEngineProject, updateEngineProject, listEngineMaterials, createEngineMaterial,
  ingestEngineMaterial, archiveEngineMaterial, type EngineProject, type EngineMaterial,
} from "@/lib/engine-projects-client";
import {
  listEngineMemories, addEngineMemory, deleteEngineMemory, type EngineMemoryNote,
} from "@/lib/engine-memory-client";
import { listEngineAgents, type EngineAgentProfile } from "@/lib/engine-agents-client";
import { listModelConnections } from "@/lib/engine-models-client";

type TabId = "overview" | "agents" | "materials" | "memory" | "rbac";

type Props = {
  projects: SpaceProject[];
  works: Work[];
  selectedId: string;
  onSelectProject: (id: string) => void;
  onOpenWork: (id: string) => void;
  onCreateWork?: ((projectId: string) => void) | undefined;
  engineMode?: boolean | undefined;
  sidebarOpen?: boolean | undefined;
  onOpenSidebar?: (() => void) | undefined;
};

export function ProjectHubView({
  projects: simProjects,
  works,
  selectedId,
  onSelectProject,
  onOpenWork,
  onCreateWork,
  engineMode = false,
  sidebarOpen = true,
  onOpenSidebar,
}: Props) {
  const engineStatus = useEngineStatus();
  const isEngine = engineMode && engineStatus.connection === "connected";

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [currentProjectId, setCurrentProjectId] = useState<string>(
    selectedId || (simProjects[0]?.id ?? ""),
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [promptValue, setPromptValue] = useState("");

  const [engineProjectsList, setEngineProjectsList] = useState<EngineProject[]>([]);
  const [allAgents, setAllAgents] = useState<EngineAgentProfile[]>([]);
  const [models, setModels] = useState<Array<{ id: string; name: string; kind?: "local" | "remote" }>>([]);
  const [projectMaterials, setProjectMaterials] = useState<EngineMaterial[]>([]);
  const [globalMemories, setGlobalMemories] = useState<EngineMemoryNote[]>([]);
  const [projectMemories, setProjectMemories] = useState<EngineMemoryNote[]>([]);
  const [agentConfigs, setAgentConfigs] = useState<Record<string, ProjectAgentConfig[]>>({});
  const [projectMembers, setProjectMembers] = useState<Record<string, ProjectMember[]>>({});
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (selectedId === "new") {
      setCreatingProject(true);
      if (!currentProjectId && (engineProjectsList[0]?.id || simProjects[0]?.id)) {
        setCurrentProjectId(engineProjectsList[0]?.id || simProjects[0]?.id || "");
      }
    } else if (selectedId) {
      setCurrentProjectId(selectedId);
    } else if (!currentProjectId && (engineProjectsList[0]?.id || simProjects[0]?.id)) {
      setCurrentProjectId(engineProjectsList[0]?.id || simProjects[0]?.id || "");
    }
  }, [selectedId, engineProjectsList, simProjects]);

  useEffect(() => {
    if (!isEngine) return;
    async function loadData() {
      try {
        const [projs, agts, modsResp, gMems] = await Promise.all([
          listEngineProjects(),
          listEngineAgents().catch(() => [] as EngineAgentProfile[]),
          listModelConnections().catch(() => null),
          listEngineMemories({ projectId: "global" }).catch(() => [] as EngineMemoryNote[]),
        ]);
        setEngineProjectsList(projs);
        setAllAgents(agts);
        const connectionItems = modsResp?.items ?? [];
        setModels(
          connectionItems.map((m) => ({
            id: m.id,
            name: m.display_name,
            kind: m.kind as "local" | "remote",
          })),
        );
        setGlobalMemories(gMems);
      } catch (err) {
        setError(err);
      }
    }
    void loadData();
  }, [isEngine]);

  useEffect(() => {
    if (!currentProjectId || !isEngine) return;
    void (async () => {
      try {
        const [mats, pMems] = await Promise.all([
          listEngineMaterials({ projectId: currentProjectId }).catch(() => [] as EngineMaterial[]),
          listEngineMemories({ projectId: currentProjectId }).catch(() => [] as EngineMemoryNote[]),
        ]);
        setProjectMaterials(mats);
        setProjectMemories(pMems);
      } catch (err) {
        setError(err);
      }
    })();
  }, [currentProjectId, isEngine]);

  const activeEngineProj = engineProjectsList.find((p) => p.id === currentProjectId);
  const activeSimProj = simProjects.find((p) => p.id === currentProjectId);

  const rawList = isEngine ? engineProjectsList : simProjects;
  const nameCounts = new Map<string, number>();
  for (const p of rawList) {
    nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
  }

  const projectOptions: SelectOption[] = rawList.map((p) => {
    const rawName = p.name || p.id;
    let label = rawName;
    const childWorks = works.filter((w) => w.projectId === p.id);
    const briefDesc = "brief" in p ? p.brief : p.description;
    const firstChild = childWorks[0];
    if ((nameCounts.get(rawName) || 0) > 1) {
      if (firstChild) {
        const distinctPart = firstChild.title.replace(rawName, "").replace(/^[·\s-]+/, "");
        label = distinctPart ? `${rawName} · ${distinctPart}` : `${rawName} (${firstChild.title})`;
      } else if (briefDesc) {
        label = `${rawName} · ${briefDesc}`;
      } else {
        label = `${rawName} · ${p.id.slice(-6)}`;
      }
    }
    return {
      value: p.id,
      label,
      desc: childWorks.length > 0
        ? `${childWorks.length} ${childWorks.length === 1 ? "lavoro" : "lavori"}: ${childWorks.map((w) => w.title).join(", ")}`
        : briefDesc || undefined,
      badge: childWorks.length > 0 ? `${childWorks.length}` : undefined,
    };
  });

  const currentOption = projectOptions.find((opt) => opt.value === currentProjectId);
  const projectName = currentOption?.label || activeEngineProj?.name || activeSimProj?.name || "Progetto";

  // --- Material handlers ---
  async function handleAddTextMaterial(title: string, text: string) {
    if (isEngine) {
      await createEngineMaterial({ projectId: currentProjectId, title, text, kind: "note" });
      const updated = await listEngineMaterials({ projectId: currentProjectId });
      setProjectMaterials(updated);
    } else {
      const simMat: EngineMaterial = {
        id: `sim_mat_${Date.now()}`, workspace_id: "default", project_id: currentProjectId,
        title, text, kind: "note", version: 1, status: "active", created_by: "Tu",
        source_uri: null, content_hash: null, mime_type: "text/plain", origin_name: null,
      };
      setProjectMaterials((prev) => [simMat, ...prev]);
    }
  }

  async function handleUploadFileMaterial(file: File) {
    if (isEngine) {
      await ingestEngineMaterial({ projectId: currentProjectId, file, title: file.name });
      const updated = await listEngineMaterials({ projectId: currentProjectId });
      setProjectMaterials(updated);
    } else {
      const simFile: EngineMaterial = {
        id: `sim_file_${Date.now()}`, workspace_id: "default", project_id: currentProjectId,
        title: file.name, text: `File caricato: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
        kind: "document", version: 1, status: "active", created_by: "Tu",
        source_uri: null, content_hash: null, mime_type: file.type || "application/octet-stream",
        origin_name: file.name,
      };
      setProjectMaterials((prev) => [simFile, ...prev]);
    }
  }

  async function handleArchiveMaterial(materialId: string) {
    if (isEngine) {
      const mat = projectMaterials.find((m) => m.id === materialId);
      await archiveEngineMaterial({ materialId, expectedVersion: mat?.version ?? 1 });
    }
    setProjectMaterials((prev) => prev.filter((m) => m.id !== materialId));
  }

  // --- Memory handlers ---
  async function handleAddProjectMemory(text: string) {
    if (isEngine) {
      const note = await addEngineMemory({ text, actorId: "person_fabio", projectId: currentProjectId });
      setProjectMemories((prev) => [note, ...prev]);
    } else {
      setProjectMemories((prev) => [{
        id: `sim_mem_${Date.now()}`, workspace_id: "default", text, work_id: null,
        project_id: currentProjectId, status: "approved",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by: "Tu",
      }, ...prev]);
    }
  }

  async function handlePromoteToGlobal(note: EngineMemoryNote) {
    if (isEngine) {
      try {
        const globalNote = await addEngineMemory({ text: note.text, actorId: "person_fabio", projectId: "global" });
        setGlobalMemories((prev) => [globalNote, ...prev]);
        await deleteEngineMemory({ memoryId: note.id, actorId: "person_fabio" });
        setProjectMemories((prev) => prev.filter((m) => m.id !== note.id));
      } catch (err) { setError(err); }
    } else {
      setGlobalMemories((prev) => [{ ...note, id: `global_${note.id}`, project_id: null }, ...prev]);
      setProjectMemories((prev) => prev.filter((m) => m.id !== note.id));
    }
  }

  async function handleDeleteMemory(memoryId: string) {
    if (isEngine) await deleteEngineMemory({ memoryId, actorId: "person_fabio" });
    setProjectMemories((prev) => prev.filter((m) => m.id !== memoryId));
  }

  // --- Agent handlers ---
  const currentAgentConfigs: ProjectAgentConfig[] = agentConfigs[currentProjectId] || (
    activeEngineProj && allAgents.length > 0
      ? allAgents.map((ag) => ({
          agentId: ag.id,
          modelOverride: activeEngineProj.agent_model_overrides?.[ag.id] ?? "",
          enabledTools: activeEngineProj.agent_tool_overrides?.[ag.id] ?? ["web_search", "document_read"],
        }))
      : [
          { agentId: "elio", modelOverride: "", enabledTools: ["web_search", "document_read"] },
          { agentId: "vera", modelOverride: "", enabledTools: ["web_search"] },
        ]
  );

  async function handleSaveAgentConfigs(configs: ProjectAgentConfig[]) {
    setAgentConfigs((prev) => ({ ...prev, [currentProjectId]: configs }));
    if (isEngine && currentProjectId) {
      try {
        const agentModelOverrides: Record<string, string> = {};
        const agentToolOverrides: Record<string, string[]> = {};
        for (const cfg of configs) {
          if (cfg.modelOverride) agentModelOverrides[cfg.agentId] = cfg.modelOverride;
          if (cfg.enabledTools?.length) agentToolOverrides[cfg.agentId] = cfg.enabledTools;
        }
        await updateEngineProject({
          projectId: currentProjectId,
          expectedVersion: activeEngineProj?.version ?? 1,
          agentModelOverrides,
          agentToolOverrides,
        });
        const updatedList = await listEngineProjects();
        setEngineProjectsList(updatedList);
      } catch (err) { setError(err); }
    }
  }

  // --- RBAC handlers ---
  const currentMembers = projectMembers[currentProjectId] || [
    { id: "collab_fabio", name: "Fabio", email: "fabio@homun.internal", permission: "admin" },
    { id: "collab_marco", name: "Marco Dev", email: "marco.dev@remote.internal", permission: "member" },
  ];

  function handleUpdatePermission(memberId: string, permission: "admin" | "member" | "reviewer") {
    setProjectMembers((prev) => ({
      ...prev,
      [currentProjectId]: currentMembers.map((m) => m.id === memberId ? { ...m, permission } : m),
    }));
  }

  function handleRemoveMember(memberId: string) {
    setProjectMembers((prev) => ({
      ...prev,
      [currentProjectId]: currentMembers.filter((m) => m.id !== memberId),
    }));
  }

  function handleAddMember(member: ProjectMember) {
    setProjectMembers((prev) => ({
      ...prev,
      [currentProjectId]: [...currentMembers, member],
    }));
  }

  // --- Project creation ---
  async function handleCreateProject(name: string, brief: string) {
    if (isEngine) {
      const created = await createEngineProject({ name, description: brief });
      const projs = await listEngineProjects();
      setEngineProjectsList(projs);
      setCurrentProjectId(created.projectId);
      onSelectProject(created.projectId);
    } else {
      const newId = `proj_${Date.now()}`;
      simProjects.push({ id: newId, name, teamId: "", brief });
      setCurrentProjectId(newId);
      onSelectProject(newId);
    }
  }

  function handlePromptSubmit() {
    if (!promptValue.trim()) return;
    onCreateWork?.(currentProjectId);
    setPromptValue("");
  }

  const projectWorks = works.filter((w) => w.projectId === currentProjectId);

  return (
    <div className="ph-hub" aria-label={`Hub di Progetto: ${projectName}`}>
      {error != null && (
        <div style={{ padding: "8px 20px" }}>
          <HomunErrorNotice error={error} />
        </div>
      )}

      {/* Single Unified Topbar */}
      <header className="cw-topbar">
        <div className="ph-topbar-breadcrumb-group">
          {!sidebarOpen && onOpenSidebar && (
            <button
              className="cw-icon"
              aria-label="Apri barra laterale"
              title="Apri barra laterale"
              onClick={onOpenSidebar}
            >
              <PanelRightClose size={19} />
            </button>
          )}
          <span className="ph-breadcrumb-root">Progetti</span>
          <span className="ph-breadcrumb-sep">/</span>
          {projectOptions.length > 1 ? (
            <div className="ph-title-heading-wrapper">
              <SettingsCustomSelect
                variant="heading"
                searchable={true}
                searchPlaceholder="Cerca progetto..."
                value={currentProjectId}
                onChange={(val) => {
                  if (val) { setCurrentProjectId(val); onSelectProject(val); }
                }}
                options={projectOptions}
                placeholder={projectName}
                footerAction={{ label: "Nuovo Progetto", onClick: () => setCreatingProject(true) }}
                footerMeta={`${projectOptions.length} ${projectOptions.length === 1 ? "progetto" : "progetti"}`}
              />
            </div>
          ) : (
            <span className="ph-topbar-name">{projectName}</span>
          )}
          <span className={isEngine ? "ph-source-badge ph-source-badge--engine" : "ph-source-badge ph-source-badge--simulation"}>
            {isEngine ? "motore" : "sim"}
          </span>
        </div>

        <div className="ph-topbar-contextual">
          <div className="ph-icon-tabs" role="tablist" aria-label="Sezioni del progetto">
            <button role="tab" aria-selected={activeTab === "overview"}
              title={`Lavori${projectWorks.length > 0 ? ` (${projectWorks.length})` : ""}`}
              className={`ph-icon-tab ${activeTab === "overview" ? "is-active" : ""}`}
              onClick={() => setActiveTab("overview")}>
              <MessageSquare size={15} />
              {projectWorks.length > 0 && <span className="ph-icon-tab-badge">{projectWorks.length}</span>}
            </button>
            <button role="tab" aria-selected={activeTab === "agents"}
              title="Squadra & Agenti"
              className={`ph-icon-tab ${activeTab === "agents" ? "is-active" : ""}`}
              onClick={() => setActiveTab("agents")}>
              <Bot size={15} />
            </button>
            <button role="tab" aria-selected={activeTab === "materials"}
              title="Documenti & Materiali"
              className={`ph-icon-tab ${activeTab === "materials" ? "is-active" : ""}`}
              onClick={() => setActiveTab("materials")}>
              <FileText size={15} />
            </button>
            <button role="tab" aria-selected={activeTab === "memory"}
              title="Memoria & Vincoli"
              className={`ph-icon-tab ${activeTab === "memory" ? "is-active" : ""}`}
              onClick={() => setActiveTab("memory")}>
              <BookMarked size={15} />
            </button>
            <button role="tab" aria-selected={activeTab === "rbac"}
              title="Accessi & Deleghe"
              className={`ph-icon-tab ${activeTab === "rbac" ? "is-active" : ""}`}
              onClick={() => setActiveTab("rbac")}>
              <UsersRound size={15} />
            </button>
          </div>
          <span className="ph-topbar-sep" aria-hidden="true" />
          <button className="ph-icon-tab" title="Nuovo lavoro in questo progetto"
            onClick={() => onCreateWork?.(currentProjectId)}>
            <Plus size={15} />
          </button>
        </div>
      </header>

      {/* Tab body */}
      <div className="ph-body">
        {activeTab === "overview" && (
          <ProjectHubOverviewTab
            projectId={currentProjectId}
            projectName={projectName}
            works={projectWorks}
            onOpenWork={onOpenWork}
            onNewWork={() => onCreateWork?.(currentProjectId)}
          />
        )}
        {activeTab === "agents" && (
          <ProjectHubAgentsTab
            projectId={currentProjectId}
            projectName={projectName}
            allAgents={allAgents}
            assignedAgentConfigs={currentAgentConfigs}
            availableModels={models}
            onSaveAgentConfigs={handleSaveAgentConfigs}
          />
        )}
        {activeTab === "materials" && (
          <ProjectHubMaterialsTab
            projectId={currentProjectId}
            projectName={projectName}
            materials={projectMaterials}
            onAddTextMaterial={handleAddTextMaterial}
            onUploadFileMaterial={handleUploadFileMaterial}
            onArchiveMaterial={handleArchiveMaterial}
          />
        )}
        {activeTab === "memory" && (
          <ProjectHubMemoryTab
            projectId={currentProjectId}
            projectName={projectName}
            globalMemories={globalMemories}
            projectMemories={projectMemories}
            onAddProjectMemory={handleAddProjectMemory}
            onPromoteToGlobal={handlePromoteToGlobal}
            onDeleteMemory={handleDeleteMemory}
          />
        )}
        {activeTab === "rbac" && (
          <ProjectHubRbacTab
            projectId={currentProjectId}
            projectName={projectName}
            members={currentMembers}
            onUpdateMemberPermission={handleUpdatePermission}
            onRemoveMember={handleRemoveMember}
            onAddMember={handleAddMember}
            onImportDeliverable={async (file) => { await handleUploadFileMaterial(file); }}
          />
        )}
      </div>

      {/* Always-visible prompt — agentic entry point for this project */}
      <div className="ph-prompt">
        <div className="ph-prompt-box">
          <input
            type="text"
            className="ph-prompt-input"
            placeholder="Chiedi o assegna un compito in questo progetto..."
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handlePromptSubmit(); }
            }}
          />
          <button className="ph-prompt-send" onClick={handlePromptSubmit}
            title="Avvia" disabled={!promptValue.trim()}>
            <ArrowUp size={14} />
          </button>
        </div>
      </div>

      <ProjectCreateModal
        isOpen={creatingProject}
        onClose={() => setCreatingProject(false)}
        onCreateProject={handleCreateProject}
      />
    </div>
  );
}
