// OB2 (fase onboarding-b): il passo «Computer» della guida — il bottone
// del consenso («Prepara il computer») con SOTTO, in parole, cosa farà, e
// la lista d'avanzamento condivisa (BoxSetupProgress). Il consenso del
// bottone VALE ANCHE per il kernel: la frase lo dice, niente secondo
// dialogo. I GB sono CALCOLATI dallo stato (neededBytes), mai inventati.
import { useEffect } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { api, useStore } from '../store'
import type { BoxSetupState } from '../../../shared/types'
import { BoxSetupProgress } from './BoxSetupProgress'
import { boxSetupActive } from '../lib/box-setup-rows'

export function GuideComputerStep() {
  const { i18n } = useLingui()
  const boxSetup = useStore((s) => s.boxSetup)
  const boxSetupStart = useStore((s) => s.boxSetupStart)
  const boxSetupCancel = useStore((s) => s.boxSetupCancel)
  const boxSetupRetry = useStore((s) => s.boxSetupRetry)
  const boxSetupOpenInstaller = useStore((s) => s.boxSetupOpenInstaller)

  // lo stato arriva dal daemon (RPC + evento box-setup): lo si chiede appena
  // il passo si monta, poi lo tiene aggiornato l'evento — senza ricaricare
  useEffect(() => {
    void api.boxSetupState().then((s) => {
      if (s) useStore.setState({ boxSetup: s })
    }).catch(() => undefined)
  }, [])

  const state: BoxSetupState | null = boxSetup
  const phase = state?.phase ?? 'idle'
  const running = boxSetupActive(phase)
  const gb = Math.ceil((state?.neededBytes ?? 0) / 1e9)

  return (
    <div key="computer" className="guide-stepin flex w-full max-w-xl flex-col gap-7 text-left" data-testid="guide-step-computer">
      <div className="flex flex-col gap-3.5">
        <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.1] tracking-[-0.01em]">{i18n.t(msg`Il computer del bot`)}</h1>
        <p className="m-0 text-base leading-[1.6] text-muted-foreground">
          {i18n.t(msg`Un computer tutto suo, dentro il tuo Mac: lavora lì senza toccare i tuoi file, e tu decidi cosa può vedere.`)}
        </p>
      </div>

      {!running && phase !== 'ready' && (
        <div className="flex flex-col gap-3.5 rounded-[20px] bg-card/55 p-[18px]">
          <button
            type="button"
            data-testid="guide-computer-prepare"
            className="min-h-[44px] self-start rounded-full bg-foreground px-[26px] py-[13px] text-base font-semibold text-background transition hover:opacity-90"
            onClick={() => { void boxSetupStart() }}
          >
            {i18n.t(msg`Prepara il computer`)}
          </button>
          {/* il consenso: cosa farà, IN PAROLE (vale anche per il kernel: lo dice qui) */}
          <ul className="m-0 flex list-none flex-col gap-1.5 pl-0 text-[13.5px] leading-[1.5] text-muted-foreground" data-testid="guide-computer-consent">
            <li>{i18n.t(msg`scarico da GitHub lo strumento container di Apple (170 MB, firmato da Apple)`)}</li>
            <li>{i18n.t(msg`si apre l'installazione di Apple, che ti chiederà la password del Mac`)}</li>
            <li>{i18n.t(msg`scarico il kernel Linux consigliato da Apple`)}</li>
            <li>{gb > 0 ? i18n.t(msg`preparo il computer del bot (circa ${gb} GB)`) : i18n.t(msg`preparo il computer del bot`)}</li>
          </ul>
        </div>
      )}

      {(running || phase === 'ready') && state && (
        <BoxSetupProgress
          state={state}
          onOpenInstaller={() => { void boxSetupOpenInstaller() }}
          onCancel={() => { void boxSetupCancel() }}
        />
      )}

      {phase === 'error' && state?.error && (
        <div className="flex flex-col gap-3 rounded-[14px] bg-destructive/10 p-4" data-testid="guide-computer-error">
          <p className="m-0 text-sm text-destructive">{state.error.message}</p>
          <button
            type="button"
            data-testid="guide-computer-retry"
            className="min-h-[44px] self-start rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:opacity-90"
            onClick={() => { void boxSetupRetry() }}
          >
            {i18n.t(msg`Riprova`)}
          </button>
        </div>
      )}

      {phase === 'cancelled' && (
        <button
          type="button"
          data-testid="guide-computer-retry"
          className="min-h-[44px] self-start rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:opacity-90"
          onClick={() => { void boxSetupRetry() }}
        >
          <Trans>Riprova</Trans>
        </button>
      )}
    </div>
  )
}
