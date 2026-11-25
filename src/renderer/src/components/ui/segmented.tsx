// C1 (fase linguaggio): Segmented — la scelta ESCLUSIVA in una pillola, alta
// 36: la scelta di UN'IMPOSTAZIONE («Sistema · Chiaro · Scuro», «Chiedi ·
// Automatico · Non chiedere»), non un filtro (quelli sono FilterChips).
// Porta al catalogo il pezzo che le Impostazioni chiamavano SettingsSegments,
// alla misura dei controlli di pagina; è un radiogroup con nome, la voce
// attiva piena, le altre grigie, ogni voce raggiungibile col Tab.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * I segmenti: due o più voci esclusive. `fill` divide la larghezza (il
 * segmento largo quanto il suo contenitore); senza, la pillola è larga
 * quanto le sue voci.
 */
export function Segmented<T extends string>({ options, value, onChange, label, fill, disabled, testId }: {
  /** le voci, nell'ordine in cui si vedono */
  options: ReadonlyArray<{ value: T; label: ReactNode; testId?: string }>
  /** la voce attiva; null finché non si conosce */
  value: T | null
  onChange(value: T): void
  /** il nome accessibile del gruppo («Tema», «Quando chiedere») */
  label?: string
  /** le voci si dividono la larghezza che c'è */
  fill?: boolean
  /** nessuna voce si può scegliere (mentre lavora) */
  disabled?: boolean
  testId?: string
}): ReactNode {
  return (
    <div
      role="radiogroup"
      {...(label ? { 'aria-label': label } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
      className={cn('inline-flex h-control max-w-full items-center gap-1 rounded-full border border-border bg-card p-1', fill && 'flex w-full')}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            {...(o.testId ? { 'data-testid': o.testId } : {})}
            className={cn(
              'inline-flex h-full min-w-0 shrink-0 items-center justify-center rounded-full px-3 text-body transition',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:pointer-events-none disabled:opacity-50',
              fill && 'flex-1',
              active ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
