// Fase 19a (V5): la card della presa di controllo CHIESTA DAL BOT
// (request_takeover) — il motivo e il bottone «Apri lo schermo», che apre il
// pannello Computer GIÀ in controllo sulla scheda Schermo (fase 19b, T1).
// Lo stato vive nel meta della entry: 'pending' alla richiesta, 'done'
// quando l'utente ha premuto «Ho finito», 'expired' dopo 30 minuti senza che
// nessuno apra lo schermo.
import { useLingui, Trans } from '@lingui/react/macro'
import { useStore } from '../store'
import type { TranscriptEntry, SendMessageMeta } from '../../../shared/types'

export function TakeoverCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const setComputerPanel = useStore((s) => s.setComputerPanel)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
  const message = meta.message as Extract<SendMessageMeta['message'], { type?: string }> | undefined
  const reason = (message as { reason?: string } | undefined)?.reason ?? ''
  const status = meta.takeover ?? 'pending'

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Trans>Presa di controllo dello schermo</Trans>
      </p>
      <p className="mt-1 text-sm whitespace-pre-wrap">{reason}</p>
      {status === 'pending' ? (
        <div className="mt-3 flex items-center gap-3">
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
            onClick={() => setComputerPanel(true, 'screen', 'control')}
          >
            <Trans>Apri lo schermo</Trans>
          </button>
          <span className="text-[11px] text-muted-foreground">{t`Il bot è in attesa: chiudi con «Ho finito» quando hai terminato.`}</span>
        </div>
      ) : status === 'done' ? (
        <p className="mt-3 text-xs text-muted-foreground"><Trans>✓ Fatto — il bot ha ricevuto il tuo messaggio.</Trans></p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground"><Trans>Scaduta: il bot non aspetta più.</Trans></p>
      )}
    </div>
  )
}
