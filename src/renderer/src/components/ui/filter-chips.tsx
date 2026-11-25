// C1 (fase linguaggio): FilterChips — LE pillole di filtro della barra, in
// tre varianti chiuse (niente più FilterPill né Button shape="pill" usati
// come filtro, e i <select> di Libreria diventano pillole-menu):
//   · scelta  — la scelta SINGOLA con il conteggio («Tutte · 12»);
//   · menu    — la pillola che apre un menu («Bot: tutti ▾»);
//   · interruttore — la pillola che ACCENDE un filtro («Archiviati»).
// Sono FILTRI: la scelta di un'impostazione è Segmented.
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from './button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu'

/** La pillola di scelta singola: accesa è piena, spenta secondaria, col conteggio. */
export function FilterChipsScelta({ active, count, onSelect, children, testId }: {
  active: boolean
  /** il conteggio accanto all'etichetta («Tutte · 12») */
  count?: number
  onSelect(): void
  children: ReactNode
  testId?: string
}): ReactNode {
  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      shape="pill"
      size="sm"
      className="text-caption"
      aria-pressed={active}
      {...(testId ? { 'data-testid': testId } : {})}
      onClick={onSelect}
    >
      {children}
      {count !== undefined && <span> · {count}</span>}
    </Button>
  )
}

/** La pillola che apre un menu: il valore scelto si vede, il menu decide. */
export function FilterChipsMenu<T extends string>({ label, value, options, onSelect, testId }: {
  /** il nome del filtro («Bot») */
  label: ReactNode
  /** il valore scelto («tutti»); null = nessuna scelta */
  value: T | null
  options: ReadonlyArray<{ value: T; label: ReactNode }>
  onSelect(value: T): void
  testId?: string
}): ReactNode {
  const scelto = options.find((o) => o.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        {...(testId ? { 'data-testid': testId } : {})}
        className="inline-flex h-control-sm shrink-0 items-center gap-1 rounded-full bg-muted px-3 text-caption text-foreground transition hover:bg-muted/70 aria-expanded:bg-foreground aria-expanded:font-medium aria-expanded:text-background"
      >
        {label}{scelto ? `: ${scelto.label}` : ''} <ChevronDown className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={String(o.value)} onClick={() => onSelect(o.value)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** La pillola-interruttore: accende o spegne UN filtro («Archiviati»). */
export function FilterChipsInterruttore({ active, onToggle, children, testId }: {
  active: boolean
  onToggle(): void
  children: ReactNode
  testId?: string
}): ReactNode {
  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      shape="pill"
      size="sm"
      className={cn('text-caption')}
      aria-pressed={active}
      {...(testId ? { 'data-testid': testId } : {})}
      onClick={onToggle}
    >
      {children}
    </Button>
  )
}
