/** Supervised external MCP tool calls, in the work panel next to the phases. */
import { useEffect, useState } from "react";
import {
  approveEngineToolCall,
  listEngineServers,
  listEngineToolCalls,
  probeEngineServer,
  proposeEngineToolCall,
  type ExternalServer,
  type ExternalToolCall,
  type ProbeResult,
} from "@/lib/engine-mcp-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationSelectField } from "./ConversationSelect";
import "./engine-mcp-settings.css";

export function ExternalToolsSection({
  workId,
  runnable,
}: {
  workId: string;
  runnable: boolean;
}) {
  const [servers, setServers] = useState<ExternalServer[] | null>(null);
  const [serverId, setServerId] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [tool, setTool] = useState("");
  const [argsJson, setArgsJson] = useState("{}");
  const [pending, setPending] = useState<ExternalToolCall[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const reload = () =>
    listEngineToolCalls(workId).then(setPending).catch(setError);

  useEffect(() => {
    let active = true;
    listEngineServers()
      .then((items) => {
        if (!active) return;
        setServers(items.filter((s) => s.status === "enabled"));
      })
      .catch((cause) => { if (active) setError(cause); });
    void reload();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId]);

  useEffect(() => {
    if (!serverId) { setProbe(null); setTool(""); return; }
    let active = true;
    setProbing(true);
    probeEngineServer(serverId)
      .then((result) => { if (active) { setProbe(result); setTool(""); } })
      .catch((cause) => { if (active) { setProbe(null); setError(cause); } })
      .finally(() => { if (active) setProbing(false); });
    return () => { active = false; };
  }, [serverId]);

  if (servers !== null && servers.length === 0) return null;

  async function propose() {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await proposeEngineToolCall({ workId, serverId, tool, argsJson });
      setNotice("Proposta pronta: approvala qui sotto per eseguire davvero la chiamata.");
      setArgsJson("{}");
      await reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function approve(call: ExternalToolCall) {
    setBusy(true);
    setError(null);
    try {
      const done = await approveEngineToolCall(call.id, call.digest);
      setNotice(done.status === "completed"
        ? "Strumento eseguito: il risultato è in revisione nella conversazione."
        : `La chiamata non è riuscita: ${done.error ?? "errore sconosciuto"}.`);
      await reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cw-engine-summary__tools" aria-label="Strumenti esterni">
      <h3>Strumenti esterni (MCP)</h3>
      <p className="cw-engine-summary__hint">
        Chiama uno strumento dichiarato: la proposta non esegue nulla; solo il tuo
        «Approva ed esegui» fa la chiamata, e il risultato arriva in revisione.
      </p>
      {servers === null ? (
        <p role="status">Leggo i server dichiarati…</p>
      ) : (
        <>
          <div className="cw-agent-editor__row">
            <label>
              Server
              <ConversationSelectField aria-label="Server MCP" value={serverId} disabled={busy || !runnable}
                onChange={(e) => setServerId(e.target.value)}>
                <option value="">Scegli…</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </ConversationSelectField>
            </label>
            <label>
              Strumento
              <ConversationSelectField aria-label="Strumento MCP" value={tool} disabled={busy || probing || !probe}
                onChange={(e) => setTool(e.target.value)}>
                <option value="">{probing ? "Scopro…" : probe ? "Scegli…" : "—"}</option>
                {probe?.tools.map((t) => <option key={t} value={t}>{t}</option>)}
              </ConversationSelectField>
            </label>
          </div>
          <label>
            Argomenti (JSON)
            <textarea className="cw-input" aria-label="Argomenti JSON" value={argsJson} rows={2} disabled={busy || !runnable}
              onChange={(e) => setArgsJson(e.target.value)} />
          </label>
          <div className="cs-actions">
            <button type="button" className="cw-secondary" disabled={busy || !runnable || !serverId || !tool}
              onClick={() => void propose()}>
              {busy ? "Preparo…" : "Prepara la proposta"}
            </button>
          </div>
        </>
      )}
      {pending.filter((c) => c.status === "pending_approval").map((call) => (
        <div className="cv-settings-card" key={call.id}>
          <strong>{call.server_name} · {call.tool}</strong>
          <p className="cw-engine-summary__hint">
            Argomenti: <code>{JSON.stringify(call.arguments)}</code>
          </p>
          <div className="cs-actions">
            <button type="button" className="cw-primary" disabled={busy}
              onClick={() => void approve(call)}>
              {busy ? "Eseguo…" : "Approva ed esegui"}
            </button>
          </div>
        </div>
      ))}
      {notice && <p role="status" className="cw-hint">{notice}</p>}
      <HomunErrorNotice error={error} />
    </section>
  );
}
