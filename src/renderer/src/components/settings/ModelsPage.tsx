// Fase impostazioni (I2): la pagina Modelli rifatta sul modello di Rakazo —
// TITOLO + TRE GRUPPI, nient'altro: «Modello dei bot» (principale + riserve
// come righe, «+ Aggiungi riserva»), «Modello delle approvazioni» (una riga,
// «Nessuno» compreso) e «Provider» (una riga per provider che SI APRE sul
// posto, «+ Aggiungi provider»). Via la frase introduttiva, il paragrafo sul
// 429, la colonna fissa «Aggiungi un modello» e i default per provider
// (I3: providers.modelDefaults non si scrive più dall'interfaccia).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { api, useStore } from '../../store'
import type {
  ApprovalsMode, AutoReviewSettings, FallbackRoute,
  LocalModelStatusRpc, ModelInfo, ProviderPublic, WebSearchStatusRpc, WebSearchProviderStatusRpc
} from '../../../../shared/types'
import { DEFAULT_AUTO_REVIEW, approvalsModeOf } from '../../../../shared/types'
import { providerPlace } from '../../../../shared/network-host'
import { fmtUsd as fmtUsdIn } from '../../lib/fmt'
import { nextModelProbe, EMPTY_MODEL_PROBE, type ModelProbeState } from '../../lib/model-probe'
import { moveFallback, removeFallback, reviewerMissing, localModelCardActions } from '../../lib/models-page'
import { ModelSelect } from '../ui/ModelSelect'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { SettingsPage } from './SettingsPage'
import { SettingsGroup } from './SettingsGroup'
import { AddProviderSheet, ProviderMark } from './AddProviderSheet'
// K4: il tetto della catena delle riserve, lo stesso del daemon
import { MAX_CHAIN_ENTRIES } from '../../../../main/agent/model-fallback'

/** L'inizio del mese corrente in ora locale (il costo «questo mese»). */
function monthStart(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

/** Il filetto tra le righe di una scheda (stessa regola di SettingsRow). */
const ROW = 'border-t border-border/40 [&:first-child]:border-0'

export function ModelsPage() {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const mainModel = useStore((s) => s.mainModel)
  const setMainModel = useStore((s) => s.setMainModel)
  const [chain, setChain] = useState<FallbackRoute[] | null>(null)
  const [reviewer, setReviewer] = useState<AutoReviewSettings | null>(null)
  const [mode, setMode] = useState<ApprovalsMode | undefined>(undefined)
  const [monthCost, setMonthCost] = useState<number | null>(null)
  // lo stato dei provider (providers:test), come oggi
  const [tests, setTests] = useState<Record<string, { ok: boolean; models?: ModelInfo[] }>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const locale = i18n.locale
  const usd = (n: number): string => fmtUsdIn(n, locale)

  useEffect(() => {
    void api.settingsGet<FallbackRoute[]>('models.fallbackChain', []).then(setChain).catch(() => setChain([]))
    void api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).then(setReviewer).catch(() => setReviewer({ ...DEFAULT_AUTO_REVIEW }))
    void api.settingsGet<ApprovalsMode | undefined>('approvals.mode', undefined).then(setMode).catch(() => setMode(undefined))
  }, [])
  useEffect(() => {
    void api.usageSummary(monthStart(), undefined, 'model')
      .then((rows) => setMonthCost(rows.reduce((a, r) => a + (r.costUsd ?? 0), 0)))
      .catch(() => setMonthCost(null))
  }, [])

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
  const retry = (id: string): void => {
    setTesting(id)
    void api.testProvider(id)
      .then((r) => setTests((prev) => ({ ...prev, [id]: r })))
      .catch(() => setTests((prev) => ({ ...prev, [id]: { ok: false } })))
      .finally(() => setTesting(null))
  }

  const persistChain = (next: FallbackRoute[]): void => {
    setChain(next)
    void api.settingsSet('models.fallbackChain', next)
  }
  const effectiveMode = reviewer ? approvalsModeOf(reviewer, mode) : 'ask'
  const missingReviewer = reviewer ? reviewerMissing(effectiveMode, reviewer) : false

  /** mezza riga del provider («Sul tuo Mac · 26 modelli · gratis e privato»…) */
  const placeLine = (p: ProviderPublic): React.ReactNode => {
    const outcome = tests[p.id]
    const modelsCount = outcome?.models?.length
    const place = providerPlace(p)
    if (place === 'mac') {
      return modelsCount === 1
        ? <Trans>Sul tuo Mac · 1 modello · gratis e privato</Trans>
        : <Trans>Sul tuo Mac · {modelsCount ?? '…'} modelli · gratis e privato</Trans>
    }
    if (place === 'rete') {
      return modelsCount === 1
        ? <Trans>Sulla tua rete · 1 modello</Trans>
        : <Trans>Sulla tua rete · {modelsCount ?? '…'} modelli</Trans>
    }
    return p.hasKey ? <Trans>Chiave API · a consumo</Trans> : <Trans>Server esterno</Trans>
  }

  return (
    <SettingsPage title={<Trans>Modelli</Trans>}>
      {/* ---- I2.1 · Modello dei bot ---- */}
      <SettingsGroup
        label={<Trans>Modello dei bot</Trans>}
        footer={<Trans>Se il modello non risponde, i bot passano alla riserva.</Trans>}
      >
        <div className={`px-4 py-3 ${ROW}`}>
          <ModelSelect
            value={mainModel && mainModel.model ? { providerId: mainModel.providerId, model: mainModel.model } : null}
            onChange={(r) =>
              void setMainModel(r ? { providerId: r.providerId, model: r.model, thinking: null } : null)}
            thinking={mainModel?.thinking ?? 'default'}
            onThinking={(level) => mainModel && void setMainModel({ ...mainModel, thinking: level })}
            ariaLabel={i18n._(msg`Il cervello dei bot`)}
          />
        </div>
        {chain?.map((r, i) => {
          const p = providers.find((x) => x.id === r.providerId)
          return (
            <div key={`${r.providerId}|${r.model}|${i}`} className={`flex items-center gap-1.5 px-4 py-3 ${ROW} ${p && !p.enabled ? 'opacity-60' : ''}`}>
              <span className="shrink-0 text-[13px] text-muted-foreground">{i + 1}.</span>
              <ModelSelect
                className="min-w-0 flex-1"
                value={r.model ? r : null}
                onChange={(next) => persistChain(chain.map((x, j) => (j === i ? (next ?? { providerId: '', model: '' }) : x)))}
                ariaLabel={t`Riserva ${i + 1}`}
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label={i18n._(msg`Altre azioni`)}
                >
                  <span className="text-sm">⋯</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={i === 0} onClick={() => persistChain(moveFallback(chain, i, -1))}>
                    <Trans>Sposta su</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={i === chain.length - 1} onClick={() => persistChain(moveFallback(chain, i, 1))}>
                    <Trans>Sposta giù</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => persistChain(removeFallback(chain, i))}>
                    <Trans>Rimuovi</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {p && !p.enabled && <span className="shrink-0 text-[10px] text-destructive line-through">{i18n._(msg`provider disattivato`)}</span>}
            </div>
          )
        })}
        {chain !== null && chain.length < MAX_CHAIN_ENTRIES && (
          <button
            type="button"
            className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground transition hover:bg-muted/70 hover:text-foreground ${ROW}`}
            onClick={() => persistChain([...chain, { providerId: '', model: '' }])}
          >
            <Plus className="size-4 shrink-0" />
            <Trans>Aggiungi riserva</Trans>
          </button>
        )}
        {chain === null && <div className={`px-4 py-3 text-sm text-muted-foreground ${ROW}`}>…</div>}
      </SettingsGroup>

      {/* ---- I2.2 · Modello delle approvazioni ---- */}
      {reviewer !== null && (
        <SettingsGroup
          label={<Trans>Modello delle approvazioni</Trans>}
          footer={<Trans>Decide da solo le richieste semplici quando le Approvazioni sono su Automatico.</Trans>}
        >
          <div className={`px-4 py-3 ${ROW}`}>
            <ModelSelect
              value={reviewer.providerId && reviewer.model ? { providerId: reviewer.providerId, model: reviewer.model } : null}
              onChange={(r) => {
                const next = { ...reviewer, providerId: r?.providerId ?? null, model: r?.model ?? null }
                setReviewer(next)
                void api.settingsSet('autoReview', next)
              }}
              allowNone
              placeholder={i18n._(msg`Nessuno`)}
              ariaLabel={i18n._(msg`Modello delle approvazioni`)}
            />
            {missingReviewer && (
              <p className="mt-2 text-[13px] text-amber-600 dark:text-amber-400">
                <Trans>Scegli un modello: senza, Automatico chiede sempre.</Trans>{' '}
                <button
                  className="text-primary transition hover:underline"
                  onClick={() => { setSettingsTab('approvazioni'); setSettingsOpen(true) }}
                >
                  <Trans>Approvazioni ›</Trans>
                </button>
              </p>
            )}
          </div>
        </SettingsGroup>
      )}

      {/* ---- I2.3 · Provider ---- */}
      <SettingsGroup label={<Trans>Provider</Trans>}>
        {providers.map((p) =>
          expanded === p.id ? (
            <ProviderDetail
              key={p.id}
              provider={p}
              onDone={() => { setExpanded(null); void refreshProviders().then(runTests) }}
            />
          ) : (
            <button
              key={p.id}
              type="button"
              className={`flex w-full items-center gap-3.5 px-4 py-3 text-left transition hover:bg-muted/70 ${ROW}`}
              onClick={() => setExpanded(p.id)}
              title={p.name}
            >
              <ProviderMark kind={p.kind} name={p.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{p.name}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{placeLine(p)}</span>
              </span>
              {tests[p.id] === undefined ? (
                <span className="shrink-0 text-[13px] text-muted-foreground">…</span>
              ) : tests[p.id]!.ok ? (
                <span className="shrink-0 text-[14px] text-chart-2"><Trans>Collegato</Trans></span>
              ) : (
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-[14px] text-destructive"><Trans>Non risponde</Trans></span>
                  <button
                    className="rounded-full bg-muted px-2.5 py-1 text-xs transition hover:bg-accent"
                    disabled={testing === p.id}
                    onClick={(e) => { e.stopPropagation(); retry(p.id) }}
                  >
                    {testing === p.id ? <Trans>Provo…</Trans> : <Trans>Riprova</Trans>}
                  </button>
                </span>
              )}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          )
        )}
        <button
          type="button"
          className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground transition hover:bg-muted/70 hover:text-foreground ${ROW}`}
          onClick={() => setAddOpen(true)}
        >
          <Plus className="size-4 shrink-0" />
          <Trans>Aggiungi provider</Trans>
        </button>
        {/* I2.5: una riga discreta, in fondo alla scheda Provider */}
        <button
          type="button"
          className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-muted-foreground transition hover:text-foreground ${ROW}`}
          onClick={() => { setSettingsTab('uso'); setSettingsOpen(true) }}
        >
          {monthCost !== null
            ? <Trans>Uso e costi: {usd(monthCost)} questo mese</Trans>
            : <Trans>Uso e costi</Trans>}
          <span>›</span>
        </button>
      </SettingsGroup>

      {/* ---- fase locale (L4): il modello Integrato ---- */}
      <LocalModelCard />

      {addOpen && (
        <AddProviderSheet
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); runTests() }}
        />
      )}
    </SettingsPage>
  )
}

/**
 * Fase locale (L4.2): la scheda «Integrato» — stato (non installato /
 * download x% / pronto / in esecuzione; LC2: anche in pausa ed errore, con
 * Riprendi e Ricomincia), RAM usata, i pulsanti Installa, Annulla e Rimuovi,
 * e l'avviso onesto. Il download parte SOLO dal consenso esplicito (modello,
 * dimensione, sorgente e licenza mostrati prima del click).
 */
function LocalModelCard() {
  const [st, setSt] = useState<LocalModelStatusRpc | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [freed, setFreed] = useState<number | null>(null)
  // LC2: il rifiuto lato demone (idoneità ricontrollata a install/restart)
  const [installError, setInstallError] = useState<string | null>(null)

  const refresh = (): void => {
    void api.localModelStatus().then(setSt).catch(() => setSt(null))
  }
  useEffect(refresh, [])
  // durante il download si polla più stretto (il progresso è il .part su disco)
  useEffect(() => {
    const ms = st?.state === 'downloading' ? 1000 : 8000
    const t = setInterval(refresh, ms)
    return () => clearInterval(t)
  }, [st?.state])

  if (st === null) {
    return (
      <SettingsGroup label={<Trans>Integrato</Trans>}>
        <div className={`px-4 py-3 text-sm text-muted-foreground ${ROW}`}>…</div>
      </SettingsGroup>
    )
  }
  const m = st.model
  const inProgress = st.state === 'downloading' || st.state === 'paused' || st.state === 'error'
  const pct = inProgress && st.progress && st.progress.total > 0
    ? Math.floor((st.progress.bytes / st.progress.total) * 100)
    : null
  // LC2: Annulla SOLO col download attivo; Riprendi (Range) e Ricomincia
  // (cancella il .part) con paused e con error
  const actions = localModelCardActions(st.state)
  const notEligible = st.eligibility.status === 'unsupported'
  const strong = st.eligibility.status === 'discouraged'
  const noSpace = st.eligibility.status === 'no-space'

  return (
    <SettingsGroup label={<Trans>Integrato</Trans>}>
      <div className={`px-4 py-3 ${ROW}`}>
        <div className="flex items-center gap-2">
          <span className="text-[15px]">{m.label}</span>
          {st.state === 'running' && <span className="rounded-full bg-chart-2/15 px-2 py-0.5 text-[11px] text-chart-2"><Trans>In esecuzione</Trans></span>}
          {st.state === 'ready' && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"><Trans>Pronto</Trans></span>}
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          <Trans>{m.sizeGb} GB · {m.source} · {m.license} · RAM ~{m.ramUseGb} GB</Trans>
        </p>

        {/* l'avviso onesto (L4: la stessa idea dell'onboarding) */}
        {st.state !== 'not-installed' && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            <Trans>Il modello integrato gira sul tuo Mac: niente costi e i dati restano qui. È più lento e sbaglia più spesso dei modelli cloud; per lavori affidabili ti consiglio un modello cloud.</Trans>
          </p>
        )}

        {notEligible && (
          <p className="mt-2 text-[13px] text-destructive"><Trans>Non disponibile su questa macchina.</Trans></p>
        )}
        {strong && (
          <p className="mt-2 text-[13px] text-amber-600 dark:text-amber-400">
            <Trans>Attenzione: con meno di {m.minRamGb} GB di RAM sarà lento e potrebbe bloccare il Mac.</Trans>
          </p>
        )}
        {noSpace && (
          <p className="mt-2 text-[13px] text-amber-600 dark:text-amber-400">
            {st.eligibility.neededGb !== undefined
              ? <Trans>Servono {st.eligibility.neededGb} GB di spazio libero (liberi: {st.eligibility.freeGb ?? '—'}).</Trans>
              : <Trans>Spazio su disco insufficiente.</Trans>}
          </p>
        )}

        {inProgress && (
          <div className="mt-3">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${pct ?? 0}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className={`text-[13px] ${st.state === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {st.state === 'downloading' && <Trans>Download {pct ?? 0}%</Trans>}
                {st.state === 'paused' && <Trans>Download in pausa · {pct ?? 0}%</Trans>}
                {st.state === 'error' && (st.error ?? '')}
              </p>
              <div className="flex items-center gap-2">
                {actions.cancel && (
                  <button
                    className="rounded-full bg-muted px-3 py-1.5 text-xs transition hover:bg-accent"
                    onClick={() => { void api.localModelCancel().then(refresh) }}
                  >
                    <Trans>Annulla</Trans>
                  </button>
                )}
                {actions.resume && (
                  <button
                    className="rounded-full bg-muted px-3 py-1.5 text-xs transition hover:bg-accent"
                    onClick={() => {
                      setInstallError(null)
                      void api.localModelInstall().then((r) => { if (r.error) setInstallError(r.error); refresh() })
                    }}
                  >
                    <Trans>Riprendi</Trans>
                  </button>
                )}
                {actions.restart && (
                  <button
                    className="rounded-full bg-muted px-3 py-1.5 text-xs transition hover:bg-accent"
                    onClick={() => {
                      setInstallError(null)
                      void api.localModelRestart().then((r) => { if (r.error) setInstallError(r.error); refresh() })
                    }}
                  >
                    <Trans>Ricomincia</Trans>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {st.state === 'not-installed' && !notEligible && (
          <div className="mt-3">
            {confirm ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span>
                  <Trans>Installare {m.label} ({m.sizeGb} GB) da {m.source}, licenza {m.license}?</Trans>
                </span>
                <button
                  className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
                  onClick={() => {
                    setConfirm(false)
                    setInstallError(null)
                    void api.localModelInstall().then((r) => { if (r.error) setInstallError(r.error); refresh() })
                  }}
                >
                  <Trans>Installa</Trans>
                </button>
                <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => setConfirm(false)}>
                  <Trans>Annulla</Trans>
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="rounded-full bg-muted px-3 py-1.5 text-xs font-medium transition hover:bg-accent"
                  onClick={() => setConfirm(true)}
                >
                  <Trans>Installa il modello integrato</Trans>
                </button>
                <span className="text-[13px] text-muted-foreground">
                  <Trans>Il modello integrato gira sul tuo Mac: niente costi e i dati restano qui. È più lento e sbaglia più spesso dei modelli cloud. Va bene per prove e cose semplici; per lavori affidabili ti consiglio un modello cloud.</Trans>
                </span>
              </div>
            )}
          </div>
        )}

        {(st.state === 'ready' || st.state === 'running') && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {removing ? (
              <>
                <span className="text-[13px] text-destructive"><Trans>Rimuovere il modello e liberare {m.sizeGb} GB?</Trans></span>
                <button
                  className="rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20"
                  onClick={() => {
                    void api.localModelRemove()
                      .then((r) => { setFreed(r.freedGb); setRemoving(false); refresh() })
                      .catch(() => setRemoving(false))
                  }}
                >
                  <Trans>Rimuovi</Trans>
                </button>
                <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => setRemoving(false)}>
                  <Trans>Annulla</Trans>
                </button>
              </>
            ) : freed !== null ? (
              <span className="text-[13px] text-chart-2"><Trans>Liberati {freed} GB.</Trans></span>
            ) : (
              <button
                className="rounded-full px-3 py-1.5 text-xs text-destructive/90 transition hover:text-destructive"
                onClick={() => setRemoving(true)}
              >
                <Trans>Rimuovi</Trans>
              </button>
            )}
          </div>
        )}

        {installError && (
          <p className="mt-2 text-[13px] text-destructive">{installError}</p>
        )}
        {st.server.lastError && (
          <p className="mt-2 text-[13px] text-destructive">{st.server.lastError}</p>
        )}
      </div>
    </SettingsGroup>
  )
}

/** I2.3: il provider aperto SUL POSTO (niente più foglio EditProviderSheet). */
function ProviderDetail({ provider, onDone }: { provider: ProviderPublic; onDone(): void }) {
  const { t } = useLingui()
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // la prova automatica di oggi, con la chiave GIÀ SALVATA quando non se ne
  // digita una nuova (R2.3): si prova l'indirizzo così com'è
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
    <div className={`px-4 py-3 ${ROW}`}>
      <div className="flex items-center gap-3">
        <ProviderMark kind={provider.kind} name={name || provider.name} />
        <strong className="min-w-0 flex-1 truncate font-display text-base">{name || provider.name}</strong>
        <button
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label={t`Chiudi`}
          onClick={onDone}
        >
          <ChevronDown className="size-4" />
        </button>
      </div>

      <div className="mt-3 space-y-2.5">
        <input
          className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
          placeholder={t`Nome`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div>
          <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => setShowAdvanced((v) => !v)}>
            <Trans>Avanzate</Trans> <ChevronDown className={`inline size-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
          </button>
          {showAdvanced && (
            <input
              className="mt-1.5 w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
              placeholder={t`Indirizzo`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          )}
        </div>

        {/* la chiave non si rilegge MAI: «•••• a1b2 · cambia» (C1) */}
        {provider.hasKey ? (
          <div className="space-y-1.5">
            <p className="text-[13px] text-muted-foreground">
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

        {/* la prova automatica */}
        {probe.probing && <p className="text-[13px] text-muted-foreground"><Trans>Provo l’indirizzo…</Trans></p>}
        {probe.ok === true && (
          <div>
            <p className="text-[14px] text-chart-2"><Trans>✓ Funziona · {probe.models.length} modelli disponibili</Trans></p>
            {probe.models.length > 0 && (
              <p className="mt-1 line-clamp-3 break-all text-xs text-muted-foreground">
                {probe.models.slice(0, 12).join(' · ')}{probe.models.length > 12 ? ` …` : ''}
              </p>
            )}
          </div>
        )}
        {probe.ok === false && <p className="text-[14px] text-destructive">{probeErrorText(probe.error ?? 'error')}</p>}

        {/* per Ollama: la chiave della ricerca web (fase 11, punto 2) */}
        {provider.kind === 'ollama' && <WebSearchKeyFields providerId={provider.id} />}

        {err && <p className="text-xs text-destructive">{err}</p>}

        <div className="flex items-center justify-between gap-2 pt-1">
          {confirmDisconnect ? (
            <span className="flex items-center gap-2 text-xs text-destructive">
              <Trans>Scollegare {provider.name}? I bot che lo usano vanno spostati.</Trans>
              <button
                className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/20"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  api.deleteProvider(provider.id)
                    .then(onDone)
                    .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false))
                }}
              >
                <Trans>Scollega</Trans>
              </button>
              <button className="text-muted-foreground transition hover:text-foreground" onClick={() => setConfirmDisconnect(false)}>
                <Trans>Annulla</Trans>
              </button>
            </span>
          ) : (
            <button
              className="rounded-full px-3 py-1.5 text-sm text-destructive/90 transition hover:text-destructive"
              onClick={() => setConfirmDisconnect(true)}
            >
              <Trans>Scollega</Trans>
            </button>
          )}
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
                .then(onDone)
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

/** La chiave della ricerca web di Ollama (WebSearchKeyRow di oggi, in forma di riga). */
function WebSearchKeyFields({ providerId }: { providerId: string }) {
  const { t } = useLingui()
  const [set, setSet] = useState<boolean | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<WebSearchStatusRpc | null>(null)

  useEffect(() => {
    void api.webSearchKeySet(providerId).then(setSet).catch(() => setSet(null))
  }, [providerId])
  useEffect(() => {
    void api.webSearchStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  const save = async (key: string | null): Promise<void> => {
    setBusy(true)
    try {
      await api.setWebSearchKey(providerId, key)
      setSet(await api.webSearchKeySet(providerId))
      setValue('')
    } finally {
      setBusy(false)
    }
  }
  const providerState = (p: WebSearchProviderStatusRpc): string =>
    p.cooldownUntil ? t`in raffreddamento` : p.lastError ? t`ultimo errore` : t`disponibile`

  return (
    <div className="space-y-1.5 rounded-xl bg-muted/70 px-3 py-2.5">
      <p className="text-sm"><Trans>Ricerca web</Trans></p>
      <p className="text-xs text-muted-foreground">
        {set === null ? '…' : set ? t`chiave salvata (nel vault)` : t`chiave per la ricerca web di Ollama`}
        {status?.providers?.length ? ` · ${status.providers.map((p) => `${p.label}: ${providerState(p)}`).join(' · ')}` : ''}
      </p>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg bg-card px-2 py-1.5 text-xs outline-none"
          type="password"
          placeholder={set ? t`chiave nuova` : t`chiave`}
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
      </div>
    </div>
  )
}
