// Fase 18b (H5.3): il selettore del modello — combobox con ricerca che
// sostituisce le <select> dei modelli nelle Impostazioni (bot, predefiniti,
// auto-review, catena delle riserve, routine). Ogni riga mostra id, finestra
// di contesto, le etichette visione/ragionamento/niente tool e il prezzo
// $/M (o «locale»/«—»); si può anche scrivere un id libero (modello nuovo non
// ancora nel catalogo) e confermarlo con Invio. Stile e token delle
// Impostazioni attuali, testi con le macro Lingui (17a).
import { useEffect, useId, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { ModelInfo } from '../../../../shared/types'

/** Fase 18b (H3): le etichette dei livelli di ragionamento (descriptor Lingui). */
export const THINKING_LABELS: Record<string, MessageDescriptor> = {
  default: msg`Predefinito`,
  off: msg`Spento`,
  minimal: msg`Minimo`,
  low: msg`Basso`,
  medium: msg`Medio`,
  high: msg`Alto`,
  xhigh: msg`Molto alto`,
  max: msg`Massimo`
}

/** Il prezzo «$0,30 / $1,20 per M» (ingresso/uscita), virgola decimale come nel resto della UI. */
function fmtUsd(n: number): string {
  return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace('.', ',')
}

/** La finestra di contesto «128k» (arrotondata ai k). */
function fmtContext(w: number): string {
  return `${Math.max(1, Math.round(w / 1024))}k`
}

export interface ModelPickerProps {
  /** l'elenco (unione catalogo + vivo) dell'api listModels */
  models: ModelInfo[]
  /** l'id scelto (stringa vuota/null = nessuno) */
  value: string | null | undefined
  onChange(id: string | null): void
  /** testo del campo quando non c'è valore (es. «predefinito…») */
  placeholder?: string
  disabled?: boolean
  className?: string
  /**
   * M8 (fase 0.3.1001): 'md' porta il campo a h-9 con text-sm, gemello della
   * <select> comune (ui/select) — sulla stessa riga, stessa altezza e baseline.
   * Default 'sm': l'aspetto compatto di sempre.
   */
  size?: 'sm' | 'md'
}

export function ModelPicker({ models, value, onChange, placeholder, disabled, className, size = 'sm' }: ModelPickerProps) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  // null = il campo mostra il valore scelto; stringa = l'utente sta cercando
  const [query, setQuery] = useState<string | null>(null)
  const [hi, setHi] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const text = query ?? value ?? ''
  const q = query?.toLowerCase().trim() ?? ''
  const filtered = q
    ? models.filter((m) => m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q))
    : models

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setQuery(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const commit = (id: string): void => {
    onChange(id || null)
    setOpen(false)
    setQuery(null)
  }

  const priceOf = (m: ModelInfo): string =>
    m.cost ? t`${fmtUsd(m.cost.input)} / ${fmtUsd(m.cost.output)} per M` : m.local ? t`locale` : '—'

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[hi] ? `${listId}-${hi}` : undefined}
        className={
          size === 'md'
            ? // M8: gemello della <select> comune (ui/select) — h-9, text-sm
              'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50'
            : 'w-full rounded-lg bg-muted px-2 py-1.5 text-xs outline-none disabled:opacity-40'
        }
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onFocus={() => { setOpen(true); setHi(0) }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setHi((i) => Math.min(i + 1, filtered.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            // la riga evidenziata, oppure il testo libero (modello nuovo non
            // ancora nel catalogo): si può scrivere e confermare
            commit(filtered[hi]?.id ?? text.trim())
          } else if (e.key === 'Escape') {
            setOpen(false)
            setQuery(null)
          }
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto scroll-thin rounded-lg border border-border bg-card p-1 shadow-soft"
        >
          {filtered.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              <Trans>nessun modello in elenco: scrivi l'id e premi Invio</Trans>
            </li>
          )}
          {filtered.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={m.id === value}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs ${i === hi ? 'bg-accent' : ''} ${m.id === value ? 'font-medium' : ''}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(m.id) }}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{m.id}</span>
              {m.contextWindow !== undefined && (
                <span className="shrink-0 text-[10px] text-muted-foreground">{fmtContext(m.contextWindow)}</span>
              )}
              {m.vision === true && <span className="shrink-0 text-[10px] text-muted-foreground">{t`visione`}</span>}
              {m.thinkingLevels.length > 0 && <span className="shrink-0 text-[10px] text-muted-foreground">{t`ragionamento`}</span>}
              {m.tools === false && <span className="shrink-0 text-[10px] text-destructive">{t`niente tool`}</span>}
              <span className="shrink-0 text-[10px] text-muted-foreground">{priceOf(m)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
