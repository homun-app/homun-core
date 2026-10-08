/** Named question recipients are local contacts, never automatic invitations. */
import { useEffect, useRef, useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { createPerson, listPeople, type ContributionPerson } from '@/lib/engine-contribution-invitations';

export function EngineRunRecipientPicker({ value, disabled, onChange, onBusyChange }: {
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [people, setPeople] = useState<ContributionPerson[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const commandId = useRef(crypto.randomUUID());
  useEffect(() => {
    let live = true;
    listPeople().then(items => { if (live) setPeople(items); })
      .catch(cause => { if (live) setError(cause); });
    return () => { live = false; };
  }, []);
  async function add() {
    if (busy || !name.trim()) return;
    setBusy(true); onBusyChange(true); setError(null);
    try {
      const person = await createPerson(name.trim(), commandId.current);
      setPeople(items => [...items.filter(item => item.id !== person.id), person]);
      onChange(person.id);
      setAdding(false); setName('');
      commandId.current = crypto.randomUUID();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false); onBusyChange(false);
    }
  }
  return <div>
    <label>A chi chiedere eventuali chiarimenti?
      <select value={value} disabled={disabled || busy} onChange={e => onChange(e.target.value)}>
        <option value="">A me</option>
        {people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
    </label>
    {!adding ? <button type="button" className="cs-link" disabled={disabled || busy} onClick={() => setAdding(true)}>
      Aggiungi una persona
    </button> : <div>
      <label>Nome della persona<input value={name} maxLength={120} disabled={disabled || busy}
        onChange={e => { setName(e.target.value); commandId.current = crypto.randomUUID(); }} /></label>
      <p className="cw-hint">Aggiunge un destinatario per le domande. Nessun invito o messaggio viene inviato.</p>
      <button type="button" className="cw-secondary" disabled={disabled || busy || !name.trim()} onClick={() => void add()}>
        {busy ? 'Aggiunta in corso…' : 'Aggiungi e seleziona'}
      </button>
      <button type="button" className="cs-link" disabled={disabled || busy} onClick={() => setAdding(false)}>Annulla</button>
    </div>}
    <HomunErrorNotice error={error} />
  </div>;
}
