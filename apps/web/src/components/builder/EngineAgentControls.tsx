/** Human steering of an already approved native execution. */
import { useRef, useState } from 'react';
import './engine-agent-controls.css';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { controlAgentRun, type AgentControlAction, type AgentControlOperation, type AgentRun } from '@/lib/engine-agent-run-client';
import { isHomunClientError } from '@/lib/homun-errors';

type PendingControl = { action: AgentControlAction; text: string | undefined; operation: AgentControlOperation };
export function EngineAgentControls({ workId, run, onUpdated }: {
  workId: string; run: AgentRun; onUpdated: (run: AgentRun) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const pending = useRef<PendingControl | null>(null);
  if (run.tool_version !== 'adaptive-materials-native-v2'
    || !['queued', 'running', 'waiting_input', 'paused'].includes(run.status)) return null;

  async function send(action: AgentControlAction) {
    if (busy) return;
    const correction = action === 'steer' || action === 'redirect' ? text.trim() : undefined;
    if (correction === '') return;
    if (!pending.current || pending.current.action !== action || pending.current.text !== correction)
      pending.current = {action, text: correction, operation: {commandId: crypto.randomUUID()}};
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const updated = await controlAgentRun(workId, run.id, action, pending.current.operation, correction);
      pending.current = null;
      if (correction) setText('');
      setNotice(action === 'steer' ? 'Correzione ricevuta: sarà usata al prossimo passaggio.'
        : action === 'redirect' ? 'Indicazioni ricevute: Homun rivaluterà le azioni ancora da eseguire.'
        : action === 'pause' ? 'Lavoro in pausa.' : action === 'resume' ? 'Lavoro ripreso.' : 'Esecuzione interrotta.');
      await onUpdated(updated);
    } catch (cause) {
      // Definitive rejection permits a fresh version on the next attempt. A
      // lost response retains both command identity and the exact pinned body.
      if (isHomunClientError(cause) && cause.httpStatus !== null && !cause.retryable)
        pending.current = null;
      setError(cause);
    } finally { setBusy(false); }
  }

  return <section className="cw-agent-controls" aria-label="Controlla il lavoro">
    <div className="cw-agent-control-actions">
      {run.status !== 'waiting_input' && (run.status === 'paused'
        ? <button className="cw-secondary" disabled={busy} onClick={() => void send('resume')}>Riprendi</button>
        : <button className="cw-secondary" disabled={busy} onClick={() => void send('pause')}>Pausa</button>)}
      <button className="cw-secondary" disabled={busy} onClick={() => void send('cancel')}>Interrompi</button>
    </div>
    {run.status !== 'waiting_input' && <>
    <label>Correggi le indicazioni
      <textarea rows={3} maxLength={16000} value={text} disabled={busy}
        onChange={event => { setText(event.target.value); setNotice(''); }}
        placeholder="Ad esempio: considera solo i dati di settembre" />
    </label>
    <p>La correzione viene letta al prossimo passaggio. «Rivedi il piano» scarta le azioni ancora da eseguire e rivaluta il lavoro con le nuove indicazioni. Le attività già svolte restano registrate.</p>
    {run.status === 'paused' && <p>Le nuove indicazioni saranno usate quando riprendi il lavoro.</p>}
    <div className="cw-agent-control-actions">
      <button className="cw-secondary" disabled={busy || !text.trim()} onClick={() => void send('steer')}>Invia correzione</button>
      <button className="cw-secondary" disabled={busy || !text.trim()} onClick={() => void send('redirect')}>Rivedi il piano</button>
    </div>
    </>}
    {notice && <p role="status">{notice}</p>}
    <HomunErrorNotice error={error} />
  </section>;
}
