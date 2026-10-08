/** Resolve only the proposal linked by this run; never approve on mount or polling. */
import { useEffect, useState } from 'react';
import { approveEngineToolCall, listEngineToolCalls, type ExternalToolCall } from '@/lib/engine-mcp-client';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { homunErrorFromHttp } from '@/lib/homun-errors';

export function AgentExternalProposal({call, busy, active = true, onApprove}: {call: ExternalToolCall; busy: boolean; active?: boolean; onApprove: () => void}) {
  return <section aria-label="Azione esterna da approvare">
    <strong>{call.server_name} · {call.tool}</strong>
    {call.tool_description && <p>{call.tool_description}</p>}
    <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
    {active && call.status === 'pending_approval' && <>
      <p>Homun aspetta la tua approvazione per questa azione. L'avvio del lavoro non la autorizza automaticamente.</p>
      <button className="cw-primary" disabled={busy} onClick={onApprove}>Approva ed esegui</button>
    </>}
    {call.status === 'running' && <p role="status">Azione esterna in corso.</p>}
    {call.status === 'result_ready' && <p role="status">{active ? 'Risultato ricevuto: Homun può continuare il lavoro e preparare la consegna finale.' : 'Risultato esterno salvato; il lavoro è interrotto e la consegna non viene eseguita.'}</p>}
    {call.error && <p role="alert">{call.error}</p>}
  </section>;
}
export function EngineAgentExternalApproval({workId, requestId, active = true}: {workId: string; requestId: string | undefined; active?: boolean}) {
  const [call, setCall] = useState<ExternalToolCall | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCall(null); setLoadError(null); setError(null);
    async function read() {
      try {
        const found = (await listEngineToolCalls(workId)).find(item => item.id === requestId);
        if (!live) return;
        if (!found) throw homunErrorFromHttp(404, {detail:'Proposta esterna collegata non disponibile'}, 'Proposta esterna non disponibile');
        setCall(found); setLoadError(null);
      } catch (cause) { if (live) { setCall(null); setLoadError(cause); } }
      finally { if (live) timer = setTimeout(() => void read(), 1500); }
    }
    if (requestId) void read();
    else setLoadError(homunErrorFromHttp(404, {detail:'Riferimento alla proposta esterna mancante'}, 'Proposta esterna non disponibile'));
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [workId, requestId]);
  async function approve() {
    if (!active || !call || busy || call.status !== 'pending_approval') return;
    setBusy(true); setError(null);
    try { setCall(await approveEngineToolCall(call.id, call.digest)); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  return <>{call ? <AgentExternalProposal call={call} busy={busy} active={active} onApprove={() => void approve()} /> : !loadError && <p role="status">Leggo l'azione proposta da Homun…</p>}<HomunErrorNotice error={loadError} /><HomunErrorNotice error={error} /></>;
}
