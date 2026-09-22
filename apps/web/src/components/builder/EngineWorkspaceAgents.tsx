import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import { ConversationAvatar } from "./ConversationAvatar";
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

import { useState } from "react";
import { EngineAgentEditor } from "./EngineAgentEditor";

/** Rich agent cards: identity, specializations, autonomy — editable, with their own model. */
export function EngineWorkspaceAgents({ agents, onChanged }: {
  agents: EngineAgentProfile[];
  onChanged?: (() => Promise<void>) | undefined;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const active = agents.filter((agent) => agent.status === "active");
  return (
    <section className="cw-workspace cw-agents-panel" aria-label="Collaboratori">
      <div className="cw-panel-top">
        <h2>La tua squadra</h2>
        <span className="cw-hint">
          {active.length} {active.length === 1 ? "collaboratore" : "collaboratori"}
        </span>
      </div>
      <p className="cw-hint">
        I collaboratori proposti in chat entrano nella squadra dopo la tua conferma. Il profilo non
        concede automaticamente strumenti o permessi.
      </p>
      {active.length === 0 && (
        <p className="cw-agents-empty">
          Non hai ancora creato collaboratori. Racconta a Homun il lavoro che vuoi affidare: ti
          proporrà chi può farlo, da creare dopo la tua conferma.
        </p>
      )}
      <div className="cw-agents-grid">
        {active.map((agent) => (
          <article key={agent.id} className="cw-agent-card">
            <header>
              <ConversationAvatar name={agent.name} large />
              <div>
                <h3>{agent.name}</h3>
                <p className="cw-agent-role">{agent.role}</p>
                {agent.tone && <p className="cw-agent-tone">{agent.tone}</p>}
              </div>
            </header>
            {agent.responsibility && (
              <p className="cw-agent-responsibility">
                <strong>Responsabilità:</strong> {agent.responsibility}
              </p>
            )}
            {agent.capabilities && agent.capabilities.length > 0 && (
              <div className="cw-agent-capabilities">
                <strong>Può eseguire</strong>
                <div className="cw-agent-caps-row">
                  {agent.capabilities.map((cap) => (
                    <span key={cap} className="cw-agent-cap-chip">
                      {CAPABILITY_LABELS[cap] ?? cap}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {agent.specializations && agent.specializations.length > 0 && (
              <div className="cw-agent-specializations">
                {(agent.specializations ?? []).map((spec) => (
                  <span key={spec} className="cw-agent-spec-chip">
                    {spec}
                  </span>
                ))}
              </div>
            )}
            <footer>
              <span className={`cw-agent-autonomy ${agent.autonomy_mode ?? "supervised"}`}>
                {AUTONOMY_LABELS[agent.autonomy_mode ?? "supervised"] ?? "Sotto supervisione"}
              </span>
              {agent.method && (
                <details>
                  <summary>Metodo di lavoro</summary>
                  <p>{agent.method}</p>
                </details>
              )}
              <details>
                <summary>Istruzioni operative</summary>
                <p>{agent.instructions}</p>
              </details>
              {onChanged && (
                <button
                  type="button"
                  className="cs-link"
                  onClick={() => setEditingId(editingId === agent.id ? null : agent.id)}
                >
                  {editingId === agent.id ? "Chiudi modifica" : "Modifica"}
                </button>
              )}
            </footer>
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
