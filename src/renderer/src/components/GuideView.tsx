// OA2/OA3 (fase onboarding-a): «Prepariamo Homun» — la guida a passi del
// primo avvio, a tutta finestra, PRIMA della chat. Lo stato vive nel daemon
// (setting onboarding.state): chiudere l'app a metà e riaprirla riporta allo
// STESSO passo (l'evento 'onboarding' aggiorna lo store). Stile della finestra
// App di oggi: fondi tenui, niente bordi.
//
// I passi (OA3): benvenuto (con la LINGUA, che cambia subito i testi),
// modello (le strade di oggi: chiave cloud consigliata, Ollama se trovato,
// Integrato se la macchina è idonea — ogni strada apre le sue Impostazioni,
// che hanno «Torna alla guida»; al salvataggio di un provider valido il
// passo si chiude da solo, lato daemon), autorizzazioni («Chiedi prima» /
// «Automatico», quest'ultimo solo con un modello), e infine si entra nella
// chat del bot principale.
import { useEffect } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { useStore, api } from '../store'
import type { OnboardingStepId, OnboardingProviderPath, AutoReviewSettings } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../../shared/types'
import type { UiLanguageSetting } from '../../../shared/ui-language'
import { SUPPORTED_UI_LANGUAGES } from '../../../shared/ui-language'
import { TRAFFIC_LIGHT_INSET } from '../layout'
import { approvalsChoices } from '../lib/guide-steps'

/** L'etichetta breve di un passo, per la fila in alto. */
function StepLabel({ step }: { step: OnboardingStepId }): string {
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
  step: OnboardingStepId
  title: React.ReactNode
  children?: React.ReactNode
  onContinue?: () => void
  onSkip?: () => void
  continueLabel?: string
}) {
  return (
    <div className="flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-6 text-center" data-testid={`guide-step-${step}`}>
      <div className="flex flex-col items-center gap-3">
        <h1 className="font-display text-3xl">{title}</h1>
        {children}
      </div>
      {(onContinue || onSkip) && (
        <div className="flex items-center gap-3">
          {onContinue && (
            <button
              type="button"
              data-testid="guide-continue"
              className="rounded-full bg-foreground px-6 py-2.5 text-sm text-background transition hover:opacity-90"
              onClick={onContinue}
            >
              {continueLabel ?? <Trans>Continua</Trans>}
            </button>
          )}
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
      )}
    </div>
  )
}

/** La carta di una strada del passo modello. */
function RoadCard({ path, onOpen }: { path: OnboardingProviderPath; onOpen: () => void }) {
  const { t } = useLingui()
  const roads: Record<OnboardingProviderPath, { title: string; note: string; primary?: boolean; test: string }> = {
    cloud: {
      title: t`Modello cloud con una chiave`,
      note: t`Il più capace, consigliato per partire. Serve una chiave (Anthropic, OpenAI, Google…).`,
      primary: true,
      test: 'guide-road-cloud'
    },
    ollama: {
      title: t`Ollama che è già sul tuo Mac`,
      note: t`Hai Ollama in casa: si aggiunge come provider e si sceglie un modello che supporti i tool.`,
      test: 'guide-road-ollama'
    },
    local: {
      title: t`Modello integrato sul tuo Mac`,
      note: t`Niente costi e i dati restano qui. È più lento e sbaglia più spesso dei modelli cloud.`,
      test: 'guide-road-local'
    }
  }
  const r = roads[path]
  return (
    <button
      type="button"
      data-testid={r.test}
      className={`flex w-full flex-col items-start gap-1 rounded-2xl px-5 py-4 text-left transition hover:bg-accent ${r.primary ? 'bg-muted' : 'bg-muted/60'}`}
      onClick={onOpen}
    >
      <span className="flex w-full items-center justify-between gap-3">
        <span className="text-sm font-medium">{r.title}</span>
        {r.primary && <span className="rounded-full bg-foreground px-2.5 py-0.5 text-[10px] text-background">{t`consigliato`}</span>}
      </span>
      <span className="text-xs text-muted-foreground">{r.note}</span>
    </button>
  )
}

/**
 * La guida. A tutta finestra: la sostituisce alla shell finché lo stato non
 * arriva a «chat».
 */
export function GuideView() {
  const { t } = useLingui()
  const onboarding = useStore((s) => s.onboarding)
  const advance = useStore((s) => s.onboardingAdvance)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const uiLanguage = useStore((s) => s.uiLanguage)
  const setUiLanguage = useStore((s) => s.setUiLanguage)
  const state = onboarding?.state ?? null
  const sequence = onboarding?.sequence ?? ['welcome', 'model', 'approvals', 'chat']
  const modelReady = onboarding?.modelReady ?? false
  const paths = onboarding?.providerPaths

  // OA3: le strade del passo modello le porta la RPC (la scoperta dei servizi
  // locali è asincrona): si chiedono quando il passo è quello
  useEffect(() => {
    if (state?.step === 'model' && !paths) {
      void api.onboardingState()
        .then((s) => { if (s) useStore.setState({ onboarding: s }) })
        .catch(() => undefined)
    }
  }, [state?.step, paths])

  if (!state || state.step === 'chat') return null
  const step = state.step

  // OA3: la scelta del passo autorizzazioni scrive approvals.mode (e il
  // derivato enabled dell'auto-revisione, come la pagina Approvazioni)
  const chooseApprovals = async (mode: 'ask' | 'auto'): Promise<void> => {
    const cfg = await api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW)
    await api.settingsSet('approvals.mode', mode)
    await api.settingsSet('approvals.modeSet', true)
    await api.settingsSet('autoReview', { ...cfg, enabled: mode === 'auto' })
    await advance('approvals', 'done')
  }
  const openModelsSettings = (): void => {
    setSettingsTab('modelli')
    setSettingsOpen(true)
  }

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
            {/* il posto della mascotte: arriva come immagine col tempo */}
            <div className="flex h-16 w-16 items-center justify-center rounded-[18px] bg-muted text-2xl" aria-hidden>🧚</div>
            <p className="max-w-md text-sm text-muted-foreground">
              {t`Homun è il tuo spazio di lavoro con la squadra AI: un bot principale che ti aiuta ogni giorno, e altri bot per le cose che ripeti.`}
            </p>
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Trans>Lingua</Trans>
              <select
                className="h-9 rounded-[10px] bg-card px-2 text-sm text-foreground outline-none"
                aria-label={t`Lingua`}
                data-testid="guide-language-select"
                value={uiLanguage}
                onChange={(e) => setUiLanguage(e.target.value as UiLanguageSetting)}
              >
                <option value="system">{t`Sistema`}</option>
                {SUPPORTED_UI_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.endonym}</option>
                ))}
              </select>
            </label>
          </StepBody>
        )}
        {step === 'model' && (
          <StepBody
            step="model"
            title={t`Il modello`}
            onSkip={() => void advance('model', 'skipped')}
          >
            <p className="max-w-md text-sm text-muted-foreground">
              {t`Il modello è ciò che fa pensare il tuo Homun: senza, i tuoi messaggi restano in attesa e ripartono da soli appena ne scegli uno. Puoi farlo ora, oppure più avanti dalla chat.`}
            </p>
            <div className="flex w-full flex-col gap-2">
              {(paths ?? (['cloud'] as OnboardingProviderPath[])).map((p) => (
                <RoadCard key={p} path={p} onOpen={openModelsSettings} />
              ))}
            </div>
          </StepBody>
        )}
        {step === 'approvals' && (
          <StepBody
            step="approvals"
            title={t`Autorizzazioni`}
            onSkip={() => void advance('approvals', 'skipped')}
          >
            <p className="max-w-md text-sm text-muted-foreground">
              {t`Che cosa può fare il tuo Homun da solo, e dove si ferma a chiederti il via?`}
            </p>
            <div className="flex w-full flex-col gap-2">
              {approvalsChoices(modelReady).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-testid={`guide-approvals-${c.id}`}
                  disabled={!c.enabled}
                  className={`flex flex-col items-start gap-1 rounded-2xl px-5 py-4 text-left transition ${c.enabled ? 'bg-muted/60 hover:bg-accent' : 'cursor-not-allowed bg-muted/30 opacity-60'}`}
                  onClick={() => { void chooseApprovals(c.id) }}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="text-sm font-medium">{c.id === 'ask' ? t`Chiedi prima` : t`Automatico`}</span>
                    {!c.enabled && <span className="text-[10px] text-muted-foreground">{c.hint}</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {c.id === 'ask'
                      ? t`Le cose che cambiano qualcosa passano da una tua conferma.`
                      : t`Un revisore controlla le azioni e le lascia passare quando sono sicure.`}
                  </span>
                </button>
              ))}
            </div>
            <p className="max-w-md text-xs text-muted-foreground">
              {t`Da solo: leggere la tua posta per riassumerla. Con la tua conferma: mandare un'email a qualcuno, cancellare file. Mai senza di te: le cose irreversibili.`}
            </p>
          </StepBody>
        )}
        {(step === 'computer' || step === 'memory') && (
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
