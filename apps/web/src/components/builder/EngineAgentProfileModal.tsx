import { useEffect } from "react";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import { ConversationAvatar } from "./ConversationAvatar";
import {
  X,
  Globe,
  Database,
  Brain,
  ShieldCheck,
  Layers,
  Sparkles,
  Bot,
  Terminal,
} from "lucide-react";
import "./engine-agent-profile-modal.css";

export function EngineAgentProfileModal({
  agent,
  onClose,
}: {
  agent: EngineAgentProfile;
  onClose: () => void;
}) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const hasWebTool =
    agent.specializations?.some((s) => /web|ricerca|online|mercato|competitor/i.test(s)) ||
    /web|online|scandagliare|internet/i.test(agent.instructions || "");

  const hasVaultAccess = true;
  const hasWorkingMemory = true;
  const isSupervised = agent.autonomy_mode !== "autonomous";

  return (
    <div
      className="cw-agent-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cw-agent-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Scheda collaboratore: ${agent.name}`}
      >
        {/* Header */}
        <header className="cw-agent-modal__header">
          <div className="cw-agent-modal__identity">
            <ConversationAvatar name={agent.name} large />
            <div>
              <div className="cw-agent-modal__name-row">
                <h3 className="cw-agent-modal__name">{agent.name}</h3>
                <span className="cw-agent-modal__kind-pill">
                  <Bot size={11} />
                  Agente Specializzato
                </span>
              </div>
              <p className="cw-agent-modal__role">{agent.role}</p>
            </div>
          </div>
          <button
            type="button"
            className="cw-agent-modal__close-btn"
            aria-label="Chiudi scheda"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {/* Content */}
        <div className="cw-agent-modal__body">
          {/* Autonomy Banner */}
          <div className="cw-agent-modal__autonomy">
            <ShieldCheck size={14} className="text-[#687a59]" />
            <div>
              <strong>{isSupervised ? "Supervisione umana attiva" : "Esecuzione autonoma"}</strong>
              <p>
                {isSupervised
                  ? "Tutte le operazioni, letture critiche o scritture richiedono il tuo esplicito via libera prima dell'avvio."
                  : "L'agente può finalizzare e archiviare i risultati in autonomia."}
              </p>
            </div>
          </div>

          {/* Strumenti e Abilità collegate */}
          <section className="cw-agent-modal__section">
            <span className="cw-agent-modal__section-title">
              <Sparkles size={13} />
              Strumenti e permessi collegati
            </span>
            <div className="cw-agent-modal__tools-grid">
              {hasWebTool && (
                <div className="cw-agent-tool-item">
                  <div className="cw-agent-tool-item__icon">
                    <Globe size={14} />
                  </div>
                  <div>
                    <strong>Ricerca Web e Intelligence</strong>
                    <p>Scansione pagine pubbliche, documentazione e analisi competitor online.</p>
                  </div>
                </div>
              )}
              {hasVaultAccess && (
                <div className="cw-agent-tool-item">
                  <div className="cw-agent-tool-item__icon">
                    <Database size={14} />
                  </div>
                  <div>
                    <strong>Vault di Progetto</strong>
                    <p>Deposito e consultazione dei dataset e dei report generati durante le fasi.</p>
                  </div>
                </div>
              )}
              {hasWorkingMemory && (
                <div className="cw-agent-tool-item">
                  <div className="cw-agent-tool-item__icon">
                    <Brain size={14} />
                  </div>
                  <div>
                    <strong>Memoria di Contesto</strong>
                    <p>Mantenimento delle evidenze concordate e dello storico delle deliberazioni.</p>
                  </div>
                </div>
              )}
              <div className="cw-agent-tool-item">
                <div className="cw-agent-tool-item__icon">
                  <Layers size={14} />
                </div>
                <div>
                  <strong>Staffetta Collaborativa</strong>
                  <p>Passaggio di consegne e interoperabilità diretta con Homun e la squadra.</p>
                </div>
              </div>
            </div>
          </section>

          {/* Responsabilità & Specializzazioni */}
          {(agent.responsibility || (agent.specializations && agent.specializations.length > 0)) && (
            <section className="cw-agent-modal__section">
              <span className="cw-agent-modal__section-title">Responsabilità e Ambito</span>
              {agent.responsibility && (
                <p className="cw-agent-modal__responsibility">{agent.responsibility}</p>
              )}
              {agent.specializations && agent.specializations.length > 0 && (
                <div className="cw-agent-modal__chips-row">
                  {agent.specializations.map((spec) => (
                    <span key={spec} className="cw-agent-spec-chip">
                      {spec}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Istruzioni Operative */}
          {agent.instructions && (
            <section className="cw-agent-modal__section">
              <span className="cw-agent-modal__section-title">Istruzioni operative assegnate</span>
              <div className="cw-agent-modal__instructions">
                {agent.instructions}
              </div>
            </section>
          )}

          {/* Metodo & Tono */}
          {(agent.method || agent.tone) && (
            <section className="cw-agent-modal__section cw-agent-modal__meta-row">
              {agent.method && (
                <div>
                  <small>Metodo di lavoro</small>
                  <p>{agent.method}</p>
                </div>
              )}
              {agent.tone && (
                <div>
                  <small>Stile e tono</small>
                  <p>{agent.tone}</p>
                </div>
              )}
            </section>
          )}
        </div>

        {/* Footer */}
        <footer className="cw-agent-modal__footer">
          <button
            type="button"
            className="cw-agent-modal__btn-secondary"
            onClick={onClose}
          >
            Chiudi
          </button>
        </footer>
      </div>
    </div>
  );
}
