// Card di approvazione inline — come "Allow once / Always allow / Deny" dell'originale.
import { useStore } from '../store'
import type { TranscriptEntry } from '../../../shared/types'

export function ApprovalCard({ entry }: { entry: TranscriptEntry }) {
  const resolve = useStore((s) => s.resolveApproval)
  const approvalId = entry.meta?.approvalId as string | undefined
  const status = (entry.meta?.status as string | undefined) ?? 'pending'

  if (!approvalId) return null
  // C4: nomi dei segreti usati dal comando (meta.secretRefs sull'entry approval)
  const secretRefs = Array.isArray(entry.meta?.secretRefs) ? (entry.meta!.secretRefs as string[]) : []

  return (
    <div className="rounded-xl border border-orange-500/40 bg-orange-500/5 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-orange-300">
        <span>⛔</span>
        <span>Richiede la tua approvazione</span>
      </div>
      <div className="mt-1 font-mono text-xs text-neutral-300">
        {String(entry.meta?.tool)} {entry.content && entry.content !== String(entry.meta?.tool) ? `— ${entry.content}` : ''}
      </div>
      {secretRefs.length > 0 && (
        <div className="mt-1 text-xs text-orange-200/90">Credenziali usate: {secretRefs.join(', ')}</div>
      )}
      {status === 'pending' ? (
        <div className="mt-3 flex gap-2">
          <button
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
            onClick={() => resolve(approvalId, 'allow', false)}
          >
            Consenti una volta
          </button>
          <button
            className="rounded-lg bg-emerald-700/60 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600/60"
            onClick={() => resolve(approvalId, 'allow', true)}
          >
            Consenti sempre
          </button>
          <button
            className="rounded-lg bg-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-600"
            onClick={() => resolve(approvalId, 'deny', false)}
          >
            Nega
          </button>
        </div>
      ) : (
        <div className={`mt-2 text-xs ${status === 'allowed' ? 'text-emerald-400' : 'text-neutral-500'}`}>
          {status === 'allowed' ? '✓ Consentito' : status === 'denied' ? 'Negato' : status === 'cancelled' ? 'Annullata (interrupt)' : status}
        </div>
      )}
    </div>
  )
}
