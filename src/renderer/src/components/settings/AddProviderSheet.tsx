// Fase impostazioni (I2.3): il foglio «Aggiungi provider» — un elenco CON
// RICERCA dei tipi (Sul tuo Mac · Con una chiave · Un altro server) e poi i
// campi di sempre di AddModelRail per il tipo scelto (prova automatica della
// chiave, «Collega <tipo>»). È lo stesso foglio che «Collega» apre dentro
// ModelSelect (I1.2), già sul tipo giusto: per questo vive qui, condiviso.
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { ChevronLeft, Search } from 'lucide-react'
import { api, useStore } from '../../store'
import type { ProviderKind, ProviderPublic } from '../../../../shared/types'
import { KNOWN_BASE_URLS } from '../../../../main/agent/live-models'
import { nextModelProbe, EMPTY_MODEL_PROBE, type ModelProbeState } from '../../lib/model-probe'
import { providerLogoUrl } from '../../lib/provider-logos'
import { CONNECTABLE_KINDS } from '../../lib/model-select'

/** I nomi dei tipi (i marchi non si traducono). */
export const KIND_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
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

const GROUP_LABELS: Record<'mac' | 'key' | 'server', MessageDescriptor> = {
  mac: msg`Sul tuo Mac`,
  key: msg`Con una chiave`,
  server: msg`Un altro server`
}

/** La piastrella del tipo: il logo vero se c'è, l'iniziale altrimenti (I2.4). */
export function ProviderMark({ kind, name, size = 'md' }: { kind: ProviderKind | string; name: string; size?: 'sm' | 'md' }) {
  const url = providerLogoUrl(kind as ProviderKind)
  const dim = size === 'md' ? 'size-11 text-base' : 'size-7 text-xs'
  if (url) {
    return (
      <span className={`grid ${dim} shrink-0 place-items-center overflow-hidden rounded-[12px] bg-card dark:bg-white`} title={name}>
        <img src={url} alt="" className="size-3/4 object-contain" draggable={false} />
      </span>
    )
  }
  return (
    <span className={`grid ${dim} shrink-0 place-items-center rounded-[12px] bg-card font-bold`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

export interface AddProviderSheetProps {
  /** il tipo già scelto (da «Collega» nel ModelSelect): salta l'elenco */
  initialKind?: ProviderKind | null
  onClose(): void
  /** collegamento riuscito: l'id del provider appena salvato */
  onSaved(providerId: string): void
}

export function AddProviderSheet({ initialKind, onClose, onSaved }: AddProviderSheetProps) {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const [kind, setKind] = useState<ProviderKind | null>(initialKind ?? null)
  const [query, setQuery] = useState('')
  // — sul Mac —
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<ProviderPublic[] | null>(null)
  const [scanError, setScanError] = useState(false)
  // — chiave / altro server —
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<ModelProbeState>(EMPTY_MODEL_PROBE)
  const probeRevision = useRef(0)
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const group = kind ? CONNECTABLE_KINDS.find((c) => c.kind === kind)?.group ?? 'key' : null
  const effectiveBaseUrl = group === 'key' ? (baseUrl || (kind ? KNOWN_BASE_URLS[kind] : '') || '') : baseUrl

  // il tipo già scelto da «Collega»: la scansione del Mac parte DA SOLA
  const scan = (): void => {
    setScanning(true)
    setFound(null)
    setScanError(false)
    void api.discoverProviders()
      .then((list) => setFound(list.filter((p) => p.discovered)))
      .catch(() => setScanError(true))
      .finally(() => setScanning(false))
  }
  useEffect(() => {
    if (kind === 'ollama' || kind === 'lmstudio') scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

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
      void api.probeProvider({ kind: kind ?? 'openai-compatible', baseUrl: url.trim(), ...(nextKey.trim() ? { apiKey: nextKey.trim() } : {}) })
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

  const connect = async (): Promise<void> => {
    if (!kind) return
    setBusy(true)
    try {
      const isServer = group === 'server'
      const name = isServer ? (serverName.trim() || 'Server') : KIND_LABELS[kind] ?? String(kind)
      const id = `${isServer ? 'custom' : kind}_${Date.now()}`
      await api.saveProvider({
        id,
        name,
        kind: isServer ? 'openai-compatible' : kind,
        baseUrl: effectiveBaseUrl.trim(),
        enabled: true,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      setApiKey('')
      setProbe(EMPTY_MODEL_PROBE)
      await refreshProviders()
      onSaved(id)
    } finally {
      setBusy(false)
    }
  }

  const q = query.trim().toLowerCase()
  const groups: Array<'mac' | 'key' | 'server'> = ['mac', 'key', 'server']
  const kindsOf = (g: 'mac' | 'key' | 'server'): ProviderKind[] =>
    CONNECTABLE_KINDS.filter((c) => c.group === g && (!q || KIND_LABELS[c.kind]!.toLowerCase().includes(q))).map((c) => c.kind)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div
        className="flex max-h-[min(640px,calc(100vh-64px))] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-card shadow-soft"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pb-2 pt-5">
          {kind && (
            <button
              className="grid size-8 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground"
              aria-label={t`Indietro`}
              onClick={() => { setKind(null); setFound(null); setApiKey(''); setBaseUrl(''); setProbe(EMPTY_MODEL_PROBE) }}
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <strong className="font-display text-lg">
            {kind ? <Trans>Collega {KIND_LABELS[kind] ?? ''}</Trans> : <Trans>Aggiungi provider</Trans>}
          </strong>
        </div>

        {/* passo 1 — l'elenco dei tipi, con ricerca */}
        {!kind && (
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
            <div className="mb-3 flex h-9 items-center gap-2 rounded-full bg-muted px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                className="w-full bg-transparent text-sm outline-none"
                placeholder={t`Cerca (Ollama, Anthropic…)`}
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-thin pr-1">
              {groups.map((g) => {
                const kinds = kindsOf(g)
                if (kinds.length === 0) return null
                return (
                  <div key={g}>
                    <p className="mb-1.5 text-[13px] text-muted-foreground">{i18n.t(GROUP_LABELS[g])}</p>
                    <div className="overflow-hidden rounded-2xl bg-muted/60">
                      {kinds.map((k) => (
                        <button
                          key={k}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-muted [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/40"
                          onClick={() => { setKind(k); setBaseUrl(''); setApiKey(''); setProbe(EMPTY_MODEL_PROBE) }}
                        >
                          <ProviderMark kind={k} name={KIND_LABELS[k]!} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm">{KIND_LABELS[k]}</span>
                            {g === 'mac' && (
                              <span className="block text-[13px] text-muted-foreground"><Trans>gratis, nessun dato esce</Trans></span>
                            )}
                            {g === 'server' && (
                              <span className="block text-[13px] text-muted-foreground"><Trans>qualsiasi servizio compatibile OpenAI</Trans></span>
                            )}
                          </span>
                          <span className="text-sm text-primary"><Trans>Collega</Trans></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* passo 2 — i campi del tipo scelto */}
        {kind && group === 'mac' && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-thin px-5 pb-5">
            <p className="text-[13px] text-muted-foreground">
              {kind === 'ollama'
                ? <Trans>Cerco Ollama sul tuo Mac (porta 11434).</Trans>
                : <Trans>Cerco LM Studio sul tuo Mac (porta 1234).</Trans>}
            </p>
            <button
              className="w-full rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
              disabled={scanning}
              onClick={scan}
            >
              {scanning ? <Trans>Cerco…</Trans> : <Trans>Cerca di nuovo</Trans>}
            </button>
            {scanError && <p className="text-[13px] text-muted-foreground"><Trans>Non riesco a cercare sul Mac: riprova.</Trans></p>}
            {found !== null && (found.length > 0 ? (
              <div className="space-y-1">
                {found.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 rounded-2xl bg-muted/60 px-3 py-2.5">
                    <ProviderMark kind={p.kind} name={p.name} size="sm" />
                    <span className="min-w-0 flex-1 text-sm">{p.name}</span>
                    <span className="text-sm text-chart-2"><Trans>Collegato</Trans></span>
                  </div>
                ))}
                <button className="w-full pt-1 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
                  <Trans>Fatto</Trans>
                </button>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                <Trans>Non l’ho trovato. Aprilo e riprova, oppure inserisci l’indirizzo a mano:</Trans>{' '}
                <a className="text-primary hover:underline" href={kind === 'ollama' ? 'https://ollama.com' : 'https://lmstudio.ai'} target="_blank" rel="noreferrer">
                  {kind === 'ollama' ? 'ollama.com' : 'lmstudio.ai'}
                </a>
              </p>
            ))}
            {found !== null && found.length === 0 && (
              <div className="space-y-2 pt-1">
                <button
                  className="text-xs text-muted-foreground transition hover:text-foreground"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <Trans>Avanzate</Trans>
                </button>
                {showAdvanced && (
                  <input
                    className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
                    placeholder={kind === 'ollama' ? t`http://127.0.0.1:11434` : t`http://127.0.0.1:1234`}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                )}
                <button
                  className="w-full rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                  disabled={busy || !baseUrl.trim()}
                  onClick={() => {
                    void (async () => {
                      setBusy(true)
                      try {
                        const id = `${kind}_${Date.now()}`
                        await api.saveProvider({ id, name: KIND_LABELS[kind]!, kind, baseUrl: baseUrl.trim(), enabled: true })
                        await refreshProviders()
                        onSaved(id)
                      } finally { setBusy(false) }
                    })()
                  }}
                >
                  <Trans>Collega {KIND_LABELS[kind] ?? ''}</Trans>
                </button>
              </div>
            )}
          </div>
        )}

        {kind && (group === 'key' || group === 'server') && (
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto scroll-thin px-5 pb-5">
            {group === 'server' && (
              <input
                className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
                placeholder={t`Nome (es. Il mio gateway)`}
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
              />
            )}
            <div>
              <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => setShowAdvanced((v) => !v)}>
                <Trans>Avanzate</Trans>
              </button>
              {showAdvanced && (
                <input
                  className="mt-1.5 w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
                  placeholder={group === 'server' ? t`Indirizzo (es. http://127.0.0.1:8000/v1)` : t`Base URL`}
                  value={baseUrl}
                  onChange={(e) => { setBaseUrl(e.target.value); scheduleProbe(apiKey, e.target.value || (kind ? KNOWN_BASE_URLS[kind] : '') || '') }}
                />
              )}
            </div>
            <label className="block text-[13px] text-muted-foreground" htmlFor="sandbot-addprovider-key"><Trans>Incolla la chiave</Trans></label>
            <input
              id="sandbot-addprovider-key"
              className="h-10 w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
              type="password"
              placeholder={group === 'server' ? t`Chiave (facoltativa)` : t`sk-…`}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); scheduleProbe(e.target.value, effectiveBaseUrl) }}
            />
            {probe.probing && <p className="text-[13px] text-muted-foreground"><Trans>Provo la chiave…</Trans></p>}
            {probe.ok === true && (
              <p className="text-[14px] text-chart-2"><Trans>✓ Funziona · {probe.models.length} modelli disponibili</Trans></p>
            )}
            {probe.ok === false && <p className="text-[14px] text-destructive">{probeErrorText(probe.error ?? 'error')}</p>}
            <p className="text-xs text-muted-foreground"><Trans>La chiave resta nel Portachiavi del Mac.</Trans></p>
            <button
              className="w-full rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
              disabled={busy || !probe.ok || !effectiveBaseUrl.trim() || (group === 'server' && !serverName.trim())}
              onClick={() => void connect()}
            >
              <Trans>Collega {group === 'server' ? (serverName.trim() || t`il server`) : (KIND_LABELS[kind] ?? '')}</Trans>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
