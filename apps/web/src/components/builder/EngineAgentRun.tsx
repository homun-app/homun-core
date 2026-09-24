/** Adaptive work: authorize sources once, follow decisions, review delivery. */
import { useEffect, useState } from 'react';
import type { Work } from './conversation-types';
import { useEngineExecution } from '@/hooks/useEngineExecution';
import { approveAgentRun, listAgentRuns, prepareAgentRun } from '@/lib/engine-agent-run-client';
import { eligibleForRead, READ_UPLOAD_EXTENSIONS } from '@/lib/engine-material-selection';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { HomunGuidanceNotice } from '@/components/HomunGuidanceNotice';
import { listEngineTeams, type EngineTeam } from '@/lib/engine-projects-client';
import { EngineRunRecipientPicker } from './EngineRunRecipientPicker';
import { EngineMaterialSelection } from './EngineMaterialSelection';
import { EngineAgentServerPicker } from './EngineAgentServerPicker';
import { EngineAgentExternalApproval } from './EngineAgentExternalApproval';
import { EngineAgentTerminalApproval } from './EngineAgentTerminalApproval';
import { EngineAgentControls } from './EngineAgentControls';

export function EngineAgentRun({ work, onChanged }: { work: Work; onChanged: () => Promise<void> }) {
  const [terminalImage, setTerminalImage] = useState('');
  const terminalValid = !terminalImage || /^sha256:[0-9a-f]{64}$/.test(terminalImage);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [teams, setTeams] = useState<EngineTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [personId, setPersonId] = useState('');
  const [personBusy, setPersonBusy] = useState(false);
  const [teamError, setTeamError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    listEngineTeams().then(items => { if (live) setTeams(items.filter(t => t.status === 'active')); })
      .catch(error => { if (live) setTeamError(error); });
    return () => { live = false; };
  }, []);
  const run = useEngineExecution(work, onChanged, {
    list: listAgentRuns, approve: approveAgentRun,
    prepare: (work: Work, id: string, materials: string[], team: string, person: string, servers: string[]) => prepareAgentRun(work, materials, id, team || undefined, person || undefined, servers, terminalImage || undefined),
  });
  const p = run.proposal;
  const revising = p?.status === 'completed' && work.engineStatus === 'ready';
  const idle = !p || ['failed', 'blocked'].includes(p.status) || revising;
  return <section className="cw-price-tool" aria-label="Esecuzione Homun">
    <h3>Lavora con Homun</h3>
    <p>Homun può cercare e leggere nei documenti scelti, approfondire i risultati e preparare la consegna.
      Se manca un'informazione, la chiederà a te o alla persona che scegli.</p>
    {idle && <>
      {teams.length > 0 && <label>Con chi vuoi lavorare?
        <select value={teamId} disabled={run.busy} onChange={e => { run.renew(); setTeamId(e.target.value); }}>
          <option value="">Homun direttamente</option>
          {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select>
      </label>}
      <HomunErrorNotice error={teamError} />
      <EngineRunRecipientPicker value={personId} disabled={run.busy} onBusyChange={setPersonBusy}
        onChange={id => { run.renew(); setPersonId(id); }} />
      <EngineAgentServerPicker selected={serverIds} disabled={run.busy} onChange={ids => { run.renew(); setServerIds(ids); }} />
      <details><summary>Terminale isolato (opzionale)</summary>
        <p>Consenti a Homun di proporre comandi. Ogni comando richiederà la tua approvazione.
          Serve Docker locale con un’immagine già presente; non verrà scaricata automaticamente.</p>
        <label>Identificativo completo dell’immagine Docker
          <input value={terminalImage} disabled={run.busy} placeholder="sha256:…"
            onChange={e => { run.renew(); setTerminalImage(e.target.value.trim()); }} />
        </label>
        {!terminalValid && <p role="alert">Inserisci sha256: seguito dalle 64 cifre esadecimali dell’immagine.</p>}
      </details>
      <EngineMaterialSelection work={work} filter={eligibleForRead} uploadExtensions={READ_UPLOAD_EXTENSIONS}
        selected={selected} maxSelected={12} disabled={run.busy}
        emptyHint="Puoi partire dalla richiesta o aggiungere i documenti da consultare."
        onSelectionChange={ids => { run.renew(); setSelected(ids); }} />
      <button className="cw-secondary" disabled={run.busy || personBusy || !terminalValid || !['draft','ready','failed'].includes(work.engineStatus ?? '')}
        onClick={() => void run.prepare(selected, teamId, personId, serverIds)}>{revising ? 'Prepara la revisione richiesta' : "Prepara l’esecuzione"}</button>
    </>}
    {p?.status === 'pending_approval' && <>
      <p><strong>{p.executor_name}</strong> · {p.materials.length ? p.materials.map(m => m.title).join(', ') : 'Obiettivo senza documenti'}</p>
      {p.team && <p>Squadra: {p.team.name}. Può consultare {p.team.members.map(m => m.name).join(', ')} usando i modelli configurati.</p>}
      {p.person && <p>Eventuali chiarimenti saranno richiesti a {p.person.name}, tramite un invito limitato alla domanda.</p>}
      <p>Autorizzi letture e ricerche su queste fonti, fino a {p.limits.max_turns} passaggi.
        Il risultato arriverà in revisione. Invii esterni e modifiche ai file non sono inclusi.</p>
      {p.terminal && <p>Terminale isolato abilitato per proporre comandi. Ogni esecuzione richiede un’approvazione separata.</p>}
      {p.tools?.some(tool => tool.toolset === "workspace_files") && <p>Homun può leggere e consegnare copie dei file prodotti nella cartella del run.</p>}
      {!!p.external_tools?.length && <>
        <p>Strumenti disponibili: ogni azione esterna richiede una tua approvazione separata.</p>
        <ul>{p.external_tools.map(tool => <li key={`${tool.server_id}:${tool.tool}`}><strong>{tool.server_name} · {tool.tool}</strong>{tool.description && ` — ${tool.description}`}</li>)}</ul>
      </>}
      <button className="cw-primary" disabled={run.busy} onClick={() => void run.approve()}>Avvia il lavoro</button>
    </>}
    {p && ['queued','running'].includes(p.status) && <p role="status">{p.executor_name} sta lavorando · {p.turns} passaggi completati.</p>}
    {p?.external_request_id && <EngineAgentExternalApproval active={p.status === 'waiting_external'} key={p.external_request_id ?? p.id} workId={work.id} requestId={p.external_request_id} />}
    {p?.terminal_request_id && <EngineAgentTerminalApproval key={p.terminal_request_id} workId={work.id} requestId={p.terminal_request_id} active={p.status === 'waiting_external'} />}
    {p?.status === 'paused' && <p role="status">Lavoro in pausa. Puoi correggere le indicazioni o riprendere.</p>}
    {p?.status === 'cancelled' && <p role="status">Esecuzione interrotta. Le attività già svolte restano consultabili.</p>}
    {p && <EngineAgentControls key={p.id} workId={work.id} run={p} onUpdated={async updated => {
      run.updateProposal(updated);
      await onChanged();
    }} />}
    {p?.history_redacted && <p>Lo storico delle fonti non è accessibile con i permessi attuali.</p>}
    {p?.observations.length ? <details><summary>Attività svolte</summary><ol>
      {p.observations.map((step, i) => <li key={i}>{step.message ?? (step.tool === 'human_input' ? 'Chiarimento ricevuto' : step.tool)}</li>)}
    </ol></details> : null}
    {p?.status === 'waiting_input' && <p role="status">{p.person ? `Homun aspetta un chiarimento da ${p.person.name}. Usa l’invito al contributo nella conversazione per condividere la domanda.` : "Homun aspetta il tuo chiarimento. Rispondi nella conversazione per proseguire."}</p>}
    {p?.status === 'completed' && !revising && <p role="status">Risultato pronto per la tua verifica nella conversazione.</p>}
    {p && ['failed','blocked'].includes(p.status) && <p role="alert">Il lavoro si è fermato: {p.error_code ?? p.status}. Le attività già svolte restano consultabili.</p>}
    <HomunGuidanceNotice message={run.recovery} /><HomunErrorNotice error={run.error} />
  </section>;
}
