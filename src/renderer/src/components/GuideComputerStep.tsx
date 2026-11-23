// OB2 (fase onboarding-b): il passo «Computer» della guida — il bottone
// del consenso («Prepara il computer») con SOTTO, in parole, cosa farà, e
// la lista d'avanzamento condivisa (BoxSetupProgress). Il consenso del
// bottone VALE ANCHE per il kernel: la frase lo dice, niente secondo
// dialogo. I GB sono CALCOLATI (mai inventati).
// OBD2 (fase onboarding-b-dettagli): il consenso elenca SOLO i passi del
// PIANO (RPC box:setup-plan — stessa funzione pura della partenza): con lo
// strumento già installato niente righe di GitHub, password o kernel, e la
// riga in più «non serve la password del Mac»; i GB sono del piano.
import { useEffect } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { api, useStore } from '../store'
import type { BoxSetupState } from '../../../shared/types'
import { boxSetupPlanBytes, type BoxSetupRowId } from '../../../shared/box-setup-plan'
import { BoxSetupProgress } from './BoxSetupProgress'
import { boxSetupActive } from '../lib/box-setup-rows'

export function GuideComputerStep() {
  const { i18n } = useLingui()
  const boxSetup = useStore((s) => s.boxSetup)
  const boxSetupStart = useStore((s) => s.boxSetupStart)
  const boxSetupCancel = useStore((s) => s.boxSetupCancel)
  const boxSetupRetry = useStore((s) => s.boxSetupRetry)
  const boxSetupOpenInstaller = useStore((s) => s.boxSetupOpenInstaller)

  // lo stato e il PIANO arrivano dal daemon (RPC + evento box-setup): li si
  // chiede appena il passo si monta, poi lo stato lo tiene aggiornato
  // l'evento — senza ricaricare
  useEffect(() => {
    void api.boxSetupState().then((s) => {
      if (s) useStore.setState({ boxSetup: s })
    }).catch(() => undefined)
    void api.boxSetupPlan().then((p) => {
      useStore.setState({ boxSetupPlan: p.steps })
    }).catch(() => undefined)
  }, [])

  const state: BoxSetupState | null = boxSetup
  const phase = state?.phase ?? 'idle'
  const running = boxSetupActive(phase)
  // OBD2: il piano decide le righe del consenso e i GB (la stima dei SOLI
  // passi che succederanno, calcolata dal piano — mai la stima intera)
  const plan = useStore((s) => s.boxSetupPlan)
  const planKnown = plan !== null
  const inPlan = (id: BoxSetupRowId): boolean => plan?.includes(id) === true
  const gb = planKnown ? Math.ceil(boxSetupPlanBytes(plan) / 1e9) : 0

  return (
    <div key="computer" className="guide-stepin flex w-full max-w-xl flex-col gap-8 text-left" data-testid="guide-step-computer">
      <div className="flex flex-col gap-4">
        <h1 className="m-0 font-display text-page font-semibold">{i18n.t(msg`Il computer del bot`)}</h1>
        <p className="m-0 text-reading text-muted-foreground">
          {i18n.t(msg`Un computer tutto suo, dentro il tuo Mac: lavora lì senza toccare i tuoi file, e tu decidi cosa può vedere.`)}
        </p>
      </div>

      {!running && phase !== 'ready' && (
        <div className="flex flex-col gap-4 rounded-surface bg-card/55 p-5">
          {/* OBR4: con l'errore il bottone NON c'è — «Prepara il computer» e
              «Riprova» farebbero la stessa cosa: resta solo «Riprova», nel
              riquadro dell'errore qui sotto; il consenso resta, in testo */}
          {phase !== 'error' && (
            <button
              type="button"
              data-testid="guide-computer-prepare"
              className="min-h-[44px] self-start rounded-full bg-foreground px-6 py-3 text-reading font-semibold text-background transition hover:opacity-90"
              onClick={() => { void boxSetupStart() }}
            >
              {i18n.t(msg`Prepara il computer`)}
            </button>
          )}
          {/* il consenso: SOLO i passi del piano, IN PAROLE (il piano è della
              partenza: non può promettere quello che non farà) */}
          <ul className="m-0 flex list-none flex-col gap-1.5 pl-0 text-small text-muted-foreground" data-testid="guide-computer-consent">
            {inPlan('download') && (
              <li>{i18n.t(msg`scarico da GitHub lo strumento container di Apple (170 MB, firmato da Apple)`)}</li>
            )}
            {inPlan('installer') && (
              <li>{i18n.t(msg`si apre l'installazione di Apple, che ti chiederà la password del Mac`)}</li>
            )}
            {inPlan('kernel') && (
              <li>{i18n.t(msg`scarico il kernel Linux consigliato da Apple`)}</li>
            )}
            {planKnown && (
              <li>{gb > 0 ? i18n.t(msg`preparo il computer del bot (circa ${gb} GB)`) : i18n.t(msg`preparo il computer del bot`)}</li>
            )}
            {planKnown && !inPlan('installer') && (
              <li>{i18n.t(msg`non serve la password del Mac`)}</li>
            )}
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
        <div className="flex flex-col gap-3 rounded-surface bg-destructive/10 p-4" data-testid="guide-computer-error">
          <p className="m-0 text-body text-destructive">{state.error.message}</p>
          <button
            type="button"
            data-testid="guide-computer-retry"
            className="min-h-[44px] self-start rounded-full bg-foreground px-5 py-2 text-body font-semibold text-background transition hover:opacity-90"
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
          className="min-h-[44px] self-start rounded-full bg-foreground px-5 py-2 text-body font-semibold text-background transition hover:opacity-90"
          onClick={() => { void boxSetupRetry() }}
        >
          <Trans>Riprova</Trans>
        </button>
      )}
    </div>
  )
}
