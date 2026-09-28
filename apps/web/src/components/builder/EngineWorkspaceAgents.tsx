import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import { ConversationAvatar } from "./ConversationAvatar";
import { useState } from "react";
import { Pencil, ChevronDown } from "lucide-react";
import { EngineAgentEditor } from "./EngineAgentEditor";
import "./engine-agents.css";

const CAPABILITY_LABELS: Record<string, string> = {
  compare_csv: "Confronto CSV",
  read_material: "Lettura materiale",
  general: "Coordinamento",
};

const AUTONOMY_LABELS: Record<string, string> = {
  supervised: "Sotto supervisione",
  autonomous: "Consegna autonoma",
};

function AgentDisclosure({ title, content }: { title: string; content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cw-agent-disclosure">
      <button
        type="button"
        className="cw-agent-disclosure__toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronDown
          size={12}
          style={{
            transform: open ? "none" : "rotate(-90deg)",
            transition: "transform 0.15s ease",
          }}
        />
        <span>{title}</span>
      </button>
      {open && <div className="cw-agent-disclosure__content">{content}</div>}
    </div>
  );
}

/** Rich agent cards: identity, specializations, autonomy — editable, with their own model. */
export function EngineWorkspaceAgents({
  agents,
  onChanged,
}: {
  agents: EngineAgentProfile[];
  onChanged?: (() => Promise<void>) | undefined;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const active = agents.filter((agent) => agent.status === "active");

  return (
    <section className="cw-agents-panel" aria-label="Collaboratori">
      <div className="cw-squad-section-head">
        <div className="cw-squad-section-title">
          <span>Squadra & Collaboratori</span>
          <span className="cw-squad-section-count">{active.length}</span>
        </div>
      </div>

      {active.length === 0 && (
        <div className="cw-squad-empty-card">
          <p className="cw-agents-empty">
            Non hai ancora creato collaboratori. Racconta a Homun il lavoro che vuoi affidare: ti
            proporrà chi può farlo, da creare dopo la tua conferma.
          </p>
        </div>
      )}

      <div className="cw-agents-grid">
        {active.map((agent) => (
          <article key={agent.id} className="cw-agent-card">
            <header className="cw-agent-card__head">
              <div className="cw-agent-card__identity">
                <ConversationAvatar name={agent.name} />
                <div className="cw-agent-card__name-col">
                  <div className="cw-agent-card__title-row">
                    <h3>{agent.name}</h3>
                    <span className={`cw-agent-autonomy-badge ${agent.autonomy_mode ?? "supervised"}`}>
                      {AUTONOMY_LABELS[agent.autonomy_mode ?? "supervised"] ?? "Sotto supervisione"}
                    </span>
                  </div>
                  <p className="cw-agent-card__role">{agent.role}</p>
                  {agent.tone && <p className="cw-agent-card__tone">{agent.tone}</p>}
                </div>
              </div>
              {onChanged && (
                <button
                  type="button"
                  className="cw-agent-card__edit-btn"
                  onClick={() => setEditingId(editingId === agent.id ? null : agent.id)}
                  title={editingId === agent.id ? "Chiudi modifica" : "Modifica collaboratore"}
                >
                  <Pencil size={13} />
                  <span>{editingId === agent.id ? "Chiudi" : "Modifica"}</span>
                </button>
              )}
            </header>

            {agent.responsibility && (
              <div className="cw-agent-card__section">
                <span className="cw-agent-card__label">Responsabilità</span>
                <p className="cw-agent-card__text">{agent.responsibility}</p>
              </div>
            )}

            {agent.capabilities && agent.capabilities.length > 0 && (
              <div className="cw-agent-card__section">
                <span className="cw-agent-card__label">Può eseguire</span>
                <div className="cw-agent-card__chips">
                  {agent.capabilities.map((cap) => (
                    <span key={cap} className="cw-agent-cap-chip">
                      {CAPABILITY_LABELS[cap] ?? cap}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {agent.specializations && agent.specializations.length > 0 && (
              <div className="cw-agent-card__section">
                <span className="cw-agent-card__label">Specializzazioni</span>
                <div className="cw-agent-card__chips">
                  {agent.specializations.map((spec) => (
                    <span key={spec} className="cw-agent-spec-chip">
                      {spec}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {(agent.method || agent.instructions) && (
              <div className="cw-agent-card__disclosures">
                {agent.method && <AgentDisclosure title="Metodo di lavoro" content={agent.method} />}
                {agent.instructions && (
                  <AgentDisclosure title="Istruzioni operative" content={agent.instructions} />
                )}
              </div>
            )}

            {editingId === agent.id && (
              <EngineAgentEditor
                key={`${agent.id}:${agent.revision}`}
                agent={agent}
                onChanged={onChanged ?? (async () => {})}
                onClose={() => setEditingId(null)}
              />
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
