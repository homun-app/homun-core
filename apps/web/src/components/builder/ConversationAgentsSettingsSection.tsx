/**
 * Settings → Agenti: list / create / edit Homun AgentProfile on the engine.
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
import { listModelConnections, postModelChat } from "@/lib/engine-models-client";
import { ConversationSelect } from "./ConversationSelect";

type Props = {
  actorId?: string;
};

const STATUS_OPTIONS = [
  { value: "draft", label: "Bozza" },
  { value: "active", label: "Attivo" },
  { value: "paused", label: "In pausa" },
  { value: "retired", label: "Ritirato" },
];

export function ConversationAgentsSettingsSection({ actorId = "person_fabio" }: Props) {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected" && status.capabilities?.features.domain;
  const [agents, setAgents] = useState<EngineAgentProfile[]>([]);
  const [connections, setConnections] = useState<Array<{ id: string; display_name: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [agentStatus, setAgentStatus] = useState("active");
  const [provaPrompt, setProvaPrompt] = useState("Ciao, presentati in una frase.");
  const [provaReply, setProvaReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const selected = agents.find((item) => item.id === selectedId) ?? null;

  async function refresh() {
    const [items, conns] = await Promise.all([
      listEngineAgents(),
      listModelConnections().catch(() => ({ items: [] as Array<{ id: string; display_name: string }> })),
    ]);
    setAgents(items);
    setConnections(conns.items.map((c) => ({ id: c.id, display_name: c.display_name })));
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }

  useEffect(() => {
    if (!engineReady) {
      setAgents([]);
      return;
    }
    void refresh().catch((cause: unknown) => setError(cause));
  }, [engineReady, status.connection]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    setName(selected.name);
    setRole(selected.role ?? "");
    setInstructions(selected.instructions ?? "");
    setConnectionId(selected.preferred_connection_id ?? "");
    setAgentStatus(selected.status || "active");
  }, [selectedId, selected?.revision]);

  function resetForm() {
    setSelectedId(null);
    setName("");
    setRole("");
    setInstructions("");
    setConnectionId("");
    setAgentStatus("active");
    setProvaReply(null);
  }

  if (status.connection !== "connected") {
    return (
      <>
        <h3>Agenti</h3>
        <p>
          Avvia il motore (<code>npm run engine:dev</code>) per creare e modificare collaboratori AI.
          Nessun fallback in simulazione.
        </p>
      </>
    );
  }

  if (!engineReady) {
    return (
      <>
        <h3>Agenti</h3>
        <p>Il motore è connesso ma la capability <code>domain</code> non è disponibile.</p>
      </>
    );
  }

  return (
    <>
      <h3>Agenti Homun</h3>
      <p>
        Profilo persistente sul motore (istruzioni + collegamento ModelPort). L&apos;id è stabile; il
        nome non è una chiave. Actor: <code>{actorId}</code>.
      </p>

      <div className="cv-settings-card">
        <strong>Elenco</strong>
        {!agents.length ? (
          <p>Nessun agente ancora. Creane uno sotto.</p>
        ) : (
          <ul className="cv-settings-memory-list">
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className={selectedId === agent.id ? "cw-primary" : "cw-secondary"}
                  disabled={busy}
                  onClick={() => setSelectedId(agent.id)}
                >
                  {agent.name}
                  {agent.role ? ` · ${agent.role}` : ""} · {agent.status}
                </button>
                <small>
                  <code>{agent.id}</code>
                </small>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="cw-secondary" disabled={busy} onClick={resetForm}>
          Nuovo agente
        </button>
      </div>

      <div className="cv-settings-card">
        <strong>{selected ? "Modifica profilo" : "Crea agente"}</strong>
        <label>
          Nome
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Nome agente"
          />
        </label>
        <label>
          Ruolo breve
          <input
            value={role}
            onChange={(event) => setRole(event.target.value)}
            aria-label="Ruolo agente"
          />
        </label>
        <label>
          Istruzioni
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={4}
            aria-label="Istruzioni agente"
          />
        </label>
        <label>
          Collegamento modello (ModelPort)
          <select
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            aria-label="Collegamento modello preferito"
          >
            <option value="">Attivo dello spazio</option>
            {connections.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.display_name} ({conn.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          Stato
          <ConversationSelect
            label="Stato agente"
            value={agentStatus}
            options={STATUS_OPTIONS}
            onChange={(value) => setAgentStatus(value)}
          />
        </label>
        <button
          type="button"
          className="cw-primary"
          disabled={busy || !name.trim()}
          onClick={() => {
            setBusy(true);
            setError(null);
            setInfo(null);
            const preferred = connectionId.trim() || null;
            const task = selected
              ? updateEngineAgent({
                  agentId: selected.id,
                  expectedVersion: selected.revision,
                  role: role.trim(),
                  instructions: instructions,
                  preferredConnectionId: preferred,
                  status: agentStatus,
                }).then(async () => {
                  setInfo(`Agente aggiornato · revisione ${selected.revision + 1}`);
                  await refresh();
                })
              : createEngineAgent({
                  name: name.trim(),
                  role: role.trim(),
                  instructions,
                  preferredConnectionId: preferred,
                  status: agentStatus,
                }).then(async (created) => {
                  setInfo(`Agente creato · ${created.agentId}`);
                  setSelectedId(created.agentId);
                  await refresh();
                });
            void task.catch((cause: unknown) => setError(cause)).finally(() => setBusy(false));
          }}
        >
          {selected ? "Salva modifiche" : "Crea agente"}
        </button>
      </div>

      {selected ? (
        <div className="cv-settings-card">
          <strong>Prova come agente</strong>
          <p>
            Chat ModelPort con system = istruzioni del profilo (non è una run completa). Usa il
            collegamento preferito se impostato.
          </p>
          <label>
            Messaggio
            <textarea
              value={provaPrompt}
              onChange={(event) => setProvaPrompt(event.target.value)}
              rows={2}
              aria-label="Messaggio prova agente"
            />
          </label>
          <button
            type="button"
            className="cw-secondary"
            disabled={busy || !provaPrompt.trim()}
            onClick={() => {
              setBusy(true);
              setError(null);
              setInfo(null);
              setProvaReply(null);
              const messages: Array<{ role: "system" | "user"; content: string }> = [];
              if (instructions.trim()) {
                messages.push({ role: "system", content: instructions.trim() });
              }
              messages.push({ role: "user", content: provaPrompt.trim() });
              void postModelChat(messages, {
                ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
              })
                .then((result) => {
                  setProvaReply(result.text);
                  setInfo(`Risposta da ${result.provider_id} · ${result.model_id}`);
                })
                .catch((cause: unknown) => setError(cause))
                .finally(() => setBusy(false));
            }}
          >
            Invia prova
          </button>
          {provaReply ? (
            <p className="cv-settings-note" role="status">
              {provaReply}
            </p>
          ) : null}
        </div>
      ) : null}

      <HomunErrorNotice error={error} />
      {info ? <p className="cv-settings-note">{info}</p> : null}
    </>
  );
}
