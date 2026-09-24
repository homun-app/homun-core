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
import { EngineWorkspaceEditApproval } from './EngineWorkspaceEditApproval';
import { EngineAgentControls } from './EngineAgentControls';

export function EngineAgentRun({ work, onChanged }: { work: Work; onChanged: () => Promise<void> }) {
  const [terminalImage, setTerminalImage] = useState('');
  const [localTerminal, setLocalTerminal] = useState(false);
  const [sshTerminal, setSshTerminal] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshHostKey, setSshHostKey] = useState('');
  const terminalValid = sshTerminal
    ? Boolean(sshHost && sshUser && sshKeyPath && sshHostKey && Number(sshPort) >= 1)
    : localTerminal || !terminalImage || /^sha256:[0-9a-f]{64}$/.test(terminalImage);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [teams, setTeams] = useState<EngineTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [personId, setPersonId] = useState('');
  const [webPages, setWebPages] = useState(false);
  const [ownedBrowser, setOwnedBrowser] = useState(false);
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
    prepare: (work: Work, id: string, materials: string[], team: string, person: string, servers: string[]) => prepareAgentRun(work, materials, id, team || undefined, person || undefined, servers, localTerminal || sshTerminal ? undefined : terminalImage || undefined, sshTerminal ? 'ssh' : localTerminal ? 'local' : undefined, sshTerminal ? {host: sshHost, user: sshUser, port: Number(sshPort), hostKey: sshHostKey, keyPath: sshKeyPath} : undefined, webPages, ownedBrowser),
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
      <label><input type="checkbox" checked={webPages} disabled={run.busy}
        onChange={e => { run.renew(); setWebPages(e.target.checked); }} /> Leggi pagine web pubbliche</label>
      {webPages && <p>Homun può cercare sul web pubblico e leggere il testo di una pagina http. Gli indirizzi privati sono rifiutati. La ricerca non entra negli account.</p>}
      <label><input type="checkbox" checked={ownedBrowser} disabled={run.busy}
        onChange={e => { run.renew(); setOwnedBrowser(e.target.checked); }} /> Apri un browser privato, senza il tuo profilo</label>
      {ownedBrowser && <p>Homun avvia un browser separato e lo tiene aperto per questo lavoro. Può leggere la pagina, compilare un campo, premere un tasto e salvare una schermata della pagina. Non usa il profilo di Chrome di questo computer e non fotografa lo schermo. Non entra negli account da solo. Se la pagina apre una finestra nativa, la chiude senza confermare e riporta il testo.</p>}
      <details><summary>Terminale (opzionale)</summary>
        <p>Consenti a Homun di proporre comandi. Ogni comando richiederà la tua approvazione.</p>
        <label><input type="checkbox" checked={localTerminal} disabled={run.busy}
          onChange={e => { run.renew(); setLocalTerminal(e.target.checked); if (e.target.checked) setSshTerminal(false); }} /> Esegui su questo computer, senza container</label>
        <label><input type="checkbox" checked={sshTerminal} disabled={run.busy}
          onChange={e => { run.renew(); setSshTerminal(e.target.checked); if (e.target.checked) setLocalTerminal(false); }} /> Esegui via SSH su un host approvato</label>
        {sshTerminal && <>
          <p>Ogni comando resta da approvare. Homun non usa la configurazione SSH di questo computer e non copia i file.</p>
          <label>Host<input value={sshHost} disabled={run.busy} onChange={e => { run.renew(); setSshHost(e.target.value.trim()); }} /></label>
          <label>Utente<input value={sshUser} disabled={run.busy} onChange={e => { run.renew(); setSshUser(e.target.value.trim()); }} /></label>
          <label>Porta<input value={sshPort} disabled={run.busy} onChange={e => { run.renew(); setSshPort(e.target.value.trim()); }} /></label>
          <label>Percorso della chiave privata<input value={sshKeyPath} disabled={run.busy} onChange={e => { run.renew(); setSshKeyPath(e.target.value.trim()); }} /></label>
          <label>Chiave pubblica del server<input value={sshHostKey} disabled={run.busy} onChange={e => { run.renew(); setSshHostKey(e.target.value.trim()); }} /></label>
        </>}
        {localTerminal
          ? <p>I comandi usano la cartella del lavoro e non ereditano le variabili d'ambiente. Non sono isolati dalla rete né dai percorsi assoluti.</p>
          : sshTerminal ? null
          : <><p>Serve Docker locale con un’immagine già presente; non verrà scaricata automaticamente.</p>
            <label>Identificativo completo dell’immagine Docker
              <input value={terminalImage} disabled={run.busy} placeholder="sha256:…"
                onChange={e => { run.renew(); setTerminalImage(e.target.value.trim()); }} />
            </label>
            {!terminalValid && <p role="alert">Inserisci sha256: seguito dalle 64 cifre esadecimali dell’immagine.</p>}
          </>}
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
        Il risultato arriverà in revisione. Gli invii esterni richiedono un’approvazione separata.</p>
      {p.browser?.policy === 'owned-headless-v1' && p.browser.version === 1 && <p>Homun può aprire un browser privato, leggere una pagina pubblica e chiudere quel browser. Non usa il profilo di Chrome di questo computer.</p>}
      {p.browser?.policy === 'owned-headless-v1' && p.browser.version === 2 && <p>Homun può aprire un browser privato, leggere una pagina pubblica e chiudere quel browser. Non usa il profilo di Chrome di questo computer. Una finestra nativa viene chiusa senza conferma e il suo testo viene riportato.</p>}
      {p.browser?.policy === 'owned-headless-v1' && p.browser.version === 3 && <p>Homun può aprire un browser privato, leggere una pagina pubblica, compilare un campo e chiudere solo quel browser. Non usa il profilo di Chrome di questo computer. Una finestra nativa viene chiusa senza conferma e il suo testo viene riportato.</p>}
      {p.browser?.policy === 'owned-headless-v1' && p.browser.version === 4 && <p>Homun può aprire un browser privato, leggere una pagina pubblica, compilare un campo, salvare una schermata della pagina e chiudere solo quel browser. Non usa il profilo di Chrome di questo computer e non fotografa lo schermo. Una finestra nativa viene chiusa senza conferma e il suo testo viene riportato.</p>}
      {p.browser?.policy === 'owned-headless-v1' && p.browser.version === 5 && <p>Homun può aprire un browser privato, leggere una pagina pubblica, interagire con riquadri interni, compilare un campo, salvare una schermata della pagina e chiudere solo quel browser. Non usa il profilo di Chrome di questo computer e non fotografa lo schermo. Una finestra nativa viene chiusa senza conferma e il suo testo viene riportato.</p>}
      {p.web_pages?.version === 3 && <p>Homun può cercare sul web pubblico, consultare provider dedicati e post pubblici su X con credenziali configurate, e leggere pagine http con memoria temporanea. Gli indirizzi privati sono rifiutati.</p>}
      {p.web_pages?.version === 2 && <p>Homun può cercare sul web pubblico e leggere pagine http. Gli indirizzi privati sono rifiutati. La ricerca non entra negli account.</p>}
      {p.web_pages?.version === 1 && <p>Homun può leggere pagine http pubbliche. Gli indirizzi privati sono rifiutati. La ricerca web non è configurata.</p>}
      {p.memory?.policy === 'scoped-workspace-v1' && <p>Homun può consultare la memoria persistente del progetto, annotare fatti importanti verificati e cercare messaggi passati nella sessione.</p>}
      {p.skills?.policy === 'workspace-catalog-v1' && <p>Homun può consultare le competenze e linee guida approvate dell’area di lavoro e proporre nuove competenze in quarantena in attesa di approvazione umana.</p>}
      {p.delegation?.policy === 'isolated-subagent-v1' && <p>Homun può delegare compiti a sotto-agenti isolati con budget limitato, strumenti dedicati e convalida di schemi strutturati.</p>}
      {p.clarify?.policy === 'structured-clarify-v1' && <p>Homun può porre domande a scelta singola, multipla o aperta per chiarire requisiti e decisioni.</p>}
      {p.goals?.policy === 'persistent-goals-v1' && <p>Homun gestisce obiettivi persistenti su più turni con contratti di verifica, barriere di attesa e criteri di qualità deterministici.</p>}
      {p.cron?.policy === 'durable-cron-v1' && <p>Homun gestisce pianificazioni cron persistenti con esecuzione a script o agente, catena di contesti e tracciamento incidenti.</p>}
      {p.session_management?.policy === 'durable-sessions-v1' && <p>Homun gestisce il ciclo di vita delle sessioni con ripristino cartella di lavoro, biforcazioni con tracciamento genealogia, esportazioni con rimozione dati sensibili e integrità SQLite.</p>}
      {p.gateway?.policy === 'core-gateway-v1' && <p>Homun gestisce il runtime gateway multicanale con accoppiamento codici DM, leasing turni esclusivo, stanze di discussione multi-agente e adattatori di messaggistica.</p>}
      {p.code_execution?.policy === 'programmatic-v1' && <p>Homun può comporre chiamate programmatiche agli strumenti tramite script Python locali, riducendo l'output e gestendo gli errori in un unico turno.</p>}
      {p.terminal?.policy === 'ssh-v1'
        ? <p>Homun può proporre comandi su {p.terminal.user}@{p.terminal.host}:{p.terminal.port}. Ogni esecuzione richiede un’approvazione separata. Non è un container e non copia i file.</p>
        : p.terminal?.policy === 'local-private-v1'
        ? <p>Homun può proporre comandi su questo computer, nella cartella del lavoro. Ogni esecuzione richiede un’approvazione separata. Non è un container isolato.</p>
        : p.terminal && <p>Terminale isolato abilitato per proporre comandi. Ogni esecuzione richiede un’approvazione separata.</p>}
      {p.tools?.some(tool => tool.name === 'write_workspace_file') && <p>Homun può leggere, cercare e proporre modifiche nella cartella del run. Ogni scrittura richiede una tua approvazione separata, dopo una lettura aggiornata.</p>}
      {p.tools?.some(tool => tool.toolset === "workspace_files") && !p.tools?.some(tool => tool.name === 'write_workspace_file') && <p>Homun può leggere e consegnare copie dei file prodotti nella cartella del run.</p>}
      {!!p.external_tools?.length && <>
        <p>Strumenti disponibili: ogni azione esterna richiede una tua approvazione separata.</p>
        <ul>{p.external_tools.map(tool => <li key={`${tool.server_id}:${tool.tool}`}><strong>{tool.server_name} · {tool.tool}</strong>{tool.description && ` — ${tool.description}`}</li>)}</ul>
      </>}
      <button className="cw-primary" disabled={run.busy} onClick={() => void run.approve()}>Avvia il lavoro</button>
    </>}
    {p && ['queued','running'].includes(p.status) && <p role="status">{p.executor_name} sta lavorando · {p.turns} passaggi completati.</p>}
    {p?.external_request_id && <EngineAgentExternalApproval active={p.status === 'waiting_external'} key={p.external_request_id ?? p.id} workId={work.id} requestId={p.external_request_id} />}
    {p?.terminal_request_id && <EngineAgentTerminalApproval key={p.terminal_request_id} workId={work.id} requestId={p.terminal_request_id} active={p.status === 'waiting_external'} />}
    {p?.file_edit_request_id && <EngineWorkspaceEditApproval key={p.file_edit_request_id} workId={work.id} requestId={p.file_edit_request_id} active={p.status === 'waiting_external'} />}
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
