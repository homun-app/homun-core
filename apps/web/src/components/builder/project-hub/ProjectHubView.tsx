import { useState, useEffect } from "react";
import { FolderGit2, MessageSquare, Bot, FileText, BookMarked, UsersRound, Plus } from "lucide-react";
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
};

export function ProjectHubView({
  projects: simProjects,
  works,
  selectedId,
  onSelectProject,
  onOpenWork,
  onCreateWork,
  engineMode = false,
}: Props) {
  const engineStatus = useEngineStatus();
  const isEngine = engineMode && engineStatus.connection === "connected";

  // Navigation State
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [currentProjectId, setCurrentProjectId] = useState<string>(
    selectedId || (simProjects[0]?.id ?? ""),
  );
  const [creatingProject, setCreatingProject] = useState(false);

  // Engine Domain State
  const [engineProjectsList, setEngineProjectsList] = useState<EngineProject[]>([]);
  const [allAgents, setAllAgents] = useState<EngineAgentProfile[]>([]);
  const [models, setModels] = useState<Array<{ id: string; name: string; kind?: "local" | "remote" }>>([]);
  const [projectMaterials, setProjectMaterials] = useState<EngineMaterial[]>([]);
  const [globalMemories, setGlobalMemories] = useState<EngineMemoryNote[]>([]);
  const [projectMemories, setProjectMemories] = useState<EngineMemoryNote[]>([]);
  const [agentConfigs, setAgentConfigs] = useState<Record<string, ProjectAgentConfig[]>>({});
  const [projectMembers, setProjectMembers] = useState<Record<string, ProjectMember[]>>({});
  const [error, setError] = useState<unknown>(null);

  // Sync selectedId from props
  useEffect(() => {
    if (selectedId) {
      setCurrentProjectId(selectedId);
    } else if (!currentProjectId && (engineProjectsList[0]?.id || simProjects[0]?.id)) {
      setCurrentProjectId(engineProjectsList[0]?.id || simProjects[0]?.id || "");
    }
  }, [selectedId, engineProjectsList, simProjects]);

  // Load engine data if engine is active
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

  // Load project-specific data when currentProjectId changes
  useEffect(() => {
    if (!currentProjectId) return;
    if (isEngine) {
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
    }
  }, [currentProjectId, isEngine]);

  // Resolve current active project info
  const activeEngineProj = engineProjectsList.find((p) => p.id === currentProjectId);
  const activeSimProj = simProjects.find((p) => p.id === currentProjectId);

  // Project items for switcher dropdown with disambiguation
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
      desc: childWorks.length > 0 ? `${childWorks.length} ${childWorks.length === 1 ? "lavoro" : "lavori"}: ${childWorks.map((w) => w.title).join(", ")}` : briefDesc || undefined,
      badge: childWorks.length > 0 ? `${childWorks.length}` : undefined,
    };
  });

  const currentOption = projectOptions.find((opt) => opt.value === currentProjectId);
  const projectName = currentOption?.label || activeEngineProj?.name || activeSimProj?.name || "Progetto";
  const projectBrief = activeEngineProj?.description || activeSimProj?.brief || "Spazio di lavoro contestuale Homun.";

  // Handlers for Materials
  async function handleAddTextMaterial(title: string, text: string) {
    if (isEngine) {
      await createEngineMaterial({
        projectId: currentProjectId,
        title,
        text,
        kind: "note",
      });
      const updated = await listEngineMaterials({ projectId: currentProjectId });
      setProjectMaterials(updated);
    } else {
      const simMat: EngineMaterial = {
        id: `sim_mat_${Date.now()}`,
        workspace_id: "default",
        project_id: currentProjectId,
        title,
        text,
        kind: "note",
        version: 1,
        status: "active",
        created_by: "Tu",
        source_uri: null,
        content_hash: null,
        mime_type: "text/plain",
        origin_name: null,
      };
      setProjectMaterials((prev) => [simMat, ...prev]);
    }
  }

  async function handleUploadFileMaterial(file: File) {
    if (isEngine) {
      await ingestEngineMaterial({
        projectId: currentProjectId,
        file,
        title: file.name,
      });
      const updated = await listEngineMaterials({ projectId: currentProjectId });
      setProjectMaterials(updated);
    } else {
      const simFile: EngineMaterial = {
        id: `sim_file_${Date.now()}`,
        workspace_id: "default",
        project_id: currentProjectId,
        title: file.name,
        text: `File caricato: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
        kind: "document",
        version: 1,
        status: "active",
        created_by: "Tu",
        source_uri: null,
        content_hash: null,
        mime_type: file.type || "application/octet-stream",
        origin_name: file.name,
      };
      setProjectMaterials((prev) => [simFile, ...prev]);
    }
  }

  async function handleArchiveMaterial(materialId: string) {
    if (isEngine) {
      const mat = projectMaterials.find((m) => m.id === materialId);
      await archiveEngineMaterial({
        materialId,
        expectedVersion: mat?.version ?? 1,
      });
    }
    setProjectMaterials((prev) => prev.filter((m) => m.id !== materialId));
  }

  // Handlers for Memories
  async function handleAddProjectMemory(text: string) {
    if (isEngine) {
      const note = await addEngineMemory({
        text,
        actorId: "person_fabio",
        projectId: currentProjectId,
      });
      setProjectMemories((prev) => [note, ...prev]);
    } else {
      setProjectMemories((prev) => [
        {
          id: `sim_mem_${Date.now()}`,
          workspace_id: "default",
          text,
          work_id: null,
          project_id: currentProjectId,
          status: "approved",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: "Tu",
        },
        ...prev,
      ]);
    }
  }

  async function handlePromoteToGlobal(note: EngineMemoryNote) {
    if (isEngine) {
      try {
        const globalNote = await addEngineMemory({
          text: note.text,
          actorId: "person_fabio",
          projectId: "global",
        });
        setGlobalMemories((prev) => [globalNote, ...prev]);
        await deleteEngineMemory({
          memoryId: note.id,
          actorId: "person_fabio",
        });
        setProjectMemories((prev) => prev.filter((m) => m.id !== note.id));
      } catch (err) {
        setError(err);
      }
    } else {
      setGlobalMemories((prev) => [{ ...note, id: `global_${note.id}`, project_id: null }, ...prev]);
      setProjectMemories((prev) => prev.filter((m) => m.id !== note.id));
    }
  }

  async function handleDeleteMemory(memoryId: string) {
    if (isEngine) {
      await deleteEngineMemory({
        memoryId,
        actorId: "person_fabio",
      });
    }
    setProjectMemories((prev) => prev.filter((m) => m.id !== memoryId));
  }

  // Handlers for Agents
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
      } catch (err) {
        setError(err);
      }
    }
  }

  // Handlers for RBAC
  const currentMembers = projectMembers[currentProjectId] || [
    { id: "collab_fabio", name: "Fabio", email: "fabio@homun.internal", permission: "admin" },
    { id: "collab_marco", name: "Marco Dev", email: "marco.dev@remote.internal", permission: "member" },
  ];

  function handleUpdatePermission(memberId: string, permission: "admin" | "member" | "reviewer") {
    setProjectMembers((prev) => ({
      ...prev,
      [currentProjectId]: currentMembers.map((m) =>
        m.id === memberId ? { ...m, permission } : m,
      ),
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

  // Create Project
  async function handleCreateProject(name: string, brief: string) {
    if (isEngine) {
      const created = await createEngineProject({
        name,
        description: brief,
      });
      const projs = await listEngineProjects();
      setEngineProjectsList(projs);
      setCurrentProjectId(created.projectId);
      onSelectProject(created.projectId);
    } else {
      const newId = `proj_${Date.now()}`;
      const newProj: SpaceProject = {
        id: newId,
        name,
        teamId: "",
        brief,
      };
      simProjects.push(newProj);
      setCurrentProjectId(newId);
      onSelectProject(newId);
    }
  }

  const projectWorks = works.filter((w) => w.projectId === currentProjectId);

  return (
    <div className="ph-hub" aria-label={`Hub di Progetto: ${projectName}`}>
      {error ? (
        <div style={{ padding: "8px 24px" }}>
          <HomunErrorNotice error={error} />
        </div>
      ) : null}

      {/* Unified Project Header */}
      <div className="ph-header">
        <div className="ph-header-top">
          <div className="ph-header-titles">
            <div className="ph-title-row">
              <FolderGit2 size={22} className="text-[#157a6e] shrink-0" />
              {projectOptions.length > 1 ? (
                <div className="ph-title-heading-wrapper">
                  <SettingsCustomSelect
                    variant="heading"
                    searchable={true}
                    searchPlaceholder="Cerca progetto per nome o contenuto..."
                    value={currentProjectId}
                    onChange={(val) => {
                      if (val) {
                        setCurrentProjectId(val);
                        onSelectProject(val);
                      }
                    }}
                    options={projectOptions}
                    placeholder={projectName}
                    footerAction={{
                      label: "Nuovo Progetto",
                      onClick: () => setCreatingProject(true),
                    }}
                    footerMeta={`${projectOptions.length} ${
                      projectOptions.length === 1 ? "progetto" : "progetti"
                    }`}
                  />
                </div>
              ) : (
                <h1 className="ph-title">{projectName}</h1>
              )}
              <span
                className={
                  isEngine
                    ? "ph-source-badge ph-source-badge--engine"
                    : "ph-source-badge ph-source-badge--simulation"
                }
              >
                Fonte: {isEngine ? "motore" : "simulazione"}
              </span>
            </div>
            {projectBrief && <p className="ph-brief">{projectBrief}</p>}
          </div>

          <div className="ph-header-actions">
            <button
              type="button"
              className="ph-btn-secondary"
              onClick={() => setCreatingProject(true)}
              title="Crea un nuovo progetto nello spazio"
            >
              <Plus size={13} />
              <span>Nuovo Progetto</span>
            </button>
            <button
              type="button"
              className="ph-btn-primary"
              onClick={() => (onCreateWork ? onCreateWork(currentProjectId) : null)}
              title="Avvia una nuova sessione di lavoro per questo progetto"
            >
              <Plus size={14} />
              <span>Nuovo Lavoro</span>
            </button>
          </div>
        </div>

        {/* Tab Bar Navigation */}
        <nav className="ph-tabs" aria-label="Sezioni del Progetto">
          <button
            className={`ph-tab ${activeTab === "overview" ? "ph-tab--active" : ""}`}
            onClick={() => setActiveTab("overview")}
          >
            <MessageSquare size={14} />
            Panoramica & Lavori
            <span className="ph-tab-pill">{projectWorks.length}</span>
          </button>

          <button
            className={`ph-tab ${activeTab === "agents" ? "ph-tab--active" : ""}`}
            onClick={() => setActiveTab("agents")}
          >
            <Bot size={14} />
            Squadra & Agenti
            <span className="ph-tab-pill">{currentAgentConfigs.length}</span>
          </button>

          <button
            className={`ph-tab ${activeTab === "materials" ? "ph-tab--active" : ""}`}
            onClick={() => setActiveTab("materials")}
          >
            <FileText size={14} />
            Documenti & Materiali
            <span className="ph-tab-pill">{projectMaterials.length}</span>
          </button>

          <button
            className={`ph-tab ${activeTab === "memory" ? "ph-tab--active" : ""}`}
            onClick={() => setActiveTab("memory")}
          >
            <BookMarked size={14} />
            Memoria & Vincoli
            <span className="ph-tab-pill">{projectMemories.length}</span>
          </button>

          <button
            className={`ph-tab ${activeTab === "rbac" ? "ph-tab--active" : ""}`}
            onClick={() => setActiveTab("rbac")}
          >
            <UsersRound size={14} />
            Accessi & Deleghe
            <span className="ph-tab-pill">{currentMembers.length}</span>
          </button>
        </nav>
      </div>

      {/* 4. Tab Body */}
      <div className="ph-body">
        {activeTab === "overview" && (
          <ProjectHubOverviewTab
            projectId={currentProjectId}
            projectName={projectName}
            works={projectWorks}
            onOpenWork={onOpenWork}
            onNewWork={() => (onCreateWork ? onCreateWork(currentProjectId) : null)}
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
            onImportDeliverable={async (file) => {
              await handleUploadFileMaterial(file);
            }}
          />
        )}
      </div>

      <ProjectCreateModal
        isOpen={creatingProject}
        onClose={() => setCreatingProject(false)}
        onCreateProject={handleCreateProject}
      />
    </div>
  );
}
