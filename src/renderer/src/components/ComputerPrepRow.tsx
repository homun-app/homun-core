// OB4 (fase onboarding-b): la preparazione in BACKGROUND dopo la guida —
// una riga DISCRETA nel pannello del bot principale, sotto «Computer»:
// «In preparazione… N%» mentre lo scarico corre (senza percentuale nelle
// altre fasi), «Serve la tua password: Apri l'installazione» sull'attesa
// dell'Installer, e a fine «Pronto». NESSUNA notifica di sistema. La riga
// c'è SOLO mentre la preparazione corre (o è appena finita): senza, mai
// partita o in errore non c'è — niente rumore.
// MB4 (fase modalita-box): «Pronto» non si dice se il computer del bot NON
// è in uso (boxInUse === false): contraddirebbe la card «Computer» che dice
// «Non in uso» — la preparazione era finita, la scelta non era registrata.
// Con boxInUse null (lettura non ancora arrivata) la riga resta: CCK3, mai
// un lampo di assenza.
//
// Fase design (DS4): la riga è una Notice del sistema (icona · testo grigio ·
// azione) dentro la sua superficie. A fine preparazione lo slot dell'icona
// resta occupato (un segno di spunta): il testo non salta di posto quando la
// rotella sparisce. NESSUN MARGINE ESTERNO, di proposito: la distanza dalla
// card «Computer» la decide chi le elenca (il pannello le tiene a 4 px).
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Check } from 'lucide-react'
import { useStore } from '../store'
import { boxSetupActive } from '../lib/box-setup-rows'
import { Notice } from './ui/notice'

export function ComputerPrepRow() {
  const { i18n } = useLingui()
  const boxSetup = useStore((s) => s.boxSetup)
  const boxSetupOpenInstaller = useStore((s) => s.boxSetupOpenInstaller)
  const boxInUse = useStore((s) => s.boxInUse)
  const phase = boxSetup?.phase ?? 'idle'
  const show = boxSetup !== null && (boxSetupActive(phase) || (phase === 'ready' && boxInUse !== false))
  if (!show) return null

  // la percentuale si calcola dai byte veri del download (mai a caso)
  const pct = phase === 'downloading' && boxSetup?.total != null && boxSetup.total > 0 && boxSetup.bytes != null
    ? Math.min(100, Math.round((boxSetup.bytes / boxSetup.total) * 100))
    : null

  if (phase === 'awaiting-installer') {
    return (
      <button
        type="button"
        className="block w-full cursor-pointer rounded-surface bg-card px-3 py-1 text-left transition hover:bg-muted"
        data-testid="bot-prep-row"
        onClick={() => { void boxSetupOpenInstaller() }}
      >
        {/* tutta la riga è il bottone: l'azione a destra è la scritta, non un secondo bottone */}
        <Notice action={<span className="text-small font-medium text-muted-foreground" data-testid="bot-prep-open-installer">{i18n.t(msg`Apri l’installazione`)}</span>}>
          <span className="font-medium text-foreground">{i18n.t(msg`Serve la tua password`)}</span>
        </Notice>
      </button>
    )
  }
  return (
    <div className="rounded-surface bg-muted/60 px-3 py-1" data-testid="bot-prep-row">
      <Notice
        icon={phase === 'ready'
          ? <Check className="size-4" aria-hidden="true" />
          : <span className="block size-2 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      >
        <span className="block truncate">
          {phase === 'ready'
            ? i18n.t(msg`Pronto`)
            : pct !== null
              ? i18n.t(msg`In preparazione… ${pct}%`)
              : i18n.t(msg`In preparazione…`)}
        </span>
      </Notice>
    </div>
  )
}
