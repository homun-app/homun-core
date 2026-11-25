// C1 (fase linguaggio): SearchField — L'UNICA ricerca dell'app. Il campo con
// la lente, 36 px (h-control), il fondo tenue e il raggio dei controlli: le
// pagine non scrivono più la loro ricerca (ognuna con la sua misura e il suo
// fondo), chiedono questa. Il valore è controllato: la pagina decide il filtro.
import { useLingui } from '@lingui/react/macro'
import { Search } from 'lucide-react'
import { cn } from '../../lib/utils'

/** La ricerca dell'app: lente · campo · (il risultato lo conta la pagina). */
export function SearchField({ value, onChange, placeholder, ariaLabel, className, testId, autoFocus }: {
  value: string
  onChange(v: string): void
  placeholder?: string
  /** il nome accessibile («Cerca tra plugin e skill») */
  ariaLabel?: string
  className?: string
  testId?: string
  autoFocus?: boolean
}): React.ReactNode {
  const { t } = useLingui()
  return (
    <label className={cn('flex h-control w-72 shrink-0 items-center gap-2 rounded-control bg-muted px-4 text-body text-muted-foreground', className)}>
      <Search className="size-4 shrink-0" aria-hidden="true" />
      <input
        type="search"
        className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        {...(testId ? { 'data-testid': testId } : {})}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        placeholder={placeholder ?? t`Cerca`}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
