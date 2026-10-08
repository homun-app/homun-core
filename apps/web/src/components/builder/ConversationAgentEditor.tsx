/**
 * Homun Agent In-Place Editor
 * Allows configuring an individual agent's identity, specialized LLM brain,
 * fallback model, reasoning/thinking mode, temperature, autonomy policy, tools, and system prompt.
 */

import { useState } from "react";
import {
  Brain,
  Shield,
  Wrench,
  Sparkles,
  Check,
  Send,
  Globe,
  FileCode,
  Database,
  ArrowLeft,
  Bot,
  RefreshCw,
  Cpu,
  Layers,
} from "lucide-react";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import { postModelChat } from "@/lib/engine-models-client";
import { SettingsToggleSwitch } from "./SettingsToggleSwitch";
import { SettingsCustomSelect } from "./SettingsCustomSelect";
import {
  AUTONOMY_LEVELS,
  TEMPERATURE_PRESETS,
  TOKEN_BUDGET_PRESETS,
  parseAgentCognitiveConfig,
  type AgentCognitiveConfig,
} from "./ConversationAgentsSettingsData";

export type AgentSavePayload = {
  name: string;
  role: string;
  responsibility: string;
  instructions: string;
  preferredConnectionId: string | null;
  autonomyMode: string;
  capabilities: string[];
  cognitiveConfig: AgentCognitiveConfig;
};

type Props = {
  agent: EngineAgentProfile | null;
  isCreating: boolean;
  connections: Array<{ id: string; display_name: string; kind?: string; model_id?: string }>;
  onSave: (payload: AgentSavePayload) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
};

export function ConversationAgentEditor({
  agent,
  isCreating,
  connections,
  onSave,
  onCancel,
  busy,
}: Props) {
  const initialCognitive = parseAgentCognitiveConfig(agent?.method);

  const [formName, setFormName] = useState(agent?.name ?? "");
  const [formRole, setFormRole] = useState(agent?.role ?? "");
  const [formResponsibility, setFormResponsibility] = useState(agent?.responsibility ?? "");
  const [formInstructions, setFormInstructions] = useState(agent?.instructions ?? "");
  const [formConnectionId, setFormConnectionId] = useState<string>(
    agent?.preferred_connection_id ?? "",
  );
  const [formAutonomy, setFormAutonomy] = useState(agent?.autonomy_mode ?? "supervised");
  const [formCapabilities, setFormCapabilities] = useState<string[]>(
    agent?.capabilities ?? ["web_search", "filesystem"],
  );

  // Cognitive & Brain settings
  const [fallbackConnectionId, setFallbackConnectionId] = useState<string>(
    initialCognitive.fallback_connection_id ?? "",
  );
  const [thinkingMode, setThinkingMode] = useState<boolean>(
    initialCognitive.thinking_mode ?? false,
  );
  const [temperature, setTemperature] = useState<number>(initialCognitive.temperature ?? 0.5);
  const [maxTokens, setMaxTokens] = useState<number>(initialCognitive.max_tokens ?? 8192);

  // Live test simulator
  const [testPrompt, setTestPrompt] = useState(
    "Ciao, presentati brevemente e spiegami in cosa puoi aiutarmi.",
  );
  const [testReply, setTestReply] = useState<string | null>(null);
  const [testingModel, setTestingModel] = useState(false);

  function toggleCapability(capId: string) {
    setFormCapabilities((prev) =>
      prev.includes(capId) ? prev.filter((c) => c !== capId) : [...prev, capId],
    );
  }

  async function handleSimulate() {
    if (!testPrompt.trim() || testingModel) return;
    setTestingModel(true);
    setTestReply(null);
    try {
      const messages: Array<{ role: "system" | "user"; content: string }> = [];
      if (formInstructions.trim()) {
        messages.push({
          role: "system",
          content: `${formInstructions.trim()}\n\n[Identità: ${formName} - ${formRole}]`,
        });
      }
      messages.push({ role: "user", content: testPrompt.trim() });

      const res = await postModelChat(
        messages,
        formConnectionId ? { connectionId: formConnectionId } : undefined,
      );
      setTestReply(res.text || "(Nessuna risposta generata)");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestReply(`Errore nel test del modello: ${msg}`);
    } finally {
      setTestingModel(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim() || busy) return;

    await onSave({
      name: formName.trim(),
      role: formRole.trim(),
      responsibility: formResponsibility.trim(),
      instructions: formInstructions.trim(),
      preferredConnectionId: formConnectionId.trim() || null,
      autonomyMode: formAutonomy,
      capabilities: formCapabilities,
      cognitiveConfig: {
        fallback_connection_id: fallbackConnectionId.trim() || null,
        thinking_mode: thinkingMode,
        temperature,
        max_tokens: maxTokens,
      },
    });
  }

  return (
    <div className="cv-agent-editor">
      {/* Intestazione Editor */}
      <div className="cv-agent-editor__header">
        <button
          type="button"
          onClick={onCancel}
          className="cv-agent-editor__back-btn"
          title="Torna alla lista squadra"
        >
          <ArrowLeft size={16} />
          <span>Squadra Agenti</span>
        </button>
        <div className="flex items-center gap-3">
          <div className="cv-agent-card__avatar">
            <Bot size={22} className="text-[#8fe3d0]" />
          </div>
          <div>
            <h3>{isCreating ? "Nuovo Collaboratore AI" : `Modifica Agente: ${formName || "Senza Nome"}`}</h3>
            <p className="text-xs text-[#9db3ad]">
              Assegna un modello LLM specializzato, parametri di pensiero e strumenti operativi.
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="cv-agent-editor__form">
        {/* Sezione 1: Identità e Ruolo */}
        <div className="cv-agent-editor__card">
          <h4 className="cv-agent-editor__card-title">
            <Bot size={16} className="text-[#8fe3d0]" />
            <span>Identità e Ruolo Professionale</span>
          </h4>
          <p className="cv-agent-editor__card-desc">
            Definisci come l'agente viene identificato all'interno dei progetti e nelle deleghe.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-[#cbd5e1] block mb-1">
                Nome Collaboratore
              </label>
              <input
                type="text"
                required
                placeholder="Es. Elena, Marco, Sofia..."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-[#cbd5e1] block mb-1">
                Ruolo e Titolo Professionale
              </label>
              <input
                type="text"
                required
                placeholder="Es. Product Architect, Full-Stack Dev..."
                value={formRole}
                onChange={(e) => setFormRole(e.target.value)}
                className="w-full"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-[#cbd5e1] block mb-1">
              Missione / Responsabilità Principale
            </label>
            <input
              type="text"
              placeholder="In una frase: cosa fa questo collaboratore per il team..."
              value={formResponsibility}
              onChange={(e) => setFormResponsibility(e.target.value)}
              className="w-full"
            />
          </div>
        </div>

        {/* Sezione 2: Cervello & Modello LLM Dedicato */}
        <div className="cv-agent-editor__card">
          <div className="flex items-center justify-between">
            <h4 className="cv-agent-editor__card-title">
              <Brain size={16} className="text-[#8fe3d0]" />
              <span>Cervello & Modello LLM Dedicato</span>
            </h4>
            <span className="text-[11px] text-[#8fe3d0] bg-[#182b26] px-2 py-0.5 rounded border border-[#253a33]">
              Modello autonomo per agente
            </span>
          </div>
          <p className="cv-agent-editor__card-desc">
            Ogni agente può sfruttare un modello specializzato per le proprie mansioni (es. Claude 3.7 per logica e codice, GPT-4o per multimodale, Ollama locale per elaborazione a costo zero).
          </p>

          {/* Modello Primario */}
          <div>
            <label className="text-xs font-medium text-[#cbd5e1] block mb-1.5 flex items-center gap-1.5">
              <Cpu size={13} className="text-[#8fe3d0]" />
              <span>Cervello Primario (Primary Brain)</span>
            </label>
            <div className="cv-agent-model-cards">
              <div
                className={`cv-agent-model-card ${formConnectionId === "" ? "is-selected" : ""}`}
                onClick={() => setFormConnectionId("")}
              >
                <div className="cv-agent-model-card__title">
                  <span>Predefinito dello Spazio</span>
                  {formConnectionId === "" && <Check size={14} />}
                </div>
                <span className="cv-agent-model-card__desc">
                  Usa il provider e modello principale configurato per lo spazio.
                </span>
              </div>

              {connections.map((c) => (
                <div
                  key={c.id}
                  className={`cv-agent-model-card ${formConnectionId === c.id ? "is-selected" : ""}`}
                  onClick={() => setFormConnectionId(c.id)}
                >
                  <div className="cv-agent-model-card__title">
                    <span>{c.display_name}</span>
                    {formConnectionId === c.id && <Check size={14} />}
                  </div>
                  <span className="cv-agent-model-card__desc">
                    {c.model_id ? `Modello: ${c.model_id}` : `ID: ${c.id}`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Modello di Riserva / Fallback */}
          <div className="mt-4 pt-4 border-t border-[rgba(255,255,255,0.06)]">
            <label className="text-xs font-medium text-[#cbd5e1] block mb-1.5 flex items-center gap-1.5">
              <Shield size={13} className="text-[#38bdf8]" />
              <span>Cervello di Riserva (Fallback Resilience)</span>
            </label>
            <p className="text-xs text-[#9db3ad] mb-2">
              Se il provider primario subisce errori 429 (rate-limit) o è irraggiungibile offline, l'agente esegue il fallback automatico su questo modello.
            </p>
            <SettingsCustomSelect
              value={fallbackConnectionId}
              onChange={(val) => setFallbackConnectionId(val)}
              options={[
                {
                  value: "",
                  label: "Nessun fallback (fermati e segnala errore)",
                  desc: "Non tentare connessioni secondarie se il primario fallisce",
                },
                ...connections.map((c) => ({
                  value: c.id,
                  label: c.display_name,
                  desc: c.model_id ? `Modello: ${c.model_id}` : `ID: ${c.id}`,
                  icon: Cpu,
                })),
              ]}
            />
          </div>

          {/* Parametri Cognitivi & Ragionamento */}
          <div className="mt-4 pt-4 border-t border-[rgba(255,255,255,0.06)] space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-[#111c18] border border-[rgba(255,255,255,0.06)]">
              <div>
                <strong className="text-xs font-semibold text-[#f4f1ee] block">
                  Ragionamento Esteso (Extended Thinking / Deep Reasoner)
                </strong>
                <span className="text-[11px] text-[#9db3ad]">
                  Attiva la catena di riflessione passo-passo prima di formulare la risposta finale (ottimale per architettura e codice).
                </span>
              </div>
              <SettingsToggleSwitch
                checked={thinkingMode}
                onChange={() => setThinkingMode(!thinkingMode)}
                ariaLabel="Attiva Thinking Mode"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-[#cbd5e1] block mb-1.5 flex items-center justify-between">
                <span>Creatività / Temperatura</span>
                <span className="text-[11px] font-mono text-[#8fe3d0]">temp: {temperature}</span>
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {TEMPERATURE_PRESETS.map((p) => {
                  const isSelected = Math.abs(temperature - p.value) < 0.05;
                  return (
                    <div
                      key={p.value}
                      className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                        isSelected
                          ? "bg-[rgba(21,122,110,0.25)] border-[#8fe3d0] text-[#f4f1ee]"
                          : "bg-[#111c18] border-[rgba(255,255,255,0.08)] text-[#9db3ad] hover:border-[rgba(255,255,255,0.18)]"
                      }`}
                      onClick={() => setTemperature(p.value)}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <strong className="text-xs">{p.label}</strong>
                        <span className="text-[10px] font-mono">{p.value}</span>
                      </div>
                      <span className="text-[10px] block opacity-80">{p.desc}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-[#cbd5e1] block mb-1.5 flex items-center justify-between">
                <span>Budget Token Massimo per Risposta</span>
                <span className="text-[11px] font-mono text-[#8fe3d0]">{maxTokens} tokens</span>
              </label>
              <div className="flex gap-2">
                {TOKEN_BUDGET_PRESETS.map((tokens) => (
                  <button
                    key={tokens}
                    type="button"
                    onClick={() => setMaxTokens(tokens)}
                    className={`px-3 py-1.5 rounded-md text-xs font-mono transition-all ${
                      maxTokens === tokens
                        ? "bg-[#157a6e] text-white border border-[#8fe3d0]"
                        : "bg-[#111c18] text-[#9db3ad] border border-[rgba(255,255,255,0.08)] hover:text-white"
                    }`}
                  >
                    {tokens.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Sezione 3: Politica di Autonomia (HITL) */}
        <div className="cv-agent-editor__card">
          <h4 className="cv-agent-editor__card-title">
            <Shield size={16} className="text-[#8fe3d0]" />
            <span>Politica di Supervisione & Autonomia (Human-In-The-Loop)</span>
          </h4>
          <p className="cv-agent-editor__card-desc">
            Decidi quando l'agente deve fermarsi per richiedere la tua autorizzazione esplicita.
          </p>

          <div className="cv-agent-autonomy-cards">
            {AUTONOMY_LEVELS.map((lvl) => {
              const IconComp = lvl.icon;
              const isSelected = formAutonomy === lvl.id;
              return (
                <div
                  key={lvl.id}
                  className={`cv-agent-autonomy-card ${isSelected ? "is-selected" : ""}`}
                  onClick={() => setFormAutonomy(lvl.id)}
                >
                  <div className="cv-agent-autonomy-card__radio" />
                  <div className="cv-agent-autonomy-card__content">
                    <div className="flex items-center gap-2">
                      <IconComp
                        size={15}
                        className={isSelected ? "text-[#8fe3d0]" : "text-[#9db3ad]"}
                      />
                      <strong>{lvl.title}</strong>
                    </div>
                    <p>{lvl.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Sezione 4: Strumenti Operativi */}
        <div className="cv-agent-editor__card">
          <h4 className="cv-agent-editor__card-title">
            <Wrench size={16} className="text-[#8fe3d0]" />
            <span>Strumenti Operativi Autorizzati</span>
          </h4>
          <p className="cv-agent-editor__card-desc">
            Attiva solo gli strumenti strettamente necessari per il compito di questo agente.
          </p>

          <div className="space-y-2">
            <div className="cv-agent-tool-row">
              <div className="cv-agent-tool-row__info">
                <div className="cv-agent-tool-row__icon">
                  <Globe size={16} />
                </div>
                <div className="cv-agent-tool-row__text">
                  <strong>Web Browser & Ricerca Web</strong>
                  <span>Consultazione documentazione online e fonti aggiornate</span>
                </div>
              </div>
              <SettingsToggleSwitch
                checked={formCapabilities.includes("web_search")}
                onChange={() => toggleCapability("web_search")}
                ariaLabel="Abilita Web Search"
              />
            </div>

            <div className="cv-agent-tool-row">
              <div className="cv-agent-tool-row__info">
                <div className="cv-agent-tool-row__icon">
                  <FileCode size={16} />
                </div>
                <div className="cv-agent-tool-row__text">
                  <strong>Lettura e Scrittura Filesystem</strong>
                  <span>Accesso ai file di progetto nel rispetto delle autorizzazioni</span>
                </div>
              </div>
              <SettingsToggleSwitch
                checked={formCapabilities.includes("filesystem")}
                onChange={() => toggleCapability("filesystem")}
                ariaLabel="Abilita Filesystem"
              />
            </div>

            <div className="cv-agent-tool-row">
              <div className="cv-agent-tool-row__info">
                <div className="cv-agent-tool-row__icon">
                  <Database size={16} />
                </div>
                <div className="cv-agent-tool-row__text">
                  <strong>Integrazioni Server MCP</strong>
                  <span>Accesso ai database SQLite, Postgres e strumenti esterni MCP</span>
                </div>
              </div>
              <SettingsToggleSwitch
                checked={formCapabilities.includes("mcp_tools")}
                onChange={() => toggleCapability("mcp_tools")}
                ariaLabel="Abilita MCP"
              />
            </div>
          </div>
        </div>

        {/* Sezione 5: Istruzioni di Sistema */}
        <div className="cv-agent-editor__card">
          <h4 className="cv-agent-editor__card-title">
            <Sparkles size={16} className="text-[#8fe3d0]" />
            <span>Istruzioni Operative & Metodologia (System Prompt)</span>
          </h4>
          <p className="cv-agent-editor__card-desc">
            Definisci la personalità, il tono di voce e le regole di convalida che l'agente deve applicare.
          </p>
          <textarea
            rows={5}
            placeholder="Es. Sii sintetico, fornisci sempre riferimenti ai file modificati e verifica la retrocompatibilità..."
            value={formInstructions}
            onChange={(e) => setFormInstructions(e.target.value)}
            className="w-full"
          />
        </div>

        {/* Sezione 6: Collaudo Rapido in Tempo Reale */}
        <div className="cv-agent-simulator">
          <div className="flex items-center justify-between">
            <strong>Collaudo Agente in Tempo Reale</strong>
            <span className="text-[11px] text-[#8fe3d0]">
              Test con modello {formConnectionId ? `assegnato (${formConnectionId})` : "predefinito"}
            </span>
          </div>
          <p>
            Invia un messaggio per verificare come risponde l'agente con il modello e le istruzioni attuali.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={testPrompt}
              onChange={(e) => setTestPrompt(e.target.value)}
              placeholder="Scrivi un messaggio di test all'agente..."
              className="flex-1"
            />
            <button
              type="button"
              disabled={testingModel || !testPrompt.trim()}
              onClick={() => void handleSimulate()}
              className="cv-unified-btn is-primary text-xs"
            >
              {testingModel ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Elaborazione...</span>
                </>
              ) : (
                <>
                  <Send size={13} />
                  <span>Invia Test</span>
                </>
              )}
            </button>
          </div>

          {testReply && (
            <div className="cv-agent-simulator__reply">
              <div className="cv-agent-simulator__reply-meta">
                <span>Risposta Agente ({formName || "Collaboratore"}):</span>
              </div>
              <p>{testReply}</p>
            </div>
          )}
        </div>

        {/* Pulsanti di Salvataggio */}
        <div className="cv-agent-editor__actions">
          <button
            type="submit"
            disabled={busy || !formName.trim()}
            className="cv-unified-btn is-primary"
          >
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check size={14} />}
            <span>{isCreating ? "Crea Collaboratore" : "Salva Modifiche"}</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="cv-unified-btn is-subtle"
          >
            Annulla
          </button>
        </div>
      </form>
    </div>
  );
}
