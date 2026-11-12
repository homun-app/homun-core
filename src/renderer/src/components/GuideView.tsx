// G2 (fase guida): la guida diventa una SCENA, secondo il mockup approvato
// (fixtures/guida-mockup): a sinistra la mascotte Bot VERA del bot
// principale (famiglia e colore veri, sguardo che segue il mouse), grande e
// sospesa, con la nuvoletta della frase sopra e l'ombra che respira sotto;
// a destra la colonna dei controlli — l'avanzamento a puntini con la lingua,
// il contenuto del passo, la navigazione in basso. Fondo unico
// (--background), aria nella colonna, niente riquadri.
// L'umore e la frase vengono dalle funzioni pure guideMood/guideBubble
// (lib/guide-scene): testi d'interfaccia Lingui, mai messaggi del bot.
// I passi: Tu (welcome), Modello, Permessi, Pronto (solo UI) — lo stato
// vive nel daemon come in onboarding-a; «Indietro» è una vista che torna al
// passo precedente senza toccare lo stato del daemon.
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { useStore, api } from '../store'
import type { OnboardingProviderPath, AutoReviewSettings } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../../shared/types'
import { avatarOf } from '../../../shared/avatar'
import type { UiLanguageSetting } from '../../../shared/ui-language'
import { SUPPORTED_UI_LANGUAGES } from '../../../shared/ui-language'
import { TRAFFIC_LIGHT_INSET } from '../layout'
import { approvalsChoices } from '../lib/guide-steps'
import { guideMood, guideBubble, guideBubbleKey, EMPTY_GUIDE_FACTS, type GuideFacts, type GuideUiStep } from '../lib/guide-scene'
import { Bot } from '../bot/Bot'

/** L'ordine dei passi della guida nella UI («Pronto» è solo UI, G6). */
const UI_STEPS: readonly GuideUiStep[] = ['welcome', 'model', 'approvals', 'ready']

/**
 * La scena a sinistra: nuvoletta, mascotte, ombra, nome. Le misure seguono
 * il mockup (460 px nella finestra larga, 320 fra 900 e 1100, 200 sotto) —
 * la larghezza arriva dallo store, che App aggiorna al resize.
 */
function SceneColumn({ phrase, bubbleKey, mood, avatar, displayName, width, mascotSize, stacked }: {
  phrase: string
  bubbleKey: string
  mood: ReturnType<typeof guideMood>
  avatar: { family: ReturnType<typeof avatarOf>['family']; color: ReturnType<typeof avatarOf>['color'] }
  displayName: string
  width: number
  mascotSize: number
  stacked: boolean
}) {
  const shadowWidth = Math.round((mascotSize / 460) * 260)
  const mascot = (
    <div className="guide-float">
      <Bot family={avatar.family} color={avatar.color} state={mood} size={mascotSize} label={displayName} />
    </div>
  )
  const shadow = (
    <div
      className="guide-shadow"
      aria-hidden
      style={{
        width: shadowWidth,
        height: Math.max(12, Math.round((mascotSize / 460) * 24)),
        borderRadius: '50%',
        background: 'radial-gradient(closest-side, rgba(40,30,10,.28), transparent)',
        marginTop: stacked ? 4 : 6
      }}
    />
  )
  const bubble = (
    <div key={bubbleKey} className="guide-bubble-pop relative max-w-[420px] rounded-[22px] bg-card px-[22px] py-[18px] text-[19px] leading-[1.4] shadow-soft">
      <span className="font-display font-medium">{phrase}</span>
      {/* la punta della nuvoletta, verso la mascotte */}
      <span aria-hidden className="absolute bottom-[-9px] left-1/2 h-[18px] w-[18px] -translate-x-1/2 rotate-45 rounded-[3px] bg-card" />
    </div>
  )
  if (stacked) {
    // finestra stretta: la mascotte va sopra, con la nuvoletta accanto
    return (
      <div className="relative flex shrink-0 items-end justify-center gap-5 px-6 pt-12" data-testid="guide-scene">
        <div className="drag-region absolute inset-x-0 top-0 h-11" style={{ paddingLeft: TRAFFIC_LIGHT_INSET }} aria-hidden />
        <div className="flex flex-col items-center">{mascot}{shadow}</div>
        <div className="flex min-w-0 flex-1 justify-start pb-8">
          <div className="max-w-[420px] text-[17px] [&_span]:text-[17px]">{bubble}</div>
        </div>
        <p className="sr-only">{displayName}</p>
      </div>
    )
  }
  return (
    <div className="relative flex shrink-0 flex-col items-center justify-center" style={{ width }} data-testid="guide-scene">
      {/* spazio ai semafori di macOS: fascia di trascinamento */}
      <div className="drag-region absolute inset-x-0 top-0 h-11" style={{ paddingLeft: TRAFFIC_LIGHT_INSET }} aria-hidden />
      <div className="absolute left-16 right-16 top-[62px] flex justify-center">{bubble}</div>
      <div className="mt-[70px]">{mascot}</div>
      {shadow}
      <p className="mt-[18px] font-display text-[22px] font-semibold">{displayName}</p>
    </div>
  )
}

/** Un puntino dell'avanzamento, col corrente allungato e i fatti pieni. */
function StepDots({ current, reachedEnd }: { current: GuideUiStep; reachedEnd: boolean }) {
  const { t } = useLingui()
  const visible: Array<'welcome' | 'model' | 'approvals'> = ['welcome', 'model', 'approvals']
  // le etichette della fila (Tu · Modello · Permessi), col macro t in scope
  const labels: Record<'welcome' | 'model' | 'approvals', string> = {
    welcome: t`Tu`,
    model: t`Modello`,
    approvals: t`Permessi`
  }
  const idx = UI_STEPS.indexOf(current)
  return (
    <div className="flex items-center gap-2.5" data-testid="guide-rail" aria-label={t`Avanzamento`}>
      {visible.map((s, i) => {
        const cur = i === Math.min(idx, 2) && !reachedEnd
        const done = i < idx || reachedEnd
        return (
          <span key={s} className="flex items-center gap-2">
            <span
              aria-hidden
              className={`h-2 rounded-full transition-all ${cur ? 'w-[22px]' : 'w-2'} ${cur || done ? 'bg-foreground' : 'bg-border'}`}
            />
            <span className={`text-[13px] ${cur ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground'}`}>
              {labels[s]}
            </span>
          </span>
        )
      })}
    </div>
  )
}

/** Il guscio di un passo: entra con la piccola animazione della scena. */
function StepPanel({ stepKey, children, testId }: { stepKey: string; children: React.ReactNode; testId: string }) {
  return (
    <div key={stepKey} className="guide-stepin flex w-full max-w-xl flex-col gap-7 text-left" data-testid={testId}>
      {children}
    </div>
  )
}

/** La carta di una strada del passo modello (finché G4 non la sostituisce). */
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
 * La guida: sostituisce la finestra finché lo stato non arriva a «chat».
 */
export function GuideView() {
  const { t, i18n } = useLingui()
  const onboarding = useStore((s) => s.onboarding)
  const advance = useStore((s) => s.onboardingAdvance)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const uiLanguage = useStore((s) => s.uiLanguage)
  const setUiLanguage = useStore((s) => s.setUiLanguage)
  const windowWidth = useStore((s) => s.windowWidth)
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const state = onboarding?.state ?? null
  const modelReady = onboarding?.modelReady ?? false
  const paths = onboarding?.providerPaths

  // G2: «Indietro» è una VISTA sul passo precedente: lo stato del daemon non
  // torna mai indietro (si avanfa soltanto); Continua riporta al passo vero
  const [backTo, setBackTo] = useState<GuideUiStep | null>(null)
  const [chosenApprovals, setChosenApprovals] = useState<'ask' | 'auto' | null>(null)

  // le strade del passo modello le porta la RPC (scoperta asincrona)
  useEffect(() => {
    if (state?.step === 'model' && !paths) {
      void api.onboardingState()
        .then((s) => { if (s) useStore.setState({ onboarding: s }) })
        .catch(() => undefined)
    }
  }, [state?.step, paths])

  const mainAgent = agents.find((a) => a.id === mainAgentId) ?? null
  const avatar = mainAgent ? avatarOf(mainAgent, agents, mainAgentId) : { family: 'h-creature' as const, color: 'c1' as const }
  const displayName = mainAgent?.name || 'Bot'

  if (!state || state.step === 'chat') return null
  const daemonStep = state.step

  // il passo della UI: i passi computer/memory non ci sono in fase A; la
  // scelta fatta dei permessi porta al passo Pronto (solo UI, G6)
  const uiStep: GuideUiStep = backTo ?? (
    daemonStep === 'approvals' && chosenApprovals !== null ? 'ready' : (daemonStep as GuideUiStep)
  )
  const stepIdx = UI_STEPS.indexOf(uiStep)

  // il nome per le frasi: col default «Bot» si lascia il saluto iniziale
  // («Come mi chiami?»); un nome VERO (adozione, ripresa) va nella frase
  const guideName = displayName === 'Bot' ? '' : displayName
  const facts: GuideFacts = {
    ...EMPTY_GUIDE_FACTS,
    name: guideName,
    modelReady
  }
  const mood = guideMood(uiStep, facts)
  const bubble = i18n.t(guideBubble(uiStep, facts))
  const bubbleKey = guideBubbleKey(uiStep, facts)

  // le misure della scena secondo la larghezza (mockup: 580/460, 420/320, 200)
  const stacked = windowWidth < 900
  const mascotSize = windowWidth >= 1100 ? 460 : windowWidth >= 900 ? 320 : 200
  const sceneWidth = windowWidth >= 1100 ? 580 : 420

  // ---- la navigazione ----
  const nextDisabled = uiStep === 'model' && !modelReady
  const nextLabel = uiStep === 'ready' ? t`Apri la chat` : t`Continua`
  const canBack = stepIdx > 0 && daemonStep !== 'welcome'
  const canSkip = uiStep === 'model' && !modelReady
  const onContinue = (): void => {
    if (backTo) { setBackTo(null); return }
    if (uiStep === 'welcome') { void advance('welcome', 'done'); return }
    if (uiStep === 'model') { if (modelReady) void advance('model', 'done'); return }
    if (uiStep === 'ready') { void advance('approvals', 'done'); return }
  }
  const onSkip = (): void => {
    if (uiStep === 'model') void advance('model', 'skipped')
  }
  const onBack = (): void => {
    if (backTo) {
      // si era già indietro: o un passo ancora prima, o si torna al passo vero
      setBackTo(UI_STEPS[UI_STEPS.indexOf(backTo) - 1] ?? null)
      return
    }
    const prev = UI_STEPS[stepIdx - 1]
    if (prev) setBackTo(prev)
  }

  // G2 tastiera: Invio = Continua quando attivo (fuori dai campi), Esc = Indietro
  const continueRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && canBack) { e.preventDefault(); onBack() }
      if (e.key === 'Enter') {
        const el = e.target as HTMLElement | null
        const inField = !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
        if (!inField && !nextDisabled && continueRef.current) {
          e.preventDefault()
          continueRef.current.click()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // il focus va al primo controllo del passo
  const controlsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = controlsRef.current
    if (!root) return
    const first = root.querySelector<HTMLElement>('input, select, button:not([disabled])')
    first?.focus()
  }, [uiStep, backTo])

  // OA3: la scelta del passo autorizzazioni scrive approvals.mode (e il
  // derivato enabled dell'auto-revisione, come la pagina Approvazioni)
  const chooseApprovals = async (mode: 'ask' | 'auto'): Promise<void> => {
    const cfg = await api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW)
    await api.settingsSet('approvals.mode', mode)
    await api.settingsSet('approvals.modeSet', true)
    await api.settingsSet('autoReview', { ...cfg, enabled: mode === 'auto' })
    setChosenApprovals(mode)
  }
  const openModelsSettings = (): void => {
    setSettingsTab('modelli')
    setSettingsOpen(true)
  }

  return (
    <div
      className={`${stacked ? 'flex flex-col' : 'flex'} h-screen w-screen overflow-hidden bg-background text-foreground`}
      data-testid="guide-view"
    >
      <SceneColumn
        phrase={bubble}
        bubbleKey={bubbleKey}
        mood={mood}
        avatar={avatar}
        displayName={displayName}
        width={sceneWidth}
        mascotSize={mascotSize}
        stacked={stacked}
      />
      <div
        ref={controlsRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={stacked ? { padding: '18px 32px 28px' } : { padding: '40px 96px 44px 48px' }}
      >
        {/* in alto: l'avanzamento a puntini e la lingua */}
        <div className="flex h-8 shrink-0 items-center justify-between gap-3">
          <StepDots current={uiStep} reachedEnd={uiStep === 'ready'} />
          <label className="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
            <Trans>Lingua</Trans>
            <select
              className="rounded-full bg-card px-3 py-1.5 text-[13px] text-foreground outline-none"
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
        </div>

        {/* al centro: il contenuto del passo */}
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto scroll-thin py-4">
          {uiStep === 'welcome' && (
            <StepPanel stepKey="welcome" testId="guide-step-welcome">
              <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.1] tracking-[-0.01em]">{t`Prepariamo Homun`}</h1>
              <p className="m-0 text-base leading-[1.6] text-muted-foreground">
                {t`Homun è il tuo spazio di lavoro con la squadra AI: un bot principale che ti aiuta ogni giorno, e altri bot per le cose che ripeti.`}
              </p>
            </StepPanel>
          )}
          {uiStep === 'model' && (
            <StepPanel stepKey="model" testId="guide-step-model">
              <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.1] tracking-[-0.01em]">{t`Il modello`}</h1>
              <p className="m-0 text-base leading-[1.6] text-muted-foreground">
                {t`Il modello è ciò che fa pensare il tuo Homun: senza, i tuoi messaggi restano in attesa e ripartono da soli appena ne scegli uno. Puoi farlo ora, oppure più avanti dalla chat.`}
              </p>
              <div className="flex w-full flex-col gap-2">
                {(paths ?? (['cloud'] as OnboardingProviderPath[])).map((p) => (
                  <RoadCard key={p} path={p} onOpen={openModelsSettings} />
                ))}
              </div>
            </StepPanel>
          )}
          {uiStep === 'approvals' && (
            <StepPanel stepKey="approvals" testId="guide-step-approvals">
              <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.1] tracking-[-0.01em]">{t`Autorizzazioni`}</h1>
              <p className="m-0 text-base leading-[1.6] text-muted-foreground">
                {t`Che cosa può fare il tuo Homun da solo, e dove si ferma a chiederti il via?`}
              </p>
              <div className="flex w-full flex-col gap-2">
                {approvalsChoices(modelReady).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`guide-approvals-${c.id}`}
                    disabled={!c.enabled}
                    aria-pressed={chosenApprovals === c.id}
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
            </StepPanel>
          )}
          {(daemonStep === 'computer' || daemonStep === 'memory') && (
            <StepPanel stepKey={daemonStep} testId={`guide-step-${daemonStep}`}>
              <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.1] tracking-[-0.01em]">{t`Prossimamente`}</h1>
              <p className="m-0 max-w-md text-base leading-[1.6] text-muted-foreground">
                {t`Questo passo arriva con un aggiornamento prossimo: per ora puoi proseguire.`}
              </p>
            </StepPanel>
          )}
        </div>

        {/* in basso: la navigazione */}
        <div className="flex shrink-0 items-center justify-between gap-3">
          {canBack ? (
            <button
              type="button"
              className="rounded-lg px-1.5 py-3 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
              onClick={onBack}
              data-testid="guide-back"
            >
              ← <Trans>Indietro</Trans>
            </button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-1">
            {canSkip && (
              <button
                type="button"
                data-testid="guide-skip"
                className="rounded-lg px-3.5 py-3 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
                onClick={onSkip}
              >
                <Trans>Salta per ora</Trans>
              </button>
            )}
            <button
              type="button"
              ref={continueRef}
              data-testid="guide-continue"
              disabled={nextDisabled}
              className="rounded-full bg-foreground px-[30px] py-[14px] text-base font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
              onClick={onContinue}
            >
              {nextLabel}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}
