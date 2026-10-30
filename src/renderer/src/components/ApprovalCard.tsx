// Card di approvazione inline — come "Allow once / Always allow / Deny" dell'originale.
// Fase 4: per update_state su routine la card mostra nome, schedule in
// linguaggio naturale e prompt (il cambio di automazione che sta per fare).
// Fase 8: pulsante "Consenti per questo turno" (stessa chiave del gate fino a
// fine turno), card compressa "Approvato automaticamente dalla regola" per le
// auto-approvazioni dell'auto-review, e "Crea regola da questa azione" che
// apre l'editor di Impostazioni → Approvazione automatica precompilato.
import { useStore } from '../store'
import { useLingui, Trans } from '@lingui/react/macro'
import { describeCron } from '../../../shared/cron-human'
import type { TranscriptEntry } from '../../../shared/types'

/** Suggerimento di regola allow partendo dall'azione della card (fase 8). */
function suggestedRule(tool: string, input: Record<string, unknown> | undefined): string {
  if (tool === 'run-command' && typeof input?.command === 'string') {
    return `comandi ${input.command.trim().split(/\s+/)[0] ?? ''} dentro il computer del bot`
  }
  if (tool === 'write-file' && typeof input?.path === 'string') {
    return `scrivere file in ${String(input.path).split('/').slice(0, -1).join('/') || 'cartella del bot'}`
  }
  if (tool === 'read-file' && typeof input?.path === 'string') {
    return `leggere file in ${String(input.path).split('/').slice(0, -1).join('/') || 'cartella del bot'}`
  }
  if (tool.startsWith('mcp__')) return `il tool ${tool}`
  return `il tool ${tool}`
}

export function ApprovalCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const resolve = useStore((s) => s.resolveApproval)
  const proposeRule = useStore((s) => s.proposeRule)
  const approvalId = entry.meta?.approvalId as string | undefined
  const status = (entry.meta?.status as string | undefined) ?? 'pending'
  const tool = String(entry.meta?.tool)

  // fase 8: auto-approvata dall'auto-review — compressa, espandibile
  if (entry.meta?.autoApproved) {
    return (
      <details className="rounded-2xl border border-chart-2/40 bg-chart-2/10 px-4 py-2">
        <summary className="cursor-pointer select-none text-xs text-chart-2/90">
          <Trans>⚡ Approvato automaticamente dalla regola: {String(entry.meta?.ruleMatched ?? '')}</Trans>
          {entry.meta?.reason ? <span className="text-muted-foreground"> — {String(entry.meta.reason)}</span> : null}
        </summary>
        <div className="mt-2 font-mono text-[11px] text-muted-foreground">
          {tool} {entry.content && entry.content !== tool ? `— ${entry.content}` : ''}
        </div>
      </details>
    )
  }

  if (!approvalId) return null
  // C4: nomi dei segreti usati dal comando (meta.secretRefs sull'entry approval)
  const secretRefs = Array.isArray(entry.meta?.secretRefs) ? (entry.meta!.secretRefs as string[]) : []
  // fase 4: input di update_state su routine (nome/schedule/prompt per la card)
  const st = entry.meta?.input as
    | { target?: string; action?: string; name?: string; schedule?: string; prompt?: string; id?: number }
    | undefined
  const isRoutine = tool === 'update_state' && st?.target === 'routine'
  // fase 5 (M1): update_state non offre "Consenti sempre" — una grant per
  // routine coprirebbe anche il cambio del prompt di una routine attiva.
  // Fase 8 (punto 2): "per questo turno" ha gli stessi divieti (più i comandi
  // never-auto, segnalati dal loop con meta.neverAuto)
  const noAlways = tool === 'update_state'
  const noTurn = noAlways || entry.meta?.neverAuto === true

  return (
    <div className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 shadow-soft">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <span>⛔</span>
        <span>{isRoutine ? <Trans>Cambio di automazione — serve la tua approvazione</Trans> : <Trans>Richiede la tua approvazione</Trans>}</span>
      </div>
      <div className="mt-1 font-mono text-xs text-foreground">
        {tool} {entry.content && entry.content !== tool ? `— ${entry.content}` : ''}
      </div>
      {isRoutine && (
        <div className="mt-2 space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs text-foreground">
          <div><span className="text-muted-foreground">{t`Routine:`}</span> {st?.name ?? (st?.id !== undefined ? `#${st.id}` : '?')}</div>
          {st?.schedule && (
            <div>
              <span className="text-muted-foreground">{t`Schedule:`}</span> {describeCron(st.schedule)}{' '}
              <span className="font-mono text-muted-foreground">({st.schedule})</span>
            </div>
          )}
          {st?.prompt && <div className="whitespace-pre-wrap"><span className="text-muted-foreground">{t`Prompt:`}</span> {st.prompt}</div>}
        </div>
      )}
      {secretRefs.length > 0 && (
        <div className="mt-1 text-xs text-destructive/90"><Trans>Credenziali usate: {secretRefs.join(', ')}</Trans></div>
      )}
      {status === 'pending' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="rounded-lg bg-chart-2 px-3 py-1.5 text-xs font-medium text-white hover:bg-chart-2/90"
            onClick={() => resolve(approvalId, 'allow', 'once')}
          >
            <Trans>Consenti una volta</Trans>
          </button>
          <button
            className="rounded-lg bg-chart-2/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-chart-2/80 disabled:hidden"
            disabled={noTurn}
            title={noTurn ? t`Questa azione chiede sempre l'approvazione` : t`Vale per lo stesso tool fino alla fine di questo turno`}
            onClick={() => resolve(approvalId, 'allow', 'turn')}
          >
            <Trans>Consenti per questo turno</Trans>
          </button>
          <button
            className="rounded-lg bg-chart-2/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-chart-2/80 disabled:hidden"
            disabled={noAlways}
            title={noAlways ? t`Le modifiche di automazione chiedono ogni volta` : undefined}
            onClick={() => resolve(approvalId, 'allow', 'always')}
          >
            <Trans>Consenti sempre</Trans>
          </button>
          <button
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted-foreground/40"
            onClick={() => resolve(approvalId, 'deny', 'once')}
          >
            <Trans>Nega</Trans>
          </button>
          {/* fase 8: crea una regola di auto-review partendo da questa azione */}
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
            title={t`Apri Impostazioni → Approvazione automatica con una regola precompilata`}
            onClick={() => proposeRule(suggestedRule(tool, entry.meta?.input as Record<string, unknown> | undefined))}
          >
            <Trans>Crea regola da questa azione</Trans>
          </button>
        </div>
      ) : (
        <div className={`mt-2 text-xs ${status === 'allowed' ? 'text-chart-2' : 'text-muted-foreground'}`}>
          {status === 'allowed' ? <Trans>✓ Consentito</Trans> : status === 'denied' ? <Trans>Negato</Trans> : status === 'cancelled' ? <Trans>Annullata (interrupt)</Trans> : status}
        </div>
      )}
    </div>
  )
}
