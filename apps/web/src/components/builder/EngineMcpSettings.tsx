/** MCP declarations and skills settings: honest add/test/approve surfaces. */
import { useEffect, useState } from "react";
import {
  createEngineServer,
  listEngineServers,
  listEngineSkills,
  probeEngineServer,
  removeEngineServer,
  skillEngineAction,
  type ExternalServer,
  type ProbeResult,
  type Skill,
} from "@/lib/engine-mcp-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import "./engine-mcp-settings.css";

export function ConversationMcpSettingsSection() {
  const [servers, setServers] = useState<ExternalServer[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    let active = true;
    listEngineServers()
      .then((items) => { if (active) setServers(items); })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, [reloadSeq]);

  const reload = () => setReloadSeq((n) => n + 1);

  return (
    <>
      <h3>Server MCP</h3>
      <p>
        Collega strumenti esterni (file, database, GitHub…): dichiari il server, decidi
        quali strumenti ammettere e lo provi. L'esecuzione resta sempre un atto che
        approvi tu: nessuno strumento parte in silenzio.
      </p>
      {servers === null && !error && <p role="status">Leggo i server dichiarati…</p>}
      {servers?.length === 0 && !adding && (
        <p className="cv-settings-note">Nessun server dichiarato.</p>
      )}
      {servers?.map((server) => (
        <ServerCard key={server.id} server={server} onChanged={reload} />
      ))}
      {adding ? (
        <AddServerForm
          onSaved={async () => { setAdding(false); reload(); }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="cw-secondary" onClick={() => setAdding(true)}>
          + Aggiungi un server MCP
        </button>
      )}
      <HomunErrorNotice error={error} />
    </>
  );
}

function ServerCard({ server, onChanged }: { server: ExternalServer; onChanged: () => void }) {
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function test() {
    setProbing(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await probeEngineServer(server.id));
    } catch (cause) {
      setError(cause);
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="cv-settings-card">
      <strong>{server.name}</strong>
      <p className="cv-mcp-meta">
        {server.transport === "stdio" ? `${server.command} ${server.args.join(" ")}`.trim() : server.url}
        {server.tools_include.length > 0 && ` · strumenti ammessi: ${server.tools_include.join(", ")}`}
        {server.tools_exclude.length > 0 && ` · esclusi: ${server.tools_exclude.join(", ")}`}
      </p>
      <div className="cs-actions">
        <button type="button" className="cw-secondary" disabled={probing} onClick={() => void test()}>
          {probing ? "Provo…" : "Prova connessione"}
        </button>
        {confirmRemove ? (
          <>
            <button type="button" className="cw-secondary" onClick={() => void removeEngineServer(server.id, server.revision).then(onChanged).catch(setError)}>
              Sì, rimuovi
            </button>
            <button type="button" className="cs-link" onClick={() => setConfirmRemove(false)}>
              Annulla
            </button>
          </>
        ) : (
          <button type="button" className="cs-link" onClick={() => setConfirmRemove(true)}>
            Rimuovi
          </button>
        )}
      </div>
      {probe && (
        <p className="cv-mcp-probe" role="status">
          Collegato{probe.server_info.name ? ` a ${probe.server_info.name}` : ""}:{" "}
          {probe.tools.length === 0
            ? "nessuno strumento nell'elenco ammesso."
            : `${probe.tools.length} strumenti ammessi su ${probe.tool_count_total} scoperti: ${probe.tools.join(", ")}.`}
        </p>
      )}
      <HomunErrorNotice error={error} />
    </div>
  );
}

function AddServerForm({ onSaved, onCancel }: {
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [toolsInclude, setToolsInclude] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await createEngineServer({
        name: name.trim(),
        transport,
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        url: url.trim(),
        toolsInclude: toolsInclude.trim() ? toolsInclude.split(",").map((t) => t.trim()).filter(Boolean) : [],
      });
      await onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="cv-mcp-add" aria-label="Nuovo server MCP"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="cw-agent-editor__row">
        <label>
          Nome
          <input value={name} maxLength={80} disabled={saving} onChange={(e) => setName(e.target.value)} placeholder="Es. GitHub del magazzino" />
        </label>
        <label>
          Trasporto
          <select aria-label="Trasporto" value={transport} disabled={saving}
            onChange={(e) => setTransport(e.target.value as "stdio" | "http")}>
            <option value="stdio">Locale (comando)</option>
            <option value="http">Remoto (URL)</option>
          </select>
        </label>
      </div>
      {transport === "stdio" ? (
        <>
          <label>
            Comando
            <input value={command} maxLength={300} disabled={saving} onChange={(e) => setCommand(e.target.value)}
              placeholder="Es. npx -y @modelcontextprotocol/server-filesystem" />
          </label>
          <label>
            Argomenti (separati da spazio)
            <input value={args} maxLength={300} disabled={saving} onChange={(e) => setArgs(e.target.value)}
              placeholder="Es. /Users/tuoi/progetti/magazzino" />
          </label>
        </>
      ) : (
        <label>
          URL
          <input value={url} maxLength={500} disabled={saving} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.esempio.com" />
        </label>
      )}
      <label>
        Strumenti ammessi (virgole; vuoto = tutti)
        <input value={toolsInclude} maxLength={300} disabled={saving} onChange={(e) => setToolsInclude(e.target.value)}
          placeholder="Es. list_issues, create_issue" />
      </label>
      <div className="cs-actions">
        <button className="cw-secondary" disabled={saving || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}>
          {saving ? "Salvo…" : "Dichiara server"}
        </button>
        <button type="button" className="cs-link" disabled={saving} onClick={onCancel}>
          Annulla
        </button>
      </div>
      <HomunErrorNotice error={error} />
    </form>
  );
}

export function ConversationSkillsSettingsSection() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    let active = true;
    listEngineSkills()
      .then((items) => { if (active) setSkills(items); })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, [reloadSeq]);

  const reload = () => setReloadSeq((n) => n + 1);
  const staged = (skills ?? []).filter((s) => s.status === "staged");

  return (
    <>
      <h3>Skill (procedure)</h3>
      <p>
        Procedure riutilizzabili scritte in chat: quelle proposte dall'agente nascono
        «da approvare» e diventano operative solo con il tuo via. Le archiviate non
        si cancellano mai.
      </p>
      {staged.length > 0 && (
        <p className="cv-settings-note" role="status">
          {staged.length} {staged.length === 1 ? "procedura attende" : "procedure attendono"} la tua approvazione.
        </p>
      )}
      {skills === null && !error && <p role="status">Leggo le procedure…</p>}
      {skills?.length === 0 && <p className="cv-settings-note">Nessuna procedura. In chat, su un messaggio dell'agente, scegli «Salva come procedura».</p>}
      {skills?.map((skill) => (
        <div className="cv-settings-card" key={skill.id}>
          <strong>{skill.name}</strong>
          <p>
            {skill.description || "Senza descrizione."}{" "}
            <small>
              {skill.status === "staged" ? "Da approvare" : skill.status === "approved" ? "Approvata" : "Archiviata"}
              {" · "}{skill.author_type === "agent" ? "proposta dall'agente" : "scritta da te"}
            </small>
          </p>
          {skill.body && (
            <details>
              <summary>Contenuto</summary>
              <pre className="cv-skill-body">{skill.body}</pre>
            </details>
          )}
          {skill.status === "staged" && (
            <div className="cs-actions">
              <button type="button" className="cw-secondary"
                onClick={() => void skillEngineAction({ skillId: skill.id, action: "approve", expectedVersion: skill.revision }).then(reload).catch(setError)}>
                Approva
              </button>
              <button type="button" className="cs-link"
                onClick={() => void skillEngineAction({ skillId: skill.id, action: "reject", expectedVersion: skill.revision }).then(reload).catch(setError)}>
                Respingi
              </button>
            </div>
          )}
          {skill.status === "approved" && (
            <button type="button" className="cs-link"
              onClick={() => void skillEngineAction({ skillId: skill.id, action: "archive", expectedVersion: skill.revision }).then(reload).catch(setError)}>
              Archivia
            </button>
          )}
        </div>
      ))}
      <HomunErrorNotice error={error} />
    </>
  );
}
