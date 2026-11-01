// Impostazioni: provider (modelli personalizzati), modello per agente, permessi, routine, connettori, cassaforte, generali.
// Fase 16 (U5): diventano un Dialog con la colonna di tab a sinistra come in
// Lovable; il contenuto dei tab resta quello di prima, coi token del nuovo
// design system. Il meccanismo settingsTab (aprire un tab preciso da un
// widget) continua a funzionare.
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg, plural } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { api, useStore } from '../store'
import { formatDate, formatTime } from '../lib/i18n'
import type { UiLanguageSetting } from '../../../shared/ui-language'

/** Il template dei secret nei comandi (fase 17a): costante, così nel messaggio
 *  di Lingui è un segnaposto e non testo con doppie graffe (sintassi ICU). */
const SECRET_TEMPLATE = '{{secret:NOME}}'
import { describeTrigger } from '../../../shared/cron-human'
// fase 17c (C5/C6): lingua attiva per le descrizioni; fiducia e template dai codici
import { pickLang } from '../../../shared/localized'
import { i18n } from '../lib/i18n'
import { VaultTab } from './VaultSettings'
import { choosePollTool, chooseQueryArgName } from '../../../shared/triggers'
import type { ProviderConfig, ProviderKind, ModelInfo, Agent, RoutineInfo, RoutineSuggestion, ConnectorInfo, McpServerInfo, McpServerSecret, RoutineTrigger, TemplateInfo, AutoReviewSettings, WebSearchStatusRpc, WebSearchProviderStatusRpc, FallbackRoute, ModelUsageRow, ModelPrice, ModelPriceMap, ThinkingSetting } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW, SECRET_KIND_FOR_NEEDS } from '../../../shared/types'
// fase 18b (K2): la selezione delle righe dell'editor dei prezzi (funzione pura)
import { priceEditorRows } from '../lib/price-editor'
// fase 10 (residuo 0d): i default per kind (modulo puro, nessuna dipendenza node)
import { modelDefaultsFor } from '../../../main/agent/model-defaults'
// fase 18b (K4): il tetto della catena delle riserve, lo stesso del daemon
import { MAX_CHAIN_ENTRIES } from '../../../main/agent/model-fallback'
// fase 18b (H5.2): i kind locali (costo «locale» nella pagina Uso e costi)
import { isLocalKind } from '../../../main/agent/live-models'
// fase 18b (H5.3): il selettore del modello a combobox
import { ModelPicker, THINKING_LABELS } from './ui/ModelPicker'
import type { UiTheme } from '../theme'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const KINDS: ProviderKind[] = [
  'ollama', 'lmstudio', 'anthropic', 'mistral', 'openrouter', 'zai', 'xai', 'deepseek', 'groq', 'openai-compatible'
]

/** I tab con i nomi per la UI (gli id interni non cambiano). Fase 17a: descriptor. */
const TAB_LABELS: Record<string, MessageDescriptor> = {
  provider: msg`Provider`,
  uso: msg`Uso e costi`,
  agenti: msg`Bot`,
  permessi: msg`Permessi`,
  routine: msg`Routine`,
  connettori: msg`Connettori`,
  autoreview: msg`Revisione automatica`,
  vault: msg`Cassaforte`,
  generale: msg`Generali`
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
  const [tab, setTab] = useState<'provider' | 'uso' | 'agenti' | 'permessi' | 'routine' | 'connettori' | 'autoreview' | 'vault' | 'generale'>('provider')

  // fase 7: un widget può chiedere di aprire un tab preciso (es. il provider
  // durante l'onboarding): lo si applica una volta e si consuma
  useEffect(() => {
    if (pendingTab) {
      setTab(pendingTab as typeof tab)
      setSettingsTab(null)
    }
  }, [pendingTab, setSettingsTab])

  return (
    <Dialog open onOpenChange={(o) => !o && setSettingsOpen(false)}>
      <DialogContent className="flex h-[600px] max-h-[92vh] max-w-[calc(100%-2rem)] gap-0 p-0 sm:max-w-4xl" showCloseButton={false}>
        <DialogTitle className="sr-only"><Trans>Impostazioni</Trans></DialogTitle>
        <nav className="w-52 shrink-0 space-y-1 overflow-y-auto scroll-thin border-r border-border p-3">
          {(Object.keys(TAB_LABELS) as Array<keyof typeof TAB_LABELS>).map((t) => (
            <button
              key={t}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab(t as typeof tab)}
            >
              {i18n.t(TAB_LABELS[t]!)}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto scroll-thin p-6">
          {tab === 'provider' && <ProvidersTab onChanged={refreshProviders} />}
          {tab === 'uso' && <UsageTab />}
          {tab === 'agenti' && <AgentsTab />}
          {tab === 'permessi' && <PermissionsTab onChanged={refreshPermissions} />}
          {tab === 'routine' && <RoutinesTab />}
          {tab === 'connettori' && <ConnectorsTab />}
          {tab === 'autoreview' && <AutoReviewTab />}
          {tab === 'vault' && <VaultTab />}
          {tab === 'generale' && <GeneralTab />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---- fase 8 (§3bis L5): auto-review delle approvazioni ----

function AutoReviewTab() {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const prefill = useStore((s) => s.autoreviewPrefill)
  const [cfg, setCfg] = useState<AutoReviewSettings | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [newAllow, setNewAllow] = useState('')
  const [newBlock, setNewBlock] = useState('')

  useEffect(() => {
    void api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).then(setCfg)
  }, [])
  // fase 8: "Crea regola da questa azione" arriva con un testo precompilato
  useEffect(() => {
    if (prefill) {
      setNewAllow(prefill)
      useStore.setState({ autoreviewPrefill: null })
    }
  }, [prefill])
  // i modelli del provider scelto (per il revisore)
  useEffect(() => {
    if (cfg?.providerId) void api.listModels(cfg.providerId).then(setModels).catch(() => setModels([]))
    else setModels([])
  }, [cfg?.providerId])

  if (!cfg) return <p className="text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>
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
    <div className="rounded-2xl border border-border bg-card px-3 py-2.5">
      <div className="text-sm text-foreground">{i18n.t(title)}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{i18n.t(hint)}</div>
      <ul className="mt-2 space-y-1">
        {rules.length === 0 && <li className="text-xs text-muted-foreground"><Trans>(nessuna regola)</Trans></li>}
        {rules.map((r, i) => (
          <li key={`${r}-${i}`} className="flex items-start gap-2 text-xs text-foreground">
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
          className="rounded-lg bg-accent px-3 py-1.5 text-xs text-foreground hover:bg-muted-foreground/40 disabled:opacity-40"
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
      <p className="text-xs text-muted-foreground">
        <Trans>Un modello piccolo rivede le azioni che chiedono approvazione secondo queste regole e può lasciarle passare da solo. Sta dopo il gate dei permessi e non cambia mai i divieti: le azioni che modificano il comportamento futuro del bot, i comandi che eseguono altri comandi e i turni aperti da altri bot o da eventi esterni chiedono comunque.</Trans>
      </p>
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-foreground"
          checked={cfg.enabled}
          onChange={(e) => save({ ...cfg, enabled: e.target.checked })}
        />
        <span>
          <span className="block text-sm text-foreground"><Trans>Approvazione automatica</Trans></span>
          <span className="block text-xs text-muted-foreground"><Trans>Al massimo 20 azioni approvate per turno; un dubbio del revisore diventa sempre una card.</Trans></span>
        </span>
      </label>
      <div className="flex gap-2">
        <select
          className="rounded-lg bg-muted px-2 py-1.5 text-xs outline-none"
          value={cfg.providerId ?? ''}
          onChange={(e) => save({ ...cfg, providerId: e.target.value || null, model: null })}
        >
          <option value="">{t`provider del revisore…`}</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {/* fase 18b (H5.3): combobox con ricerca, capacità e prezzi */}
        <ModelPicker
          className="min-w-44"
          models={models}
          value={cfg.model}
          placeholder={t`modello… (vuoto = default del provider)`}
          disabled={!cfg.providerId}
          onChange={(m) => save({ ...cfg, model: m })}
        />
      </div>
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

// ---- fase 18b (H6.2): la pagina Uso e costi ----

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
  const fmtUsd = (n: number): string => '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace('.', ',')

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
      className={`rounded-lg px-2.5 py-1 text-xs ${view === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      onClick={() => setView(id)}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-3">
      {/* periodo */}
      <div className="flex flex-wrap items-center gap-1">
        {(Object.keys(PERIOD_LABELS) as UsagePeriod[]).map((p) => (
          <button
            key={p}
            className={`rounded-lg px-2.5 py-1 text-xs ${period === p ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setPeriod(p)}
          >
            {i18n.t(PERIOD_LABELS[p]!)}
          </button>
        ))}
      </div>

      {/* riepilogo */}
      <div className="grid grid-cols-2 gap-2 rounded-2xl border border-border bg-card px-3 py-2.5 sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>chiamate</Trans></div>
          <div className="text-sm text-foreground">{fmtInt(totalCalls)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>token in</Trans></div>
          <div className="text-sm text-foreground">{fmtInt(totalIn)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>token out</Trans></div>
          <div className="text-sm text-foreground">{fmtInt(totalOut)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>costo totale</Trans></div>
          <div className="text-sm text-foreground">{anyUnknown ? `≥ ${fmtUsd(totalCost)}` : fmtUsd(totalCost)}</div>
        </div>
      </div>
      {anyUnknown && (
        <p className="text-xs text-muted-foreground"><Trans>Il costo è un minimo: alcuni modelli non hanno un prezzo.</Trans></p>
      )}

      {/* tre viste */}
      <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
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
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
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
                  <tr key={`${key}-${i}`} className="border-b border-border/50 last:border-0">
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

      {/* prezzi personalizzati (H1.3): i modelli usati nel periodo SENZA prezzo
          di catalogo e NON locali */}
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
 * providers.modelPrices). Le righe le sceglie la funzione PURA priceEditorRows:
 * un modello resta nell'editor anche DOPO che le chiamate hanno registrato un
 * costo (un prezzo sbagliato si corregge), e un prezzo salvato si vede sempre.
 */
function PriceSettings({ modelRows, prices, providers, onSaved }: {
  modelRows: ModelUsageRow[]
  prices: ModelPriceMap
  providers: ProviderConfig[]
  onSaved(): void
}) {
  const target = priceEditorRows(modelRows, prices)
  const inputCls = 'w-20 rounded-lg bg-muted px-2 py-1 text-xs outline-none'

  if (target.length === 0) return null

  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card px-3 py-2.5">
      <div className="text-sm text-foreground"><Trans>Prezzi personalizzati</Trans></div>
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

// ---- fase 18b (H5.4): l'editor della catena delle riserve ----

/**
 * Il massimo di voci della catena (H2.1). K4: la stessa costante del daemon
 * (routeChain taglia le voci oltre il tetto): una sola verità.
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
    <div className="space-y-2 rounded-2xl border border-border bg-card px-3 py-2.5">
      <div className="text-sm text-foreground"><Trans>Riserve</Trans></div>
      <p className="text-xs text-muted-foreground">
        <Trans>Se il modello di un bot non risponde o raggiunge un limite, il turno passa alla riserva successiva. Con un limite (429) si salta agli altri provider.</Trans>
      </p>
      {chain.map((r, i) => {
        const p = providers.find((x) => x.id === r.providerId)
        return (
          <div key={`${r.providerId}|${r.model}|${i}`} className={`flex flex-wrap items-center gap-2 ${p?.enabled ? '' : 'opacity-60'}`}>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{i + 1}.</span>
            <select
              className="rounded-lg bg-muted px-2 py-1.5 text-xs outline-none"
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
          className="rounded-lg bg-muted px-3 py-1.5 text-xs hover:bg-accent"
          onClick={() => persist([...chain, { providerId: '', model: '' }])}
        >
          <Trans>Aggiungi riserva</Trans>
        </button>
      )}
    </div>
  )
}

// ---- fase 5: "Connetti app" — catalogo con stato + server MCP manuali ----

const STATUS_DOT: Record<string, string> = {
  not_connected: 'bg-muted-foreground/40',
  connected: 'bg-chart-2',
  needs_auth: 'bg-destructive',
  error: 'bg-destructive'
}
const STATUS_LABEL: Record<string, MessageDescriptor> = {
  not_connected: msg`non connesso`,
  connected: msg`connesso`,
  needs_auth: msg`da autorizzare`,
  error: msg`errore`
}

/**
 * Fase 13: Connettori con QUATTRO schede — App (catalogo, come prima),
 * Installati (server del registro/plugin/gateway con enabledFor per bot),
 * Marketplace (elenco, aggiungi/rimuovi) e Gateway (modulo del punto 7).
 */
function ConnectorsTab() {
  const { t } = useLingui()
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const [sub, setSub] = useState<'app' | 'installati' | 'marketplace' | 'gateway'>('app')
  useEffect(() => { void refreshConnectors() }, [refreshConnectors])
  const subBtn = (id: typeof sub, label: string): ReactNode => (
    <button
      key={id}
      className={`rounded-lg px-2.5 py-1 text-xs ${sub === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      onClick={() => setSub(id)}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">{subBtn('app', t`App`)}{subBtn('installati', t`Installati`)}{subBtn('marketplace', t`Marketplace`)}{subBtn('gateway', t`Gateway`)}</div>
      {sub === 'app' && (
        <>
          <p className="text-xs text-muted-foreground">
            <Trans>Le app si collegano come server MCP con OAuth: i loro tool diventano <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>. I token stanno cifrati nel Keychain. Il bot può proporre un'app in chat, ma la connessione parte solo dal tuo click.</Trans>
          </p>
          <div className="grid grid-cols-2 gap-2">
            {connectors.map((c) => (
              <ConnectorTile key={c.id} c={c} />
            ))}
          </div>
          <ManualServers />
          <ClientMetadataUrlRow />
        </>
      )}
      {sub === 'installati' && <InstalledTab />}
      {sub === 'marketplace' && <MarketplaceTab />}
      {sub === 'gateway' && <GatewayTab />}
    </div>
  )
}

/**
 * Fase 13 (punto 6.2): URL del Client ID Metadata Document (CIMD) ospitato
 * dall'utente — vuoto = Dynamic Client Registration. Una riga che spiega.
 */
function ClientMetadataUrlRow() {
  const { t } = useLingui()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    void api.settingsGet<string>('connectors.oauth.clientMetadataUrl', '').then(setUrl).catch(() => setUrl(''))
  }, [])
  if (url === null) return null
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>OAuth</Trans></span>
      <span className="text-[11px] text-muted-foreground"><Trans>Se ospiti un documento dei metadati del client (CIMD, es. su GitHub Pages, https e con percorso), incollalo qui; vuoto = registrazione dinamica (DCR).</Trans></span>
      <input
        className="min-w-0 flex-1 rounded-lg bg-muted px-2 py-1.5 text-xs outline-none"
        placeholder={t`https://utente.github.io/sandbot/client.json`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => void api.connectorsSetClientMetadataUrl(url.trim())}
      />
    </div>
  )
}

/** Scheda Installati: server del registro/plugin/gateway con fonte, fiducia, stato, enabledFor, disinstalla. */
function InstalledTab() {
  const { t } = useLingui()
  const [data, setData] = useState<{ servers: Array<McpServerInfo & { needsReauth?: boolean; neverAuthorized?: boolean }>; plugins: Array<{ name: string; marketplace: string; sha12: string; skills: Array<{ name: string }>; servers: string[]; enabledFor: string[]; updateAvailable?: boolean }> } | null>(null)
  const agents = useStore((s) => s.agents)
  const [values, setValues] = useState<Record<string, string>>({})
  const [reconnectMsg, setReconnectMsg] = useState('')
  const refresh = async (): Promise<void> => { setData(await api.connectorsInstalled() as { servers: Array<McpServerInfo & { needsReauth?: boolean; neverAuthorized?: boolean }>; plugins: Array<{ name: string; marketplace: string; sha12: string; skills: Array<{ name: string }>; servers: string[]; enabledFor: string[]; updateAvailable?: boolean }> }) }
  useEffect(() => { void refresh() }, [])
  if (data === null) return <p className="text-xs text-muted-foreground"><Trans>installati…</Trans></p>

  const enabledForEditor = (kind: 'server' | 'plugin', id: string, current: string[] | undefined): ReactNode => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground"><Trans>per bot:</Trans></span>
      {agents.map((a) => {
        const on = current?.includes('*') || current?.includes(a.id)
        return (
          <label key={a.id} className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3 accent-foreground"
              checked={on}
              onChange={() => {
                const next = current?.includes('*') ? [] : [...(current ?? [])]
                const i = next.indexOf(a.id)
                if (i >= 0) next.splice(i, 1)
                else next.push(a.id)
                void api.connectorsSetEnabledFor(kind, id, next).then(refresh)
              }}
            />
            {a.name}
          </label>
        )
      })}
    </div>
  )

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <Trans>Server del registro pubblico e plugin installati. Chiavi, header e variabili stanno cifrati: si compilano qui, MAI in chat.</Trans>
      </p>
      {data.servers.length === 0 && data.plugins.length === 0 && <p className="text-xs text-muted-foreground"><Trans>nessun server o plugin installato</Trans></p>}
      {data.servers.map((sv) => {
        const src = sv.source as { kind?: string; name?: string; plugin?: string; preset?: string } | undefined
        const needs = sv.needsAuth as { kind?: string; keys?: string[] } | undefined
        // fase 17a (K3): tre messaggi interi distinti, scelti col ternario FUORI
        // dal testo — dentro <Trans> una stringa JS è un segnaposto e resterebbe
        // italiana anche in inglese
        const keys = needs?.keys?.join(', ') ?? ''
        return (
          <div key={sv.id} className="rounded-2xl border border-border bg-card px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${needs ? 'bg-destructive' : 'bg-chart-2'}`} />
              <span className="text-sm text-foreground">{sv.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{src?.kind ?? t`manuale`}</span>
              {sv.trustLabel && (
                <span className="text-[10px] text-muted-foreground">
                  {/* fase 17c (C5): la fiducia si traduce dal kind; le righe vecchie mostrano il label com'è */}
                  {sv.trustKind === 'verified-domain' ? t`dominio verificato`
                    : sv.trustKind === 'github-account' ? t`account GitHub`
                    : sv.trustKind === 'unverified' ? t`non verificato`
                    : sv.trustLabel}
                </span>
              )}
              <span className="flex-1 truncate text-xs text-muted-foreground">{sv.transport === 'http' ? sv.url : `${sv.box?.command ?? ''} ${(sv.box?.args ?? []).join(' ')}`}</span>
              {/* L1+M2: sessione OAuth da (ri)fare di un server non del catalogo →
                  authorizeWithLoopback; "Connetti" se non ha mai avuto token
                  (plugin appena installato), "Riconnetti" se è scaduta */}
              {sv.needsReauth && (
                <button
                  className="rounded-lg bg-accent px-2 py-0.5 text-xs text-white hover:bg-muted-foreground/40"
                  onClick={async () => {
                    const r = await api.connectorsReconnectServer(sv.id).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
                    setReconnectMsg(r.ok ? (r.message ?? t`riconnesso`) : t`riconnessione non riuscita: ${'error' in r ? r.error ?? '' : ''}`)
                    await refresh()
                  }}
                >
                  {sv.neverAuthorized ? <Trans>Connetti</Trans> : <Trans>Riconnetti</Trans>}
                </button>
              )}
              <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.connectorsUninstallServer(sv.id); await refresh() }}><Trans>disinstalla</Trans></button>
            </div>
            {reconnectMsg && <p className="mt-1 text-[11px] text-muted-foreground">{reconnectMsg}</p>}
            {enabledForEditor('server', sv.id, sv.enabledFor)}
            {needs?.keys?.length ? (
              <div className="mt-2 space-y-1 border-t border-border pt-2">
                <p className="text-[11px] text-destructive/80">
                  {needs.kind === 'key' ? (
                    <Trans>serve: {keys} (header)</Trans>
                  ) : needs.kind === 'env' ? (
                    <Trans>serve: {keys} (variabile d’ambiente)</Trans>
                  ) : (
                    <Trans>serve: {keys} (impostazione del plugin)</Trans>
                  )}
                </p>
                {needs.keys.map((k) => (
                  <div key={k} className="flex gap-1">
                    <input
                      className="min-w-0 flex-1 rounded-lg bg-muted px-2 py-1 text-xs outline-none"
                      type="password"
                      placeholder={k}
                      value={values[`${sv.id}:${k}`] ?? ''}
                      onChange={(e) => setValues((p) => ({ ...p, [`${sv.id}:${k}`]: e.target.value }))}
                    />
                  </div>
                ))}
                <button
                  className="rounded-lg bg-accent px-2 py-1 text-xs text-white hover:bg-muted-foreground/40"
                  onClick={async () => {
                    const vals: Record<string, string> = {}
                    for (const k of needs.keys ?? []) if (values[`${sv.id}:${k}`]?.trim()) vals[k] = values[`${sv.id}:${k}`]!.trim()
                    // L1: il kind è quello di SECRET_KIND (mappato da needsAuth.kind) —
                    // lo STESSO che il resolver legge alla connessione
                    await api.connectorsSaveServerValues(sv.id, SECRET_KIND_FOR_NEEDS[needs.kind as keyof typeof SECRET_KIND_FOR_NEEDS], vals)
                    setValues({})
                    await refresh()
                  }}
                >
                  <Trans>salva cifrato</Trans>
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
      {data.plugins.map((p) => (
        <div key={`${p.marketplace}/${p.name}`} className="rounded-2xl border border-border bg-card px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">{p.name}</span>
            <span className="text-xs text-muted-foreground">{p.marketplace} · {p.sha12}</span>
            <span className="flex-1" />
            <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.pluginsUninstall(p.name, p.marketplace); await refresh() }}><Trans>disinstalla</Trans></button>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground"><Trans>{p.skills.length} skill · {p.servers.length} server{p.updateAvailable ? t` · nuova versione disponibile (aggiorna = nuova card in chat)` : ''}</Trans></p>
          {enabledForEditor('plugin', p.name, p.enabledFor)}
        </div>
      ))}
    </div>
  )
}

/** Scheda Marketplace: elenco dei marketplace registrati, aggiungi (owner/repo o URL git) o rimuovi. Il BOT non può. */
function MarketplaceTab() {
  const { t } = useLingui()
  const [list, setList] = useState<Array<{ name: string; source: string; kind: string; official: boolean }> | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const refresh = async (): Promise<void> => setList(await api.marketplaceList())
  useEffect(() => { void refresh() }, [])
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <Trans>Plugin nel formato di Claude Code. Predefinito: <code>anthropics/claude-plugins-official</code> (puoi rimuoverlo). Di un plugin Homun importa SOLO skill e server MCP; hook, bin/ e comandi non girano mai.</Trans>
      </p>
      {(list ?? []).map((m) => (
        <div key={m.source} className="flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2">
          <span className="text-sm text-foreground">{m.name}</span>
          {m.official && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"><Trans>marketplace ufficiale</Trans></span>}
          <span className="flex-1 truncate text-xs text-muted-foreground">{m.source}</span>
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.marketplaceRemove(m.source); await refresh() }}><Trans>rimuovi</Trans></button>
        </div>
      ))}
      <div className="flex gap-1">
        <input
          className="min-w-0 flex-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs outline-none"
          placeholder={t`owner/repo di GitHub oppure URL git https`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          className="rounded-lg bg-accent px-2.5 py-1.5 text-xs text-white hover:bg-muted-foreground/40 disabled:opacity-40"
          disabled={!input.trim()}
          onClick={async () => {
            setError('')
            try {
              await api.marketplaceAdd(input.trim())
              setInput('')
              await refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          <Trans>aggiungi</Trans>
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** Scheda Gateway (punto 7): un server MCP remoto di aggregazione, preset come dati, chiavi cifrate. */
function GatewayTab() {
  const { t } = useLingui()
  const [presets, setPresets] = useState<Array<{ id: string; name: string; auth: string; headerName?: string; help: string }> | null>(null)
  const [warning, setWarning] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    void api.connectorsGatewayPresets().then((r) => { setPresets(r.presets); setWarning(r.warning) }).catch(() => setPresets([]))
  }, [])
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{warning || t`Un gateway custodisce l'accesso a tutte le app che colleghi lì: è un servizio di terzi`}</p>
      <div className="flex flex-wrap gap-1">
        {(presets ?? []).map((p) => (
          <button
            key={p.id}
            className="rounded-lg border border-border px-2 py-1 text-[11px] text-foreground hover:border-primary hover:text-primary"
            onClick={() => { setName(p.name); setUrl(''); setToken('') }}
            title={p.help}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="space-y-2 rounded-2xl border border-border bg-card p-3">
        <div className="grid grid-cols-2 gap-2">
          <input className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome (es. Composio)`} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`URL https del server MCP`} value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" type="password" placeholder={t`chiave / token Bearer (salvata cifrata)`} value={token} onChange={(e) => setToken(e.target.value)} />
        {(presets ?? []).find((p) => p.name === name)?.help && (
          <p className="text-[11px] text-muted-foreground">{presets!.find((p) => p.name === name)!.help}</p>
        )}
        <button
          className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
          disabled={!name.trim() || !url.trim().startsWith('https://') || !token.trim()}
          onClick={async () => {
            setError('')
            const preset = (presets ?? []).find((p) => p.name === name)
            try {
              // il preset dice SOLO nome header e testo d'aiuto (dati, nessuna chiamata API)
              await api.connectorsAddGateway({
                name: name.trim(), url: url.trim(),
                auth: preset?.auth === 'bearer' ? 'bearer' : 'headers',
                ...(preset ? { preset: preset.id } : {}),
                ...(preset?.headerName ? { headerName: preset.headerName, headers: { [preset.headerName]: token.trim() } } : { headers: { Authorization: `Bearer ${token.trim()}` } })
              })
              setName(''); setUrl(''); setToken('')
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          <Trans>aggiungi gateway</Trans>
        </button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}

function ConnectorTile({ c }: { c: ConnectorInfo }) {
  const { t, i18n } = useLingui()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [instructions, setInstructions] = useState(c.state.instructions)

  const toggleTool = async (tool: string, disabled: boolean): Promise<void> => {
    const next = disabled
      ? c.state.disabledTools.filter((t) => t !== tool)
      : [...c.state.disabledTools, tool]
    await api.connectorsSetTools(c.id, next)
  }

  return (
    <div className="rounded-2xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-base">{c.logo}</span>
        <span className="text-sm text-foreground">{c.name}</span>
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.state.status]}`} title={c.state.error ?? i18n.t(STATUS_LABEL[c.state.status] ?? msg`errore`)} />
        <span className="text-[10px] uppercase text-muted-foreground">{i18n.t(STATUS_LABEL[c.state.status] ?? msg`errore`)}</span>
        <div className="flex-1" />
        {c.state.status === 'connected' ? (
          <>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
              {open ? <Trans>chiudi</Trans> : <Trans>tool</Trans>}
            </button>
            <button
              className="text-xs text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try { await api.connectorsDisconnect(c.id) } finally { setBusy(false) }
              }}
            >
              <Trans>disconnetti</Trans>
            </button>
          </>
        ) : (
          <button
            className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await api.connectorsConnect(c.id) } finally { setBusy(false) }
            }}
          >
            {busy ? <Trans>autorizza nel browser…</Trans> : c.state.status === 'needs_auth' ? <Trans>riconnetti</Trans> : <Trans>connetti</Trans>}
          </button>
        )}
      </div>
      {c.state.error && <p className="mt-1 text-[11px] text-destructive/80">{c.state.error}</p>}
      {/* fase 17c (C5): le note del catalogo nella lingua dell'interfaccia */}
      {c.state.status !== 'connected' && c.notes && (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{pickLang(c.notes, uiLang())}</p>
      )}

      {/* client OAuth statico (Google): credenziali cifrate, guida in docs/google-oauth.md */}
      {c.clientRegistration === 'static' && c.state.status !== 'connected' && (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {c.hasStaticCredentials ? (
            <p className="text-[11px] text-muted-foreground"><Trans>Client OAuth configurato ✓</Trans></p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                <Trans>Serve un client OAuth tuo (tipo "Desktop app"):</Trans>{' '}
                <a className="text-primary hover:underline" href={c.docsUrl} target="_blank" rel="noreferrer">{t`guida`}</a>{' '}
                {' · docs/google-oauth.md'}
              </p>
              <div className="flex gap-1">
                <input
                  className="min-w-0 flex-1 rounded-lg bg-muted px-2 py-1 text-xs outline-none"
                  placeholder="client_id"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
                <input
                  className="min-w-0 flex-1 rounded-lg bg-muted px-2 py-1 text-xs outline-none"
                  type="password"
                  placeholder="client_secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
                <button
                  className="rounded-lg bg-accent px-2 py-1 text-xs text-white hover:bg-muted-foreground/40 disabled:opacity-40"
                  disabled={!clientId.trim() || !clientSecret.trim()}
                  onClick={() => void api.connectorsSaveStaticClient(c.id, clientId.trim(), clientSecret.trim())}
                >
                  <Trans>salva</Trans>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {open && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {/* tool del connettore: interruttore per ognuno (i disattivati non sono offerti al modello) */}
          {c.tools.length === 0 && <p className="text-[11px] text-muted-foreground"><Trans>nessun tool elencato</Trans></p>}
          {c.tools.map((t) => {
            const disabled = c.state.disabledTools.includes(t.name)
            return (
              <label key={t.name} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 accent-foreground"
                  checked={!disabled}
                  onChange={() => void toggleTool(t.name, disabled)}
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px] text-foreground">{t.name}</span>
                  <span className="block text-[10px] text-muted-foreground">{t.description}</span>
                </span>
              </label>
            )
          })}
          {/* istruzioni personalizzate: iniettate nel system prompt quando il connettore è attivo */}
          <div>
            <p className="mb-1 text-[11px] text-muted-foreground"><Trans>Istruzioni personalizzate (vanno nel prompt del bot quando il connettore è attivo)</Trans></p>
            <textarea
              className="w-full resize-none rounded-lg bg-muted px-2 py-1.5 text-xs outline-none"
              rows={3}
              placeholder={t`es. Usa questo account solo per lavoro; le email in italiano vanno riassunte in bulleted list…`}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => void api.connectorsSetInstructions(c.id, instructions)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** Server MCP aggiunti a mano: restano nella stessa vista "Connetti app". */
function ManualServers() {
  const { t } = useLingui()
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [secrets, setSecrets] = useState<string[]>([])
  const [edit, setEdit] = useState<McpServerInfo | null>(null)
  // fase 5: bearer token del server manuale (salvato CIFRATO, mai nei settings)
  const [editBearer, setEditBearer] = useState('')
  const [tests, setTests] = useState<Record<string, { ok: boolean; error?: string; tools?: string[] }>>({})
  const [secName, setSecName] = useState('')
  const [secValue, setSecValue] = useState('')

  const refresh = async () => {
    setServers(await api.mcpList())
    setSecrets(await api.vaultList())
  }
  useEffect(() => { void refresh() }, [])

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground"><Trans>Server MCP manuali (stdio o HTTP, con header/bearer salvati cifrati).</Trans></p>
      {servers.map((s) => (
        <div key={s.id} className="rounded-2xl border border-border bg-card px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${s.enabled ? 'bg-chart-2' : 'bg-muted-foreground/40'}`} />
            <span className="text-sm text-foreground">{s.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{s.transport}</span>
            {s.auth && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-primary">{s.auth.kind}</span>}
            <span className="flex-1 truncate text-xs text-muted-foreground">{s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</span>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={async () => {
              setTests((p) => ({ ...p, [s.id]: { ok: true, tools: ['test…'] } }))
              const r = await api.mcpTest(s.id)
              setTests((p) => ({ ...p, [s.id]: r }))
            }}><Trans>test</Trans></button>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setEdit(s); setEditBearer('') }}><Trans>modifica</Trans></button>
            <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.mcpDelete(s.id); await refresh() }}><Trans>elimina</Trans></button>
          </div>
          {tests[s.id] && (
            <div className={`mt-2 text-xs ${tests[s.id].ok ? 'text-chart-2' : 'text-destructive'}`}>
              {tests[s.id].ok ? t`✓ ${tests[s.id].tools?.length ?? 0} tool: ${(tests[s.id].tools ?? []).join(', ').slice(0, 200)}` : t`✕ ${tests[s.id].error ?? ''}`}
            </div>
          )}
        </div>
      ))}
      {edit ? (
        <div className="space-y-2 rounded-2xl border border-border bg-muted p-3">
          <div className="grid grid-cols-2 gap-2">
            <input className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome (es. weather)`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <select className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" value={edit.transport} onChange={(e) => setEdit({ ...edit, transport: e.target.value as 'stdio' | 'http' })}>
              <option value="stdio">{t`stdio (comando locale)`}</option>
              <option value="http">{t`http (URL)`}</option>
            </select>
          </div>
          {edit.transport === 'stdio' ? (
            <div className="grid grid-cols-2 gap-2">
              <input className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Comando (es. node)`} value={edit.command ?? ''} onChange={(e) => setEdit({ ...edit, command: e.target.value })} />
              <input className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Argomenti separati da spazio`} value={(edit.args ?? []).join(' ')} onChange={(e) => setEdit({ ...edit, args: e.target.value ? e.target.value.split(/\s+/) : [] })} />
            </div>
          ) : (
            <>
              <input className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`URL (es. http://localhost:3001/mcp)`} value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              <input
                className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
                type="password"
                placeholder={t`Bearer token (opzionale — salvato cifrato)`}
                value={editBearer}
                onChange={(e) => setEditBearer(e.target.value)}
              />
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setEdit(null)}><Trans>Annulla</Trans></button>
            <button
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90"
              onClick={async () => {
                const secret: McpServerSecret | undefined = edit.transport === 'http' && editBearer.trim() ? { bearerToken: editBearer.trim() } : undefined
                await api.mcpSave({ ...edit, id: edit.id || 'mcp_' + Date.now() }, secret)
                setEdit(null); setEditBearer('')
                await refresh()
              }}
            >
              <Trans>Salva</Trans>
            </button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground hover:border-muted-foreground hover:text-foreground" onClick={() => { setEdit({ id: '', name: '', transport: 'stdio', command: '', args: [], enabled: true }); setEditBearer('') }}>
          <Trans>+ Aggiungi server MCP</Trans>
        </button>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground"><Trans>Vault credenziali (AES-256-GCM, chiave master in safeStorage): il bot vede i nomi col tool <code>list-credentials</code> e li usa scrivendo <code>{SECRET_TEMPLATE}</code> nei comandi — i valori non compaiono mai nel transcript.</Trans></p>
        {secrets.map((n) => (
          <div key={n} className="flex items-center gap-2 rounded-lg border border-border px-2 py-2">
            <span className="text-sm text-foreground">🔐 {n}</span>
            <div className="flex-1" />
            <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.vaultDelete(n); await refresh() }}><Trans>elimina</Trans></button>
          </div>
        ))}
        <div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome (es. api_key_github)`} value={secName} onChange={(e) => setSecName(e.target.value)} />
          <input className="min-w-0 flex-1 rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none" type="password" placeholder={t`Valore`} value={secValue} onChange={(e) => setSecValue(e.target.value)} />
          <button className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40" disabled={!secName.trim() || !secValue} onClick={async () => { await api.vaultStore(secName.trim(), secValue); setSecName(''); setSecValue(''); await refresh() }}><Trans>Salva</Trans></button>
        </div>
      </div>
    </div>
  )
}

// Il runtime dei bot vive in un daemon separato: può partire all'accesso del
// Mac e sopravvivere alla finestra chiusa (LaunchAgent con riavvio sui crash).
// Fase 6: fuso orario, finestre di consegna, rientro/pausa per assenza e
// notifiche per agente.
function GeneralTab() {
  const { t, i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  // fase 16 (U0): il selettore del tema (setting ui.theme)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  // fase 17a (L6): il selettore della lingua (setting ui.language)
  const uiLanguage = useStore((s) => s.uiLanguage)
  const setUiLanguage = useStore((s) => s.setUiLanguage)
  const [atLogin, setAtLogin] = useState(false)
  const [busy, setBusy] = useState(false)
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
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
        <span className="text-sm"><Trans>Tema</Trans></span>
        <div className="flex gap-1 rounded-full bg-muted p-1">
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
      <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
        <span className="text-sm"><Trans>Lingua</Trans></span>
        <div className="flex gap-1 rounded-full bg-muted p-1">
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

      {libStats?.warn && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <Trans>Libreria: {(libStats.bytes / 1024 / 1024 / 1024).toFixed(1)} GB — oltre i 2 GB consigliati. Valuta cosa cancellare dalla vista Libreria (nessun blocco automatico).</Trans>
        </p>
      )}

      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-foreground"
          checked={atLogin}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="space-y-1">
          <span className="block text-sm text-foreground"><Trans>Avvia all'accesso</Trans></span>
          <span className="block text-xs text-muted-foreground">
            <Trans>Il daemon dei Bot parte quando accedi al Mac e resta attivo con la finestra chiusa (LaunchAgent con riavvio automatico dopo un crash). Puoi disattivarlo qui.</Trans>
          </span>
        </span>
      </label>

      <div className="space-y-2 rounded-2xl border border-border bg-card px-4 py-3">
        <p className="text-sm text-foreground"><Trans>Consegna e presenza</Trans></p>
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

      <div className="space-y-2 rounded-2xl border border-border bg-card px-4 py-3">
        <p className="text-sm text-foreground"><Trans>Notifiche per agente</Trans></p>
        {agents.map((a) => {
          const off = disabledNotifications.includes(a.id)
          return (
            <label key={a.id} className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="text-foreground">{a.name}</span>
              <button
                className={`rounded-lg px-2 py-1 text-[11px] ${off ? 'bg-muted text-muted-foreground' : 'bg-chart-2/15 text-chart-2'}`}
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

// ---- fase 9 (punto 1): modelli del provider (predefinito, riserva, auto-review) ----

interface ModelOverrides { defaultModel?: string; fallbackModel?: string; autoReviewModel?: string }

/**
 * I tre modelli configurabili per provider: il predefinito va ai bot nuovi
 * (onboarding e template), la riserva rileva i turni quando il principale non
 * risponde, il revisore giudica le approvazioni automatiche. Salvati nel
 * setting 'providers.modelDefaults' (chiave = id del provider).
 * Fase 10 (residuo 0d): senza override il selettore mostra il default
 * EFFETTIVO del provider (es. "predefinito: kimi-k3:cloud").
 */
function ModelDefaultsRow({ p }: { p: ProviderConfig }) {
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
  // fase 18b (H5.3): il selettore a combobox (ricerca, capacità e prezzi in
  // vista); il testo libero resta possibile per i modelli non ancora a catalogo
  const picker = (role: keyof ModelOverrides, label: string): ReactNode => (
    <ModelPicker
      className="min-w-44"
      models={models ?? []}
      value={saved[role] ?? ''}
      placeholder={saved[role] ? label : effLabel(role, label)}
      onChange={(m) => void save({ [role]: m ?? undefined } as ModelOverrides)}
    />
  )

  if (models === null) return <div className="mt-2 text-xs text-muted-foreground"><Trans>modelli…</Trans></div>
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>modelli</Trans></span>
      {picker('defaultModel', t`predefinito`)}
      {picker('fallbackModel', t`riserva`)}
      {picker('autoReviewModel', t`auto-review`)}
    </div>
  )
}

/**
 * Fase 11 (punto 2): campo "chiave per la ricerca web" del provider Ollama.
 * Il valore va SOLO nel vault sigillato: la UI non lo rilegge mai, chiede al
 * daemon se la chiave è impostata (booleano).
 */
function WebSearchKeyRow({ p }: { p: ProviderConfig }) {
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
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>ricerca web</Trans></span>
      <input
        className="w-56 rounded-lg bg-muted px-2 py-1.5 text-xs outline-none"
        type="password"
        placeholder={set ? t`chiave salvata (scrivi per sostituirla)` : t`chiave per la ricerca web di Ollama`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className="rounded-lg bg-accent px-2.5 py-1.5 text-xs hover:bg-muted-foreground/40 disabled:opacity-50"
        disabled={busy || !value.trim()}
        onClick={() => void save(value.trim())}
      >
        <Trans>Salva chiave</Trans>
      </button>
      {set && (
        <button
          className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
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
 * Fase 15 (S5): sezione "Ricerca web" — l'interruttore dei servizi senza
 * chiave (You.com, Exa, Tavily), la nota sulla privacy coi link ai termini e
 * lo stato per provider (disponibile / in raffreddamento fino a HH:MM /
 * ultimo errore) dall'RPC di sola lettura websearch:status.
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
      return {
        text: t`ultimo errore: ${p.lastError.kind}${p.lastError.status !== undefined ? t` (HTTP ${p.lastError.status})` : ''}`,
        cls: 'text-muted-foreground'
      }
    }
    return { text: t`disponibile`, cls: 'text-chart-2' }
  }

  return (
    <div className="rounded-2xl border border-border bg-card px-3 py-2.5">
      <div className="text-sm text-foreground"><Trans>Ricerca web</Trans></div>
      <label className="mt-2 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-foreground"
          checked={keyless ?? true}
          disabled={keyless === null}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="space-y-1">
          <span className="block text-xs text-foreground">
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

function ProvidersTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const [edit, setEdit] = useState<ProviderConfig | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error?: string; models?: ModelInfo[] }>>({})

  async function scan() {
    await api.discoverProviders()
    await onChanged()
  }

  async function test(id: string) {
    setTesting(id)
    const r = await api.testProvider(id)
    setTestResult((p) => ({ ...p, [id]: r }))
    setTesting(null)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground"><Trans>Provider locali e cloud — chiunque parli OpenAI-compatible funziona.</Trans></p>
        <button className="rounded-lg bg-muted px-3 py-1.5 text-xs hover:bg-accent" onClick={() => void scan()}>
          <Trans>Scansiona locale (Ollama / LM Studio)</Trans>
        </button>
      </div>

      {providers.map((p) => (
        <div key={p.id} className="rounded-2xl border border-border bg-card px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-chart-2" />
            <span className="text-sm text-foreground">{p.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{p.kind}</span>
            <span className="flex-1 truncate text-xs text-muted-foreground">{p.baseUrl}</span>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setEdit(p)}><Trans>modifica</Trans></button>
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void test(p.id)}
              disabled={testing === p.id}
            >
              {testing === p.id ? t`test…` : t`test`}
            </button>
            <button
              className="text-xs text-muted-foreground hover:text-destructive"
              onClick={async () => {
                await api.deleteProvider(p.id)
                await onChanged()
              }}
            >
              <Trans>elimina</Trans>
            </button>
          </div>
          {testResult[p.id] && (
            <div className={`mt-2 text-xs ${testResult[p.id].ok ? 'text-chart-2' : 'text-destructive'}`}>
              {testResult[p.id].ok
                ? i18n.t(plural(testResult[p.id].models?.length ?? 0, { one: '✓ # modello disponibile', other: '✓ # modelli disponibili' }))
                : t`✕ ${testResult[p.id].error ?? ''}`}
            </div>
          )}
          <ModelDefaultsRow p={p} />
          {p.kind === 'ollama' && <WebSearchKeyRow p={p} />}
        </div>
      ))}

      {/* fase 18b (H5.4): l'editor della catena delle riserve tra provider */}
      <FallbackChainSection />

      {/* fase 15 (S5): la ricerca senza chiave, accanto alla riga della chiave Ollama */}
      <WebSearchSection />

      {edit ? (
        <ProviderForm
          initial={edit}
          onSave={async (p) => {
            await api.saveProvider(p)
            setEdit(null)
            await onChanged()
          }}
          onCancel={() => setEdit(null)}
        />
      ) : (
        <button
          className="w-full rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground hover:border-muted-foreground hover:text-foreground"
          onClick={() =>
            setEdit({ id: '', name: '', kind: 'openai-compatible', baseUrl: 'https://', apiKey: '', enabled: true })
          }
        >
          <Trans>+ Aggiungi provider</Trans>
        </button>
      )}
    </div>
  )
}

function ProviderForm({ initial, onSave, onCancel }: { initial: ProviderConfig; onSave: (p: ProviderConfig) => Promise<void>; onCancel: () => void }) {
  const { t } = useLingui()
  const [p, setP] = useState(initial)
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-muted p-3">
      <div className="grid grid-cols-2 gap-2">
        <input
          className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
          placeholder={t`Nome (es. Z.ai)`}
          value={p.name}
          onChange={(e) => setP({ ...p, name: e.target.value })}
        />
        <select
          className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
          value={p.kind}
          onChange={(e) => setP({ ...p, kind: e.target.value as ProviderKind })}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>
      <input
        className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
        placeholder={t`Base URL (es. https://api.z.ai)`}
        value={p.baseUrl}
        onChange={(e) => setP({ ...p, baseUrl: e.target.value })}
      />
      <input
        className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
        placeholder={t`API key (vuoto per locali)`}
        type="password"
        value={p.apiKey}
        onChange={(e) => setP({ ...p, apiKey: e.target.value })}
      />
      <div className="flex justify-end gap-2 pt-1">
        <button className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={onCancel}>
          <Trans>Annulla</Trans>
        </button>
        <button
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90"
          onClick={() => void onSave({ ...p, id: p.id || p.kind + '_' + Date.now() })}
        >
          <Trans>Salva</Trans>
        </button>
      </div>
    </div>
  )
}

function AgentsTab() {
  const { t, i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const providers = useStore((s) => s.providers)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const setMainAgent = useStore((s) => s.setMainAgent)
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})
  // fase 7: catalogo dei template (creazione bot col kickstart)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])

  useEffect(() => {
    for (const p of providers) {
      if (!models[p.id]) {
        api.listModels(p.id).then((ms: ModelInfo[]) => setModels((prev) => ({ ...prev, [p.id]: ms }))).catch(() => {})
      }
    }
  }, [providers])
  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => undefined)
  }, [])

  // fase 9 (punto 1): il rifiuto della capability "tools" (o qualunque errore
  // di agents:update) si mostra sotto la riga del bot, non si perde in console
  const [agentError, setAgentError] = useState<Record<string, string>>({})
  async function patch(a: Agent, p: Partial<Agent>) {
    try {
      await api.updateAgent(a.id, p)
      setAgentError((prev) => ({ ...prev, [a.id]: '' }))
    } catch (e) {
      setAgentError((prev) => ({ ...prev, [a.id]: e instanceof Error ? e.message : String(e) }))
    }
  }

  // fase 7: senza setting mainAgentId il principale è il primo agente
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground"><Trans>Scegli con quale modello pensa ciascun bot.</Trans></p>
      {agents.map((a) => (
        <div key={a.id} className="rounded-2xl border border-border bg-card px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{a.name}</span>
            {a.id === effectiveMain ? (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary" title={t`Punto di contatto principale dell'utente: coordina gli altri bot`}>
                <Trans>★ principale</Trans>
              </span>
            ) : (
              <button
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t`Rendi questo bot il punto di contatto principale dell'utente`}
                onClick={() => void setMainAgent(a.id)}
              >
                <Trans>Rendi principale</Trans>
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
              value={a.providerId ?? ''}
              onChange={async (e) => {
                const pid = e.target.value || null
                await patch(a, { providerId: pid, model: null })
              }}
            >
              <option value="">{t`— provider —`}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {/* fase 18b (H5.3): combobox con ricerca, capacità e prezzi */}
            <ModelPicker
              models={models[a.providerId ?? ''] ?? []}
              value={a.model}
              placeholder={t`— modello —`}
              disabled={!a.providerId}
              onChange={(m) => void patch(a, { model: m })}
            />
          </div>
          {/* fase 18b (H3): il livello di ragionamento del bot — Predefinito +
              i livelli del modello scelto; nascosto se il modello non è
              controllabile. Se il livello salvato non è più supportato si
              mostra Predefinito MA il dato non si riscrive (l'adattatore clampa) */}
          {(() => {
            const chosen = (models[a.providerId ?? ''] ?? []).find((m) => m.id === a.model)
            const levels = chosen?.thinkingLevels ?? []
            if (levels.length === 0) return null
            const savedLevel = levels.includes((a.thinking ?? 'default') as ThinkingSetting) ? (a.thinking ?? 'default') : 'default'
            return (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t`ragionamento`}</span>
                <select
                  className="rounded-lg bg-muted px-2 py-1.5 text-xs outline-none"
                  value={savedLevel}
                  onChange={(e) => void patch(a, { thinking: e.target.value as ThinkingSetting })}
                >
                  {['default', ...levels].map((l) => (
                    <option key={l} value={l}>{i18n.t(THINKING_LABELS[l]!)}</option>
                  ))}
                </select>
              </div>
            )
          })()}
          <input
            className="mt-2 w-full rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
            placeholder={t`Descrizione / ruolo del bot (va nel system prompt)`}
            defaultValue={a.description}
            onBlur={async (e) => void patch(a, { description: e.target.value })}
          />
          {agentError[a.id] ? (
            <div className="mt-1.5 text-xs text-destructive">✕ {agentError[a.id]}</div>
          ) : null}
        </div>
      ))}

      {templates.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            <Trans>Crea un bot da template: parte con un messaggio di configurazione che crea routine (in pausa), memorie e domande di attivazione.</Trans>
          </p>
          <div className="grid grid-cols-2 gap-2">
            {templates.map((t) => (
              <button
                key={t.id}
                className="rounded-2xl border border-border bg-card px-3 py-2 text-left hover:border-border"
                onClick={async () => {
                  try {
                    await api.createAgentFromTemplate(t.id)
                  } catch (e) {
                    console.error('createAgentFromTemplate:', e instanceof Error ? e.message : e)
                  }
                }}
                title={pickLang(t.description, uiLang())}
              >
                <span className="mr-1">{t.avatar}</span>
                <span className="text-sm text-foreground">{pickLang(t.name, uiLang())}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{pickLang(t.description, uiLang())}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PermissionsTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t } = useLingui()
  const permissions = useStore((s) => s.permissions)
  if (!permissions) return null
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <Trans>Regole per tool: consenti sempre / chiedi / blocca. "Consenti sempre" nelle card salva una standing grant.</Trans>
      </p>
      <div className="rounded-2xl border border-border bg-card px-3 py-2.5">
        <label className="flex items-center justify-between text-sm">
          <span className="text-foreground"><Trans>Politica predefinita</Trans></span>
          <select
            className="rounded-lg bg-muted px-2.5 py-1.5 text-sm outline-none"
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
        <div key={i} className="flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2.5">
          <span className="w-36 font-mono text-xs text-foreground">{r.tool}</span>
          <span className="w-24 font-mono text-xs text-muted-foreground">{r.pattern}</span>
          <div className="flex-1" />
          <select
            className="rounded-lg bg-muted px-2.5 py-1.5 text-xs outline-none"
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
    </div>
  )
}

// ---- fase 6: tab Routine con trigger in linguaggio naturale, prossima
// esecuzione, stato (attiva / in pausa / in pausa per assenza) e editor dei
// tipi di trigger (schedule, email, calendar_event, webhook, poll avanzato) ----

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
    await api.updateRoutineTrigger(r.id, r.enabled ? { enabled: 0 } : { enabled: 1, paused_for_away: 0 })
    await refresh()
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <Trans>Le routine sono attività automatiche del Bot: su orario (cron o "ogni giorno alle 9, circa"), su un'email in arrivo, prima di un evento del calendario, da un webhook o quando torni al computer. I loro messaggi non urgenti aspettano la finestra di consegna.</Trans>
      </p>

      {routines.map((r) => {
        const state = r.enabled ? t`attiva` : r.paused_for_away ? t`in pausa per assenza` : t`in pausa`
        const stateColor = r.enabled ? 'text-chart-2' : r.paused_for_away ? 'text-destructive' : 'text-muted-foreground'
        return (
          <div key={r.id} className="rounded-2xl border border-border bg-card px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${r.enabled ? 'bg-chart-2' : r.paused_for_away ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
              <span className="text-sm text-foreground">{r.title}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{i18n.t(KIND_LABEL[kindOf(r.trigger)])}</span>
              <div className="flex-1" />
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
              <div className="mt-1 flex items-center gap-2 rounded-lg border border-border bg-muted px-2 py-1.5">
                <code className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{r.webhook_url}</code>
                <code className="hidden truncate text-[10px] text-muted-foreground" title={`Authorization: Bearer ${r.trigger?.type === 'webhook' ? r.trigger.token : ''}`}>
                  {r.trigger?.type === 'webhook' ? r.trigger.token.slice(0, 10) + '…' : ''}
                </code>
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
            onCreate={async (title, prompt, trigger, timezone) => {
              setErr('')
              try {
                await api.createRoutineTrigger(activeId!, title, prompt, trigger, timezone || undefined)
                await refresh()
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e))
              }
            }}
            err={err}
          />
          <div className="space-y-2 border-t border-border pt-2">
            <button
              className="rounded-lg bg-muted px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-40"
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
              <div key={i} className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">{s.title}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.schedule}</code>
                  <div className="flex-1" />
                  <button
                    className="rounded-md bg-chart-2/70 px-2 py-1 text-xs text-white hover:bg-chart-2/80"
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
          className="w-full rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground hover:border-muted-foreground hover:text-foreground"
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
    <div className="space-y-2 rounded-2xl border border-border bg-muted p-3">
      <div className="flex gap-1">
        {(Object.keys(KIND_LABEL) as TriggerKind[]).map((k) => (
          <button
            key={k}
            className={`rounded-lg px-2 py-1 text-[11px] ${kind === k ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button className={`rounded-lg px-2 py-1 ${cron !== '' ? 'bg-accent' : ''}`} onClick={() => { setCron('0 9 * * *') }}>{t`cron`}</button>
            <button className={`rounded-lg px-2 py-1 ${cron === '' ? 'bg-accent' : ''}`} onClick={() => setCron('')}>{t`ogni…`}</button>
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
                <label className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive/90">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmReadOnly}
                    onChange={(e) => setConfirmReadOnly(e.target.checked)}
                  />
                  <Trans>Confermo che questo tool legge soltanto e non modifica nulla (server aggiunto a mano: la dichiarazione "sola lettura" non è verificata)</Trans>
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
      <div className="space-y-2 rounded-lg border border-border bg-card px-2 py-2">
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
        <button className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={props.onCancel}><Trans>Annulla</Trans></button>
        <button
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
          disabled={busy || !title.trim() || !prompt.trim() || !props.agentId || (!!modelProvider && !modelId.trim())}
          onClick={() => void save()}
        >
          {r ? <Trans>Salva</Trans> : <Trans>Crea routine</Trans>}
        </button>
      </div>
    </div>
  )
}
