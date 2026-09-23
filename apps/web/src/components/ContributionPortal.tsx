import { useEffect, useState } from 'react';
import { HomunErrorNotice } from './HomunErrorNotice';
import { ENGINE_DEFAULT_BASE_URL } from '@/lib/engine-client';
import { portalRequest, type ContributionPortalView } from '@/lib/engine-contribution-invitations';
import './builder/engine-organization.css';

export function ContributionPortal() {
  const [credentials] = useState(() => {
    const values = new URLSearchParams(window.location.hash.slice(1));
    return { token: values.get('contribution') || '', engine: values.get('engine') || ENGINE_DEFAULT_BASE_URL };
  });
  const [view,setView] = useState<ContributionPortalView | null>(null);
  const [text,setText] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<unknown>(null);
  const load = () => portalRequest<ContributionPortalView>(credentials.engine,credentials.token,'read').then(setView);
  useEffect(() => { void load().catch(setError); }, []);
  async function submit() {
    setBusy(true); setError(null);
    try { await portalRequest(credentials.engine,credentials.token,'respond',text); await load(); }
    catch(e) { setError(e); } finally { setBusy(false); }
  }
  return <main className="organization-editor" style={{ margin: '3rem auto' }}>
    <h1>Il tuo contributo</h1><p>Fonte: motore · Accesso limitato a questa richiesta.</p>
    <HomunErrorNotice error={error} />
    {view && <><p>Stai rispondendo come <strong>{view.recipient_name}</strong> ({view.recipient_id}).</p>
      <h2>{view.work_title}</h2><p>{view.need}</p>
      {view.status === 'used' ? <><p role="status">Risposta registrata. Grazie.</p><p>{view.response_text}</p></> : <>
        <label>La tua risposta<textarea rows={6} maxLength={12000} value={text} disabled={busy} onChange={e => setText(e.target.value)} /></label>
        <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? 'Invio…' : 'Invia il contributo'}</button>
      </>}
    </>}
    {!view && !error && <p>Caricamento della richiesta…</p>}
    <p>Se il motore non è raggiungibile, chiedi a chi ti ha invitato. Il link non abilita l'accesso agli altri lavori.</p>
  </main>;
}
