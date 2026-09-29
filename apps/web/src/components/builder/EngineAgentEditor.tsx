/** Editor of one engine agent: professional identity, autonomy, capabilities and its own model. */
import { useEffect, useState } from "react";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import { updateEngineAgent } from "@/lib/engine-agents-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationSelectField } from "./ConversationSelect";
import { AgentModelSelector } from "./AgentModelSelector";
import "./engine-agent-editor.css";

const CAPABILITY_CHOICES = [
  { id: "compare_csv", label: "Confronto CSV" },
  { id: "read_material", label: "Lettura materiale" },
];

const AUTONOMY_CHOICES = [
  { id: "supervised", label: "Sotto supervisione" },
  { id: "autonomous", label: "Consegna autonoma" },
];

export function EngineAgentEditor({
  agent,
  onChanged,
  onClose,
}: {
  agent: EngineAgentProfile;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [role, setRole] = useState(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [responsibility, setResponsibility] = useState(agent.responsibility ?? "");
  const [specializations, setSpecializations] = useState((agent.specializations ?? []).join(", "));
  const [method, setMethod] = useState(agent.method ?? "");
  const [tone, setTone] = useState(agent.tone ?? "");
  const [autonomy, setAutonomy] = useState(agent.autonomy_mode ?? "supervised");
  const [capabilities, setCapabilities] = useState<string[]>(agent.capabilities ?? []);
  const [connectionId, setConnectionId] = useState(agent.preferred_connection_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function toggleCapability(id: string) {
    setCapabilities((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateEngineAgent({
        agentId: agent.id,
        expectedVersion: agent.revision,
        role: role.trim(),
        instructions: instructions.trim(),
        responsibility: responsibility.trim(),
        specializations: specializations.split(",").map((item) => item.trim()).filter(Boolean),
        method: method.trim(),
        tone: tone.trim(),
        autonomyMode: autonomy,
        capabilities,
        preferredConnectionId: connectionId.trim() ? connectionId.trim() : null,
      });
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="cw-agent-editor"
      aria-label={`Modifica ${agent.name}`}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
    >
      <h4>{agent.name}</h4>
      <label>
        Ruolo
        <input value={role} maxLength={180} disabled={saving} onChange={(e) => setRole(e.target.value)} />
      </label>
      <label>
        Istruzioni
        <textarea className="cw-input" value={instructions} maxLength={2000} disabled={saving}
          onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <label>
        Di cosa è responsabile
        <input value={responsibility} maxLength={500} disabled={saving} onChange={(e) => setResponsibility(e.target.value)} />
      </label>
      <label>
        Specializzazioni (separate da virgola)
        <input value={specializations} maxLength={300} disabled={saving} onChange={(e) => setSpecializations(e.target.value)} />
      </label>
      <label>
        Metodo di lavoro
        <input value={method} maxLength={500} disabled={saving} onChange={(e) => setMethod(e.target.value)} />
      </label>
      <label>
        Tono
        <input value={tone} maxLength={120} disabled={saving} onChange={(e) => setTone(e.target.value)} />
      </label>
      <div className="cw-agent-editor__row">
        <label>
          Autonomia
          <ConversationSelectField aria-label="Autonomia" value={autonomy} disabled={saving}
            onChange={(e) => setAutonomy(e.target.value)}>
            {AUTONOMY_CHOICES.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </ConversationSelectField>
        </label>
        <div className="cw-agent-editor__field">
          <span>Modello per questo collaboratore</span>
          <AgentModelSelector
            value={connectionId}
            onChange={setConnectionId}
            disabled={saving}
          />
        </div>
      </div>
      <fieldset className="cw-agent-editor__capabilities">
        <legend>Capacità che sa usare</legend>
        {CAPABILITY_CHOICES.map((choice) => (
          <label key={choice.id}>
            <input type="checkbox" checked={capabilities.includes(choice.id)} disabled={saving}
              onChange={() => toggleCapability(choice.id)} />
            {choice.label}
          </label>
        ))}
      </fieldset>
      <div className="cs-actions">
        <button className="cw-primary" disabled={saving || !role.trim() || !instructions.trim()}>
          {saving ? "Sto salvando…" : "Salva modifiche"}
        </button>
        <button type="button" className="cw-secondary" disabled={saving} onClick={onClose}>
          Annulla
        </button>
      </div>
      {saving && <p role="status">Salvataggio in corso…</p>}
      <HomunErrorNotice error={error} />
    </form>
  );
}
