// C1 (fase linguaggio): Icon — l'icona del catalogo. Solo Lucide, con le
// due misure dei token scritte dal pezzo (16 nel testo e nei bottoni, 20
// nelle testate): senza misura lucide disegna 24, e la regola del tema è che
// la misura si scrive SEMPRE — qui la scrive il catalogo una volta sola.
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

export type IconSize = 'sm' | 'lg'

const SIZE: Record<IconSize, string> = {
  sm: 'size-4',
  lg: 'size-5'
}

/** L'icona lucide, alla misura dei token: sm 16 (default) · lg 20 (le testate). */
export function Icon({ icon, size = 'sm', className, ...rest }: {
  /** il componente lucide da disegnare (per esempio Plus, ChevronDown) */
  icon: LucideIcon
  /** sm 16 px, il default · lg 20 px, le testate */
  size?: IconSize
  className?: string
} & Omit<React.ComponentProps<LucideIcon>, 'className' | 'size'>): React.ReactNode {
  const I = icon
  return <I className={cn(SIZE[size], className)} aria-hidden="true" {...rest} />
}
