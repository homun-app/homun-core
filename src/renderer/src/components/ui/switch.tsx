// C1 (fase linguaggio): Switch — l'interruttore del catalogo, SOLO per
// acceso/spento (V5: l'interruttore Attivo di una riga). Il bottone è alto
// 32 (il controllo piccolo: il bersaglio), la pista 24 e la pallina 20, come
// l'interruttore che le Impostazioni già disegnavano: la forma passa al
// catalogo, il gesto resta.
import { cn } from '../../lib/utils'

/** L'interruttore: acceso/spento, nient'altro (le scelte sono Segmented). */
export function Switch({ checked, onChange, disabled, label, testId, className }: {
  checked: boolean
  onChange(v: boolean): void
  disabled?: boolean
  /** il nome accessibile dell'interruttore («Attivo», «Tutti i bot») */
  label: string
  testId?: string
  className?: string
}): React.ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      {...(testId ? { 'data-testid': testId } : {})}
      className={cn('relative h-control-sm w-10 shrink-0 rounded-full transition', disabled && 'opacity-40', className)}
      onClick={() => onChange(!checked)}
    >
      <span className={`absolute inset-x-0 inset-y-1 rounded-full transition ${checked ? 'bg-foreground' : 'bg-muted-foreground/30'}`} />
      <span className={`absolute top-1 size-5 rounded-full bg-card transition-all ${checked ? 'right-0.5' : 'left-0.5'}`} />
    </button>
  )
}
