import { useEffect, useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { invitationRequest } from '@/lib/engine-contribution-invitations';
import { EngineContributionInvitations } from './EngineContributionInvitations';
import type { Work } from './conversation-types';

type Person = { id: string; name: string };
export function EngineAskPerson({ work, onChanged }: { work: Work; onChanged?: (() => Promise<void>) | undefined }) {
  const [people,setPeople] = useState<Person[]>([]);
  const [selected,setSelected] = useState('');
  const [name,setName] = useState('');
  const [question,setQuestion] = useState('');
  const [asked,setAsked] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<unknown>(null);
  useEffect(() => { void invitationRequest<{ items: Person[] }>('/people').then(v => setPeople(v.items)).catch(setError); }, []);
  async function ask() {
    setBusy(true); setError(null);
    try {
      let personId = selected;
      if (!personId) {
        const person = await invitationRequest<Person>('/people', { command_id: crypto.randomUUID(), name });
        personId = person.id;
      }
      await invitationRequest(`/works/${encodeURIComponent(work.id)}/ask-person`, {
        command_id: crypto.randomUUID(), person_id: personId, need: question, expected_version: work.revision,
        // A manual consultation is independent of plan completion.
        step_id: `consultation:${crypto.randomUUID()}`,
      });
      setAsked(true);
      await onChanged?.();
    } catch(e) { setError(e); } finally { setBusy(false); }
  }
  if (asked) return <EngineContributionInvitations workId={work.id} />;
  return <section className="organization-editor">
    <h3>Chiedi a una persona</h3>
    <p>Definisci il destinatario e la domanda. Poi potrai creare un link riservato per raccogliere la risposta.</p>
    <HomunErrorNotice error={error} />
    <label>Destinatario<select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Nuova persona</option>
      {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>
    {!selected && <label>Nome<input value={name} maxLength={120} onChange={e => setName(e.target.value)} /></label>}
    <label>Di cosa hai bisogno?<textarea value={question} maxLength={4000} rows={3} onChange={e => setQuestion(e.target.value)} /></label>
    <button type="button" disabled={busy || (!selected && !name.trim()) || !question.trim()} onClick={() => void ask()}>Crea richiesta di contributo</button>
  </section>;
}
