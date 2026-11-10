// Fase impostazioni (I1): UN solo selettore di modello, per i quattro posti
// che ne avevano uno ciascuno (cervello dei bot, revisore, riserve, pannello
// del bot). La riga chiusa mostra il nome del modello e, piccolo e grigio, il
// provider — niente dimensioni né «vede · ragiona». Il popover ha la ricerca
// in cima (fuoco automatico), i modelli pronti raggruppati per provider con
// le capacità come icone (occhio = vede, lampadina = ragiona), e sotto un
// separatore i provider da COLLEGARE: «Collega» apre il foglio di I2 già sul
// tipo giusto; a collegamento riuscito il popover si riapre sui modelli
// nuovi, col primo adatto evidenziato. Il ragionamento non è un secondo menu
// accanto: sta nel «⋯» della riga chiusa (I1.4), solo quando il modello ha
// livelli. Combobox: aria-expanded, frecce, Invio, Esc.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Check, ChevronDown, Eye, Lightbulb, MoreHorizontal, Search } from 'lucide-react'
import { api, useStore } from '../../store'
import type { FallbackRoute, ModelInfo, ProviderKind, ThinkingSetting } from '../../../../shared/types'
import { modelEntries, filterModelEntries, connectableKinds, firstSuitableModel, type ModelEntry } from '../../lib/model-select'
import { MODEL_DEFAULTS_BY_KIND } from '../../../../main/agent/model-defaults'
import { THINKING_LABELS } from './ModelPicker'
import { AddProviderSheet, KIND_LABELS, ProviderMark } from '../settings/AddProviderSheet'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './dropdown-menu'

/** Lo stato dei modelli di un provider: in carico, guasto o pronto. */
type ProviderModels = { state: 'loading' } | { state: 'error' } | { state: 'ok'; models: ModelInfo[] }

export interface ModelSelectProps {
  /** la scelta di oggi (providerId + model); null = nessuno / «come gli altri» */
  value: FallbackRoute | null
  onChange(route: FallbackRoute | null): void
  /** revisore (I1.3): prima voce «Nessuno» — salva null */
  allowNone?: boolean
  /** pannello del bot (I1.3): prima voce «Come gli altri · <modello principale>» */
  allowFollowMain?: boolean
  /** il livello di ragionamento di oggi (I1.4) */
  thinking?: ThinkingSetting | null
  onThinking?(level: ThinkingSetting): void
  /**
   * I1.4/I6: da dove vengono i livelli di ragionamento quando value è vuoto —
   * per «Come gli altri» è il modello PRINCIPALE risolto (il ⋯ resta offerto
   * anche seguendo gli altri, come faceva la select di prima)
   */
  followModel?: FallbackRoute | null
  placeholder?: string
  ariaLabel?: string
  className?: string
  /**
   * RV4 (fase beta.2): apre subito l'elenco al primo render (il foglio del
   * modello del bot ci arriva già col cerca-modello in vista, un clic in meno)
   */
  defaultOpen?: boolean
}

export function ModelSelect({
  value, onChange, allowNone, allowFollowMain, thinking, onThinking, followModel,
  placeholder, ariaLabel, className, defaultOpen
}: ModelSelectProps) {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const mainModel = useStore((s) => s.mainModel)
  const [open, setOpen] = useState(defaultOpen ?? false)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const [modelsBy, setModelsBy] = useState<Record<string, ProviderModels>>({})
  // «Collega» (I1.2): il foglio di collegamento, col tipo già scelto
  const [connectKind, setConnectKind] = useState<ProviderKind | null>(null)
  // dopo un collegamento riuscito: il popover si riapre e il PRIMO ADEGUATO
  // del provider nuovo resta evidenziato
  const [highlightProvider, setHighlightProvider] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const active = providers.filter((p) => p.enabled)

  /** scarica i modelli di un provider (una volta per stato noto) */
  const load = (providerId: string): void => {
    setModelsBy((prev) => (prev[providerId] ? prev : { ...prev, [providerId]: { state: 'loading' } }))
    void api.listModels(providerId)
      .then((ms) => setModelsBy((prev) => ({ ...prev, [providerId]: { state: 'ok', models: ms } })))
      .catch(() => setModelsBy((prev) => ({ ...prev, [providerId]: { state: 'error' } })))
  }

  useEffect(() => {
    for (const p of active) load(p.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length, providers.map((p) => p.id).join(',')])

  // chiusura al clic fuori (il foglio di collegamento sta DENTRO rootRef e
  // non chiude il popover: si riapre da solo al salvataggio)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const entries = useMemo(
    () => modelEntries(active, Object.fromEntries(
      active.map((p) => {
        const st = modelsBy[p.id]
        return [p.id, st && st.state === 'ok' ? st.models : []]
      })
    ) as Record<string, ModelInfo[]>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, modelsBy]
  )
  const filtered = useMemo(() => filterModelEntries(entries, query), [entries, query])

  // il modello da cui vengono i livelli del ragionamento: quello scelto, o
  // il principale risolto quando si segue «Come gli altri»
  const levelSource = value && value.model ? value : (followModel && followModel.model ? followModel : null)
  const chosen = levelSource
    ? entries.find((e) => e.providerId === levelSource.providerId && e.model.id === levelSource.model)
    : undefined
  const chosenLabel = value
    ? (chosen?.model.label ?? chosen?.model.id ?? value.model)
    : null
  const chosenProviderName = value ? (providers.find((p) => p.id === value.providerId)?.name ?? value.providerId) : null
  const levels = chosen?.model.thinkingLevels ?? []

  // il popover si apre con il fuoco sulla ricerca e la scelta già evidenziata
  useEffect(() => {
    if (!open) return
    setQuery('')
    const at = filtered.findIndex((e) => value && e.providerId === value.providerId && e.model.id === value.model)
    setHi(at >= 0 ? at : 0)
    requestAnimationFrame(() => searchRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // dopo un collegamento riuscito (I1.2): appena i modelli del provider nuovo
  // arrivano, il popover si riapre col primo adatto evidenziato
  useEffect(() => {
    if (!highlightProvider) return
    const st = modelsBy[highlightProvider]
    if (st?.state !== 'ok') return
    const at = filtered.findIndex((e) => e.providerId === highlightProvider)
    if (at >= 0) {
      // il «primo adatto»: il predefinito del tipo quando c'è, altrimenti il
      // primo che dichiara di usare i tool
      const p = providers.find((x) => x.id === highlightProvider)
      const preferred = p ? MODEL_DEFAULTS_BY_KIND[p.kind]?.defaultModel : undefined
      const within = firstSuitableModel(st.models, preferred ?? null)
      const absolute = at + Math.max(0, within)
      setOpen(true)
      setHi(Math.min(absolute, filtered.length - 1))
      // scorre la voce evidenziata in vista
      requestAnimationFrame(() => {
        document.getElementById(`${listId}-${Math.min(absolute, filtered.length - 1)}`)?.scrollIntoView({ block: 'nearest' })
      })
    }
    setHighlightProvider(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightProvider, modelsBy, filtered])

  const commit = (e: ModelEntry): void => {
    onChange({ providerId: e.providerId, model: e.model.id })
    setOpen(false)
  }

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((i) => Math.min(i + 1, filtered.length - 1))
      document.getElementById(`${listId}-${Math.min(hi + 1, filtered.length - 1)}`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((i) => Math.max(i - 1, 0))
      document.getElementById(`${listId}-${Math.max(hi - 1, 0)}`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[hi]
      if (target) commit(target)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const toConnect = connectableKinds(providers)
  const closedLabel = chosenLabel
    ?? (allowFollowMain && (!value || !value.model)
      ? (mainModel?.model ? t`Come gli altri (${mainModel.model})` : t`Come gli altri`)
      : undefined)
    ?? (allowNone && !value ? t`Nessuno` : undefined)
    ?? placeholder
    ?? t`— modello —`

  return (
    <div ref={rootRef} className={`relative flex min-w-0 items-center gap-1.5 ${className ?? ''}`}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel ?? t`Provider e modello`}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3 text-sm outline-none transition hover:bg-muted/70 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {closedLabel}
          {chosenProviderName && (
            <span className="ml-1.5 text-xs text-muted-foreground">{chosenProviderName}</span>
          )}
        </span>
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* I1.4: il ragionamento nel «⋯» della riga chiusa, solo se il modello ha livelli */}
      {levels.length > 0 && onThinking && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition hover:bg-muted/70 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label={t`Ragionamento`}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={levels.includes((thinking ?? 'default') as ThinkingSetting) ? (thinking ?? 'default') : 'default'}
              onValueChange={(v) => onThinking(v as ThinkingSetting)}
            >
              {(['default', ...levels] as ThinkingSetting[]).map((l) => (
                <DropdownMenuRadioItem key={l} value={l}>
                  {l === 'default' ? i18n.t(msg`Ragionamento: Predefinito`) : i18n.t(THINKING_LABELS[l] ?? msg`${l}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {open && (
        <div className="absolute left-0 top-11 z-30 flex max-h-80 w-[min(26rem,calc(100vw-96px))] flex-col overflow-hidden rounded-2xl bg-card p-1.5 shadow-soft">
          {/* la ricerca, in cima, col fuoco automatico */}
          <div className="mb-1 flex h-9 shrink-0 items-center gap-2 rounded-full bg-muted px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={filtered[hi] ? `${listId}-${hi}` : undefined}
              className="w-full bg-transparent text-sm outline-none"
              placeholder={t`Cerca un modello o un provider`}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHi(0) }}
              onKeyDown={onSearchKey}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin" role="listbox" id={listId} aria-label={t`Modelli`}>
            {/* I1.3: le opzioni d'uso stanno SEMPRE in cima (anche con un
                modello già scelto: servono per TORNARE indietro) */}
            {allowFollowMain && (
              <button
                role="option"
                aria-selected={!value || !value.model}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent"
                onClick={() => { onChange(null); setOpen(false) }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {mainModel?.model ? t`Come gli altri (${mainModel.model})` : t`Come gli altri`}
                </span>
                {(!value || !value.model) && <Check className="size-4 shrink-0" />}
              </button>
            )}
            {allowNone && (
              <button
                role="option"
                aria-selected={!value}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent"
                onClick={() => { onChange(null); setOpen(false) }}
              >
                <span className="min-w-0 flex-1 truncate">{t`Nessuno`}</span>
                {!value && <Check className="size-4 shrink-0" />}
              </button>
            )}

            {/* i modelli pronti, raggruppati per provider */}
            {active.map((p) => {
              const st = modelsBy[p.id]
              const groupEntries = filtered.filter((e) => e.providerId === p.id)
              if (st?.state === 'error' && groupEntries.length === 0) {
                return (
                  <div key={p.id} className="px-2 py-2">
                    <p className="text-[13px] font-medium">{p.name}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-[13px]">
                      <span className="text-destructive">{t`Non risponde`}</span>
                      <button
                        className="rounded-full bg-muted px-2.5 py-1 text-xs transition hover:bg-accent"
                        onClick={() => { setModelsBy((prev) => ({ ...prev, [p.id]: { state: 'loading' } })); void api.listModels(p.id).then((ms) => setModelsBy((prev) => ({ ...prev, [p.id]: { state: 'ok', models: ms } }))).catch(() => setModelsBy((prev) => ({ ...prev, [p.id]: { state: 'error' } }))) }}
                      >
                        <Trans>Riprova</Trans>
                      </button>
                    </p>
                  </div>
                )
              }
              if (st?.state === 'loading' && groupEntries.length === 0) {
                return (
                  <div key={p.id} className="px-2 py-2 text-[13px]">
                    <span className="font-medium">{p.name}</span>{' '}
                    <span className="text-muted-foreground">…</span>
                  </div>
                )
              }
              if (groupEntries.length === 0) return null
              return (
                <div key={p.id}>
                  <p className="px-2 pb-0.5 pt-2 text-[13px] font-medium text-muted-foreground">{p.name}</p>
                  {groupEntries.map((e) => {
                    // l'indice globale dentro `filtered` per aria-activedescendant
                    const abs = filtered.indexOf(e)
                    const selected = !!value && value.providerId === e.providerId && value.model === e.model.id
                    return (
                      <button
                        key={e.key}
                        id={`${listId}-${abs}`}
                        role="option"
                        aria-selected={selected}
                        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${abs === hi ? 'bg-accent' : ''} ${selected ? 'font-medium' : ''}`}
                        onMouseEnter={() => setHi(abs)}
                        onMouseDown={(ev) => { ev.preventDefault(); commit(e) }}
                        onClick={() => commit(e)}
                      >
                        <span className="min-w-0 flex-1 truncate">{e.model.label ?? e.model.id}</span>
                        {/* I1.2: le capacità come icone col title */}
                        {e.model.vision === true && (
                          <span title={t`vede (immagini)`} className="shrink-0 text-muted-foreground"><Eye className="size-3.5" /></span>
                        )}
                        {e.model.thinkingLevels.length > 0 && (
                          <span title={t`ragiona`} className="shrink-0 text-muted-foreground"><Lightbulb className="size-3.5" /></span>
                        )}
                        {selected && <Check className="size-4 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {filtered.length === 0 && active.length > 0 && (
              <p className="px-2 py-2 text-[13px] text-muted-foreground"><Trans>Nessun modello trovato.</Trans></p>
            )}

            {/* separatore, poi i provider da collegare (I1.2) */}
            {toConnect.length > 0 && (
              <div className="mt-1 border-t border-border/40 pt-1">
                {toConnect.map(({ kind }) => (
                  <div key={kind} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                    <ProviderMark kind={kind} name={KIND_LABELS[kind] ?? kind} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{KIND_LABELS[kind] ?? kind}</span>
                    <button
                      className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs transition hover:bg-accent"
                      onClick={() => setConnectKind(kind)}
                    >
                      <Trans>Collega</Trans>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {connectKind !== null && (
        <AddProviderSheet
          initialKind={connectKind}
          onClose={() => setConnectKind(null)}
          onSaved={(providerId) => {
            setConnectKind(null)
            setHighlightProvider(providerId)
          }}
        />
      )}
    </div>
  )
}
