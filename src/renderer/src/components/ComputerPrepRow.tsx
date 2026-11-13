// OB4 (fase onboarding-b): la preparazione in BACKGROUND dopo la guida —
// una riga DISCRETA nel pannello del bot principale, sotto «Computer»:
// «In preparazione… N%» mentre lo scarico corre (senza percentuale nelle
// altre fasi), «Serve la tua password: Apri l'installazione» sull'attesa
// dell'Installer, e a fine «Pronto». NESSUNA notifica di sistema. La riga
// c'è SOLO mentre la preparazione corre (o è appena finita): senza, mai
// partita o in errore non c'è — niente rumore.
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { useStore } from '../store'
import { boxSetupActive } from '../lib/box-setup-rows'

export function ComputerPrepRow() {
  const { i18n } = useLingui()
  const boxSetup = useStore((s) => s.boxSetup)
  const boxSetupOpenInstaller = useStore((s) => s.boxSetupOpenInstaller)
  const phase = boxSetup?.phase ?? 'idle'
  const show = boxSetup !== null && (boxSetupActive(phase) || phase === 'ready')
  if (!show) return null

  // la percentuale si calcola dai byte veri del download (mai a caso)
  const pct = phase === 'downloading' && boxSetup?.total != null && boxSetup.total > 0 && boxSetup.bytes != null
    ? Math.min(100, Math.round((boxSetup.bytes / boxSetup.total) * 100))
    : null

  if (phase === 'awaiting-installer') {
    return (
      <button
        className="mt-1 flex w-full items-center justify-between gap-2 rounded-[16px] bg-card px-3 py-2.5 text-left transition hover:bg-muted"
        data-testid="bot-prep-row"
        onClick={() => { void boxSetupOpenInstaller() }}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{i18n.t(msg`Serve la tua password`)}</span>
        <span className="shrink-0 text-xs font-semibold text-muted-foreground" data-testid="bot-prep-open-installer">{i18n.t(msg`Apri l’installazione`)}</span>
      </button>
    )
  }
  return (
    <div className="mt-1 flex items-center justify-between gap-2 rounded-[16px] bg-muted/60 px-3 py-2.5" data-testid="bot-prep-row">
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
        {phase !== 'ready' && (
          <span className="block size-2 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
        )}
        <span className="truncate">
          {phase === 'ready'
            ? i18n.t(msg`Pronto`)
            : pct !== null
              ? i18n.t(msg`In preparazione… ${pct}%`)
              : i18n.t(msg`In preparazione…`)}
        </span>
      </span>
    </div>
  )
}
