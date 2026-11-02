// Impostazioni (fase 16c, C2): un foglio grande con la colonna di sezioni a
// sinistra come nella tavola 5 — Generali · Modelli · App e skill ·
// Approvazioni · Cassaforte · Routine · Uso e costi. La scheda «Bot» sparisce
// (le impostazioni dei bot vivono nel pannello del bot, Avanzate, dalla 16b).
// Il meccanismo settingsTab (aprire una sezione precisa da un widget)
// continua a funzionare con i NUOVI id. Niente bordi: fondi tenui (bg-muted).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { X, ChevronDown, MoreHorizontal, Plus } from 'lucide-react'
import { api, useStore } from '../store'
import { formatDate, formatTime } from '../lib/i18n'
import type { UiLanguageSetting } from '../../../shared/ui-language'
import { describeTrigger } from '../../../shared/cron-human'
// fase 17c (C5/C6): lingua attiva per le descrizioni; fiducia e template dai codici
import { i18n } from '../lib/i18n'
import { VaultTab } from './VaultSettings'
import { choosePollTool, chooseQueryArgName } from '../../../shared/triggers'
import type { ProviderKind, ProviderPublic, ModelInfo, RoutineInfo, RoutineSuggestion, ConnectorInfo, McpServerInfo, RoutineTrigger, AutoReviewSettings, WebSearchStatusRpc, WebSearchProviderStatusRpc, FallbackRoute, ModelUsageRow, ModelPrice, ModelPriceMap, ThinkingSetting } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../../shared/types'
// fase 18b (K2): la selezione delle righe dell'editor dei prezzi (funzione pura)
import { priceEditorRows } from '../lib/price-editor'
// fase 10 (residuo 0d): i default per kind (modulo puro, nessuna dipendenza node)
import { modelDefaultsFor } from '../../../main/agent/model-defaults'
// fase 18b (K4): il tetto della catena delle riserve, lo stesso del daemon
import { MAX_CHAIN_ENTRIES } from '../../../main/agent/model-fallback'
// fase 16c (C3.4): i base URL noti e la prova «vale solo l'ultima»
import { KNOWN_BASE_URLS, isLocalKind } from '../../../main/agent/live-models'
// fase 16c correzioni (R5): il POSTO fisico di un provider (host, non kind) e
// la valuta nella lingua dell'interfaccia
import { providerPlace } from '../../../shared/network-host'
import { fmtUsd as fmtUsdIn } from '../lib/fmt'
import { nextModelProbe, EMPTY_MODEL_PROBE, type ModelProbeState } from '../lib/model-probe'
// fase 18b (H5.3): il selettore del modello a combobox
import { ModelPicker, THINKING_LABELS } from './ui/ModelPicker'
import type { UiTheme } from '../theme'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
// fase 16c (C4): la vista condivisa con la finestra «Collega app»
import { AppsView } from './AppsWindow'

/** Le sezioni con i nomi per la UI (fase 16c, C2 — tavola 5). */
const SECTION_LABELS: Record<string, MessageDescriptor> = {
  generale: msg`Generali`,
  modelli: msg`Modelli`,
  app: msg`App e skill`,
  approvazioni: msg`Approvazioni`,
  vault: msg`Cassaforte`,
  routine: msg`Routine`,
  uso: msg`Uso e costi`
}

/** La lingua attiva come UiLanguage (fase 17c, C6: descrizioni cron-human). */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

export function Settings() {
  const { i18n } = useLingui()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const pendingTab = useStore((s) => s.settingsTab)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const refreshPermissions = useStore((s) => s.refreshPermissions)
  const [tab, setTab] = useState<string>('generale')

  // fase 7: un widget può chiedere di aprire una sezione precisa (es. il
  // provider durante l'onboarding): lo si applica una volta e si consuma
  useEffect(() => {
    if (pendingTab) {
      setTab(pendingTab in SECTION_LABELS ? pendingTab : 'modelli')
      setSettingsTab(null)
    }
  }, [pendingTab, setSettingsTab])

  return (
    <Dialog open onOpenChange={(o) => !o && setSettingsOpen(false)}>
      <DialogContent className="flex h-[min(760px,calc(100vh-48px))] w-[min(1080px,calc(100vw-48px))] max-w-[min(1080px,calc(100vw-48px))] gap-0 p-0" showCloseButton={false}>
        <DialogTitle className="sr-only"><Trans>Impostazioni</Trans></DialogTitle>
        {/* fase 16c (C2): colonna di sezioni a sinistra, testo semplice,
            selezione su bg-muted, NESSUN bordo */}
        <nav className="w-52 shrink-0 space-y-0.5 overflow-y-auto scroll-thin p-3">
          <strong className="block px-3 pb-3 pt-1 font-display text-lg">{i18n._(msg`Impostazioni`)}</strong>
          {(Object.keys(SECTION_LABELS) as string[]).map((t) => (
            <button
              key={t}
              className={`w-full rounded-full px-3 py-2 text-left text-sm transition ${tab === t ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab(t)}
            >
              {i18n.t(SECTION_LABELS[t]!)}
            </button>
          ))}
        </nav>
        <div className="@container relative min-w-0 flex-1 overflow-y-auto scroll-thin">
          {/* la ✕ tonda in alto a destra (Esc chiude, come sempre nel Dialog) */}
          <button
            className="absolute right-5 top-4 z-10 grid size-9 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground"
            aria-label={i18n._(msg`Chiudi`)}
            onClick={() => setSettingsOpen(false)}
          >
            <X className="size-4" />
          </button>
          <div className="px-6 py-6">
            {tab === 'generale' && <GeneralTab />}
            {tab === 'modelli' && <ModelsTab onOpenUsage={() => setTab('uso')} />}
            {tab === 'app' && <AppsView />}
            {tab === 'approvazioni' && <ApprovalsTab onChanged={refreshPermissions} />}
            {tab === 'vault' && <VaultTab />}
            {tab === 'routine' && <RoutinesTab />}
            {tab === 'uso' && <UsageTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---- fase 16c (C3): la sezione Modelli (tavola 5) ----

/** L'inizio del mese corrente in ora locale (il costo «questo mese»). */
function monthStart(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

const KIND_LABELS: Partial<Record<ProviderKind, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  mistral: 'Mistral',
  zai: 'Z.ai',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  'openai-compatible': 'OpenAI-compatible'
}

/** Le pillole del «Con una chiave API»: le prime quattro visibili, il resto in «Altri ▾». */
const KEY_KINDS: ProviderKind[] = ['anthropic', 'openai', 'mistral', 'zai', 'openrouter', 'xai', 'deepseek', 'groq']

/** L'esito dell'ultimo providers:test per provider (C3.1). */
type TestOutcome = { ok: boolean; models?: ModelInfo[]; error?: string }

function ModelsTab({ onOpenUsage }: { onOpenUsage(): void }) {
  const { t } = useLingui()
  const providers = useStore((s) => s.providers)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const [tests, setTests] = useState<Record<string, TestOutcome>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [monthCost, setMonthCost] = useState<number | null>(null)
  // fase 16c correzioni (R5.2): il costo del mese PER PROVIDER — la stessa
  // aggregate 'model' (le righe portano providerId) si somma per provider
  const [providerCosts, setProviderCosts] = useState<Record<string, number>>({})
  const [editing, setEditing] = useState<ProviderPublic | null>(null)
  // R6.2: «+ Aggiungi un modello» aperto sotto «Collegati» (colonna singola)
  const [addOpen, setAddOpen] = useState(false)
  const { i18n } = useLingui()
  const locale = i18n.locale
  const usd = (n: number): string => fmtUsdIn(n, locale)

  // lo stato arriva dall'ultimo providers:test, rifatto all'apertura senza bloccare
  const runTests = (): void => {
    for (const p of providers) {
      if (!p.enabled) continue
      void api.testProvider(p.id)
        .then((r) => setTests((prev) => ({ ...prev, [p.id]: r })))
        .catch(() => setTests((prev) => ({ ...prev, [p.id]: { ok: false } })))
    }
  }
  useEffect(() => {
    runTests()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length])
  useEffect(() => {
    void api.usageSummary(monthStart(), undefined, 'model')
      .then((rows) => {
        setMonthCost(rows.reduce((a, r) => a + (r.costUsd ?? 0), 0))
        const byProvider: Record<string, number> = {}
        for (const r of rows) byProvider[r.providerId] = (byProvider[r.providerId] ?? 0) + (r.costUsd ?? 0)
        setProviderCosts(byProvider)
      })
      .catch(() => setMonthCost(null))
  }, [])
  const retry = (id: string): void => {
    setTesting(id)
    void api.testProvider(id)
      .then((r) => setTests((prev) => ({ ...prev, [id]: r })))
      .catch(() => setTests((prev) => ({ ...prev, [id]: { ok: false } })))
      .finally(() => setTesting(null))
  }

  return (
    <div className="space-y-6">
      <div className="pr-12">
        <h2 className="font-display text-2xl">{i18n._(msg`Modelli`)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <Trans>Il modello è il cervello dei bot. Ne basta uno; puoi cambiarlo quando vuoi.</Trans>
        </p>
      </div>

      {/* fase 16c correzioni (R6.2): le colonne si decidono dal CONTENUTO
          della sezione (@container): affiancate da 960 px, sotto una sola —
          in cima a «Collegati» il bottone «+ Aggiungi un modello» che apre le
          stesse tre strade QUI sotto e si richiude.
          FASE RILASCIO — CORREZIONI (K5): la soglia sale da 820 a 960 px di
          contenuto — a 1440 di finestra (contenuto 824) resta UNA colonna a
          tutta larghezza e nessuna etichetta scende sotto i 160 px; affiancate,
          la colonna sinistra non scende mai sotto 584 px (960 − 360 − spazi) */}
      <div className="flex flex-col gap-4 @[960px]:flex-row">
        <div className="min-w-0 flex-1 space-y-6">
          {/* C3.1 — Collegati */}
          <section>
            <p className="mb-1 text-[13px] text-muted-foreground"><Trans>Collegati</Trans></p>
            <button
              className="mb-2 flex w-full items-center gap-2 rounded-[14px] bg-muted/60 px-3 py-2 text-left text-sm transition hover:bg-muted @[960px]:hidden"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
            >
              <Plus className="size-4 shrink-0" />
              <span className="min-w-0 flex-1"><Trans>Aggiungi un modello</Trans></span>
              <ChevronDown className={`size-4 shrink-0 transition-transform ${addOpen ? 'rotate-180' : ''}`} />
            </button>
            {addOpen && (
              <div className="mb-3 @[960px]:hidden">
                <AddModelRail
                  onSaved={() => {
                    void refreshProviders()
                    runTests()
                  }}
                />
              </div>
            )}
            {providers.length === 0 && (
              <p className="py-3 text-sm text-muted-foreground"><Trans>Nessun modello collegato: comincia da qui sopra.</Trans></p>
            )}
            {providers.map((p) => {
              const outcome = tests[p.id]
              // fase 16c correzioni (R5.1): il posto lo decide l'HOST del
              // baseUrl (mac | rete | internet), non discovered né il kind
              const place = providerPlace(p)
              const modelsCount = outcome?.models?.length
              const cost = providerCosts[p.id]
              return (
                <div key={p.id} className="flex items-center gap-3.5 py-2.5" title={p.name}>
                  <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-muted text-base font-bold">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* R6.3: il nome su UNA riga, troncato con «…» (intero nel
                        title della riga); la mezza riga troncata su una riga */}
                    <span className="block truncate text-[15px]">{p.name}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">
                      {place === 'mac'
                        ? <Trans>Sul tuo Mac · {modelsCount ?? '…'} modelli · gratis e privato</Trans>
                        : place === 'rete'
                          // rete: i dati escono dal Mac — NON si dice «privato»
                          ? <Trans>Sulla tua rete · {modelsCount ?? '…'} modelli</Trans>
                          : p.hasKey
                            ? <Trans>Chiave API · a consumo{cost !== undefined ? ` · ${usd(cost)} ` : ''}{cost !== undefined ? <Trans>questo mese</Trans> : ''}</Trans>
                            : <Trans>Server esterno</Trans>}
                    </span>
                  </span>
                  {outcome === undefined ? (
                    <span className="shrink-0 text-[13px] text-muted-foreground">…</span>
                  ) : outcome.ok ? (
                    <span className="shrink-0 text-[14px] text-chart-2"><Trans>Collegato</Trans></span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[14px] text-destructive"><Trans>Non risponde</Trans></span>
                      <button className="rounded-full bg-muted px-2.5 py-1 text-xs transition hover:bg-accent" disabled={testing === p.id} onClick={() => retry(p.id)}>
                        {testing === p.id ? <Trans>Provo…</Trans> : p.hasKey ? <Trans>Riprova</Trans> : <Trans>Cambia chiave</Trans>}
                      </button>
                    </span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={t`Altre azioni`}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditing(p)}><Trans>Modifica</Trans></DropdownMenuItem>
                      <DropdownMenuItem onClick={() => retry(p.id)}><Trans>Prova</Trans></DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { void api.deleteProvider(p.id).then(() => refreshProviders()) }}>
                        <Trans>Rimuovi</Trans>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
            })}
          </section>

          {/* C3.2 — Chi usa cosa */}
          <section>
            <p className="mb-1 text-[13px] text-muted-foreground"><Trans>Chi usa cosa</Trans></p>
            {/* 1 · il cervello dei bot */}
            <MainModelRow />
            {/* 2 · se non risponde */}
            <div className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]"><Trans>Se non risponde</Trans></span>
                <span className="block text-[13px] text-muted-foreground"><Trans>Si passa da solo alla riserva</Trans></span>
              </span>
            </div>
            <FallbackChainSection />
            {/* 3 · revisione delle approvazioni */}
            <ReviewerModelRow />
          </section>

          <button className="text-sm text-primary transition hover:underline" onClick={onOpenUsage}>
            {/* R5.2: la riga in fondo resta il TOTALE del mese (tutti i provider) */}
            {monthCost !== null ? <Trans>Uso e costi: {usd(monthCost)} questo mese ›</Trans> : <Trans>Uso e costi ›</Trans>}
          </button>

          {/* fase 15 (S5): la ricerca web e i default per provider restano qui
              (Opzioni avanzate, chiuse: non si perde nessuna funzione) */}
          <details className="pt-2">
            <summary className="cursor-pointer text-[13px] text-muted-foreground transition hover:text-foreground"><Trans>Opzioni avanzate</Trans></summary>
            <div className="mt-2 space-y-3">
              <WebSearchSection />
              {providers.filter((p) => p.kind === 'ollama').map((p) => <WebSearchKeyRow key={p.id} p={p} />)}
              {providers.map((p) => <ModelDefaultsRow key={p.id} p={p} />)}
            </div>
          </details>
        </div>

        {/* C3.4 — Aggiungi un modello: colonna a destra da 960 px del
            contenuto (R6.2, K5); sotto, il bottone in cima a «Collegati» */}
        <div className="hidden shrink-0 @[960px]:block @[960px]:w-[360px]">
          <AddModelRail
            onSaved={() => {
              void refreshProviders()
              runTests()
            }}
          />
        </div>
      </div>

      {editing && (
        <EditProviderSheet
          provider={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void refreshProviders()
          }}
        />
      )}
    </div>
  )
}

/**
 * C3.2.1 — «Il cervello dei bot». Fase 16c correzioni (R6.4): UN solo
 * selettore «provider · modello» (niente più campo di testo libero), con le
 * voci di models:list di TUTTI i provider attivi e le capacità accanto
 * («vede · ragiona»); sotto, «Ragionamento» solo se il modello ha livelli.
 */
function MainModelRow() {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const mainModel = useStore((s) => s.mainModel)
  const setMainModel = useStore((s) => s.setMainModel)
  // i modelli di TUTTI i provider attivi (un selettore solo, nessun cambio
  // di provider a parte); chiave `providerId::modelId`
  const active = providers.filter((p) => p.enabled)
  const [byProvider, setByProvider] = useState<Record<string, ModelInfo[]>>({})
  useEffect(() => {
    let alive = true
    for (const p of active) {
      if (byProvider[p.id]) continue
      void api.listModels(p.id)
        .then((ms) => { if (alive) setByProvider((prev) => ({ ...prev, [p.id]: ms })) })
        .catch(() => { if (alive) setByProvider((prev) => ({ ...prev, [p.id]: [] })) })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])
  /** le capacità accanto al nome del modello («vede · ragiona») */
  const capsOf = (m: ModelInfo): string => {
    const caps: string[] = []
    if (m.vision === true) caps.push(i18n._(msg`vede`))
    if (m.thinkingLevels.length > 0) caps.push(i18n._(msg`ragiona`))
    return caps.length ? ` · ${caps.join(' · ')}` : ''
  }
  const entries = active.flatMap((p) =>
    (byProvider[p.id] ?? []).map((m) => ({ key: `${p.id}::${m.id}`, p, m }))
  )
  const value = mainModel?.providerId && mainModel.model ? `${mainModel.providerId}::${mainModel.model}` : ''
  const chosen = entries.find((e) => e.key === value)
  const levels = chosen?.m.thinkingLevels ?? []
  const providerName = (id: string): string => providers.find((p) => p.id === id)?.name ?? id
  return (
    // K5 (fase rilascio — correzioni): l'etichetta STA SOPRA e i controlli
    // sotto, a tutta larghezza — mai più il selettore che schiaccia il testo
    // fino a una parola per riga
    <div className="py-2.5">
      <span className="block text-[15px]"><Trans>Il cervello dei bot</Trans></span>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <select
          className="h-9 min-w-0 flex-1 basis-52 truncate rounded-full bg-muted px-3 text-sm outline-none"
          value={value}
          aria-label={t`Provider e modello`}
          onChange={(e) => {
            if (!e.target.value) {
              void setMainModel(null)
              return
            }
            const [providerId, modelId] = e.target.value.split('::')
            void setMainModel({ providerId: providerId ?? '', model: modelId ?? '', thinking: null })
          }}
        >
          <option value="">{t`— provider · modello —`}</option>
          {/* il valore attuale resta scegliibile anche mentre models:list
              carica (o se il provider non risponde) */}
          {value && !chosen && mainModel && (
            <option value={value}>{`${providerName(mainModel.providerId)} · ${mainModel.model}`}</option>
          )}
          {entries.map((e) => (
            <option key={e.key} value={e.key}>{`${e.p.name} · ${e.m.label ?? e.m.id}${capsOf(e.m)}`}</option>
          ))}
        </select>
        {levels.length > 0 && (
          <select
            className="h-9 shrink-0 rounded-full bg-muted px-3 text-xs outline-none"
            aria-label={t`Ragionamento`}
            value={levels.includes((mainModel?.thinking ?? 'default') as ThinkingSetting) ? mainModel?.thinking ?? 'default' : 'default'}
            onChange={(e) => mainModel && void setMainModel({ ...mainModel, thinking: e.target.value as ThinkingSetting })}
          >
            {(['default', ...levels] as ThinkingSetting[]).map((l) => (
              <option key={l} value={l}>{i18n.t(THINKING_LABELS[l] ?? msg`${l}`)}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

/** C3.2.3 — «Revisione delle approvazioni»: il modello del revisore (le regole stanno in Approvazioni). */
function ReviewerModelRow() {
  const { t } = useLingui()
  const providers = useStore((s) => s.providers)
  const [cfg, setCfg] = useState<AutoReviewSettings | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  useEffect(() => {
    void api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).then(setCfg)
  }, [])
  useEffect(() => {
    if (cfg?.providerId) void api.listModels(cfg.providerId).then(setModels).catch(() => setModels([]))
    else setModels([])
  }, [cfg?.providerId])
  if (!cfg) return null
  const save = (next: AutoReviewSettings): void => {
    setCfg(next)
    void api.settingsSet('autoReview', next)
  }
  return (
    // K5 (fase rilascio — correzioni): etichetta e descrizione SOPRA, controlli
    // sotto a tutta larghezza; provider e modello su UNA riga di due colonne
    // (minmax(0,1fr) ciascuna) che sotto i 420 px di contenuto si impilano
    <div className="py-2.5">
      <span className="block text-[15px]"><Trans>Revisione delle approvazioni</Trans></span>
      <span className="block text-[13px] text-muted-foreground"><Trans>Un modello piccolo che decide le richieste semplici</Trans></span>
      <div className="mt-2 grid grid-cols-1 gap-2 @[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <select
          className="h-9 min-w-0 truncate rounded-full bg-muted px-3 text-sm outline-none"
          value={cfg.providerId ?? ''}
          aria-label={t`Provider`}
          onChange={(e) => save({ ...cfg, providerId: e.target.value || null, model: null })}
        >
          <option value="">{t`— provider —`}</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <ModelPicker
          className="min-w-0"
          models={models}
          value={cfg.model}
          placeholder={t`Modello (vuoto: quello del provider)`}
          disabled={!cfg.providerId}
          onChange={(m) => save({ ...cfg, model: m })}
        />
      </div>
    </div>
  )
}

/** C3.1 — il foglio Modifica: nome, base URL, chiave «•••• a1b2 · cambia», mai il valore. */
function EditProviderSheet({ provider, onClose, onSaved }: { provider: ProviderPublic; onClose(): void; onSaved(): void }) {
  const { t } = useLingui()
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // fase 16c correzioni (R2.3): la prova nel foglio «Modifica» — se l'utente
  // cambia l'indirizzo senza ridigitare la chiave, la prova usa quella GIÀ
  // SALVATA del provider (providerId: la chiave non torna mai indietro)
  const [probe, setProbe] = useState<ModelProbeState>(EMPTY_MODEL_PROBE)
  const probeRevision = useRef(0)
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (probeTimer.current) clearTimeout(probeTimer.current)
    const url = baseUrl.trim()
    if (!/^https?:\/\//.test(url)) { setProbe(EMPTY_MODEL_PROBE); return }
    probeTimer.current = setTimeout(() => {
      const revision = ++probeRevision.current
      setProbe((s) => nextModelProbe(s, { type: 'start', revision }, probeRevision.current))
      void api.probeProvider({
        kind: provider.kind,
        baseUrl: url,
        providerId: provider.id,
        ...(key.trim() ? { apiKey: key.trim() } : {})
      })
        .then((r) => setProbe((s) => nextModelProbe(
          s,
          r.ok
            ? { type: 'result', revision, ok: true, models: r.models ?? [] }
            : { type: 'result', revision, ok: false, error: r.error ?? 'error' },
          probeRevision.current
        )))
        .catch(() => setProbe((s) => nextModelProbe(s, { type: 'result', revision, ok: false, error: 'unreachable' }, probeRevision.current)))
    }, 400)
    return () => { if (probeTimer.current) clearTimeout(probeTimer.current) }
  }, [baseUrl, key, provider.id, provider.kind])
  const probeErrorText = (code: string): string =>
    code === 'invalid-key' ? t`La chiave non è valida`
      : code === 'unreachable' ? t`Il servizio non risponde`
        : t`La prova non è riuscita`
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <strong className="block font-display text-lg">{provider.name}</strong>
        <input className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none" placeholder={t`Nome`} value={name} onChange={(e) => setName(e.target.value)} />
        <div>
          <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => setShowAdvanced((v) => !v)}>
            <Trans>Avanzate</Trans> <ChevronDown className={`inline size-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
          </button>
          {showAdvanced && (
            <input className="mt-1.5 w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none" placeholder={t`Base URL`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          )}
        </div>
        {/* R2.3: l'esito della prova (con la chiave salvata se non se ne digita una nuova) */}
        {probe.probing && <p className="text-[13px] text-muted-foreground"><Trans>Provo l'indirizzo…</Trans></p>}
        {probe.ok === true && (
          <p className="text-[14px] text-chart-2"><Trans>✓ Funziona · {probe.models.length} modelli disponibili</Trans></p>
        )}
        {probe.ok === false && <p className="text-[14px] text-destructive">{probeErrorText(probe.error ?? 'error')}</p>}
        {/* C1: la chiave non si rilegge MAI — solo il suggerimento «•••• a1b2» */}
        {provider.hasKey ? (
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">
              {key ? <Trans>Chiave nuova</Trans> : <Trans>•••• {provider.keyHint ?? ''}</Trans>}{' '}
              {!key && (
                <button className="text-primary transition hover:underline" onClick={() => setKey(' ')}>
                  <Trans>cambia</Trans>
                </button>
              )}
            </p>
            {key && (
              <input
                className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
                type="password"
                placeholder={t`Nuova chiave API`}
                value={key.trim() ? key : ''}
                onChange={(e) => setKey(e.target.value)}
              />
            )}
          </div>
        ) : (
          <input
            className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
            type="password"
            placeholder={t`Chiave API (opzionale)`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        )}
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            <Trans>Annulla</Trans>
          </button>
          <button
            className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
            disabled={busy || !name.trim()}
            onClick={() => {
              setBusy(true)
              setErr('')
              api.saveProvider({
                id: provider.id,
                name: name.trim(),
                kind: provider.kind,
                baseUrl: baseUrl.trim(),
                enabled: provider.enabled,
                ...(key.trim() ? { apiKey: key.trim() } : {})
              })
                .then(onSaved)
                .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false))
            }}
          >
            <Trans>Salva</Trans>
          </button>
        </div>
      </div>
    </div>
  )
}

/** C3.4 — la colonna «Aggiungi un modello»: sul Mac, con una chiave, un altro server. */
function AddModelRail({ onSaved }: { onSaved(): void }) {
  const { t, i18n } = useLingui()
  const [mode, setMode] = useState<'mac' | 'key' | 'server'>('mac')
  // — sul Mac —
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<ProviderPublic[] | null>(null)
  // fase 16c correzioni (R1): la scansione fallita si vede (non è «vuoto»)
  const [scanError, setScanError] = useState(false)
  // — chiave API / altro server —
  const [kind, setKind] = useState<ProviderKind>('anthropic')
  const [showOtherKinds, setShowOtherKinds] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [probe, setProbe] = useState<ModelProbeState>(EMPTY_MODEL_PROBE)
  const probeRevision = useRef(0)
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const probeErrorText = (code: string): string =>
    code === 'invalid-key' ? t`La chiave non è valida`
      : code === 'unreachable' ? t`Il servizio non risponde`
        : t`La prova non è riuscita`

  /** La prova parte DA SOLA appena la chiave cambia (debounce 400 ms); vale solo l'ultima. */
  const scheduleProbe = (nextKey: string, url: string): void => {
    if (probeTimer.current) clearTimeout(probeTimer.current)
    setProbe(EMPTY_MODEL_PROBE)
    if (!url.trim()) return
    probeTimer.current = setTimeout(() => {
      const revision = ++probeRevision.current
      setProbe((s) => nextModelProbe(s, { type: 'start', revision }, probeRevision.current))
      void api.probeProvider({ kind, baseUrl: url.trim(), ...(nextKey.trim() ? { apiKey: nextKey.trim() } : {}) })
        .then((r) => setProbe((s) => nextModelProbe(
          s,
          r.ok
            ? { type: 'result', revision, ok: true, models: r.models ?? [] }
            : { type: 'result', revision, ok: false, error: r.error ?? 'error' },
          probeRevision.current
        )))
        .catch(() => setProbe((s) => nextModelProbe(s, { type: 'result', revision, ok: false, error: 'unreachable' }, probeRevision.current)))
    }, 400)
  }

  const effectiveBaseUrl = mode === 'key'
    ? (baseUrl || KNOWN_BASE_URLS[kind] || '')
    : baseUrl
  const railButton = (id: typeof mode, title: MessageDescriptor, sub: MessageDescriptor): ReactNode => (
    <button
      role="radio"
      aria-checked={mode === id}
      className={`rounded-2xl px-3.5 py-3 text-left transition ${mode === id ? 'bg-card shadow-soft' : 'hover:bg-card/60'}`}
      onClick={() => { setMode(id); setProbe(EMPTY_MODEL_PROBE); setApiKey(''); setBaseUrl(''); setFound(null) }}
    >
      <span className={`block text-sm ${mode === id ? 'font-semibold' : ''}`}>{i18n.t(title)}</span>
      <span className="block text-[13px] text-muted-foreground">{i18n.t(sub)}</span>
    </button>
  )

  const connect = async (): Promise<void> => {
    const name = mode === 'server' ? (serverName.trim() || 'Server') : (KIND_LABELS[kind] ?? String(kind))
    await api.saveProvider({
      id: `${mode === 'server' ? 'custom' : kind}_${Date.now()}`,
      name,
      kind: mode === 'server' ? 'openai-compatible' : kind,
      baseUrl: effectiveBaseUrl.trim(),
      enabled: true,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    })
    setApiKey('')
    setProbe(EMPTY_MODEL_PROBE)
    onSaved()
  }

  return (
    <div className="w-full shrink-0 space-y-3 rounded-3xl bg-muted p-5">
      <strong><Trans>Aggiungi un modello</Trans></strong>
      <div role="radiogroup" aria-label={t`Come`} className="flex flex-col gap-1">
        {railButton('mac', msg`Sul tuo Mac`, msg`Ollama, LM Studio · gratis, nessun dato esce`)}
        {railButton('key', msg`Con una chiave API`, msg`Anthropic, OpenAI, Mistral, Z.ai…`)}
        {railButton('server', msg`Un altro server`, msg`Qualsiasi servizio compatibile OpenAI`)}
      </div>

      {mode === 'mac' && (
        <div className="space-y-2">
          <button
            className="w-full rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
            disabled={scanning}
            onClick={() => {
              setScanning(true)
              setFound(null)
              setScanError(false)
              void api.discoverProviders()
                .then((list) => setFound(list.filter((p) => p.discovered)))
                .catch(() => setScanError(true))
                .finally(() => setScanning(false))
            }}
          >
            {scanning ? <Trans>Cerco…</Trans> : <Trans>Cerca sul Mac</Trans>}
          </button>
          {/* fase 16c correzioni (R1): un RPC fallito non è «non ho trovato
              niente» — riga d'errore in parole, il Riprova è il bottone stesso */}
          {scanError && (
            <p className="text-[13px] text-muted-foreground"><Trans>Non riesco a cercare sul Mac: riprova.</Trans></p>
          )}
          {found !== null && (found.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {found.map((p) => <li key={p.id} className="rounded-xl bg-card px-3 py-1.5">{p.name}</li>)}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              <Trans>Non ho trovato Ollama né LM Studio. Aprili e riprova.</Trans>{' '}
              <a className="text-primary hover:underline" href="https://ollama.com" target="_blank" rel="noreferrer">{'ollama.com'}</a>
            </p>
          ))}
        </div>
      )}

      {mode === 'key' && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {KEY_KINDS.slice(0, 4).map((k) => (
              <button
                key={k}
                className={`h-8 rounded-full px-3 text-[13px] transition ${kind === k ? 'bg-foreground text-background' : 'bg-card hover:bg-card/80'}`}
                onClick={() => { setKind(k); setBaseUrl(''); setProbe(EMPTY_MODEL_PROBE) }}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
            <div className="relative">
              <button
                className={`h-8 rounded-full px-3 text-[13px] transition ${KEY_KINDS.slice(4).includes(kind) ? 'bg-foreground text-background' : 'bg-card hover:bg-card/80'}`}
                onClick={() => setShowOtherKinds((v) => !v)}
              >
                <Trans>Altri</Trans> <ChevronDown className="inline size-3" />
              </button>
              {showOtherKinds && (
                <div className="absolute left-0 top-9 z-10 overflow-hidden rounded-xl bg-card py-1 shadow-soft">
                  {KEY_KINDS.slice(4).map((k) => (
                    <button
                      key={k}
                      className={`block w-full px-4 py-1.5 text-left text-[13px] transition hover:bg-muted ${kind === k ? 'font-semibold' : ''}`}
                      onClick={() => { setKind(k); setBaseUrl(''); setShowOtherKinds(false); setProbe(EMPTY_MODEL_PROBE) }}
                    >
                      {KIND_LABELS[k]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <ModelKeyFields
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            baseUrl={baseUrl}
            setBaseUrl={(v) => { setBaseUrl(v); scheduleProbe(apiKey, v || KNOWN_BASE_URLS[kind] || '') }}
            effectiveBaseUrl={effectiveBaseUrl}
            apiKey={apiKey}
            setApiKey={(v) => { setApiKey(v); scheduleProbe(v, effectiveBaseUrl) }}
            probe={probe}
            probeErrorText={probeErrorText}
          />
          <p className="text-xs text-muted-foreground"><Trans>La chiave resta nel Portachiavi del Mac.</Trans></p>
          <button
            className="w-full rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
            disabled={!probe.ok || !effectiveBaseUrl.trim()}
            onClick={() => void connect()}
          >
            <Trans>Collega {KIND_LABELS[kind]}</Trans>
          </button>
        </div>
      )}

      {mode === 'server' && (
        <div className="space-y-2.5">
          <input
            className="w-full rounded-[12px] bg-card px-3 py-2 text-sm outline-none"
            placeholder={t`Nome (es. Il mio gateway)`}
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
          />
          <ModelKeyFields
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            baseUrl={baseUrl}
            setBaseUrl={(v) => { setBaseUrl(v); scheduleProbe(apiKey, v) }}
            effectiveBaseUrl={effectiveBaseUrl}
            apiKey={apiKey}
            setApiKey={(v) => { setApiKey(v); scheduleProbe(v, effectiveBaseUrl) }}
            probe={probe}
            probeErrorText={probeErrorText}
            urlPlaceholder={t`Indirizzo (es. http://127.0.0.1:8000/v1)`}
            keyPlaceholder={t`Chiave (facoltativa)`}
          />
          <p className="text-xs text-muted-foreground"><Trans>La chiave resta nel Portachiavi del Mac.</Trans></p>
          <button
            className="w-full rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
            disabled={!probe.ok || !serverName.trim() || !effectiveBaseUrl.trim()}
            onClick={() => void connect()}
          >
            <Trans>Collega {serverName.trim() || t`il server`}</Trans>
          </button>
        </div>
      )}
    </div>
  )
}

/** I campi condivisi da «Con una chiave API» e «Un altro server» (URL sotto Avanzate, chiave, esito). */
function ModelKeyFields(props: {
  showAdvanced: boolean
  setShowAdvanced(v: boolean): void
  baseUrl: string
  setBaseUrl(v: string): void
  effectiveBaseUrl: string
  apiKey: string
  setApiKey(v: string): void
  probe: ModelProbeState
  probeErrorText(code: string): string
  urlPlaceholder?: string
  keyPlaceholder?: string
}): ReactNode {
  const { t } = useLingui()
  return (
    <>
      <div>
        <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => props.setShowAdvanced(!props.showAdvanced)}>
          <Trans>Avanzate</Trans> <ChevronDown className={`inline size-3 transition-transform ${props.showAdvanced ? 'rotate-180' : ''}`} />
        </button>
        {props.showAdvanced && (
          <input
            className="mt-1.5 w-full rounded-[12px] bg-card px-3 py-2 text-sm outline-none"
            placeholder={props.urlPlaceholder ?? t`Base URL`}
            value={props.baseUrl}
            onChange={(e) => props.setBaseUrl(e.target.value)}
          />
        )}
      </div>
      <label className="block text-[13px] text-muted-foreground" htmlFor="sandbot-api-key"><Trans>Incolla la chiave</Trans></label>
      <input
        id="sandbot-api-key"
        className="h-10 w-full rounded-[12px] bg-card px-3 py-2 text-sm outline-none"
        type="password"
        placeholder={props.keyPlaceholder ?? t`sk-…`}
        value={props.apiKey}
        onChange={(e) => props.setApiKey(e.target.value)}
      />
      {props.probe.probing && <p className="text-[13px] text-muted-foreground"><Trans>Provo la chiave…</Trans></p>}
      {props.probe.ok === true && (
        <p className="text-[14px] text-chart-2">
          <Trans>✓ Funziona · {props.probe.models.length} modelli disponibili</Trans>
        </p>
      )}
      {props.probe.ok === false && (
        <p className="text-[14px] text-destructive">{props.probeErrorText(props.probe.error ?? 'error')}</p>
      )}
    </>
  )
}

// ---- fase 9/15/11: le opzioni avanzate dei modelli (default per provider e
// ricerca web) — non si perde nessuna funzione della 15 ----

interface ModelOverrides { defaultModel?: string; fallbackModel?: string; autoReviewModel?: string }

/**
 * I tre modelli configurabili per provider: il predefinito va ai bot nuovi
 * (onboarding e template), la riserva rileva i turni quando il principale non
 * risponde, il revisore giudica le approvazioni automatiche. Salvati nel
 * setting 'providers.modelDefaults' (chiave = id del provider).
 */
function ModelDefaultsRow({ p }: { p: ProviderPublic }) {
  const { t } = useLingui()
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [saved, setSaved] = useState<ModelOverrides>({})

  useEffect(() => {
    void api.settingsGet<Record<string, ModelOverrides> | undefined>('providers.modelDefaults', undefined)
      .then((all) => setSaved(all?.[p.id] ?? {}))
      .catch(() => setSaved({}))
    void api.listModels(p.id).then(setModels).catch(() => setModels([]))
  }, [p.id])

  const save = async (patch: ModelOverrides): Promise<void> => {
    const next = { ...saved, ...patch }
    setSaved(next)
    const all = await api.settingsGet<Record<string, ModelOverrides>>('providers.modelDefaults', {})
    await api.settingsSet('providers.modelDefaults', { ...all, [p.id]: next })
  }

  const effective = modelDefaultsFor(p)
  const effLabel = (role: keyof ModelOverrides, fallback: string): string => {
    const eff = effective[role]
    return eff ? t`${fallback}: ${eff}` : t`${fallback}…`
  }
  const picker = (role: keyof ModelOverrides, label: string): ReactNode => (
    <ModelPicker
      className="min-w-44"
      models={models ?? []}
      value={saved[role] ?? ''}
      placeholder={saved[role] ? label : effLabel(role, label)}
      onChange={(m) => void save({ [role]: m ?? undefined } as ModelOverrides)}
    />
  )

  if (models === null) return <div className="text-xs text-muted-foreground"><Trans>modelli…</Trans></div>
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-muted px-3 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{p.name}</span>
      {picker('defaultModel', t`predefinito`)}
      {picker('fallbackModel', t`riserva`)}
      {picker('autoReviewModel', t`auto-review`)}
    </div>
  )
}

/**
 * Fase 11 (punto 2): campo «chiave per la ricerca web» del provider Ollama.
 * Il valore va SOLO nel vault sigillato: la UI non lo rilegge mai.
 */
function WebSearchKeyRow({ p }: { p: ProviderPublic }) {
  const { t } = useLingui()
  const [set, setSet] = useState<boolean | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.webSearchKeySet(p.id).then(setSet).catch(() => setSet(null))
  }, [p.id])

  const save = async (key: string | null): Promise<void> => {
    setBusy(true)
    try {
      await api.setWebSearchKey(p.id, key)
      setSet(await api.webSearchKeySet(p.id))
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-muted px-3 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>ricerca web</Trans></span>
      <input
        className="w-56 rounded-lg bg-card px-2 py-1.5 text-xs outline-none"
        type="password"
        placeholder={set ? t`chiave salvata (scrivi per sostituirla)` : t`chiave per la ricerca web di Ollama`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className="rounded-full bg-card px-2.5 py-1.5 text-xs transition hover:bg-card/80 disabled:opacity-50"
        disabled={busy || !value.trim()}
        onClick={() => void save(value.trim())}
      >
        <Trans>Salva chiave</Trans>
      </button>
      {set && (
        <button
          className="rounded-full px-2.5 py-1.5 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          disabled={busy}
          onClick={() => void save(null)}
        >
          <Trans>Rimuovi</Trans>
        </button>
      )}
      <span className={`text-xs ${set ? 'text-chart-2' : 'text-muted-foreground'}`}>
        {set === null ? '' : set ? t`ricerca web attiva (chiave nel vault)` : t`ricerca web non attiva`}
      </span>
    </div>
  )
}

/**
 * Fase 15 (S5): sezione «Ricerca web» — l'interruttore dei servizi senza
 * chiave (You.com, Exa, Tavily), la nota sulla privacy e lo stato per provider.
 */
function WebSearchSection() {
  const { t } = useLingui()
  const [keyless, setKeyless] = useState<boolean | null>(null)
  const [status, setStatus] = useState<WebSearchStatusRpc | null>(null)

  const refresh = () => {
    void api.settingsGet<boolean>('webSearch.keyless', true).then(setKeyless).catch(() => setKeyless(null))
    void api.webSearchStatus().then(setStatus).catch(() => setStatus(null))
  }
  useEffect(refresh, [])

  const toggle = async (v: boolean): Promise<void> => {
    setKeyless(v)
    await api.settingsSet('webSearch.keyless', v)
    refresh()
  }

  const stateOf = (p: WebSearchProviderStatusRpc): { text: string; cls: string } => {
    if (p.cooldownUntil) {
      return {
        text: t`in raffreddamento fino a ${formatTime(p.cooldownUntil)}`,
        cls: 'text-destructive'
      }
    }
    if (p.lastError) {
      return { text: t`ultimo errore: ${p.lastError.kind}${p.lastError.status !== undefined ? t` (HTTP ${p.lastError.status})` : ''}`, cls: 'text-muted-foreground' }
    }
    return { text: t`disponibile`, cls: 'text-chart-2' }
  }

  return (
    <div className="rounded-2xl bg-muted px-3 py-2.5">
      <div className="text-sm"><Trans>Ricerca web</Trans></div>
      <label className="mt-2 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-foreground"
          checked={keyless ?? true}
          disabled={keyless === null}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="space-y-1">
          <span className="block text-xs">
            <Trans>Usa i servizi di ricerca gratuiti senza chiave (You.com, Exa, Tavily)</Trans>
          </span>
          <span className="block text-xs text-muted-foreground">
            <Trans>Le ricerche dei bot vengono inviate a questi servizi, secondo i loro termini d&apos;uso: <a className="text-primary hover:underline" href="https://you.com/acceptable-use-policy-may-2026" target="_blank" rel="noreferrer">You.com</a>{' · '}<a className="text-primary hover:underline" href="https://exa.ai/terms" target="_blank" rel="noreferrer">Exa</a>{' · '}<a className="text-primary hover:underline" href="https://docs.tavily.com/documentation/keyless" target="_blank" rel="noreferrer">Tavily</a></Trans>
          </span>
        </span>
      </label>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {(status?.providers ?? []).map((p) => (
          <span key={p.name} className={`text-xs ${stateOf(p).cls}`}>
            {p.label}: {stateOf(p).text}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---- fase 16c (C2): Approvazioni = permessi + regole (il modello del
// revisore sta in Modelli, C3.2) ----

function ApprovalsTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t, i18n } = useLingui()
  const permissions = useStore((s) => s.permissions)
  const prefill = useStore((s) => s.autoreviewPrefill)
  const [cfg, setCfg] = useState<AutoReviewSettings | null>(null)
  const [newAllow, setNewAllow] = useState('')
  const [newBlock, setNewBlock] = useState('')

  useEffect(() => {
    void api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).then(setCfg)
  }, [])
  useEffect(() => {
    if (prefill) {
      setNewAllow(prefill)
      useStore.setState({ autoreviewPrefill: null })
    }
  }, [prefill])
  if (!permissions || !cfg) return <p className="text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>

  const save = (next: AutoReviewSettings): void => {
    setCfg(next)
    void api.settingsSet('autoReview', next)
  }
  const inputCls = 'flex-1 rounded-lg bg-muted px-2 py-1.5 text-xs outline-none'

  const RuleList = ({ title, hint, rules, onAdd, onRemove, value, setValue }: {
    title: MessageDescriptor
    hint: MessageDescriptor
    rules: string[]
    onAdd(): void
    onRemove(i: number): void
    value: string
    setValue(v: string): void
  }) => (
    <div className="rounded-2xl bg-muted px-3 py-2.5">
      <div className="text-sm">{i18n.t(title)}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{i18n.t(hint)}</div>
      <ul className="mt-2 space-y-1">
        {rules.length === 0 && <li className="text-xs text-muted-foreground"><Trans>(nessuna regola)</Trans></li>}
        {rules.map((r, i) => (
          <li key={`${r}-${i}`} className="flex items-start gap-2 text-xs">
            <span className="flex-1">{r}</span>
            <button className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onRemove(i)}>✕</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          className={inputCls}
          placeholder={t`es. comandi ls e cat dentro la home del bot`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { onAdd(); setValue('') } }}
        />
        <button
          className="rounded-full bg-card px-3 py-1.5 text-xs transition hover:bg-card/80 disabled:opacity-40"
          disabled={!value.trim()}
          onClick={() => { onAdd(); setValue('') }}
        >
          <Trans>Aggiungi</Trans>
        </button>
      </div>
    </div>
  )

  return (
    <div className="space-y-3">
      <p className="pr-12 text-xs text-muted-foreground">
        <Trans>Regole per tool: consenti sempre / chiedi / blocca. «Consenti sempre» nelle card salva una standing grant.</Trans>
      </p>
      <div className="rounded-2xl bg-muted px-4 py-3">
        <label className="flex items-center justify-between text-sm">
          <span><Trans>Politica predefinita</Trans></span>
          <select
            className="rounded-full bg-card px-2.5 py-1.5 text-sm outline-none"
            value={permissions.default}
            onChange={async (e) => {
              await api.setPermissions({ ...permissions, default: e.target.value as typeof permissions.default })
              await onChanged()
            }}
          >
            <option value="always_allow">{t`Consenti sempre`}</option>
            <option value="needs_approval">{t`Chiedi approvazione`}</option>
            <option value="blocked">{t`Blocca`}</option>
          </select>
        </label>
      </div>
      {permissions.rules.map((r, i) => (
        <div key={i} className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2.5">
          <span className="w-36 font-mono text-xs">{r.tool}</span>
          <span className="w-24 font-mono text-xs text-muted-foreground">{r.pattern}</span>
          <div className="flex-1" />
          <select
            className="rounded-full bg-card px-2.5 py-1.5 text-xs outline-none"
            value={r.mode}
            onChange={async (e) => {
              const rules = [...permissions.rules]
              rules[i] = { ...r, mode: e.target.value as typeof r.mode }
              await api.setPermissions({ ...permissions, rules })
              await onChanged()
            }}
          >
            <option value="always_allow">{t`Consenti sempre`}</option>
            <option value="needs_approval">{t`Chiedi approvazione`}</option>
            <option value="blocked">{t`Blocca`}</option>
          </select>
        </div>
      ))}

      <h3 className="pt-3 font-display text-lg"><Trans>Auto-revisione delle approvazioni</Trans></h3>
      <p className="text-xs text-muted-foreground">
        <Trans>Un modello piccolo rivede le azioni che chiedono approvazione secondo queste regole e può lasciarle passare da solo. Sta dopo il gate dei permessi e non cambia mai i divieti: le azioni che modificano il comportamento futuro del bot, i comandi che eseguono altri comandi e i turni aperti da altri bot o da eventi esterni chiedono comunque.</Trans>
      </p>
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-muted px-4 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-foreground"
          checked={cfg.enabled}
          onChange={(e) => save({ ...cfg, enabled: e.target.checked })}
        />
        <span>
          <span className="block text-sm"><Trans>Approvazione automatica</Trans></span>
          <span className="block text-xs text-muted-foreground"><Trans>Al massimo 20 azioni approvate per turno; un dubbio del revisore diventa sempre una card.</Trans></span>
        </span>
      </label>
      <p className="text-xs text-muted-foreground"><Trans>Il modello del revisore si sceglie in Modelli › Revisione delle approvazioni.</Trans></p>
      <RuleList
        title={msg`⚡ Continua da solo quando l'azione rispetta queste regole`}
        hint={msg`Se una regola corrisponde (e nessuna regola di fermata), il revisore può approvare l'azione o l'invio della bozza.`}
        rules={cfg.allowRules}
        value={newAllow}
        setValue={setNewAllow}
        onAdd={() => save({ ...cfg, allowRules: [...cfg.allowRules, newAllow.trim()] })}
        onRemove={(i) => save({ ...cfg, allowRules: cfg.allowRules.filter((_, j) => j !== i) })}
      />
      <RuleList
        title={msg`⛔ Fermati e chiedimi sempre quando…`}
        hint={msg`Una di queste regole vince sempre sulle altre: l'azione diventa una card.`}
        rules={cfg.blockRules}
        value={newBlock}
        setValue={setNewBlock}
        onAdd={() => save({ ...cfg, blockRules: [...cfg.blockRules, newBlock.trim()] })}
        onRemove={(i) => save({ ...cfg, blockRules: cfg.blockRules.filter((_, j) => j !== i) })}
      />
    </div>
  )
}

// ---- fase 18b (H6.2): la pagina Uso e costi (stile 16c: fondi, niente bordi) ----

/** Le finestre del periodo, calcolate in ora LOCALE nel renderer. */
type UsagePeriod = 'today' | '7d' | '30d' | 'month'

const PERIOD_LABELS: Record<UsagePeriod, MessageDescriptor> = {
  today: msg`Oggi`,
  '7d': msg`7 giorni`,
  '30d': msg`30 giorni`,
  month: msg`Questo mese`
}

/** L'inizio locale del periodo (ms epoch). */
function periodStart(p: UsagePeriod): number {
  const now = new Date()
  if (p === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (p === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return now.getTime() - (p === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000
}

/** Le etichette delle origini delle chiamate (le `source` di model_usage). */
const SOURCE_LABELS: Record<string, MessageDescriptor> = {
  turn: msg`turno`,
  group: msg`gruppo`,
  subagent: msg`sottoagente`,
  wake: msg`wake`,
  review: msg`review`,
  compaction: msg`compaction`,
  'quick-ask': msg`quick ask`,
  'routine-suggest': msg`suggerimento routine`
}

function UsageTab() {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const [period, setPeriod] = useState<UsagePeriod>('7d')
  const [view, setView] = useState<'model' | 'agent' | 'source'>('model')
  const [rows, setRows] = useState<ModelUsageRow[]>([])
  const [modelRows, setModelRows] = useState<ModelUsageRow[]>([])
  const [prices, setPrices] = useState<ModelPriceMap>({})
  const [loaded, setLoaded] = useState(false)

  const refresh = () => {
    const from = periodStart(period)
    setLoaded(false)
    void api.usageSummary(from, undefined, view).then((r) => { setRows(r); setLoaded(true) }).catch(() => { setRows([]); setLoaded(true) })
    // i prezzi personalizzati si propongono sui modelli del periodo (H6.2):
    // serve la vista per modello anche quando la tabella è su un'altra
    void api.usageSummary(from, undefined, 'model').then(setModelRows).catch(() => setModelRows([]))
    void api.settingsGet<ModelPriceMap>('providers.modelPrices', {}).then(setPrices).catch(() => setPrices({}))
  }
  useEffect(refresh, [period, view])

  const fmtInt = (n: number): string => n.toLocaleString(i18n.locale === 'en' ? 'en' : 'it')
  // fase 16c correzioni (R5.3): la valuta nella lingua dell'interfaccia
  const fmtUsd = (n: number): string => fmtUsdIn(n, i18n.locale)

  const totalCalls = rows.reduce((a, r) => a + r.calls, 0)
  const totalIn = rows.reduce((a, r) => a + r.input, 0)
  const totalOut = rows.reduce((a, r) => a + r.output, 0)
  const totalCost = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0)
  const anyUnknown = rows.some((r) => r.costUsd === null || r.costPartial)

  // il costo di una riga: noto, locale, o sconosciuto
  const costCell = (r: ModelUsageRow): { text: string; partial: boolean } => {
    if (r.costUsd !== null) return { text: fmtUsd(r.costUsd), partial: r.costPartial }
    if (isLocalKind(r.providerKind)) return { text: t`locale`, partial: false }
    return { text: '—', partial: false }
  }

  const segBtn = (id: typeof view, label: string): ReactNode => (
    <button
      key={id}
      className={`rounded-full px-2.5 py-1 text-xs ${view === id ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      onClick={() => setView(id)}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-3 pr-12">
      {/* periodo */}
      <div className="flex flex-wrap items-center gap-1">
        {(Object.keys(PERIOD_LABELS) as UsagePeriod[]).map((p) => (
          <button
            key={p}
            className={`rounded-full px-2.5 py-1 text-xs ${period === p ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setPeriod(p)}
          >
            {i18n.t(PERIOD_LABELS[p]!)}
          </button>
        ))}
      </div>

      {/* riepilogo */}
      <div className="grid grid-cols-2 gap-2 rounded-2xl bg-muted px-3 py-2.5 sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>chiamate</Trans></div>
          <div className="text-sm">{fmtInt(totalCalls)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>token in</Trans></div>
          <div className="text-sm">{fmtInt(totalIn)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>token out</Trans></div>
          <div className="text-sm">{fmtInt(totalOut)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>costo totale</Trans></div>
          <div className="text-sm">{anyUnknown ? `≥ ${fmtUsd(totalCost)}` : fmtUsd(totalCost)}</div>
        </div>
      </div>
      {anyUnknown && (
        <p className="text-xs text-muted-foreground"><Trans>Il costo è un minimo: alcuni modelli non hanno un prezzo.</Trans></p>
      )}

      {/* tre viste */}
      <div className="flex items-center gap-1 rounded-full bg-muted p-1 w-fit">
        {segBtn('model', t`per modello`)}
        {segBtn('agent', t`per bot`)}
        {segBtn('source', t`per origine`)}
      </div>

      {/* tabella */}
      {!loaded ? (
        <p className="text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground"><Trans>Nessuna chiamata nel periodo.</Trans></p>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-muted">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">{view === 'model' ? t`modello` : view === 'agent' ? t`bot` : t`origine`}</th>
                <th className="px-3 py-2 text-right"><Trans>chiamate</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>token in</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>token out</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>cache</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>costo</Trans></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const cost = costCell(r)
                const key = view === 'model' ? `${r.providerId}|${r.model}` : view === 'agent' ? (r.agentId ?? 'system') : r.source
                return (
                  <tr key={`${key}-${i}`} className="border-t border-border/30 first:border-0">
                    <td className="px-3 py-2 font-mono">
                      {view === 'model'
                        ? `${r.providerKind}:${r.model}`
                        : view === 'agent'
                          ? (r.agentName ?? t`Sistema`)
                          : (SOURCE_LABELS[r.source] ? i18n.t(SOURCE_LABELS[r.source]!) : r.source)}
                    </td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.calls)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.input)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.output)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.cacheRead + r.cacheWrite)}</td>
                    <td className="px-3 py-2 text-right">
                      {cost.text}
                      {cost.partial && <span className="ml-1 text-[10px] text-muted-foreground">{t`parziale`}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* prezzi personalizzati (H1.3) */}
      <PriceSettings
        modelRows={modelRows}
        prices={prices}
        providers={providers}
        onSaved={refresh}
      />
    </div>
  )
}

/**
 * Fase 18b (H6.2 → K2): i prezzi $/M dei modelli senza catalogo (salvano in
 * providers.modelPrices). Le righe le sceglie la funzione PURA priceEditorRows.
 */
function PriceSettings({ modelRows, prices, providers, onSaved }: {
  modelRows: ModelUsageRow[]
  prices: ModelPriceMap
  providers: ProviderPublic[]
  onSaved(): void
}) {
  const target = priceEditorRows(modelRows, prices)
  const inputCls = 'w-20 rounded-lg bg-muted px-2 py-1 text-xs outline-none'

  if (target.length === 0) return null

  return (
    <div className="space-y-2 rounded-2xl bg-muted px-3 py-2.5">
      <div className="text-sm"><Trans>Prezzi personalizzati</Trans></div>
      <p className="text-xs text-muted-foreground">
        <Trans>Questi modelli non hanno un prezzo di catalogo: scrivi quello che paghi (dollari per milione di token). Vale per le chiamate da qui in avanti, lo storico non cambia.</Trans>
      </p>
      <p className="text-xs text-muted-foreground">
        <Trans>Svuota entrambi i campi per togliere un prezzo.</Trans>
      </p>
      {target.map((r) => (
        <PriceRow
          key={`${r.providerId}|${r.model}`}
          providerId={r.providerId}
          model={r.model}
          label={providers.find((p) => p.id === r.providerId)?.name ?? r.providerKind}
          price={prices[r.providerId]?.[r.model]}
          inputCls={inputCls}
          onSaved={onSaved}
        />
      ))}
    </div>
  )
}

/** Fase 18b (K2): una riga dell'editor — svuotare ENTRAMBI i campi CANCELLA la voce. */
function PriceRow({ providerId, model, label, price, inputCls, onSaved }: {
  providerId: string
  model: string
  label: string
  price?: ModelPrice
  inputCls: string
  onSaved(): void
}) {
  const [inVal, setInVal] = useState(price ? String(price.input) : '')
  const [outVal, setOutVal] = useState(price ? String(price.output) : '')

  const commit = async (): Promise<void> => {
    const all = await api.settingsGet<ModelPriceMap>('providers.modelPrices', {})
    // K2: entrambi i campi VUOTI → la voce si CANCELLA (un prezzo si può togliere)
    if (!inVal.trim() && !outVal.trim()) {
      const rest = { ...(all[providerId] ?? {}) }
      delete rest[model]
      await api.settingsSet('providers.modelPrices', { ...all, [providerId]: rest })
      onSaved()
      return
    }
    // un campo valido si salva, l'altro vuoto resta quello che c'era (o 0)
    const cur = all[providerId]?.[model] ?? { input: 0, output: 0 }
    const num = (raw: string, old: number): number => {
      const n = Number(raw.replace(',', '.'))
      return raw.trim() && Number.isFinite(n) && n >= 0 ? n : old
    }
    const next = { input: num(inVal, cur.input), output: num(outVal, cur.output) }
    await api.settingsSet('providers.modelPrices', { ...all, [providerId]: { ...(all[providerId] ?? {}), [model]: next } })
    onSaved()
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-mono">{model}</span>
      <span className="text-muted-foreground">{label}</span>
      <label className="flex items-center gap-1">
        <Trans>ingresso $/M</Trans>
        <input className={inputCls} type="text" value={inVal} onChange={(e) => setInVal(e.target.value)} onBlur={() => void commit()} />
      </label>
      <label className="flex items-center gap-1">
        <Trans>uscita $/M</Trans>
        <input className={inputCls} type="text" value={outVal} onChange={(e) => setOutVal(e.target.value)} onBlur={() => void commit()} />
      </label>
    </div>
  )
}

// ---- fase 18b (H5.4): l'editor della catena delle riserve (stile 16c) ----

/**
 * Il massimo di voci della catena (H2.1). K4: la stessa costante del daemon.
 */
const MAX_FALLBACK_CHAIN = MAX_CHAIN_ENTRIES

function FallbackChainSection() {
  const { t } = useLingui()
  const providers = useStore((s) => s.providers)
  const [chain, setChain] = useState<FallbackRoute[] | null>(null)
  // i modelli per provider (per il ModelPicker di ogni voce)
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})

  useEffect(() => {
    void api.settingsGet<FallbackRoute[]>('models.fallbackChain', []).then(setChain).catch(() => setChain([]))
  }, [])
  useEffect(() => {
    for (const p of providers) {
      if (!models[p.id]) {
        api.listModels(p.id).then((ms: ModelInfo[]) => setModels((prev) => ({ ...prev, [p.id]: ms }))).catch(() => {})
      }
    }
  }, [providers])

  if (chain === null) return <div className="text-xs text-muted-foreground"><Trans>riserve…</Trans></div>

  const persist = (next: FallbackRoute[]): void => {
    setChain(next)
    void api.settingsSet('models.fallbackChain', next)
  }
  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= chain.length) return
    const next = [...chain]
    const [x] = next.splice(i, 1)
    next.splice(j, 0, x!)
    persist(next)
  }

  return (
    <div className="space-y-2 rounded-2xl bg-muted/60 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">
        <Trans>Se il modello di un bot non risponde o raggiunge un limite, il turno passa alla riserva successiva. Con un limite (429) si salta agli altri provider.</Trans>
      </p>
      {chain.map((r, i) => {
        const p = providers.find((x) => x.id === r.providerId)
        return (
          <div key={`${r.providerId}|${r.model}|${i}`} className={`flex flex-wrap items-center gap-2 ${p?.enabled ? '' : 'opacity-60'}`}>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{i + 1}.</span>
            <select
              className="rounded-full bg-card px-2 py-1.5 text-xs outline-none"
              value={r.providerId}
              onChange={(e) => persist(chain.map((x, j) => j === i ? { providerId: e.target.value, model: '' } : x))}
            >
              <option value="">{t`— provider —`}</option>
              {providers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <ModelPicker
              className="min-w-48 flex-1"
              models={models[r.providerId] ?? []}
              value={r.model}
              placeholder={t`modello…`}
              onChange={(m) => persist(chain.map((x, j) => j === i ? { providerId: r.providerId, model: m ?? '' } : x))}
            />
            <button className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === chain.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => persist(chain.filter((_, j) => j !== i))}>✕</button>
            {p && !p.enabled && <span className="text-[10px] text-destructive line-through">{t`provider disattivato`}</span>}
          </div>
        )
      })}
      {chain.length < MAX_FALLBACK_CHAIN && (
        <button
          className="rounded-full bg-card px-3 py-1.5 text-xs transition hover:bg-card/80"
          onClick={() => persist([...chain, { providerId: '', model: '' }])}
        >
          <Trans>Aggiungi riserva</Trans>
        </button>
      )}
    </div>
  )
}

// fase 6: fuso orario, finestre di consegna, rientro/pausa per assenza e
// notifiche per agente (stile 16c: fondi tenui, niente bordi)
function GeneralTab() {
  const { t, i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  // fase 16 (U0): il selettore del tema (setting ui.theme)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  // fase 16b (S3.3): la voce di debug che rimette le righe tool-call in chat
  const debugSteps = useStore((s) => s.debugSteps)
  const setDebugSteps = useStore((s) => s.setDebugSteps)
  // fase 17a (L6): il selettore della lingua (setting ui.language)
  const uiLanguage = useStore((s) => s.uiLanguage)
  const setUiLanguage = useStore((s) => s.setUiLanguage)
  // fase rilascio (A3): stato con requiresApproval; (A8) versione e check
  const [atLogin, setAtLogin] = useState<{ enabled: boolean; requiresApproval: boolean; mechanism: 'agentService' | 'plist' }>({ enabled: false, requiresApproval: false, mechanism: 'plist' })
  const [busy, setBusy] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  // K6 (fase rilascio — correzioni): le build senza app-update.yml (le --dir)
  // non ricevono aggiornamenti: lo si dice in parole, niente bottone
  const [canUpdate, setCanUpdate] = useState(true)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] = useState<'none' | 'available' | 'current' | 'error'>('none')
  const [tz, setTz] = useState('')
  const [winMode, setWinMode] = useState<'morning' | 'working'>('morning')
  const [morning, setMorning] = useState({ start: '08:30', end: '09:30' })
  const [working, setWorking] = useState({ start: '09:00', end: '19:00' })
  const [minAwayHours, setMinAwayHours] = useState(12)
  const [awayPauseDays, setAwayPauseDays] = useState(7)
  const [disabledNotifications, setDisabledNotifications] = useState<string[]>([])

  // fase 14 (punto 1): spazio della LIBRERIA — avviso oltre 2 GB, NESSUN blocco
  const [libStats, setLibStats] = useState<{ bytes: number; warn: boolean } | null>(null)
  useEffect(() => { void api.libraryStats().then(setLibStats).catch(() => undefined) }, [])

  useEffect(() => {
    void api.getLaunchAtLogin().then(setAtLogin)
    void api.updaterStatus().then((s) => { setAppVersion(s.current); setCanUpdate(s.canUpdate) }).catch(() => undefined)
    void api.settingsGet('userTimeZone', '').then(setTz)
    void api.settingsGet('deliveryWindow', { mode: 'morning', morning: { start: '08:30', end: '09:30' }, working: { start: '09:00', end: '19:00' } })
      .then((w) => {
        const cfg = w as { mode: 'morning' | 'working'; morning: { start: string; end: string }; working: { start: string; end: string } }
        setWinMode(cfg.mode)
        setMorning(cfg.morning)
        setWorking(cfg.working)
      })
    void api.settingsGet('minAwayHours', 12).then((v) => setMinAwayHours(Number(v) || 12))
    void api.settingsGet('awayPauseDays', 7).then((v) => setAwayPauseDays(Number(v) || 7))
    void api.settingsGet('notifications.disabledAgents', []).then((v) => setDisabledNotifications(Array.isArray(v) ? (v as string[]) : []))
  }, [])

  async function toggle(enabled: boolean) {
    setBusy(true)
    try {
      await api.setLaunchAtLogin(enabled)
      setAtLogin(await api.getLaunchAtLogin())
    } finally {
      setBusy(false)
    }
  }

  // fase rilascio (A8): «Controlla aggiornamenti» — il dialogo di scarico lo
  // apre il main se c'è davvero una versione nuova; qui lo stato in parole
  async function checkUpdates(): Promise<void> {
    setUpdateBusy(true)
    setUpdateResult('none')
    try {
      const r = await api.updaterCheck()
      setUpdateResult(r.available ? 'available' : r.error ? 'error' : 'current')
    } catch {
      setUpdateResult('error')
    } finally {
      setUpdateBusy(false)
    }
  }

  const inputCls = 'rounded-lg bg-muted px-2 py-1.5 text-xs outline-none'
  const saveWindow = async (): Promise<void> => {
    await api.settingsSet('deliveryWindow', { mode: winMode, morning, working })
  }
  const toggleAgentNotification = async (agentId: string, off: boolean): Promise<void> => {
    const next = off ? disabledNotifications.filter((a) => a !== agentId) : [...disabledNotifications, agentId]
    setDisabledNotifications(next)
    await api.settingsSet('notifications.disabledAgents', next)
  }

  return (
    <div className="space-y-3 pr-12">
      <div className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3">
        <span className="text-sm"><Trans>Tema</Trans></span>
        <div className="flex gap-1 rounded-full bg-card p-1">
          {([['system', msg`Sistema`], ['light', msg`Chiaro`], ['dark', msg`Scuro`]] as const).map(([value, label]) => (
            <button
              key={value}
              className={`rounded-full px-3 py-1 text-xs transition ${theme === value ? 'bg-foreground text-background' : 'text-muted-foreground'}`}
              onClick={() => setTheme(value as UiTheme)}
            >
              {i18n.t(label)}
            </button>
          ))}
        </div>
      </div>

      {/* fase 17a (L6): le voci delle lingue si scrivono nella LORO lingua e
          non si traducono; solo "Sistema" si traduce */}
      <div className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3">
        <span className="text-sm"><Trans>Lingua</Trans></span>
        <div className="flex gap-1 rounded-full bg-card p-1">
          {([['system', msg`Sistema`], ['it', msg`Italiano`], ['en', msg`English`]] as const).map(([value, label]) => (
            <button
              key={value}
              className={`rounded-full px-3 py-1 text-xs transition ${uiLanguage === value ? 'bg-foreground text-background' : 'text-muted-foreground'}`}
              onClick={() => setUiLanguage(value as UiLanguageSetting)}
            >
              {i18n.t(label)}
            </button>
          ))}
        </div>
      </div>

      {/* fase 16b (S3.3): il debug — le righe tool-call/tool-result in chat */}
      <button
        className="flex w-full items-center justify-between rounded-2xl bg-muted px-4 py-3 text-left"
        onClick={() => setDebugSteps(!debugSteps)}
      >
        <span className="pr-4">
          <span className="block text-sm"><Trans>Mostra i passaggi in chat</Trans></span>
          <span className="block text-xs text-muted-foreground">
            <Trans>Le chiamate e i risultati dei tool tornano come righe nella conversazione (per il debug).</Trans>
          </span>
        </span>
        <span className={`relative h-6 w-10 shrink-0 rounded-full transition ${debugSteps ? 'bg-foreground' : 'bg-muted-foreground/30'}`}>
          <span className={`absolute top-0.5 size-5 rounded-full bg-card transition-all ${debugSteps ? 'right-0.5' : 'left-0.5'}`} />
        </span>
      </button>

      {libStats?.warn && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <Trans>Libreria: {(libStats.bytes / 1024 / 1024 / 1024).toFixed(1)} GB — oltre i 2 GB consigliati. Valuta cosa cancellare dalla vista Libreria (nessun blocco automatico).</Trans>
        </p>
      )}

      <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-muted px-4 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-foreground"
          checked={atLogin.enabled}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="space-y-1">
          <span className="block text-sm"><Trans>Avvia all'accesso</Trans></span>
          <span className="block text-xs text-muted-foreground">
            <Trans>Il daemon dei Bot parte quando accedi al Mac e resta attivo con la finestra chiusa (riavvio automatico dopo un crash). Puoi disattivarlo qui.</Trans>
          </span>
        </span>
      </label>

      {/* fase rilascio (A3): macOS aspetta il via dell'utente in Elementi login */}
      {atLogin.requiresApproval && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-muted px-4 py-3">
          <span className="text-xs text-muted-foreground">
            <Trans>Per attivare l'avvio all'accesso, macOS chiede il tuo via: aprì Elementi login e attiva Homun.</Trans>
          </span>
          <button
            className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs text-background"
            onClick={() => void api.openLoginItemsSettings()}
          >
            <Trans>Apri Elementi login</Trans>
          </button>
        </div>
      )}

      {/* fase rilascio (A8): la versione e il controllo manuale degli aggiornamenti.
          K6 (correzioni): senza app-update.yml (build --dir) lo si DICE, il
          bottone non c'è — un controllo non può riuscire */}
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-muted px-4 py-3">
        <span className="min-w-0 text-sm">
          <Trans>Versione</Trans> <span className="text-muted-foreground">{appVersion || '—'}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {!canUpdate ? (
            <span className="text-xs text-muted-foreground"><Trans>Questa build non riceve aggiornamenti</Trans></span>
          ) : (
            <>
              {updateResult === 'current' && <span className="text-xs text-muted-foreground"><Trans>Homun è aggiornato</Trans></span>}
              {updateResult === 'available' && <span className="text-xs text-muted-foreground"><Trans>Versione nuova disponibile</Trans></span>}
              {updateResult === 'error' && <span className="text-xs text-muted-foreground"><Trans>Controllo non riuscito</Trans></span>}
              <button
                className="rounded-full bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-40"
                disabled={updateBusy}
                onClick={() => void checkUpdates()}
              >
                <Trans>Controlla aggiornamenti</Trans>
              </button>
            </>
          )}
        </span>
      </div>

      <div className="space-y-2 rounded-2xl bg-muted px-4 py-3">
        <p className="text-sm"><Trans>Consegna e presenza</Trans></p>
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          <Trans>Fuso orario</Trans>
          <input
            className={`w-44 ${inputCls}`}
            placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            onBlur={() => void api.settingsSet('userTimeZone', tz.trim())}
          />
        </label>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span><Trans>Finestra di consegna</Trans></span>
          <div className="flex items-center gap-2">
            <select
              className={inputCls}
              value={winMode}
              onChange={(e) => { setWinMode(e.target.value as 'morning' | 'working'); void saveWindow() }}
            >
              <option value="morning">{t`mattina`}</option>
              <option value="working">{t`orario lavorativo`}</option>
            </select>
            {winMode === 'morning' ? (
              <>
                <input className={`w-16 ${inputCls}`} value={morning.start} onChange={(e) => setMorning({ ...morning, start: e.target.value })} onBlur={() => void saveWindow()} />
                <span>–</span>
                <input className={`w-16 ${inputCls}`} value={morning.end} onChange={(e) => setMorning({ ...morning, end: e.target.value })} onBlur={() => void saveWindow()} />
              </>
            ) : (
              <>
                <span>{t`lun–ven`}</span>
                <input className={`w-16 ${inputCls}`} value={working.start} onChange={(e) => setWorking({ ...working, start: e.target.value })} onBlur={() => void saveWindow()} />
                <span>–</span>
                <input className={`w-16 ${inputCls}`} value={working.end} onChange={(e) => setWorking({ ...working, end: e.target.value })} onBlur={() => void saveWindow()} />
              </>
            )}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground"><Trans>I messaggi non urgenti delle routine aspettano questa finestra (o l'apertura della chat del bot).</Trans></p>
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          <Trans>Look-around al rientro dopo (ore di assenza)</Trans>
          <input className={`w-16 ${inputCls}`} type="number" min={1} value={minAwayHours}
            onChange={(e) => setMinAwayHours(Number(e.target.value))}
            onBlur={() => void api.settingsSet('minAwayHours', Math.max(1, Number(minAwayHours) || 12))} />
        </label>
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          <Trans>Pausa delle routine dopo (giorni di assenza)</Trans>
          <input className={`w-16 ${inputCls}`} type="number" min={1} value={awayPauseDays}
            onChange={(e) => setAwayPauseDays(Number(e.target.value))}
            onBlur={() => void api.settingsSet('awayPauseDays', Math.max(1, Number(awayPauseDays) || 7))} />
        </label>
      </div>

      <div className="space-y-2 rounded-2xl bg-muted px-4 py-3">
        <p className="text-sm"><Trans>Notifiche per agente</Trans></p>
        {agents.map((a) => {
          const off = disabledNotifications.includes(a.id)
          return (
            <label key={a.id} className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{a.name}</span>
              <button
                className={`rounded-full px-2 py-1 text-[11px] ${off ? 'bg-card text-muted-foreground' : 'bg-chart-2/15 text-chart-2'}`}
                onClick={() => void toggleAgentNotification(a.id, off)}
              >
                {off ? t`disattivate` : t`attivate`}
              </button>
            </label>
          )
        })}
      </div>
    </div>
  )
}

// ---- fase 6: tab Routine con trigger in linguaggio naturale (stile 16c) ----

type TriggerKind = 'schedule' | 'email' | 'calendar_event' | 'webhook' | 'connector_poll' | 'presence_return'

function kindOf(t: RoutineTrigger | null | undefined, legacySchedule?: string): TriggerKind {
  if (!t) return 'schedule'
  if (t.type === 'schedule') return 'schedule'
  if (t.type === 'connector_poll') return t.preset ?? 'connector_poll'
  return t.type
}

const KIND_LABEL: Record<TriggerKind, MessageDescriptor> = {
  schedule: msg`orario`,
  email: msg`email in arrivo`,
  calendar_event: msg`evento del calendario`,
  webhook: msg`webhook`,
  connector_poll: msg`poll di un connettore`,
  presence_return: msg`quando torni al computer`
}

function RoutinesTab() {
  const { t, i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const connectors = useStore((s) => s.connectors)
  const select = useStore((s) => s.select)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const openBotTab = useStore((s) => s.openBotTab)
  const [routines, setRoutines] = useState<RoutineInfo[]>([])
  const [editing, setEditing] = useState<RoutineInfo | null>(null)
  const [err, setErr] = useState('')
  const [suggestions, setSuggestions] = useState<RoutineSuggestion[]>([])
  const [busy, setBusy] = useState(false)
  // fase 7 (residuo 0a): i server MCP manuali sono ammessi come fonte dei
  // poll (con conferma esplicita di sola lettura)
  const [manualServers, setManualServers] = useState<McpServerInfo[]>([])

  const refresh = async () => {
    if (activeId) setRoutines(await api.listRoutines(activeId))
  }
  useEffect(() => { void refresh() }, [activeId])
  useEffect(() => {
    api.mcpList()
      .then((all) => setManualServers(all.filter((s) => s.enabled && !s.catalogId)))
      .catch(() => undefined)
  }, [])

  const pauseResume = async (r: RoutineInfo): Promise<void> => {
    // la ripresa dalla UI è un'azione dell'utente: nessuna card di approvazione
    await api.updateRoutine(r.id, r.enabled ? { enabled: 0 } : { enabled: 1 })
    await refresh()
  }

  return (
    <div className="space-y-3 pr-12">
      <p className="text-xs text-muted-foreground">
        <Trans>Le routine sono attività automatiche del Bot: su orario (cron o «ogni giorno alle 9, circa»), su un'email in arrivo, prima di un evento del calendario, da un webhook o quando torni al computer. I loro messaggi non urgenti aspettano la finestra di consegna.</Trans>
      </p>

      {routines.map((r) => {
        const state = r.enabled ? t`attiva` : r.paused_for_away ? t`in pausa per assenza` : t`in pausa`
        const stateColor = r.enabled ? 'text-chart-2' : r.paused_for_away ? 'text-destructive' : 'text-muted-foreground'
        return (
          <div key={r.id} className="rounded-2xl bg-muted px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${r.enabled ? 'bg-chart-2' : r.paused_for_away ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
              <span className="text-sm">{r.title}</span>
              <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{i18n.t(KIND_LABEL[kindOf(r.trigger)])}</span>
              <div className="flex-1" />
              {/* fase 16c (C2): ogni riga apre anche il pannello del bot su «Routine» */}
              <button
                className="text-xs text-muted-foreground transition hover:text-foreground"
                title={t`Apri nel pannello del bot`}
                onClick={() => {
                  void select(r.agent_id)
                  openBotTab('routines')
                  setSettingsOpen(false)
                }}
              >
                <Trans>nel bot ›</Trans>
              </button>
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setEditing(r)}><Trans>modifica</Trans></button>
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => void pauseResume(r)}>
                {r.enabled ? <Trans>metti in pausa</Trans> : <Trans>riattiva</Trans>}
              </button>
              <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.deleteRoutine(r.id); await refresh() }}>
                <Trans>elimina</Trans>
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{describeTrigger(r.trigger ?? null, r.schedule, uiLang())}</p>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className={stateColor}>{state}</span>
              {r.next_run && <span>{t`prossima: ${formatDate(r.next_run)}`}</span>}
              {r.last_run && <span>{t`ultima: ${formatDate(r.last_run)}`}</span>}
            </div>
            {r.webhook_url && (
              <div className="mt-1 flex items-center gap-2 rounded-xl bg-card px-2 py-1.5">
                <code className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{r.webhook_url}</code>
                <button
                  className="text-[10px] text-primary hover:text-primary"
                  onClick={() => void navigator.clipboard?.writeText(
                    `curl -X POST ${r.webhook_url} -H "Authorization: Bearer ${r.trigger?.type === 'webhook' ? r.trigger.token : ''}" -d '{"test":1}'`
                  )}
                >
                  <Trans>copia curl</Trans>
                </button>
              </div>
            )}
          </div>
        )
      })}

      {editing ? (
        <TriggerEditor
          agentId={activeId}
          routine={editing}
          connectors={connectors}
          manualServers={manualServers}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh() }}
        />
      ) : (
        <>
          <NewRoutinePicker
            agentId={activeId}
            connectors={connectors}
            manualServers={manualServers}
            onCreate={async (title, prompt, trigger, timezone, model) => {
              setErr('')
              try {
                await api.createRoutineTrigger(activeId!, title, prompt, trigger, timezone || undefined, model)
                await refresh()
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e))
              }
            }}
            err={err}
          />
          <div className="space-y-2 pt-2">
            <button
              className="rounded-full bg-muted px-3 py-1.5 text-xs transition hover:bg-accent disabled:opacity-40"
              disabled={busy || !activeId}
              onClick={async () => {
                setBusy(true); setErr(''); setSuggestions([])
                try { setSuggestions(await api.suggestRoutines(activeId!)) }
                catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
                setBusy(false)
              }}
            >
              {busy ? t`analizzo…` : <Trans>✨ Suggerisci dal transcript</Trans>}
            </button>
            {suggestions.map((s, i) => (
              <div key={i} className="rounded-2xl bg-muted px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{s.title}</span>
                  <code className="rounded-full bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.schedule}</code>
                  <div className="flex-1" />
                  <button
                    className="rounded-full bg-card px-2 py-1 text-xs transition hover:bg-card/80"
                    onClick={async () => {
                      await api.createRoutine(activeId!, s.title, s.description, s.schedule)
                      setSuggestions(suggestions.filter((_, j) => j !== i))
                      await refresh()
                    }}
                  >
                    <Trans>Aggiungi</Trans>
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Bottone "+ routine" che apre l'editor con il tipo di trigger da scegliere. */
function NewRoutinePicker(props: {
  agentId: string | null
  connectors: ConnectorInfo[]
  manualServers: McpServerInfo[]
  onCreate(title: string, prompt: string, trigger: RoutineTrigger, timezone: string, model?: { providerId?: string | null; model?: string | null; thinking?: ThinkingSetting | null }): Promise<void>
  err: string
}) {
  const [kind, setKind] = useState<TriggerKind | null>(null)
  if (!kind) {
    return (
      <div className="space-y-2">
        <button
          className="w-full rounded-2xl bg-muted px-3 py-2.5 text-sm text-muted-foreground transition hover:text-foreground"
          onClick={() => setKind('schedule')}
        >
          <Trans>+ Nuova routine</Trans>
        </button>
        {props.err && <p className="text-xs text-destructive">{props.err}</p>}
      </div>
    )
  }
  return (
    <TriggerEditor
      agentId={props.agentId}
      connectors={props.connectors}
      manualServers={props.manualServers}
      initialKind={kind}
      onCancel={() => setKind(null)}
      onSaved={() => setKind(null)}
      onCreate={props.onCreate}
    />
  )
}

/** L'editor dei trigger: campi comuni (titolo/prompt) + campi per tipo. */
function TriggerEditor(props: {
  agentId: string | null
  routine?: RoutineInfo
  initialKind?: TriggerKind
  connectors: ConnectorInfo[]
  manualServers: McpServerInfo[]
  onCancel(): void
  onSaved(): void
  onCreate?(title: string, prompt: string, trigger: RoutineTrigger, timezone: string, model?: { providerId?: string | null; model?: string | null; thinking?: ThinkingSetting | null }): Promise<void>
}) {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const r = props.routine
  const [kind, setKind] = useState<TriggerKind>(props.initialKind ?? kindOf(r?.trigger, r?.schedule))
  const [title, setTitle] = useState(r?.title ?? '')
  const [prompt, setPrompt] = useState(r?.prompt ?? '')
  const [timezone, setTimezone] = useState(r?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // fase 18b (H7): il modello PROPRIo della routine (null = quello del bot)
  const [modelProvider, setModelProvider] = useState(r?.providerId ?? '')
  const [modelId, setModelId] = useState(r?.model ?? '')
  const [modelThinking, setModelThinking] = useState<ThinkingSetting>((r?.thinking as ThinkingSetting) ?? 'default')
  const [routineModels, setRoutineModels] = useState<ModelInfo[]>([])
  useEffect(() => {
    if (modelProvider) api.listModels(modelProvider).then(setRoutineModels).catch(() => setRoutineModels([]))
    else setRoutineModels([])
  }, [modelProvider])
  /** il modello della routine per la RPC (null = quello del bot) */
  const modelPatch = modelProvider
    ? { providerId: modelProvider, model: modelId, thinking: modelThinking !== 'default' ? modelThinking : null }
    : { providerId: null, model: null, thinking: null }

  // schedule
  // schedule: il toggle è "cron" se c'è un'espressione, "ogni…" se vuota
  // (le routine every hanno la colonna schedule vuota)
  const [cron, setCron] = useState(
    r?.trigger?.type === 'schedule'
      ? (r.trigger.kind === 'cron' ? r.trigger.cron : '')
      : (r?.schedule && kindOf(r.trigger) === 'schedule' ? r.schedule : r?.trigger ? '' : '0 9 * * *')
  )
  const [every, setEvery] = useState<'day' | 'weekday' | 'week' | 'month' | 'hour'>(
    r?.trigger?.type === 'schedule' && r.trigger.kind === 'every' ? r.trigger.every : 'day'
  )
  const [at, setAt] = useState(r?.trigger?.type === 'schedule' && r.trigger.kind === 'every' ? (r.trigger.at ?? '09:00') : '09:00')
  const [weekday, setWeekday] = useState(1)
  const [monthDay, setMonthDay] = useState(1)
  const [mode, setMode] = useState<'at' | 'around'>('at')
  // poll (email/calendar/generico)
  const [connectorId, setConnectorId] = useState('')
  const [tool, setTool] = useState('')
  const [idField, setIdField] = useState('')
  const [intervalMin, setIntervalMin] = useState(5)
  const [offsetMinutes, setOffsetMinutes] = useState(10)
  const [query, setQuery] = useState('')
  const [argsJson, setArgsJson] = useState('{}')
  // fase 7 (residuo 0a): conferma esplicita per i poll su server NON del catalogo
  const [confirmReadOnly, setConfirmReadOnly] = useState(r?.trigger?.type === 'connector_poll' ? !!r.trigger.userConfirmedReadOnly : false)

  // preset: il tool lo sceglie l'euristica dai tool del connettore connesso
  const presetConnectors = props.connectors.filter((c) => c.state.status === 'connected' && c.tools.length > 0)
  const autoTool = (preset: 'email' | 'calendar_event', cid: string): { tool: string | null; argName: string | null } => {
    const conn = presetConnectors.find((c) => c.id === (cid || (preset === 'email' ? 'gmail' : 'gcalendar')))
    if (!conn) return { tool: null, argName: null }
    const chosen = choosePollTool(
      conn.tools.map((t) => ({
        name: t.name,
        description: t.description,
        annotations: t.annotations,
        inputProperties: undefined
      })),
      preset
    )
    const full = conn.tools.find((t) => t.name === chosen) ?? null
    return { tool: chosen, argName: chooseQueryArgName(full ? { name: full.name, description: full.description, annotations: full.annotations } : null) }
  }

  const buildTrigger = (): RoutineTrigger | null => {
    if (kind === 'schedule') {
      // il toggle "ogni…" svuota il cron: i due modi di dire l'orario
      return cron.trim()
        ? { type: 'schedule', kind: 'cron', cron: cron.trim() }
        : { type: 'schedule', kind: 'every', every, at, mode, ...(every === 'week' ? { weekday } : {}), ...(every === 'month' ? { monthDay } : {}) }
    }
    if (kind === 'webhook') return { type: 'webhook', token: r?.trigger?.type === 'webhook' ? r.trigger.token : '' }
    if (kind === 'presence_return') return { type: 'presence_return' }
    // email / calendar_event / connector_poll
    const cid = connectorId || (kind === 'email' ? 'gmail' : kind === 'calendar_event' ? 'gcalendar' : '')
    // fase 7 (residuo 0a): server manuale (non del catalogo) → serve la
    // conferma esplicita che il tool legge soltanto
    const isManual = props.manualServers.some((s) => s.id === cid)
    let args: Record<string, unknown>
    try {
      args = JSON.parse(argsJson || '{}') as Record<string, unknown>
    } catch {
      return null // args non validi: il salvataggio lo segnala
    }
    if (kind === 'email' && query.trim()) {
      const { argName } = autoTool('email', cid)
      if (argName) args = { ...args, [argName]: query.trim() }
    }
    return {
      type: 'connector_poll',
      connectorId: cid,
      tool: tool.trim(),
      args,
      intervalMin: Math.max(2, Number(intervalMin) || 2),
      idField: idField.trim(),
      ...(kind === 'email' ? { preset: 'email' as const } : {}),
      ...(kind === 'calendar_event' ? { preset: 'calendar_event' as const, offsetMinutes: Math.max(0, Number(offsetMinutes) || 0) } : {}),
      ...(isManual ? { userConfirmedReadOnly: confirmReadOnly } : {})
    }
  }

  const save = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const trigger = buildTrigger()
      if (!trigger) throw new Error(t`Argomenti (args) non sono JSON valido`)
      if (props.onCreate) await props.onCreate(title.trim(), prompt.trim(), trigger, timezone.trim(), modelPatch)
      else await api.updateRoutineTrigger(r!.id, { title: title.trim(), prompt: prompt.trim(), trigger, timezone: timezone.trim(), ...modelPatch })
      props.onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // precompilazione dei preset alla scelta del tipo
  useEffect(() => {
    if (kind === 'email') {
      const { tool: t, argName } = autoTool('email', connectorId)
      if (t) setTool(t)
      setIdField((v) => v || 'messages[].id')
      void argName
    } else if (kind === 'calendar_event') {
      const { tool: t } = autoTool('calendar_event', connectorId)
      if (t) setTool(t)
      setIdField((v) => v || 'events[].id')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, connectorId])

  const inputCls = 'rounded-lg bg-muted px-2 py-1.5 text-xs outline-none'
  const presetHint = (preset: 'email' | 'calendar_event'): string => {
    const { tool: chosen } = autoTool(preset, connectorId)
    return chosen
      ? t`tool scelto dal connettore: ${chosen}`
      : t`nessun tool riconosciuto nel connettore: configura tool e idField a mano`
  }

  return (
    <div className="space-y-2 rounded-2xl bg-muted p-3">
      <div className="flex flex-wrap gap-1">
        {(Object.keys(KIND_LABEL) as TriggerKind[]).map((k) => (
          <button
            key={k}
            className={`rounded-full px-2 py-1 text-[11px] ${kind === k ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setKind(k)}
          >
            {i18n.t(KIND_LABEL[k])}
          </button>
        ))}
      </div>
      <input className={`w-full ${inputCls} text-sm`} placeholder={t`Titolo (es. Riepilogo email del mattino)`} value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className={`w-full ${inputCls} text-sm`} placeholder={t`Cosa deve fare il Bot a ogni esecuzione`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      {kind === 'schedule' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <button className={`rounded-full px-2 py-1 ${cron !== '' ? 'bg-card text-foreground' : ''}`} onClick={() => { setCron('0 9 * * *') }}>{t`cron`}</button>
            <button className={`rounded-full px-2 py-1 ${cron === '' ? 'bg-card text-foreground' : ''}`} onClick={() => setCron('')}>{t`ogni…`}</button>
            {cron === '' && (
              <>
                <select className={inputCls} value={every} onChange={(e) => setEvery(e.target.value as typeof every)}>
                  <option value="day">{t`giorno`}</option>
                  <option value="weekday">{t`giorni feriali`}</option>
                  <option value="week">{t`settimana`}</option>
                  <option value="month">{t`mese`}</option>
                  <option value="hour">{t`ora`}</option>
                </select>
                {every === 'week' && (
                  <select className={inputCls} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                    {[msg`domenica`, msg`lunedì`, msg`martedì`, msg`mercoledì`, msg`giovedì`, msg`venerdì`, msg`sabato`].map((d, i) => (
                      <option key={i} value={i}>{i18n.t(d)}</option>
                    ))}
                  </select>
                )}
                {every === 'month' && (
                  <input className={`w-16 ${inputCls}`} type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))} />
                )}
                <input className={`w-20 ${inputCls}`} placeholder="HH:MM" value={at} onChange={(e) => setAt(e.target.value)} />
                <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as 'at' | 'around')}>
                  <option value="at">{t`preciso`}</option>
                  <option value="around">{t`circa (±15 min)`}</option>
                </select>
              </>
            )}
            {cron !== '' && <input className={`flex-1 font-mono ${inputCls}`} value={cron} onChange={(e) => setCron(e.target.value)} />}
          </div>
        </div>
      )}

      {(kind === 'email' || kind === 'calendar_event' || kind === 'connector_poll') && (
        <div className="space-y-2">
          {kind === 'connector_poll' && (
            <>
              <select className={`w-full ${inputCls}`} value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                <option value="">{t`— connettore —`}</option>
                {presetConnectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {props.manualServers.map((s) => <option key={s.id} value={s.id}>{s.name} {t`(server manuale)`}</option>)}
              </select>
              {props.manualServers.some((s) => s.id === connectorId) && (
                // fase 7 (residuo 0a): readOnlyHint di un server manuale è
                // autodichiarato — serve la spunta esplicita dell'utente
                <label className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive/90">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmReadOnly}
                    onChange={(e) => setConfirmReadOnly(e.target.checked)}
                  />
                  <Trans>Confermo che questo tool legge soltanto e non modifica nulla (server aggiunto a mano: la dichiarazione «sola lettura» non è verificata)</Trans>
                </label>
              )}
            </>
          )}
          {(kind === 'email' || kind === 'calendar_event') && <p className="text-[11px] text-muted-foreground">{presetHint(kind)}</p>}
          {kind === 'email' && (
            <input className={`w-full ${inputCls}`} placeholder={t`Quando arriva un'e-mail che corrisponde a… (query)`} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {kind === 'calendar_event' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Trans>avvisa</Trans>
              <input className={`w-16 ${inputCls}`} type="number" min={0} value={offsetMinutes} onChange={(e) => setOffsetMinutes(Number(e.target.value))} />
              <Trans>minuti prima dell'evento</Trans>
            </label>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input className={`font-mono ${inputCls}`} placeholder={t`tool (mcp__…__…)`} value={tool} onChange={(e) => setTool(e.target.value)} />
            <input className={`font-mono ${inputCls}`} placeholder={t`idField (es. "messages[].id")`} value={idField} onChange={(e) => setIdField(e.target.value)} />
            <input className={inputCls} type="number" min={2} title={t`minuti tra i poll (minimo 2)`} value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))} />
            {kind === 'connector_poll' && (
              <input className={`font-mono ${inputCls}`} placeholder={t`args JSON, es. {"query":"x"}`} value={argsJson} onChange={(e) => setArgsJson(e.target.value)} />
            )}
          </div>
        </div>
      )}

      {kind === 'webhook' && (
        <p className="text-[11px] text-muted-foreground">
          <Trans>All'uscita trovi l'URL con il token da copiare: qualunque sistema può far scattare la routine con un POST.</Trans>
        </p>
      )}
      {kind === 'presence_return' && (
        <p className="text-[11px] text-muted-foreground"><Trans>La routine gira quando torni al computer dopo un'assenza lunga.</Trans></p>
      )}

      {/* fase 18b (H7): il modello della routine — «Quello del bot» (default)
          oppure provider + ModelPicker + ragionamento, come per i bot (H3) */}
      <div className="space-y-2 rounded-xl bg-card/60 px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t`modello`}</span>
          <select
            className={inputCls}
            value={modelProvider}
            onChange={(e) => { setModelProvider(e.target.value); setModelId(''); setModelThinking('default') }}
          >
            <option value="">{t`Quello del bot`}</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {modelProvider && (
            <ModelPicker
              className="min-w-44 flex-1"
              models={routineModels}
              value={modelId || null}
              placeholder={t`— modello —`}
              onChange={(m) => setModelId(m ?? '')}
            />
          )}
        </div>
        {(() => {
          // il ragionamento del modello della routine (come in H3)
          const chosen = routineModels.find((m) => m.id === modelId)
          const levels = chosen?.thinkingLevels ?? []
          if (levels.length === 0) return null
          const savedLevel = levels.includes(modelThinking) ? modelThinking : 'default'
          return (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t`ragionamento`}</span>
              <select
                className={inputCls}
                value={savedLevel}
                onChange={(e) => setModelThinking(e.target.value as ThinkingSetting)}
              >
                {['default', ...levels].map((l) => (
                  <option key={l} value={l}>{i18n.t(THINKING_LABELS[l]!)}</option>
                ))}
              </select>
            </div>
          )
        })()}
        <p className="text-[11px] text-muted-foreground">
          <Trans>Vale solo per i turni di questa routine; il resto del bot non cambia.</Trans>
        </p>
      </div>

      <input className={`w-full ${inputCls}`} placeholder={t`Fuso orario (es. Europe/Rome)`} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={props.onCancel}><Trans>Annulla</Trans></button>
        <button
          className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={busy || !title.trim() || !prompt.trim() || !props.agentId || (!!modelProvider && !modelId.trim())}
          onClick={() => void save()}
        >
          {r ? <Trans>Salva</Trans> : <Trans>Crea routine</Trans>}
        </button>
      </div>
    </div>
  )
}
