import { useEffect, useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { homunErrorFromHttp } from '@/lib/homun-errors';
import { approveFileEdit, listFileEdits, type FileEdit } from '@/lib/engine-file-edit-client';

export function EngineWorkspaceEditApproval({workId, requestId, active}: {workId: string; requestId: string; active: boolean}) {
  const [edit, setEdit] = useState<FileEdit | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const found = (await listFileEdits(workId)).find(item => item.id === requestId);
        if (!found) throw homunErrorFromHttp(404, {detail: 'Modifica collegata non disponibile'}, 'Modifica non disponibile');
        if (live) { setEdit(found); setError(null); }
      } catch (cause) { if (live) { setEdit(null); setError(cause); } }
      finally { if (live) timer = setTimeout(() => void read(), 1500); }
    }
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [workId, requestId]);
  async function approve() {
    if (!edit || busy || !active || edit.status !== 'pending_approval') return;
    setBusy(true); setError(null);
    try { setEdit(await approveFileEdit(workId, edit)); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  return <>{edit && <FileEditProposal edit={edit} busy={busy} active={active} approve={() => void approve()} />}<HomunErrorNotice error={error} /></>;
}

export function FileEditProposal({edit, busy, active, approve}: {edit: FileEdit; busy: boolean; active: boolean; approve: () => void}) {
  const introduced = edit.diagnostics?.introduced ?? [];
  return <section aria-label="Modifica file Homun">
    <h4>Modifica proposta da Homun</h4>
    <p>{edit.operation === 'patch' ? 'Sostituzione mirata' : 'Sostituzione dell’intero file'} di <code>{edit.path}</code>.</p>
    <p>Il file cambia solo se approvi questo contenuto esatto. Una lettura più recente annulla la proposta.</p>
    {edit.diff_preview && <details open><summary>Differenza proposta</summary><pre>{edit.diff_preview}</pre></details>}
    {edit.diagnostics?.lsp === 'unavailable' && <p>Non è disponibile un language server. Il controllo è solo sintattico, dove previsto.</p>}
    {!!introduced.length && <p role="alert">Errori di sintassi introdotti: {introduced.join(' ')}</p>}
    {edit.diagnostics?.preexisting && <p>{edit.diagnostics.note}</p>}
    {edit.status === 'pending_approval' && (active
      ? <button className="cw-primary" disabled={busy} onClick={approve}>Approva e scrivi il file</button>
      : <p>Il lavoro è interrotto: questa modifica non può essere approvata.</p>)}
    {edit.status !== 'pending_approval' && <p role="status">Modifica: {edit.status}</p>}
    {edit.error && <p role="alert">{edit.error}</p>}
  </section>;
}
