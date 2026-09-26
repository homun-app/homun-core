/**
 * Settings → Agenti & Ruoli: Squad management for AI collaborators.
 * Every agent can use its own dedicated LLM model, fallback model, thinking mode, and autonomy policy.
 * Small modular shell using ConversationAgentEditor in-place.
 */

import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  createEngineAgent,
  listEngineAgents,
  updateEngineAgent,
  type EngineAgentProfile,
} from "@/lib/engine-agents-client";
import { listModelConnections } from "@/lib/engine-models-client";
import {
  UsersRound,
  Bot,
  Plus,
  RefreshCw,
  Sparkles,
  Settings2,
  Brain,
  Shield,
  Layers,
  Cpu,
} from "lucide-react";
import {
  ROLE_TEMPLATES,
  parseAgentCognitiveConfig,
  serializeAgentCognitiveConfig,
  type RoleTemplate,
} from "./ConversationAgentsSettingsData";
import {
  ConversationAgentEditor,
  type AgentSavePayload,
} from "./ConversationAgentEditor";
import "./conversation-agents-settings.css";

type Props = {
  actorId?: string;
};

export function ConversationAgentsSettingsSection({ actorId = "person_fabio" }: Props) {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected" && status.capabilities?.features.agents;

  const [agents, setAgents] = useState<EngineAgentProfile[]>([]);
  const [connections, setConnections] = useState<
    Array<{ id: string; display_name: string; kind?: string; model_id?: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // In-place editor state
  const [editingAgent, setEditingAgent] = useState<EngineAgentProfile | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const [items, conns] = await Promise.all([
        listEngineAgents(),
        listModelConnections().catch(() => ({
          items: [] as Array<{
            id: string;
            display_name: string;
            kind?: string;
            model_id: string;
          }>,
        })),
      ]);
      setAgents(items);
      setConnections(
        conns.items.map((c) => {
          const item: { id: string; display_name: string; kind?: string; model_id?: string } = {
            id: c.id,
            display_name: c.display_name,
          };
          if (c.kind) item.kind = c.kind;
          if (c.model_id) item.model_id = c.model_id;
          return item;
        }),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!engineReady) {
      setAgents([]);
      return;
    }
    void refresh();
  }, [engineReady, status.connection]);

  function openCreate(template?: RoleTemplate) {
    if (template) {
      setEditingAgent({
        id: "",
        workspace_id: "",
        name: template.name,
        role: template.role,
        responsibility: template.responsibility,
        instructions: template.instructions,
        autonomy_mode: template.autonomyMode,
        capabilities: template.capabilities,
        revision: 1,
        status: "active",
      });
    } else {
      setEditingAgent(null);
    }
    setIsCreating(true);
  }

  function openEdit(agent: EngineAgentProfile) {
    setIsCreating(false);
    setEditingAgent(agent);
  }

  function closeEditor() {
    setEditingAgent(null);
    setIsCreating(false);
  }

  async function handleSaveAgent(payload: AgentSavePayload) {
    setBusy(true);
    setError(null);
    try {
      const serializedMethod = serializeAgentCognitiveConfig(
        editingAgent?.method,
        payload.cognitiveConfig,
      );

      if (isCreating || !editingAgent?.id) {
        await createEngineAgent({
          name: payload.name,
          role: payload.role,
          instructions: payload.instructions,
          preferredConnectionId: payload.preferredConnectionId,
          actor: { id: actorId, displayName: "Fabio" },
        });
      } else {
        await updateEngineAgent({
          agentId: editingAgent.id,
          expectedVersion: editingAgent.revision,
          role: payload.role,
          instructions: payload.instructions,
          preferredConnectionId: payload.preferredConnectionId,
          responsibility: payload.responsibility,
          autonomyMode: payload.autonomyMode,
          capabilities: payload.capabilities,
          method: serializedMethod,
          actor: { id: actorId, displayName: "Fabio" },
        });
      }

      await refresh();
      closeEditor();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (status.connection !== "connected") {
    return (
      <div className="cv-agents-wrap">
        <div className="cv-agents-header">
          <h3>Squadra Agenti & Ruoli Specializzati</h3>
          <p>Collega l’applicazione desktop Homun per visualizzare e configurare la tua squadra di agenti.</p>
        </div>
      </div>
    );
  }

  // Se l'utente sta creando o modificando un agente, mostra l'editor in-place
  if (isCreating || editingAgent) {
    return (
      <div className="cv-agents-wrap">
        <HomunErrorNotice error={error} />
        <ConversationAgentEditor
          agent={editingAgent}
          isCreating={isCreating}
          connections={connections}
          onSave={handleSaveAgent}
          onCancel={closeEditor}
          busy={busy}
        />
      </div>
    );
  }

  return (
    <div className="cv-agents-wrap">
      {/* Intestazione Sezione */}
      <div className="cv-agents-header flex items-center justify-between">
        <div>
          <h3>Squadra Agenti & Modelli Indipendenti</h3>
          <p>
            Ogni agente opera con il proprio modello LLM specializzato, parametri cognitivi di riflessione e strumenti dedicati.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            className="cv-unified-btn is-subtle text-xs"
            title="Aggiorna lista squadra"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
            <span>Aggiorna</span>
          </button>
          <button
            type="button"
            onClick={() => openCreate()}
            disabled={busy}
            className="cv-unified-btn is-primary text-xs"
          >
            <Plus size={14} />
            <span>Aggiungi Agente</span>
          </button>
        </div>
      </div>

      <HomunErrorNotice error={error} />

      {/* Banner Esplicativo Modello per Agente */}
      <div className="cv-agents-explainer">
        <div className="cv-agents-explainer__icon">
          <Brain size={18} />
        </div>
        <div className="cv-agents-explainer__text">
          <strong>Modelli eterogenei per compiti specifici</strong>
          <p>
            Assegna Claude 3.7 per compiti di architettura e codice, GPT-4o per analisi multimodale o sintesi, e modelli locali Ollama (Llama 3.3) per elaborazioni senza costi di token o fallback resiliente offline.
          </p>
        </div>
      </div>

      {/* Elenco Agenti Attivi */}
      <div className="cv-agents-list">
        {agents.length === 0 ? (
          <div className="p-8 rounded-xl bg-white border border-[#dce4d5] text-center space-y-4">
            <Bot size={36} className="text-[#203c32] mx-auto opacity-70" />
            <div>
              <strong className="text-sm font-semibold text-[#1c2d22] block" style={{ fontFamily: "Manrope, sans-serif" }}>
                Nessun collaboratore configurato
              </strong>
              <p className="text-xs text-[#647a6d] mt-1">
                Inizia con uno dei ruoli predefiniti raccomandati per strutturare la tua squadra.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center pt-2">
              {ROLE_TEMPLATES.map((tmpl) => (
                <button
                  key={tmpl.role}
                  type="button"
                  onClick={() => openCreate(tmpl)}
                  className="cv-unified-btn is-subtle text-xs"
                >
                  <Plus size={13} />
                  <span>{tmpl.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          agents.map((agent) => {
            const cognitive = parseAgentCognitiveConfig(agent.method);
            const assignedConn = connections.find(
              (c) => c.id === agent.preferred_connection_id,
            );
            const fallbackConn = connections.find(
              (c) => c.id === cognitive.fallback_connection_id,
            );

            return (
              <div key={agent.id} className="cv-agent-card">
                <div className="cv-agent-card__top">
                  <div className="cv-agent-card__identity">
                    <div className="cv-agent-card__avatar">
                      <Bot size={22} className="text-[#8fe3d0]" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4>{agent.name}</h4>
                        <span className="cv-agent-card__badge-role">
                          {agent.role || "Specialista"}
                        </span>
                        {agent.status === "active" && (
                          <span className="cv-agent-card__badge-status is-active">Attivo</span>
                        )}
                      </div>
                      <p className="cv-agent-card__responsibility">
                        {agent.responsibility ||
                          (agent.instructions ? agent.instructions.slice(0, 110) + "..." : "Collaboratore operativo del team")}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => openEdit(agent)}
                    className="cv-unified-btn is-subtle text-xs"
                  >
                    <Settings2 size={13} />
                    <span>Configura</span>
                  </button>
                </div>

                {/* Badges del Cervello & Parametri Cognitivi */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[rgba(255,255,255,0.06)] text-[11px]">
                  {/* Modello Primario */}
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[rgba(21,122,110,0.18)] border border-[rgba(143,227,208,0.2)] text-[#8fe3d0]">
                    <Cpu size={12} />
                    <span className="font-medium">
                      {assignedConn
                        ? `${assignedConn.display_name} (${assignedConn.model_id ?? assignedConn.id})`
                        : agent.preferred_connection_id
                        ? agent.preferred_connection_id
                        : "Modello Predefinito Spazio"}
                    </span>
                  </div>

                  {/* Fallback Resilience */}
                  {fallbackConn && (
                    <div className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#182b26] border border-[#253a33] text-[#38bdf8]">
                      <Shield size={11} />
                      <span>Fallback: {fallbackConn.display_name}</span>
                    </div>
                  )}

                  {/* Thinking Mode */}
                  {cognitive.thinking_mode && (
                    <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-[rgba(168,85,247,0.15)] border border-[rgba(168,85,247,0.3)] text-purple-300">
                      <Brain size={11} />
                      <span>Thinking ON</span>
                    </div>
                  )}

                  {/* Temperatura */}
                  <div className="px-2 py-0.5 rounded bg-[#111c18] border border-[rgba(255,255,255,0.08)] text-[#9db3ad] font-mono">
                    temp: {cognitive.temperature ?? 0.5}
                  </div>

                  {/* Autonomia */}
                  <div className="px-2 py-0.5 rounded bg-[#111c18] border border-[rgba(255,255,255,0.08)] text-[#9db3ad]">
                    {agent.autonomy_mode === "strict"
                      ? "Supervisione stretta"
                      : agent.autonomy_mode === "autonomous"
                      ? "Autonomo"
                      : "Semi-autonomo"}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Preset Ruoli Rapidi */}
      {agents.length > 0 && (
        <div className="p-4 rounded-xl bg-[#edf2e7] border border-[rgba(104,122,89,0.12)] space-y-2">
          <span className="text-xs font-semibold text-[#1c2d22] flex items-center gap-1.5">
            <Sparkles size={13} className="text-[#203c32]" />
            <span>Aggiungi rapidamente un ruolo specializzato alla squadra:</span>
          </span>
          <div className="flex flex-wrap gap-2 pt-1">
            {ROLE_TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.role}
                type="button"
                onClick={() => openCreate(tmpl)}
                className="cv-unified-btn is-subtle text-xs"
              >
                <Plus size={12} />
                <span>{tmpl.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
