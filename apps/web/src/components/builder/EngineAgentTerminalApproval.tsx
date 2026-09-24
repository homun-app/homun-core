import { useEffect, useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { homunErrorFromHttp } from '@/lib/homun-errors';
import { listTerminalJobs, terminalAction, type TerminalJob } from '@/lib/engine-terminal-client';

export function EngineAgentTerminalApproval({workId, requestId, active}: {workId: string; requestId: string; active: boolean}) {
  const [job, setJob] = useState<TerminalJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const found = (await listTerminalJobs(workId)).find(item => item.id === requestId);
        if (!found) throw homunErrorFromHttp(404, {detail: 'Comando collegato non disponibile'}, 'Comando non disponibile');
        if (live) { setJob(found); setError(null); }
      } catch (cause) { if (live) { setJob(null); setError(cause); } }
      finally { if (live) timer = setTimeout(() => void read(), 1500); }
    }
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [workId, requestId]);
  async function act(action: 'approve' | 'refresh' | 'stop') {
    if (!job || busy || (action === 'approve' && !active)) return;
    setBusy(true); setError(null);
    try { setJob(await terminalAction(workId, job, action)); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  return <>{job && <TerminalProposal job={job} busy={busy} active={active} act={action => void act(action)} />}<HomunErrorNotice error={error} /></>;
}

export function TerminalProposal({job, busy, active, act}: {job: TerminalJob; busy: boolean; active: boolean; act: (action: 'approve' | 'refresh' | 'stop') => void}) {
  return <section aria-label="Comando Homun">
    {job && <>
      <h4>Comando proposto da Homun</h4>
      <pre>{job.command}</pre>
      {job.timeout_seconds !== undefined && <p>Durata autorizzata: {job.timeout_seconds} secondi.
        Il controllo della scadenza opera mentre Homun è acceso.</p>}
      {job.background && <p>Il comando resta in esecuzione dopo l'avvio. Homun potrà leggerne lo stato, attenderne la fine o arrestarlo senza una seconda approvazione.</p>}
      {job.stdin && !job.pty && <p>Homun potrà inviare input a questo processo dopo l'avvio. Non è un terminale interattivo.</p>}
      {job.pty && <p>Questo processo ha un terminale. Homun risponde alle richieste di stato, cursore e dimensione. Non è uno schermo completo.</p>}
      {job.timed_out && <p role="alert">Durata superata: Homun ha richiesto l’arresto. Verifica lo stato del processo qui sotto.</p>}
      <p>Ambiente isolato, senza rete, con una cartella dedicata a questo lavoro.</p>
      <details><summary>Ambiente autorizzato</summary><code>{job.image}</code></details>
      {job.status === 'pending_approval' && (active
        ? <button className="cw-primary" disabled={busy} onClick={() => void act('approve')}>Approva ed esegui il comando</button>
        : <p>Il lavoro è interrotto: questo comando non può essere approvato.</p>)}
      {job.status !== 'pending_approval' && <>
        <p role="status">Processo: {job.status}{job.exit_code !== undefined ? ` · uscita ${job.exit_code}` : ''}</p>
        <button className="cw-secondary" disabled={busy} onClick={() => void act('refresh')}>Aggiorna stato e log</button>
        {!['exited', 'dead', 'dispatching'].includes(job.status) && <button className="cw-secondary" disabled={busy} onClick={() => void act('stop')}>Arresta il processo</button>}
        {!active && !['exited', 'dead'].includes(job.status) && <p>Interrompere il lavoro non conferma l'arresto del processo. Puoi verificarlo e arrestarlo qui.</p>}
      </>}
      {job.logs && <details><summary>Log del processo (coda, massimo {job.logs.line_limit} righe)</summary>
        <pre>{job.logs.text}</pre>{job.logs.truncated && <p>Output ridotto al limite di visualizzazione.</p>}
      </details>}
      {job.error && <p role="alert">{job.error}</p>}
    </>}
  </section>;
}
