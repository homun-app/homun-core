import { useState, useEffect } from "react";
import { Bot, Brain, Check, Globe, Laptop, Plus, Settings2, Shield, Trash2, Wrench } from "lucide-react";
import { SettingsCustomSelect, type SelectOption } from "../SettingsCustomSelect";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";

export type ProjectAgentConfig = {
  agentId: string;
  modelOverride?: string; // empty means inherit default
  enabledTools: string[];
};

type Props = {
  projectId: string;
  projectName: string;
  allAgents: EngineAgentProfile[];
  assignedAgentConfigs: ProjectAgentConfig[];
  availableModels: Array<{ id: string; name: string; kind?: "local" | "remote" }>;
  onSaveAgentConfigs: (configs: ProjectAgentConfig[]) => void;
};

export function ProjectHubAgentsTab({
  projectId,
  projectName,
  allAgents,
  assignedAgentConfigs,
  availableModels,
  onSaveAgentConfigs,
}: Props) {
  const [configs, setConfigs] = useState<ProjectAgentConfig[]>(assignedAgentConfigs);
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    setConfigs(assignedAgentConfigs);
  }, [assignedAgentConfigs]);

  const assignedAgentIds = new Set(configs.map((c) => c.agentId));
  const unassignedAgents = allAgents.filter((a) => !assignedAgentIds.has(a.id));

  const modelOptions: SelectOption[] = [
    {
      value: "",
      label: "Eredita default aziendale (Consigliato)",
      desc: "Usa il modello LLM stabilito nelle impostazioni globali dello spazio.",
      badge: "Default",
    },
    ...availableModels.map((m) => ({
      value: m.id,
      label: m.name,
      desc: m.kind === "local" ? "Elaborazione locale privata (Ollama)" : "Provider remoto via API",
      badge: m.kind === "local" ? "Locale" : "Cloud",
    })),
  ];

  function handleModelChange(agentId: string, modelId: string) {
    const updated = configs.map((c) =>
      c.agentId === agentId ? { ...c, modelOverride: modelId } : c,
    );
    setConfigs(updated);
    onSaveAgentConfigs(updated);
  }

  function handleToggleTool(agentId: string, toolId: string) {
    const updated = configs.map((c) => {
      if (c.agentId !== agentId) return c;
      const tools = c.enabledTools.includes(toolId)
        ? c.enabledTools.filter((t) => t !== toolId)
        : [...c.enabledTools, toolId];
      return { ...c, enabledTools: tools };
    });
    setConfigs(updated);
    onSaveAgentConfigs(updated);
  }

  function handleAddAgent(agentId: string) {
    const updated = [
      ...configs,
      {
        agentId,
        modelOverride: "",
        enabledTools: ["web_search", "document_read"],
      },
    ];
    setConfigs(updated);
    onSaveAgentConfigs(updated);
    setAssigning(false);
  }

  function handleRemoveAgent(agentId: string) {
    const updated = configs.filter((c) => c.agentId !== agentId);
    setConfigs(updated);
    onSaveAgentConfigs(updated);
  }

  return (
    <div className="ph-tab-content">
      <div className="ph-card">
        <div className="ph-card-header">
          <div>
            <h3 className="ph-card-title">
              <Bot size={16} className="text-[#8fe3d0]" />
              Agenti Assegnati a {projectName}
            </h3>
            <p className="ph-card-subtitle">
              Scegli quali agenti operano su questo perimetro, imposta override di modelli per privacy o costi e attiva i tool necessari.
            </p>
          </div>
          {unassignedAgents.length > 0 && (
            <button className="ph-btn-primary" onClick={() => setAssigning(!assigning)}>
              <Plus size={15} />
              Assegna Agente
            </button>
          )}
        </div>

        {/* Quick Assign Dropdown Drawer */}
        {assigning && (
          <div
            style={{
              padding: "14px 16px",
              background: "#0a1310",
              border: "1px solid rgba(143, 227, 208, 0.2)",
              borderRadius: 10,
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <strong style={{ fontSize: 13, color: "#f4f1ee" }}>Seleziona un collaboratore artificiale:</strong>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                {unassignedAgents.map((agent) => (
                  <button
                    key={agent.id}
                    className="ph-btn-secondary"
                    onClick={() => handleAddAgent(agent.id)}
                    style={{ fontSize: 12, padding: "6px 12px" }}
                  >
                    <Plus size={13} />
                    {agent.name} ({agent.role || "Specialist"})
                  </button>
                ))}
              </div>
            </div>
            <button className="ph-btn-secondary" onClick={() => setAssigning(false)}>
              Annulla
            </button>
          </div>
        )}

        {configs.length === 0 ? (
          <div className="ph-empty">
            <Bot className="ph-empty-icon" />
            <h4 className="ph-empty-title">Nessun agente assegnato al progetto</h4>
            <p className="ph-empty-desc">
              Assegna almeno un agente per iniziare a delegare compiti su {projectName}.
            </p>
          </div>
        ) : (
          <div className="ph-agent-grid">
            {configs.map((config) => {
              const agentProfile = allAgents.find((a) => a.id === config.agentId) || {
                id: config.agentId,
                name: config.agentId,
                role: "Agente Homun",
              };
              const isOverridden = Boolean(config.modelOverride);

              return (
                <div key={config.agentId} className="ph-agent-card">
                  <div className="ph-agent-head">
                    <div className="ph-agent-profile">
                      <div className="ph-agent-avatar">
                        {agentProfile.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <div className="ph-agent-name">{agentProfile.name}</div>
                        <div className="ph-agent-role">{agentProfile.role || "Assistente Specializzato"}</div>
                      </div>
                    </div>
                    <button
                      className="ph-btn-secondary"
                      onClick={() => handleRemoveAgent(config.agentId)}
                      title="Rimuovi dal progetto"
                      style={{ padding: "6px 8px" }}
                    >
                      <Trash2 size={14} className="text-red-400" />
                    </button>
                  </div>

                  {/* LLM Model Selection with Override Indicator */}
                  <div className="ph-override-box">
                    <div className="ph-override-label">
                      <span>Modello LLM Esecutivo</span>
                      <span className={isOverridden ? "ph-override-badge" : "ph-override-badge ph-override-badge--default"}>
                        {isOverridden ? "Override attivo" : "Default dello spazio"}
                      </span>
                    </div>
                    <SettingsCustomSelect
                      value={config.modelOverride || ""}
                      onChange={(val) => handleModelChange(config.agentId, val)}
                      options={modelOptions}
                      placeholder="Eredita default aziendale"
                    />
                  </div>

                  {/* Tool Capabilities for this Project */}
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#8c9e99" }}>
                      Strumenti autorizzati nel progetto
                    </span>
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      {[
                        { id: "web_search", label: "Web Search", icon: Globe },
                        { id: "document_read", label: "Grounding Documenti", icon: Brain },
                        { id: "terminal_mcp", label: "Strumenti MCP / Codice", icon: Wrench },
                      ].map((tool) => {
                        const enabled = config.enabledTools.includes(tool.id);
                        const Icon = tool.icon;
                        return (
                          <button
                            key={tool.id}
                            type="button"
                            onClick={() => handleToggleTool(config.agentId, tool.id)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "4px 8px",
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 500,
                              cursor: "pointer",
                              transition: "all 0.15s ease",
                              border: enabled
                                ? "1px solid rgba(143, 227, 208, 0.3)"
                                : "1px solid rgba(255, 255, 255, 0.06)",
                              background: enabled ? "rgba(21, 122, 110, 0.2)" : "rgba(255, 255, 255, 0.03)",
                              color: enabled ? "#8fe3d0" : "#8c9e99",
                            }}
                          >
                            <Icon size={12} />
                            {tool.label}
                            {enabled && <Check size={11} />}
                          </button>
                        );
                      })}
                    </div>
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
