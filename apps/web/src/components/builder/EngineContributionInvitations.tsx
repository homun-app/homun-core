import { useEffect, useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { contributionLink, invitationRequest, type InvitationList, type ContributionInvitation } from '@/lib/engine-contribution-invitations';

export function EngineContributionInvitations({ workId }: { workId: string }) {
  const [data,setData] = useState<InvitationList | null>(null);
  const [name,setName] = useState('');
  const [link,setLink] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<unknown>(null);
  const [copied,setCopied] = useState(false);
  const refresh = () => invitationRequest<InvitationList>(`/works/${encodeURIComponent(workId)}/contribution-invitations`).then(setData);
  useEffect(() => { void refresh().catch(setError); }, [workId]);
  async function issue(requestId: string, registeredName: string | null) {
    setBusy(true); setError(null); setLink(''); setCopied(false);
    try {
      const value = await invitationRequest<ContributionInvitation>(`/contributions/${encodeURIComponent(requestId)}/invitation`, { recipient_name: registeredName || name });
      if (value.token) setLink(contributionLink(value.token,window.location.href));
      await refresh();
    } catch(e) { setError(e); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError(null);
    try { await invitationRequest(`/contribution-invitations/${encodeURIComponent(id)}/revoke`, {}); setLink(''); await refresh(); }
    catch(e) { setError(e); } finally { setBusy(false); }
  }
  return <section className="organization-editor" aria-label="Invito al contributo">
    <h3>Chiedi il contributo alla persona</h3>
    <p>Il link consente solo di leggere questa richiesta e inviare una risposta come destinatario indicato. Scade dopo 7 giorni.</p>
    <p>Il motore è locale: la persona deve poter raggiungere questa pagina e il motore. Questo invito non pubblica il server e non invia messaggi.</p>
    <HomunErrorNotice error={error} />
    {data?.requests.map(request => <div key={request.id}>
      <p>{request.need}</p><p>Destinatario: {request.recipient_name || request.recipient_id}</p>
      {!request.recipient_name && <label>Nome della persona<input value={name} maxLength={120} onChange={e => setName(e.target.value)} /></label>}
      <button type="button" disabled={busy || (!request.recipient_name && !name.trim())} onClick={() => void issue(request.id,request.recipient_name)}>Crea un link di invito</button>
    </div>)}
    {link && <div><p>Conserva il link: sarà mostrato solo ora. Crearne un altro revoca quello precedente.</p>
      <textarea aria-label="Link di invito riservato" readOnly value={link} rows={3} />
      <button type="button" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(setError)}>{copied ? 'Copiato' : 'Copia link'}</button>
    </div>}
    {data?.invitations.filter(i => i.status === 'active').map(invitation => <p key={invitation.id}>
      Invito per {invitation.recipient_name} · scade {new Date(invitation.expires_at).toLocaleDateString()}{' '}
      <button type="button" disabled={busy} onClick={() => void revoke(invitation.id)}>Revoca</button>
    </p>)}
  </section>;
}
