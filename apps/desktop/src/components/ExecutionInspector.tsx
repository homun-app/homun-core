import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import {
  fetchAgentRunEvents,
  fetchLatestAgentCheckpoint,
  fetchLatestAgentPrompt,
  fetchThreadAgentRuns,
  fetchThreadWorkingLedger,
  type AgentPromptView,
  type AgentRunEventView,
  type AgentRunView,
} from "../lib/chatApi";

export function ExecutionInspector({ threadId }: { threadId: string }) {
  const [runs, setRuns] = useState<AgentRunView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentRunEventView[]>([]);
  const [prompt, setPrompt] = useState<AgentPromptView | null>(null);
  const [checkpoint, setCheckpoint] = useState<Record<string, unknown> | null>(null);
  const [ledger, setLedger] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchThreadAgentRuns(threadId), fetchThreadWorkingLedger(threadId)])
      .then(([nextRuns, nextLedger]) => {
        if (cancelled) return;
        setRuns(nextRuns);
        setLedger(nextLedger.markdown);
        setSelected(nextRuns[0]?.run_id ?? null);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [threadId]);

  useEffect(() => {
    if (!selected) { setEvents([]); setPrompt(null); setCheckpoint(null); return; }
    let cancelled = false;
    Promise.allSettled([
      fetchAgentRunEvents(selected),
      fetchLatestAgentPrompt(selected),
      fetchLatestAgentCheckpoint(selected),
    ]).then(([eventResult, promptResult, checkpointResult]) => {
      if (cancelled) return;
      setEvents(eventResult.status === "fulfilled" ? eventResult.value : []);
      setPrompt(promptResult.status === "fulfilled" ? promptResult.value : null);
      setCheckpoint(checkpointResult.status === "fulfilled" ? checkpointResult.value : null);
    });
    return () => { cancelled = true; };
  }, [selected]);

  if (loading) return <div className="workbench-empty"><Loader2 size={22} className="spin" /><p>Loading execution state…</p></div>;
  if (error) return <div className="workbench-empty"><AlertCircle size={24} /><p>{error}</p></div>;
  if (runs.length === 0) return <div className="workbench-empty"><CheckCircle2 size={24} /><p>No agent execution recorded for this task yet.</p></div>;
  const run = runs.find((item) => item.run_id === selected) ?? runs[0];
  return (
    <div className="execution-inspector">
      <label className="execution-run-select">Attempt
        <select value={run.run_id} onChange={(event) => setSelected(event.target.value)}>
          {runs.map((item) => <option key={item.run_id} value={item.run_id}>#{item.attempt} · {item.status}</option>)}
        </select>
      </label>
      <div className="execution-summary">
        <span className={`execution-status ${run.status}`}>{run.status}</span>
        <span>{run.model ?? "default model"}</span>
        <code>{run.prompt_fingerprint?.slice(0, 12) ?? "no prompt hash"}</code>
      </div>
      <section><h4>Instruction packets</h4>
        {prompt?.packets?.length ? <ul>{prompt.packets.map((packet) =>
          <li key={`${packet.source}:${packet.id}`}><strong>{packet.source}</strong> · {packet.id}<small>{packet.chars} chars · {packet.sha256.slice(0, 10)}</small></li>)}</ul>
          : <p className="wf-muted">No packet snapshot.</p>}
      </section>
      <section><h4>Timeline</h4><ol className="execution-timeline">{events.map((event) =>
        <li key={event.event_id}><code>{event.kind}</code><span>{event.round == null ? "run" : `round ${event.round}`}</span></li>)}</ol></section>
      <section><h4>Safe checkpoint</h4><p>{checkpoint ? `Round ${String(checkpoint.round ?? "—")} · ${String(checkpoint.fingerprint ?? "").slice(0, 16)}` : "No resumable checkpoint."}</p></section>
      <details><summary>Working Ledger</summary><pre>{ledger}</pre></details>
    </div>
  );
}
