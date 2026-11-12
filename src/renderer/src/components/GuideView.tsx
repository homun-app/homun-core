// OA2 (fase onboarding-a): «Prepariamo Homun» — la guida a passi del primo
// avvio, a tutta finestra, PRIMA della chat. Lo stato vive nel daemon
// (setting onboarding.state): chiudere l'app a metà e riaprirla riporta allo
// STESSO passo (l'evento 'onboarding' aggiorna lo store). Stile della
// finestra App di oggi: fondi tenui, niente bordi.
// OA3 riempie i passi (benvenuto, modello, autorizzazioni); qui ci sono
// l'impalcatura, la fila dei passi in alto e i bottoni che la fanno
// avanzare (Continua / Salta per ora).
import { useLingui, Trans } from '@lingui/react/macro'
import { useStore } from '../store'
import type { OnboardingStepId } from '../../../shared/types'
import { TRAFFIC_LIGHT_INSET } from '../layout'

/** L'etichetta breve di un passo, per la fila in alto. */
function StepLabel({ step }: { step: Exclude<OnboardingStepId, 'chat'> | 'chat' }): string {
  const { t } = useLingui()
  switch (step) {
    case 'welcome': return t`Benvenuto`
    case 'model': return t`Modello`
    case 'computer': return t`Computer`
    case 'memory': return t`Memoria`
    case 'approvals': return t`Autorizzazioni`
    default: return t`Pronto`
  }
}

/** Un pallino della fila: fatto, corrente o da fare. */
function StepChip({ step, state }: { step: OnboardingStepId; state: 'done' | 'current' | 'todo' | 'skipped' }) {
  const { t } = useLingui()
  return (
    <span
      data-testid={`guide-chip-${step}`}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${
        state === 'current'
          ? 'bg-foreground text-background'
          : state === 'done'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground'
      }`}
    >
      {state === 'done' && <span aria-hidden>✓</span>}
      {state === 'skipped' && <span aria-hidden>–</span>}
      <StepLabel step={step} />
      {state === 'skipped' && <span className="opacity-70">({t`saltato`})</span>}
    </span>
  )
}

/** La fila dei passi in alto, col corrente evidenziato. */
function StepRail({ sequence, current, done, skipped }: {
  sequence: OnboardingStepId[]
  current: OnboardingStepId
  done: OnboardingStepId[]
  skipped: OnboardingStepId[]
}) {
  const steps: Array<Exclude<OnboardingStepId, 'chat'>> = sequence.filter((s) => s !== 'chat')
  const currentIdx = steps.indexOf(current as Exclude<OnboardingStepId, 'chat'>)
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5" data-testid="guide-rail">
      {steps.map((s, i) => (
        <StepChip
          key={s}
          step={s}
          state={s === current ? 'current' : skipped.includes(s) ? 'skipped' : done.includes(s) ? 'done' : i < currentIdx ? 'done' : 'todo'}
        />
      ))}
    </div>
  )
}

/** Il guscio di un passo: titolo grande, testo, azioni in basso. */
function StepBody({ step, title, children, onContinue, onSkip, continueLabel }: {
  step: Exclude<OnboardingStepId, 'chat'>
  title: React.ReactNode
  children?: React.ReactNode
  onContinue: () => void
  onSkip?: () => void
  continueLabel?: string
}) {
  return (
    <div className="flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-6 text-center" data-testid={`guide-step-${step}`}>
      <div className="flex flex-col items-center gap-3">
        <h1 className="font-display text-3xl">{title}</h1>
        {children}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="guide-continue"
          className="rounded-full bg-foreground px-6 py-2.5 text-sm text-background transition hover:opacity-90"
          onClick={onContinue}
        >
          {continueLabel ?? <Trans>Continua</Trans>}
        </button>
        {onSkip && (
          <button
            type="button"
            data-testid="guide-skip"
            className="rounded-full bg-muted px-5 py-2.5 text-sm text-foreground transition hover:bg-accent"
            onClick={onSkip}
          >
            <Trans>Salta per ora</Trans>
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * La guida. A tutta finestra: la sostituisce alla shell finché lo stato non
 * arriva a «chat». Il contenuto dei passi arriva con OA3; qui ogni passo ha
 * già il suo posto e i bottoni giusti.
 */
export function GuideView() {
  const { t } = useLingui()
  const onboarding = useStore((s) => s.onboarding)
  const advance = useStore((s) => s.onboardingAdvance)
  const state = onboarding?.state ?? null
  const sequence = onboarding?.sequence ?? ['welcome', 'model', 'approvals', 'chat']
  if (!state || state.step === 'chat') return null
  const step = state.step
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-muted/40 text-foreground" data-testid="guide-view">
      {/* la fascia del titolo: spazio ai semafori di macOS e trascinamento */}
      <div className="drag-region h-11 shrink-0" style={{ paddingLeft: TRAFFIC_LIGHT_INSET }} />
      <div className="flex flex-1 flex-col items-center gap-8 px-6 pb-10">
        <StepRail sequence={sequence} current={step} done={state.done} skipped={state.skipped} />
        {step === 'welcome' && (
          <StepBody
            step="welcome"
            title={t`Prepariamo Homun`}
            onContinue={() => void advance('welcome', 'done')}
            continueLabel={t`Iniziamo`}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-[18px] bg-muted text-2xl" aria-hidden>🧚</div>
            <p className="max-w-md text-sm text-muted-foreground">{t`Pochi passi e il tuo Homun è pronto: il modello che lo fa pensare, che cosa può fare da solo.`}</p>
          </StepBody>
        )}
        {step === 'model' && (
          <StepBody
            step="model"
            title={t`Il modello`}
            onContinue={() => void advance('model', 'done')}
            onSkip={() => void advance('model', 'skipped')}
          >
            <p className="max-w-md text-sm text-muted-foreground">{t`Il modello è ciò che fa pensare il tuo Homun. Si può scegliere ora, oppure più avanti dalla chat.`}</p>
          </StepBody>
        )}
        {(step === 'approvals' || step === 'computer' || step === 'memory') && (
          <StepBody
            step={step}
            title={<StepLabel step={step as Exclude<OnboardingStepId, 'chat'>} />}
            onContinue={() => void advance(step, 'done')}
            onSkip={() => void advance(step, 'skipped')}
          >
            <p className="max-w-md text-sm text-muted-foreground">{t`Questo passo arriva con un aggiornamento prossimo: per ora puoi proseguire.`}</p>
          </StepBody>
        )}
      </div>
    </div>
  )
}
