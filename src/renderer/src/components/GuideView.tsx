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
import type { AutoReviewSettings, MainModel } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../../shared/types'
import { avatarOf, BOT_FAMILIES, BOT_COLORS } from '../../../shared/avatar'
import type { BotFamily, BotColor } from '../../../shared/types'
import { guideNameOf, GUIDE_NAME_MAX } from '../lib/guide-identity'
import type { UiLanguageSetting } from '../../../shared/ui-language'
import { SUPPORTED_UI_LANGUAGES } from '../../../shared/ui-language'
import { TRAFFIC_LIGHT_INSET } from '../layout'
import { approvalsChoices } from '../lib/guide-steps'
import { guideMood, guideBubble, guideBubbleKey, EMPTY_GUIDE_FACTS, type GuideFacts, type GuideUiStep } from '../lib/guide-scene'
import { Bot } from '../bot/Bot'
// G4: il passo Modello vive in un componente suo (griglia, prova, Ollama, Integrato)
import { GuideModelStep, type ModelStepFacts } from './GuideModelStep'
// G6: l'arrivo in chat — la mascotte vola dalla scena al pannello del bot
import { stashMascotFlight } from '../lib/guide-arrival'

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
  // GC1: l'umore è leggibile anche da fuori (data-mood), per la sonda
  const mascot = (
    <div className="guide-float" data-mood={mood}>
      <Bot family={avatar.family} color={avatar.color} state={mood} size={mascotSize} label={displayName} />
    </div>
  )
  const shadow = (
    // GC4: il colore dell'ombra sta nel CSS (qui solo le misure): nel tema
    // scuro la variante .dark la rende un alone chiaro molto tenue, quella
    // scura sparisce sul fondo scuro
    <div
      className="guide-shadow"
      aria-hidden
      style={{
        width: shadowWidth,
        height: Math.max(12, Math.round((mascotSize / 460) * 24)),
        borderRadius: '50%',
        marginTop: stacked ? 4 : 6
      }}
    />
  )
  const bubble = (
    <div key={bubbleKey} className="guide-bubble-pop relative max-w-[420px] rounded-[22px] bg-card px-[22px] py-[18px] text-[19px] leading-[1.4] shadow-soft">
      <span className="font-display font-medium">{phrase}</span>
      {/* la punta della nuvoletta, verso la mascotte: in basso quando la
          nuvoletta sta SOPRA (affiancata), a sinistra quando sta a DESTRA
          della mascotte (layout impilato, GC4) */}
      <span
        aria-hidden
        className={`absolute h-[18px] w-[18px] rotate-45 rounded-[3px] bg-card ${stacked ? 'left-[-9px] top-1/2 -translate-y-1/2' : 'bottom-[-9px] left-1/2 -translate-x-1/2'}`}
      />
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

/**
 * G3: il passo «Tu» — il nome e la faccia del bot principale, secondo il
 * mockup: campo nome (max 40, vuoto = «Bot»), le 5 famiglie come piastrelle
 * col Bot piccolo da 62 px nel colore scelto, i 7 colori come tondi da 34 px
 * col doppio anello sul selezionato. Ogni scelta è IMMEDIATA sulla mascotte
 * grande (la bozza vive in GuideView) e fa il lampo felice (~1 s).
 */
function WelcomeStep({ name, onName, family, color, onPickFamily, onPickColor, onConfirm }: {
  name: string
  onName(v: string): void
  family: BotFamily
  color: BotColor
  onPickFamily(f: BotFamily): void
  onPickColor(c: BotColor): void
  onConfirm(): void
}) {
  const { t } = useLingui()
  const familyLabels: Record<BotFamily, string> = {
    'h-creature': t`Creatura`,
    'h-robo': t`Robottino`,
    'h-device': t`Tech`,
    jelly: t`Gelatina`,
    pixel: t`Pixel`
  }
  const colorLabels: Record<BotColor, string> = {
    c1: t`Arancio`, c2: t`Rosa`, c3: t`Verde`, c4: t`Blu`, c5: t`Giallo`, c6: t`Turchese`, c7: t`Grafite`
  }
  return (
    <StepPanel stepKey="welcome" testId="guide-step-welcome">
      <div className="flex flex-col gap-3.5">
        <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.1] tracking-[-0.01em]">{t`Diamo una faccia al tuo bot`}</h1>
        <p className="m-0 text-base leading-[1.6] text-muted-foreground">
          {t`È il tuo punto di contatto in Homun: ti risponde, lavora per te e coordina gli altri bot. Puoi cambiarlo quando vuoi.`}
        </p>
      </div>
      <label className="flex flex-col gap-2 text-sm font-semibold">
        {t`Come si chiama?`}
        <input
          data-testid="guide-name-input"
          className="rounded-[14px] bg-card px-4 py-3.5 text-lg font-medium text-foreground outline-none"
          placeholder={t`Bot`}
          maxLength={GUIDE_NAME_MAX}
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onConfirm() } }}
        />
      </label>
      <div className="flex flex-col gap-3.5">
        <span className="text-sm font-semibold">{t`Che aspetto ha?`}</span>
        <div className="grid grid-cols-5 gap-3.5">
          {BOT_FAMILIES.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`guide-family-${f}`}
              aria-pressed={family === f}
              aria-label={familyLabels[f]}
              className={`flex min-h-[44px] flex-col items-center gap-1.5 rounded-2xl px-1.5 pb-2.5 pt-3 transition ${family === f ? 'bg-card shadow-[0_0_0_2px_var(--foreground)]' : 'hover:bg-accent/60'}`}
              onClick={() => onPickFamily(f)}
            >
              <Bot family={f} color={color} state="idle" size={62} track={false} />
              <span className="text-xs">{familyLabels[f]}</span>
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex gap-1.5">
          {BOT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`guide-color-${c}`}
              aria-pressed={color === c}
              aria-label={colorLabels[c]}
              className="grid size-11 shrink-0 place-items-center rounded-full transition hover:scale-105"
              onClick={() => onPickColor(c)}
            >
              {/* il tondo visibile è da 34 px (mockup), il bersaglio del clic 44 */}
              <span
                className={`size-[34px] rounded-full ${color === c ? 'shadow-[0_0_0_3px_var(--background),0_0_0_5px_var(--foreground)]' : ''}`}
                style={{ background: `var(--bot-${c})` }}
              />
            </button>
          ))}
        </div>
      </div>
    </StepPanel>
  )
}

/**
 * G5: il passo «Permessi» — le due schede grandi del mockup. La scrittura
 * dei setting resta quella di OA3 (approvalsChoices, approvals.mode,
 * approvals.modeSet, autoReview derivato): cambia solo come si presenta.
 * «Fai quello che ti chiedo» senza modello resta spenta, con la riga che
 * dice perché.
 */
function ApprovalsStep({ modelReady, chosen, onChoose }: {
  modelReady: boolean
  chosen: 'ask' | 'auto' | null
  onChoose(mode: 'ask' | 'auto'): void
}) {
  const { t } = useLingui()
  const cards: Array<{
    id: 'ask' | 'auto'
    title: string
    desc: string
    alone: string
    ask: string
  }> = [
    {
      id: 'ask',
      title: t`Chiedimi prima`,
      desc: t`Leggo e cerco da solo. Prima di cambiare qualcosa, ti chiedo.`,
      alone: t`leggere la posta, cercare sul web, preparare bozze`,
      ask: t`inviare, scrivere, cancellare, pagare`
    },
    {
      id: 'auto',
      title: t`Fai quello che ti chiedo`,
      desc: t`Faccio da solo ciò che serve alla tua richiesta.`,
      alone: t`tutto quello che serve a ciò che mi hai chiesto`,
      ask: t`soldi, messaggi a persone nuove, cancellazioni, cose fuori richiesta`
    }
  ]
  const choices = approvalsChoices(modelReady)
  return (
    <StepPanel stepKey="approvals" testId="guide-step-approvals">
      <div className="flex flex-col gap-3.5">
        <h1 className="m-0 font-display text-[40px] font-semibold leading-[1.1] tracking-[-0.01em]">{t`Quanto posso fare da solo?`}</h1>
        <p className="m-0 text-base leading-[1.6] text-muted-foreground">
          {t`Lo cambi quando vuoi da Impostazioni › Approvazioni.`}
        </p>
      </div>
      <div className="flex w-full flex-col gap-3">
        {cards.map((c) => {
          const enabled = c.id === 'ask' || modelReady
          return (
            <button
              key={c.id}
              type="button"
              data-testid={`guide-approvals-${c.id}`}
              aria-pressed={chosen === c.id}
              disabled={!enabled}
              className={`flex min-h-[44px] flex-col gap-1.5 rounded-[20px] px-6 py-[22px] text-left transition ${chosen === c.id ? 'bg-card shadow-[0_0_0_2px_var(--foreground)]' : 'bg-card/55 hover:bg-card dark:bg-card'} ${enabled ? '' : 'cursor-not-allowed opacity-55'}`}
              onClick={() => { if (enabled) onChoose(c.id) }}
            >
              <span className="font-display text-xl font-semibold">{c.title}</span>
              <span className="text-sm leading-[1.45] text-muted-foreground">{c.desc}</span>
              <span className="mt-1.5 flex flex-col gap-1 text-[13.5px] leading-[1.4]">
                <span><b className="text-guide-good">{t`Da solo`}</b> · {c.alone}</span>
                <span><b>{t`Ti chiedo`}</b> · {c.ask}</span>
              </span>
              {!enabled && (
                <span className="text-[12.5px] text-destructive">{t`Serve un modello: torna indietro e collegane uno`}</span>
              )}
            </button>
          )
        })}
      </div>
    </StepPanel>
  )
}

/**
 * G6: il passo «Pronto» (SOLO della UI: la sequenza del daemon non cambia) —
 * «Tutto pronto.», tre righe di riepilogo (il tuo bot, il modello o «da
 * scegliere», i permessi) e il bottone «Apri la chat», che fa l'avanzare di
 * approvals e porta in chat (la mascotte ci vola, FLIP in lib/guide-arrival).
 */
function ReadyStep({ modelReady, chosen }: { modelReady: boolean; chosen: 'ask' | 'auto' | null }) {
  const { t } = useLingui()
  const [summary, setSummary] = useState<{ model: string; approvals: 'ask' | 'auto' } | null>(null)
  const agents = useStore((st) => st.agents)
  const mainAgentId = useStore((st) => st.mainAgentId)
  const providers = useStore((st) => st.providers)
  const main = agents.find((a) => a.id === mainAgentId) ?? null
  const avatar = main ? avatarOf(main, agents, mainAgentId) : { family: 'h-creature' as const, color: 'c1' as const }
  useEffect(() => {
    let alive = true
    void (async () => {
      const mm = await api.settingsGet<MainModel | null>('models.main', null).catch(() => null)
      const mode = chosen ?? await api.settingsGet<'ask' | 'auto' | null>('approvals.mode', null).catch(() => null)
      if (!alive) return
      const modelName = mm && modelReady
        ? `${providers.find((p) => p.id === mm.providerId)?.name ?? mm.providerId} · ${mm.model}`
        : null
      setSummary({ model: modelName ?? t`da scegliere`, approvals: mode === 'auto' ? 'auto' : 'ask' })
    })()
    return () => { alive = false }
  }, [chosen, modelReady, providers, t])
  const familyLabel = avatar.family === 'h-creature' ? t`Creatura`
    : avatar.family === 'h-robo' ? t`Robottino`
      : avatar.family === 'h-device' ? t`Tech`
        : avatar.family === 'jelly' ? t`Gelatina` : t`Pixel`
  const colorLabel = avatar.color === 'c1' ? t`Arancio`
    : avatar.color === 'c2' ? t`Rosa`
      : avatar.color === 'c3' ? t`Verde`
        : avatar.color === 'c4' ? t`Blu`
          : avatar.color === 'c5' ? t`Giallo`
            : avatar.color === 'c6' ? t`Turchese` : t`Grafite`
  const rows: Array<{ test: string; k: string; v: string; ok: boolean }> = [
    { test: 'guide-summary-bot', k: t`Il tuo bot`, v: `${main?.name ?? 'Bot'} · ${familyLabel}, ${colorLabel.toLowerCase()}`, ok: true },
    { test: 'guide-summary-model', k: t`Modello`, v: summary?.model ?? t`da scegliere`, ok: modelReady },
    { test: 'guide-summary-permissions', k: t`Permessi`, v: (summary?.approvals ?? 'ask') === 'auto' ? t`Fai quello che ti chiedo` : t`Chiedimi prima`, ok: true }
  ]
  return (
    <StepPanel stepKey="ready" testId="guide-step-ready">
      <h1 className="m-0 font-display text-[44px] font-semibold leading-[1.1] tracking-[-0.01em]">{t`Tutto pronto.`}</h1>
      <div className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <div key={r.test} data-testid={r.test} className="flex items-center gap-3 rounded-[14px] bg-card px-4 py-3.5">
            <span
              aria-hidden
              className={`grid size-[30px] place-items-center rounded-full text-sm font-bold ${r.ok ? 'bg-chart-2/15 text-chart-2' : 'bg-muted text-muted-foreground'}`}
            >
              {r.ok ? '✓' : '–'}
            </span>
            <span className="flex flex-col">
              <span className="text-[13px] text-muted-foreground">{r.k}</span>
              <span className="max-w-full truncate text-[15.5px] font-semibold">{r.v}</span>
            </span>
          </div>
        ))}
      </div>
    </StepPanel>
  )
}

/**
 * La guida: sostituisce la finestra finché lo stato non arriva a «chat».
 */
export function GuideView() {
  const { t, i18n } = useLingui()
  const onboarding = useStore((s) => s.onboarding)
  const advance = useStore((s) => s.onboardingAdvance)
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
  // G6: il passo Pronto (solo UI) — raggiunto dopo la scelta dei permessi;
  // la chiave è startedAt, così un «Rifai da capo» lo azzera da solo
  const guideReadyAt = useStore((st) => st.guideReadyAt)
  const setGuideReadyAt = useStore((st) => st.setGuideReadyAt)

  // G3: la bozza del passo «Tu» — nome e aspetto si provano SUBITO sulla
  // mascotte grande; si salvano solo a «Continua» (agents:update). Il campo
  // nome parte dal nome attuale: col default «Bot» resta vuoto col segnaposto
  // (il saluto della nuvoletta chiede «come mi chiami?»)
  const agentForDraft = useStore((st) => st.agents.find((a) => a.id === st.mainAgentId) ?? null)
  const [draftName, setDraftName] = useState<string>(() => (agentForDraft && agentForDraft.name !== 'Bot' ? agentForDraft.name : ''))
  const [draftAvatar, setDraftAvatar] = useState<{ family: BotFamily; color: BotColor } | null>(null)
  // il lampo felice (~1 s) dopo la scelta di una faccia o un colore
  const [flashHappy, setFlashHappy] = useState(false)
  // G4: i fatti del passo Modello per la scena, la sua Continua e il pronto
  const [modelFacts, setModelFacts] = useState<ModelStepFacts>({ providerPath: null, probe: 'idle', ollamaChosen: false, download: 'idle' })
  const [modelLocalReady, setModelLocalReady] = useState(false)
  const modelContinueRef = useRef<(() => Promise<boolean>) | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const happyFlash = (): void => {
    setFlashHappy(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashHappy(false), 1_100)
  }
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  // le strade del passo modello le porta la RPC (scoperta asincrona)
  useEffect(() => {
    if (state?.step === 'model' && !paths) {
      void api.onboardingState()
        .then((s) => { if (s) useStore.setState({ onboarding: s }) })
        .catch(() => undefined)
    }
  }, [state?.step, paths])

  const mainAgent = agents.find((a) => a.id === mainAgentId) ?? null
  const savedAvatar = mainAgent ? avatarOf(mainAgent, agents, mainAgentId) : { family: 'h-creature' as const, color: 'c1' as const }
  if (!state || state.step === 'chat') return null
  const daemonStep = state.step

  // G3: sul passo Tu la scena mostra la BOZZA (anteprima immediata del nome,
  // della faccia e del colore), altrove l'aspetto salvato del bot
  const onTuStep = daemonStep === 'welcome' || backTo === 'welcome'
  const avatar = onTuStep ? (draftAvatar ?? savedAvatar) : savedAvatar
  const typedName = (onTuStep ? draftName : (mainAgent?.name ?? '')).trim()
  const displayName = typedName || 'Bot'

  // il passo della UI: i passi computer/memory non ci sono in fase A; il
  // passo Pronto (solo UI, G6) sta fra i permessi scelti e la chat
  const reachedReady = daemonStep === 'approvals' && guideReadyAt === state.startedAt
  const uiStep: GuideUiStep = backTo ?? (daemonStep === 'approvals' && reachedReady ? 'ready' : daemonStep as GuideUiStep)
  const stepIdx = UI_STEPS.indexOf(uiStep)

  // il nome per le frasi: sul passo Tu quello digitato finora (vuoto =
  // saluto iniziale), altrove il nome vero del bot
  const facts: GuideFacts = {
    ...EMPTY_GUIDE_FACTS,
    name: typedName,
    modelReady,
    flashHappy,
    // G4: lo stato del pannello del passo Modello (strada, prova, download)
    providerPath: modelFacts.providerPath,
    probe: modelFacts.probe,
    ollamaChosen: modelFacts.ollamaChosen,
    download: modelFacts.download
  }
  const mood = guideMood(uiStep, facts)
  const bubble = i18n.t(guideBubble(uiStep, facts))
  const bubbleKey = guideBubbleKey(uiStep, facts)

  // le misure della scena secondo la larghezza (mockup: 580/460, 420/320, 200)
  const stacked = windowWidth < 900
  const mascotSize = windowWidth >= 1100 ? 460 : windowWidth >= 900 ? 320 : 200
  const sceneWidth = windowWidth >= 1100 ? 580 : 420

  // ---- la navigazione ----
  // G4: «Continua» del passo Modello è attivo solo col modello pronto (la
  // prova riuscita col modello scelto, Ollama scelto, o l'integrato pronto);
  // il modelReady del daemon copre il caso limite di un salvataggio esterno
  const modelReadyHere = modelLocalReady || modelReady
  // G5: anche il passo Permessi aspetta la scelta (mockup: Continua spento
  // finché non si sceglie una delle due schede)
  const nextDisabled = (uiStep === 'model' && !modelReadyHere) || (uiStep === 'approvals' && chosenApprovals === null)
  const nextLabel = uiStep === 'ready' ? t`Apri la chat` : t`Continua`
  const canBack = stepIdx > 0 && daemonStep !== 'welcome'
  const canSkip = uiStep === 'model' && !modelReadyHere
  // G3: «Continua» del passo Tu salva nome e aspetto del bot principale
  // (agents:update, con la validazione dell'avatar che il daemon già fa)
  const saveTuStep = async (): Promise<void> => {
    if (!mainAgentId) return
    try {
      await api.updateAgent(mainAgentId, { name: guideNameOf(draftName), avatar: { family: avatar.family, color: avatar.color } })
    } catch {
      // i valori sono quelli validi del selettore: la validazione del daemon
      // non può rifiutarli; se la RPC cade, la guida prosegue lo stesso
    }
  }
  const onContinue = (): void => {
    if (uiStep === 'welcome') {
      void saveTuStep().then(() => {
        if (backTo) setBackTo(null)
        else void advance('welcome', 'done')
      })
      return
    }
    if (uiStep === 'model') {
      if (backTo) { setBackTo(null); return }
      // la Continua del pannello aperto (salva il provider e models.main: il
      // passo si chiude da solo, modelBecameReady); senza pannello con
      // Continua, il modelReady del daemon avanza direttamente
      const fn = modelContinueRef.current
      if (fn) void fn().then((done) => { if (!done && modelReady) void advance('model', 'done') })
      else if (modelReady) void advance('model', 'done')
      return
    }
    if (uiStep === 'approvals') {
      if (backTo) { setBackTo(null); return }
      // la scelta ha GIÀ scritto i setting (OA3): Continua porta al passo
      // Pronto (solo UI), la sequenza del daemon non cambia
      if (chosenApprovals) setGuideReadyAt(state.startedAt)
      return
    }
    if (backTo) { setBackTo(null); return }
    if (uiStep === 'ready') {
      // G6: la mascotte si misura PRIMA che la guida chiuda, poi l'avanzare
      // dei permessi porta in chat (l'arrivo vola con un FLIP in App)
      stashMascotFlight()
      void advance('approvals', 'done')
    }
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
              className="min-h-[44px] rounded-full bg-card px-3 py-1.5 text-[13px] text-foreground outline-none"
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
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto scroll-thin py-4 px-1">
          {uiStep === 'welcome' && (
            <WelcomeStep
              name={draftName}
              onName={setDraftName}
              family={avatar.family}
              color={avatar.color}
              onPickFamily={(family) => { setDraftAvatar({ family, color: avatar.color }); happyFlash() }}
              onPickColor={(color) => { setDraftAvatar({ family: avatar.family, color }); happyFlash() }}
              onConfirm={onContinue}
            />
          )}
          {uiStep === 'model' && (
            <GuideModelStep
              paths={paths}
              onFactsChange={setModelFacts}
              onReadyChange={setModelLocalReady}
              registerContinue={(fn) => { modelContinueRef.current = fn }}
            />
          )}
          {uiStep === 'approvals' && (
            <ApprovalsStep modelReady={modelReady} chosen={chosenApprovals} onChoose={(mode) => { void chooseApprovals(mode) }} />
          )}
          {uiStep === 'ready' && <ReadyStep modelReady={modelReady} chosen={chosenApprovals} />}
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
