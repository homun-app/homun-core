// G4 (fase guida): il passo «Modello» — si collega e si prova DENTRO la
// guida, mai più le Impostazioni. La griglia dei provider (Anthropic
// consigliato, OpenAI, OpenRouter, Altri…, Ollama solo se trovato, Integrato
// solo se la macchina lo consente), il pannello del provider scelto che
// PRENDE il posto della griglia (con «← Altri provider»), la chiave con la
// prova PRIMA di salvare (useProviderSetup condiviso col foglio
// Impostazioni), i modelli come pillole col consigliato già scelto
// (recommendedModel), Ollama con i tool letti dalle capability, e il modello
// integrato con la dimensione VERA del catalogo e la barra di avanzamento.
// La chiave non si logga mai e non torna alla UI.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
// GC4: icone vere per «Altri…» e «Integrato» (lucide, già nel progetto)
import { MoreHorizontal, Cpu } from 'lucide-react'
import { api, useStore } from '../store'
import type { ModelInfo, OnboardingProviderPath, ProviderKind, ProviderPublic } from '../../../shared/types'
import { KIND_LABELS, useProviderSetup, probeButtonDisabled, suggestedNameOf } from '../lib/use-provider-setup'
import { guideProviderCards, GUIDE_OTHER_KINDS, type GuideProviderCardId } from '../lib/guide-provider-cards'
import { providerKeyUrl } from '../lib/provider-key-urls'
import { recommendedModel } from '../lib/recommended-model'
import { guideModelPills } from '../lib/guide-model-pills'
import { openAiCompatBase } from '../../../main/agent/live-models'
import { runLocalModelPolling } from '../lib/guide-local-model'
import { ModelPicker } from './ui/ModelPicker'
import { ProviderMark } from './settings/AddProviderSheet'

/** I fatti del passo modello per la scena (umore e nuvoletta). */
export interface ModelStepFacts {
  providerPath: 'cloud' | 'ollama' | 'local' | null
  probe: 'idle' | 'testing' | 'ok' | 'bad'
  ollamaChosen: boolean
  download: 'idle' | 'running' | 'done'
}

export interface GuideModelStepProps {
  /** le strade per questa macchina (RPC onboarding:state) */
  paths: OnboardingProviderPath[] | undefined
  /** i fatti del passo aggiorno la scena (umore e nuvoletta) */
  onFactsChange(f: ModelStepFacts): void
  /** «Continua» è attivo quando il modello del passo è pronto */
  onReadyChange(ready: boolean): void
  /** registra la Continua del passo: salva provider e models.main */
  registerContinue(fn: (() => Promise<boolean>) | null): void
}

/** La scheda di un provider della griglia (mockup: min 124 px, logo o iniziale). */
function ProviderCard({ id, label, desc, badge, logoKind, icon, onPick }: {
  id: GuideProviderCardId | ProviderKind
  label: string
  desc: string
  badge?: string
  logoKind: string
  /** GC4: icona vera per le schede senza logo (Altri…, Integrato) */
  icon?: React.ReactNode
  onPick(): void
}) {
  return (
    <button
      type="button"
      data-testid={`guide-provider-${id}`}
      onClick={onPick}
      className="flex min-h-[124px] flex-col items-start gap-3 rounded-surface bg-card/55 p-4 text-left transition hover:-translate-y-px hover:bg-card dark:bg-card/80"
    >
      <span className="flex w-full items-center justify-between gap-2">
        {icon ? (
          // la stessa piastrella dei loghi, con l'icona lucide (mai una lettera)
          <span className="grid size-11 shrink-0 place-items-center rounded-surface bg-card text-foreground" aria-hidden>
            {icon}
          </span>
        ) : (
          <ProviderMark kind={logoKind as ProviderKind} name={label} />
        )}
        {badge && (
          <span className="rounded-full bg-guide-good/15 px-2 py-0.5 text-caption font-semibold text-guide-good">{badge}</span>
        )}
      </span>
      <span className="text-body font-semibold">{label}</span>
      <span className="text-small text-muted-foreground">{desc}</span>
    </button>
  )
}

/**
 * GC2: le pillole dei modelli del pannello con chiave — al massimo 4 (il
 * consigliato per primo, poi gli altri nell'ordine dell'elenco: funzione
 * pura guideModelPills) più una pillola «Altri modelli…» con lo STESSO
 * stile, che apre il ModelPicker. Il trigger non mostra MAI il valore
 * scelto: era quello il «quarto controllo» che sembrava una pillola rotta.
 * Un modello scelto dal picker che non è fra le pillole diventa una pillola,
 * selezionata, al posto dell'ultima.
 */
export function GuideModelPills({ kind, models, selected, onSelect, pickerLabel }: {
  kind: string
  models: readonly string[]
  selected: string | null
  onSelect(id: string): void
  pickerLabel: string
}) {
  const pills = guideModelPills(kind, models, selected)
  const pillCls = 'max-w-full min-h-[44px] truncate rounded-full px-4 py-2 text-small font-semibold transition'
  return (
    <>
      {pills.map((m) => (
        <button
          key={m}
          type="button"
          data-testid={`guide-model-${m}`}
          aria-pressed={selected === m}
          className={`${pillCls} ${selected === m ? 'bg-foreground text-background' : 'bg-background text-foreground hover:bg-accent'}`}
          onClick={() => onSelect(m)}
        >
          {m}
        </button>
      ))}
      <ModelPicker
        pillTrigger={{ label: pickerLabel }}
        className={`${pillCls} bg-background text-foreground hover:bg-accent`}
        models={models.map((id): ModelInfo => ({ id, source: 'live', vision: false, tools: true, thinkingLevels: [], cost: null, costSource: null, local: false }))}
        value={selected}
        onChange={(id) => { if (id) onSelect(id) }}
      />
    </>
  )
}

export function GuideModelStep({ paths, onFactsChange, onReadyChange, registerContinue }: GuideModelStepProps) {
  const { t } = useLingui()
  const providers = useStore((s) => s.providers)
  // che pannello è aperto: la griglia, l'elenco «Altri…», il pannello Integrato
  // ('local', che NON è un kind: il kind del provider integrato è homun-local),
  // Ollama, o un tipo con chiave
  type ModelPanel = 'grid' | 'others' | 'local' | ProviderKind
  const [panel, setPanel] = useState<ModelPanel>('grid')
  // la prova/salvataggio della chiave: l'hook condiviso col foglio Impostazioni
  const setup = useProviderSetup(panel !== 'grid' && panel !== 'others' && panel !== 'ollama' && panel !== 'local' ? panel : null)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  // U6: il campo «Nome del modello» scritto a mano (aperto da «Altro…», o
  // obbligatorio quando /models manca o è vuoto)
  const [manualModelOpen, setManualModelOpen] = useState(false)
  // Ollama: il provider scoperto e i suoi modelli (con i tool)
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[] | null>(null)
  const [ollamaModel, setOllamaModel] = useState<string | null>(null)
  // Integrato: lo stato VERO del download (poll come la scheda Impostazioni)
  const [localState, setLocalState] = useState<'idle' | 'downloading' | 'ready' | 'other'>('idle')
  const [localPct, setLocalPct] = useState(0)
  const [localSizeGb, setLocalSizeGb] = useState<number | null>(null)
  const [localInstallError, setLocalInstallError] = useState<string | null>(null)
  // GC6.2: l'errore del download in PAROLE (il messaggio del daemon), la
  // ripartenza del polling (pollEpoch) e l'attesa del download appena avviato
  const [localDownloadError, setLocalDownloadError] = useState<string | null>(null)
  const [pollEpoch, setPollEpoch] = useState(0)
  const expectingDownload = useRef(false)
  const continueBusy = useRef(false)

  // il tipo con chiave del pannello aperto (Ollama e Integrato sono a parte)
  const cloudKind: ProviderKind | null =
    panel !== 'grid' && panel !== 'others' && panel !== 'ollama' && panel !== 'local' ? panel : null
  const kind = cloudKind
  const isCloudPanel = cloudKind !== null
  // l'hook cambia identità a ogni render: la Continua registrata legge SEMPRE
  // l'ultima chiave/indirizzo attraverso il ref
  const setupRef = useRef(setup)
  setupRef.current = setup
  const needsAddress = kind === 'openai-compatible'

  // la griglia: le strade di questa macchina (Ollama trovato, Integrato idoneo)
  const cards = useMemo(
    () => guideProviderCards({ ollamaFound: paths?.includes('ollama') ?? false, localAllowed: paths?.includes('local') ?? false }),
    [paths]
  )

  // ---- i fatti per la scena (memo: l'identità cambia solo quando cambiano) ----
  const facts = useMemo<ModelStepFacts>(() => ({
    providerPath: panel === 'grid' || panel === 'others' ? null : panel === 'ollama' ? 'ollama' : panel === 'local' ? 'local' : 'cloud',
    probe: setup.probe.probing ? 'testing' : setup.probe.ok === true ? 'ok' : setup.probe.ok === false ? 'bad' : 'idle',
    ollamaChosen: ollamaModel !== null,
    download: localState === 'downloading' ? 'running' : localState === 'ready' ? 'done' : 'idle'
  }), [panel, setup.probe.probing, setup.probe.ok, ollamaModel, localState])
  useEffect(() => { onFactsChange(facts) }, [facts, onFactsChange])

  // quando la prova riesce, il consigliato è GIÀ scelto (recommendedModel)
  useEffect(() => {
    if (setup.probe.ok && setup.probe.models.length > 0) {
      setSelectedModel((cur) => (cur && setup.probe.models.includes(cur) ? cur : recommendedModel(kind ?? '', setup.probe.models)))
    }
    if (setup.probe.ok !== true) setSelectedModel(null)
  }, [setup.probe.ok, setup.probe.models, kind])

  // «Continua» del pannello con chiave: salva la chiave (Portachiavi) e poi
  // models.main — il passo si chiude da solo (modelBecameReady, OA3)
  const cloudContinue = useCallback(async (): Promise<boolean> => {
    if (!kind || !selectedModel || continueBusy.current) return false
    continueBusy.current = true
    try {
      const providerId = await setupRef.current.save()
      if (!providerId) return false
      await api.settingsSet('models.main', { providerId, model: selectedModel, thinking: null })
      return true
    } finally {
      continueBusy.current = false
    }
  }, [kind, selectedModel])

  // Ollama: all'apertura si scopre il provider e si elencano i modelli coi tool
  useEffect(() => {
    if (panel !== 'ollama') return
    let alive = true
    void api.discoverProviders()
      .then(async (list) => {
        const disc = list.find((p) => p.kind === 'ollama')
        if (!disc || !alive) return
        const models = await api.listModels(disc.id)
        if (alive) setOllamaModels(models)
      })
      .catch(() => { if (alive) setOllamaModels([]) })
    return () => { alive = false }
  }, [panel])

  // il consigliato di Ollama: il primo che usa i tool
  useEffect(() => {
    if (panel !== 'ollama' || !ollamaModels) return
    const firstWithTools = ollamaModels.find((m) => m.tools !== false)
    setOllamaModel(firstWithTools ? firstWithTools.id : null)
  }, [panel, ollamaModels])

  const ollamaContinue = useCallback(async (): Promise<boolean> => {
    if (!ollamaModel || continueBusy.current) return false
    continueBusy.current = true
    try {
      // il provider scoperto si salva SOLO se non c'è già
      if (!providers.some((p) => p.kind === 'ollama' && p.enabled)) {
        await api.saveProvider({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', enabled: true })
      }
      const providerId = providers.find((p) => p.kind === 'ollama' && p.enabled)?.id ?? 'ollama'
      await api.settingsSet('models.main', { providerId, model: ollamaModel, thinking: null })
      return true
    } finally {
      continueBusy.current = false
    }
  }, [ollamaModel, providers])

  // OBV4: la Continua del pannello Integrato col modello PRONTO — dal vivo
  // non faceva nulla (continueFn nullo) e il passo era un vicolo cieco. La
  // RPC del daemon scrive models.main se manca (l'id dal catalogo, mai
  // scritto a mano qui) e chiude il passo (modelBecameReady): la finestra
  // avanza con l'evento onboarding, come gli altri pannelli.
  const localContinue = useCallback(async (): Promise<boolean> => {
    if (localState !== 'ready' || continueBusy.current) return false
    continueBusy.current = true
    try {
      const main = await api.localModelEnsureMain().catch(() => null)
      return !!main && main.providerId === 'homun-local'
    } finally {
      continueBusy.current = false
    }
  }, [localState])

  // Integrato: lo stato si polla col driver condiviso (lib/guide-local-model,
  // 1 s durante il download come la scheda Impostazioni); al modello pronto
  // il passo si chiude da solo (daemon). GC6.2: il loop riparte anche DOPO
  // «Scarica» (pollEpoch) — prima partiva solo all'apertura del pannello e
  // continuava solo se lo stato era già downloading: dopo localModelInstall()
  // nessuno lo riavviava e la finestra restava ferma su «Pronto a scaricare.»
  useEffect(() => {
    if (panel !== 'local') return
    let alive = true
    void runLocalModelPolling({
      status: () => api.localModelStatus(),
      onUi: (u) => {
        if (!alive) return
        // finché il download è ATTESO, le letture ancora precedenti allo
        // stato downloading del daemon non riportano il pannello indietro
        if (u.state === 'idle' && expectingDownload.current) return
        if (u.sizeGb !== null) setLocalSizeGb(u.sizeGb)
        if (u.state === 'error') {
          // l'errore in PAROLE (il messaggio del daemon), pannello pronto a riprovare
          setLocalState('other')
          setLocalPct(0)
          setLocalDownloadError(u.error ?? '')
          return
        }
        setLocalState(u.state)
        setLocalPct(u.pct)
      },
      delay: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      isAlive: () => alive,
      expecting: () => expectingDownload.current
    })
    return () => { alive = false }
  }, [panel, pollEpoch])

  const localInstall = async (): Promise<void> => {
    setLocalInstallError(null)
    setLocalDownloadError(null)
    const r = await api.localModelInstall().catch(() => null)
    if (!r) return
    if (!r.started) {
      // l'idoneità ricontrollata dal daemon ha rifiutato (per esempio spazio)
      setLocalInstallError(r.error ?? 'no')
      return
    }
    // GC6.2: «Scarico…» SUBITO, con la barra e «Annulla», e il polling
    // riparte: le prime letture possono non essere ancora downloading
    expectingDownload.current = true
    setLocalPct((p) => Math.max(p, 1))
    setLocalState('downloading')
    setPollEpoch((e) => e + 1)
  }

  // la Continua attiva e la sua funzione, secondo il pannello
  const ready = isCloudPanel
    ? setup.probe.ok === true && selectedModel !== null
    : panel === 'ollama'
      ? ollamaModel !== null
      : panel === 'local'
        ? localState === 'ready'
        : false
  useEffect(() => { onReadyChange(ready) }, [ready, onReadyChange])
  const continueFn = isCloudPanel ? cloudContinue : panel === 'ollama' ? ollamaContinue : panel === 'local' ? localContinue : null
  useEffect(() => { registerContinue(continueFn) }, [continueFn, registerContinue])

  // ---- il pannello con chiave ----
  if (isCloudPanel) {
    const providerLabel = KIND_LABELS[kind!] ?? kind!
    const keyUrl = providerKeyUrl(kind!)
    const probeErrorText =
      setup.probe.error === 'invalid-key'
        ? t`Questa chiave non funziona: ${providerLabel} risponde “non autorizzata”. Controlla di averla copiata intera.`
        : setup.probe.error === 'unreachable'
          ? t`Non riesco a raggiungere ${providerLabel}. Controlla la connessione e riprova.`
          : t`La prova non è riuscita. Controlla la chiave e riprova.`
    return (
      <div key={panel} className="guide-stepin flex w-full max-w-xl flex-col gap-5 text-left" data-testid="guide-step-model">
        <div>
          <h1 className="m-0 font-display text-page font-semibold">{t`Collega un modello`}</h1>
          <p className="m-0 mt-3 text-reading text-muted-foreground">
            {t`È quello che fa pensare il tuo bot. Si prova subito, prima di salvare.`}
          </p>
        </div>
        <button
          type="button"
          data-testid="guide-back-providers"
          className="min-h-[44px] self-start rounded-control px-1.5 py-2 text-body font-semibold text-muted-foreground transition hover:text-foreground"
          onClick={() => { setPanel(kind === 'xai' || kind === 'mistral' || kind === 'deepseek' || kind === 'groq' || kind === 'zai' || kind === 'openai-compatible' ? 'others' : 'grid'); setup.reset(); setSelectedModel(null) }}
        >
          ← <Trans>Altri provider</Trans>
        </button>
        <div className="flex flex-col gap-3 rounded-surface bg-card p-5">
          {needsAddress && (
            <>
              {/* U6: il Nome — precompilato con l'host dell'indirizzo, modificabile */}
              <label className="flex flex-col gap-2 text-body font-semibold">
                {t`Il nome del servizio`}
                <input
                  data-testid="guide-name-input"
                  className="rounded-surface bg-background px-4 py-3 text-reading font-medium text-foreground outline-none"
                  placeholder={setup.suggestedName || t`es. Il mio gateway`}
                  value={setup.name}
                  onChange={(e) => setup.setName(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-2 text-body font-semibold">
                {t`L'indirizzo del servizio`}
                <input
                  data-testid="guide-baseurl-input"
                  className="rounded-surface bg-background px-4 py-3 text-reading font-medium text-foreground outline-none"
                  placeholder={t`Indirizzo (es. http://127.0.0.1:8000/v1)`}
                  value={setup.baseUrl}
                  onChange={(e) => setup.setBaseUrl(e.target.value)}
                />
                {/* U6: l'URL che la prova chiama DAVVERO — si vede se manca /v1, niente correzioni silenziose */}
                <span className="text-caption font-normal text-muted-foreground" data-testid="guide-probe-url">
                  <Trans>La prova chiama {openAiCompatBase({ baseUrl: setup.baseUrl || 'http://…' }) + '/models'}</Trans>
                </span>
              </label>
            </>
          )}
          <label className="flex flex-col gap-2 text-body font-semibold">
            <span className="flex items-center justify-between gap-3">
              {needsAddress ? t`La chiave (facoltativa)` : t`La chiave di ${providerLabel}`}
              {keyUrl && (
                <a href={keyUrl} target="_blank" rel="noreferrer" className="text-small font-medium text-primary hover:underline">
                  <Trans>Dove la trovo?</Trans>
                </a>
              )}
            </span>
            <span className="flex gap-2">
              <input
                data-testid="guide-key-input"
                type="password"
                autoComplete="off"
                className="min-w-0 flex-1 rounded-surface bg-background px-4 py-3 text-reading font-medium text-foreground outline-none"
                placeholder={needsAddress ? t`lasciala vuota se il server non la chiede` : t`Incolla qui la chiave`}
                value={setup.apiKey}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setup.probeNow() } }}
                onChange={(e) => setup.setApiKey(e.target.value)}
              />
              <button
                type="button"
                data-testid="guide-key-probe"
                className="shrink-0 rounded-surface bg-foreground px-5 text-body font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                disabled={probeButtonDisabled({ probing: setup.probe.probing, apiKey: setup.apiKey, baseUrl: needsAddress ? setup.effectiveBaseUrl : setup.apiKey, needsAddress })}
                onClick={() => setup.probeNow()}
              >
                {setup.probe.probing ? t`Provo…` : t`Prova`}
              </button>
            </span>
          </label>
          {setup.probe.ok === true && (
            <div className="guide-stepin flex flex-col gap-3">
              <p className="m-0 rounded-surface bg-guide-good/15 px-3 py-2 text-body text-guide-good" data-testid="guide-probe-ok">
                <Trans>Funziona. La chiave resta nel Portachiavi del Mac.</Trans>
              </p>
              {/* GC2: le pillole (max 4, consigliato per primo) + «Altri modelli…» */}
              <div className="flex flex-wrap gap-2" data-testid="guide-model-pills">
                <GuideModelPills
                  kind={kind!}
                  models={setup.probe.models}
                  selected={selectedModel}
                  onSelect={setSelectedModel}
                  pickerLabel={t`Altri modelli…`}
                />
                {/* U6: «Altro…» accanto alle pillole per scrivere il modello a mano */}
                <button
                  type="button"
                  data-testid="guide-model-other"
                  className={`min-h-[36px] rounded-full px-4 text-small font-medium transition ${manualModelOpen || selectedModel === null ? 'bg-muted text-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setManualModelOpen((v) => !v)}
                >
                  <Trans>Altro…</Trans>
                </button>
              </div>
              {(manualModelOpen || setup.probe.models.length === 0) && (
                /* U6: /models manca o è vuoto, o l'utente vuole scrivere a mano */
                <label className="flex flex-col gap-2 text-body font-semibold">
                  {setup.probe.models.length === 0 ? t`Il servizio non elenca i modelli: scrivi il nome del modello` : t`Il nome del modello`}
                  <input
                    data-testid="guide-manual-model"
                    className="rounded-surface bg-background px-4 py-3 text-reading font-medium text-foreground outline-none"
                    placeholder={t`es. llama-3.2-3b-instruct`}
                    value={selectedModel ?? ''}
                    onChange={(e) => setSelectedModel(e.target.value.trim() || null)}
                  />
                </label>
              )}
            </div>
          )}
          {setup.probe.ok === false && (
            <p className="guide-stepin m-0 rounded-surface bg-destructive/10 px-3 py-2 text-body text-destructive" data-testid="guide-probe-error">
              {probeErrorText}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ---- il pannello di Ollama ----
  if (panel === 'ollama') {
    return (
      <div key="ollama" className="guide-stepin flex w-full max-w-xl flex-col gap-5 text-left" data-testid="guide-step-model">
        <div>
          <h1 className="m-0 font-display text-page font-semibold">{t`Collega un modello`}</h1>
          <p className="m-0 mt-3 text-reading text-muted-foreground">
            {t`È quello che fa pensare il tuo bot. Si prova subito, prima di salvare.`}
          </p>
        </div>
        <button
          type="button"
          data-testid="guide-back-providers"
          className="min-h-[44px] self-start rounded-control px-1.5 py-2 text-body font-semibold text-muted-foreground transition hover:text-foreground"
          onClick={() => { setPanel('grid'); setOllamaModels(null); setOllamaModel(null) }}
        >
          ← <Trans>Altri provider</Trans>
        </button>
        <div className="flex flex-col gap-2 rounded-surface bg-card p-5">
          <span className="text-body font-semibold">{t`Ho trovato questi modelli sul tuo Mac`}</span>
          {ollamaModels === null && <p className="m-0 text-body text-muted-foreground">{t`Cerco…`}</p>}
          {ollamaModels?.length === 0 && <p className="m-0 text-body text-muted-foreground">{t`Nessun modello: aprilo e ricrea uno di questi modelli, poi riprova.`}</p>}
          {ollamaModels?.map((m) => {
            const withTools = m.tools !== false
            const firstWithTools = ollamaModels.find((x) => x.tools !== false)?.id
            return (
              <button
                key={m.id}
                type="button"
                data-testid={`guide-ollama-${m.id}`}
                disabled={!withTools}
                aria-pressed={ollamaModel === m.id}
                className={`flex min-h-[44px] items-center justify-between gap-3 rounded-surface px-4 py-2 text-left transition ${ollamaModel === m.id ? 'bg-background shadow-[inset_0_0_0_2px_var(--foreground)]' : 'hover:bg-background/60'} ${withTools ? '' : 'cursor-not-allowed opacity-45'}`}
                onClick={() => setOllamaModel(m.id)}
              >
                <span className="min-w-0 truncate font-semibold">{m.id}</span>
                <span className="shrink-0 text-small text-muted-foreground">
                  {withTools ? (m.id === firstWithTools ? t`usa i tool · consigliato` : t`usa i tool`) : t`non usa i tool: non adatto`}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // ---- il pannello del modello Integrato ----
  if (panel === 'local') {
    const pct = localState === 'ready' ? 100 : localPct
    return (
      <div key="local" className="guide-stepin flex w-full max-w-xl flex-col gap-5 text-left" data-testid="guide-step-model">
        <div>
          <h1 className="m-0 font-display text-page font-semibold">{t`Collega un modello`}</h1>
          <p className="m-0 mt-3 text-reading text-muted-foreground">
            {t`È quello che fa pensare il tuo bot. Si prova subito, prima di salvare.`}
          </p>
        </div>
        <button
          type="button"
          data-testid="guide-back-providers"
          className="min-h-[44px] self-start rounded-control px-1.5 py-2 text-body font-semibold text-muted-foreground transition hover:text-foreground"
          onClick={() => setPanel('grid')}
        >
          ← <Trans>Altri provider</Trans>
        </button>
        <div className="flex flex-col gap-3 rounded-surface bg-card p-5" data-testid="guide-local-panel">
          <p className="m-0 text-body">
            <Trans>Scarico un modello adatto a questo Mac ({localSizeGb ?? '—'} GB). Gira tutto qui: niente costi, ma è più lento dei modelli cloud.</Trans>
          </p>
          <div className="h-2.5 overflow-hidden rounded-full bg-background">
            <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="flex items-center justify-between gap-3 text-small text-muted-foreground">
            <span data-testid="guide-local-label">
              {localState === 'ready' ? t`Scaricato e provato.` : localState === 'downloading' ? `${t`Scarico…`} ${pct}%` : t`Pronto a scaricare.`}
            </span>
            {localState === 'downloading' ? (
              <button
                type="button"
                data-testid="guide-local-cancel"
                className="min-h-[44px] rounded-surface bg-foreground px-4 py-2 text-body font-semibold text-background transition hover:opacity-90"
                onClick={() => { void api.localModelCancel().catch(() => undefined) }}
              >
                <Trans>Annulla</Trans>
              </button>
            ) : localState !== 'ready' ? (
              <button
                type="button"
                data-testid="guide-local-install"
                className="min-h-[44px] rounded-surface bg-foreground px-4 py-2 text-body font-semibold text-background transition hover:opacity-90"
                onClick={() => { void localInstall() }}
              >
                <Trans>Scarica</Trans>
              </button>
            ) : null}
          </span>
          {localInstallError && <p className="m-0 text-body text-destructive">{t`Non posso ora: controlla lo spazio e riprova.`}</p>}
          {localDownloadError !== null && (
            <p className="m-0 text-body text-destructive" data-testid="guide-local-download-error">
              {t`Il download del modello non è riuscito.`} {localDownloadError}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ---- l'elenco «Altri…» ----
  if (panel === 'others') {
    return (
      <div key="others" className="guide-stepin flex w-full max-w-xl flex-col gap-5 text-left" data-testid="guide-step-model">
        <div>
          <h1 className="m-0 font-display text-page font-semibold">{t`Collega un modello`}</h1>
          <p className="m-0 mt-3 text-reading text-muted-foreground">
            {t`È quello che fa pensare il tuo bot. Si prova subito, prima di salvare.`}
          </p>
        </div>
        <button
          type="button"
          data-testid="guide-back-providers"
          className="min-h-[44px] self-start rounded-control px-1.5 py-2 text-body font-semibold text-muted-foreground transition hover:text-foreground"
          onClick={() => setPanel('grid')}
        >
          ← <Trans>Altri provider</Trans>
        </button>
        <div className="overflow-hidden rounded-surface bg-card/60">
          {GUIDE_OTHER_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`guide-other-${k}`}
              className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-accent [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/40"
              onClick={() => setPanel(k)}
            >
              <ProviderMark kind={k} name={KIND_LABELS[k] ?? k} size="sm" />
              <span className="flex-1 text-body">{KIND_LABELS[k] ?? k}</span>
              {k === 'openai-compatible' && <span className="text-small text-muted-foreground">{t`chiede anche l'indirizzo`}</span>}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // ---- la griglia ----
  const cardDefs: Record<GuideProviderCardId, { label: string; desc: string; badge?: string; icon?: React.ReactNode }> = {
    anthropic: { label: 'Anthropic', desc: t`Claude. Il più affidabile coi tool.`, badge: t`consigliato` },
    openai: { label: 'OpenAI', desc: t`Con una chiave API.` },
    openrouter: { label: 'OpenRouter', desc: t`Molti modelli, una chiave.` },
    others: { label: t`Altri…`, desc: t`xAI, Mistral, DeepSeek, Groq, Z.ai e i compatibili OpenAI.`, icon: <MoreHorizontal className="size-5" /> },
    ollama: { label: 'Ollama', desc: t`Già sul tuo Mac.`, badge: t`trovato` },
    local: { label: t`Integrato`, desc: t`Gira tutto qui, senza costi.`, icon: <Cpu className="size-5" /> }
  }
  return (
    <div key="grid" className="guide-stepin flex w-full max-w-xl flex-col gap-8 text-left" data-testid="guide-step-model">
      <div>
        <h1 className="m-0 font-display text-page font-semibold">{t`Collega un modello`}</h1>
        <p className="m-0 mt-3 text-reading text-muted-foreground">
          {t`È quello che fa pensare il tuo bot. Si prova subito, prima di salvare.`}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {cards.map((c) => (
          <ProviderCard
            key={c}
            id={c}
            label={cardDefs[c].label}
            desc={cardDefs[c].desc}
            badge={cardDefs[c].badge}
            logoKind={c}
            icon={cardDefs[c].icon}
            onPick={() => setPanel(c === 'others' ? 'others' : c as ProviderKind)}
          />
        ))}
      </div>
    </div>
  )
}
