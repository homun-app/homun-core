/** Review a saved external result before delivery to the current work. */
import { useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { approveEngineToolDelivery, previewEngineToolDelivery, type ExternalDeliveryPreview } from '@/lib/engine-mcp-client';

export function ExternalDeliveryCard({ proposalId, onChanged }: { proposalId: string; onChanged: () => Promise<void> }) {
  const [preview, setPreview] = useState<ExternalDeliveryPreview | null>(null);
  const [commandId, setCommandId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function review() {
    setBusy(true); setError(null); setPreview(null);
    try {
      setPreview(await previewEngineToolDelivery(proposalId));
      setCommandId(crypto.randomUUID());
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  async function deliver() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      await approveEngineToolDelivery(preview, commandId);
      await onChanged();
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }
  return <div>
    <p>Il risultato è già salvato. Rivedi la consegna per aggiungerlo al lavoro attuale.</p>
    <button type="button" className="cw-secondary" disabled={busy} onClick={() => void review()}>
      {preview ? 'Aggiorna anteprima' : 'Rivedi consegna'}
    </button>
    {preview && <div>
      <strong>{preview.title}</strong>
      <p>{preview.objective}</p>
      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{preview.text}</pre>
      <p>Questa approvazione consegna il risultato salvato senza ripetere l’azione esterna.</p>
      <button type="button" className="cw-primary" disabled={busy} onClick={() => void deliver()}>
        {busy ? 'Attendi…' : 'Approva la consegna al lavoro'}
      </button>
    </div>}
    <HomunErrorNotice error={error} />
  </div>;
}
