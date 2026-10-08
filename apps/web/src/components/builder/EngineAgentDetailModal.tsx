import { useEffect, useState } from "react";
import { X, Pencil, Sparkles, User, Bot, Check } from "lucide-react";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import type { MemberProfile } from "./conversation-members";
import { ConversationAvatar } from "./ConversationAvatar";
import { EngineAgentEditor } from "./EngineAgentEditor";
import "./engine-agent-modal.css";

const CAPABILITY_LABELS: Record<string, string> = {
  compare_csv: "Confronto CSV",
  read_material: "Lettura materiale",
  general: "Coordinamento",
};

const AUTONOMY_LABELS: Record<string, string> = {
  supervised: "Sotto supervisione",
  autonomous: "Consegna autonoma",
};

export type DetailTarget =
  | { kind: "agent"; agent: EngineAgentProfile }
  | { kind: "human"; name: string; profile: MemberProfile };

export function EngineAgentDetailModal({
  target,
  onClose,
  onChanged,
}: {
  target: DetailTarget;
  onClose: () => void;
  onChanged?: (() => Promise<void>) | undefined;
}) {
  const [mode, setMode] = useState<"overview" | "edit">("overview");

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const isAgent = target.kind === "agent";
  const title = isAgent ? target.agent.name : target.name;
  const role = isAgent ? target.agent.role : target.profile.role;

  return (
    <div
      className="cw-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Dettagli di ${title}`}
    >
      <div className="cw-modal-sheet">
        {/* Header */}
        <header className="cw-modal-header">
          <div className="cw-modal-identity">
            <ConversationAvatar name={title} human={!isAgent} large />
            <div className="cw-modal-name-col">
              <div className="cw-modal-title-row">
                <h2>{title}</h2>
                <span className={`cw-modal-badge ${isAgent ? "badge-agent" : "badge-human"}`}>
                  {isAgent ? <Bot size={12} /> : <User size={12} />}
                  <span>{isAgent ? "Agente AI" : "Persona"}</span>
                </span>
                {isAgent && (
                  <span
                    className={`cw-agent-autonomy-badge ${target.agent.autonomy_mode ?? "supervised"}`}
                  >
                    {AUTONOMY_LABELS[target.agent.autonomy_mode ?? "supervised"] ?? "Sotto supervisione"}
                  </span>
                )}
              </div>
              <p className="cw-modal-role">{role}</p>
              {isAgent && target.agent.tone && (
                <p className="cw-modal-tone">{target.agent.tone}</p>
              )}
            </div>
          </div>

          <div className="cw-modal-top-actions">
            {isAgent && onChanged && mode === "overview" && (
              <button
                type="button"
                className="cw-modal-btn-subtle"
                onClick={() => setMode("edit")}
              >
                <Pencil size={13} />
                <span>Modifica</span>
              </button>
            )}
            <button
              type="button"
              className="cw-modal-close-btn"
              onClick={onClose}
              title="Chiudi finestra"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Body content */}
        <div className="cw-modal-body">
          {mode === "edit" && isAgent ? (
            <div className="cw-modal-edit-container">
              <div className="cw-modal-edit-top">
                <h3>Modifica profilo collaboratore</h3>
                <button
                  type="button"
                  className="cs-link"
                  onClick={() => setMode("overview")}
                >
                  Torna alla panoramica
                </button>
              </div>
              <EngineAgentEditor
                key={`${target.agent.id}:${target.agent.revision}`}
                agent={target.agent}
                onChanged={async () => {
                  await onChanged?.();
                  setMode("overview");
                }}
                onClose={() => setMode("overview")}
              />
            </div>
          ) : isAgent ? (
            <div className="cw-modal-sections">
              {target.agent.responsibility && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Responsabilità</span>
                  <p className="cw-modal-text">{target.agent.responsibility}</p>
                </div>
              )}

              {target.agent.capabilities && target.agent.capabilities.length > 0 && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Può eseguire</span>
                  <div className="cw-modal-chips">
                    {target.agent.capabilities.map((cap) => (
                      <span key={cap} className="cw-agent-cap-chip">
                        {CAPABILITY_LABELS[cap] ?? cap}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {target.agent.specializations && target.agent.specializations.length > 0 && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Specializzazioni</span>
                  <div className="cw-modal-chips">
                    {target.agent.specializations.map((spec) => (
                      <span key={spec} className="cw-agent-spec-chip">
                        {spec}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {target.agent.method && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Metodo di lavoro</span>
                  <div className="cw-modal-quote-box">{target.agent.method}</div>
                </div>
              )}

              {target.agent.instructions && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Istruzioni operative</span>
                  <div className="cw-modal-instructions-box">{target.agent.instructions}</div>
                </div>
              )}
            </div>
          ) : (
            /* Human Profile */
            <div className="cw-modal-sections">
              {target.profile.bio && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Descrizione & Attività</span>
                  <p className="cw-modal-text">{target.profile.bio}</p>
                </div>
              )}

              {target.profile.skills && target.profile.skills.length > 0 && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Competenze</span>
                  <div className="cw-modal-chips">
                    {target.profile.skills.map((s) => (
                      <span key={s} className="cw-agent-cap-chip">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {target.profile.email && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Email di contatto</span>
                  <p className="cw-modal-text">{target.profile.email}</p>
                </div>
              )}

              {target.profile.invitation && (
                <div className="cw-modal-section">
                  <span className="cw-modal-section-label">Stato invito</span>
                  <p className="cw-modal-text">
                    {target.profile.invitation === "pending"
                      ? "In attesa di accettazione"
                      : "Accettato"}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="cw-modal-footer">
          <button type="button" className="cw-modal-btn-subtle" onClick={onClose}>
            Chiudi
          </button>
        </footer>
      </div>
    </div>
  );
}
