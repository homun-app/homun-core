// C1 (fase linguaggio): Card — LA superficie del catalogo: una forma sola
// (rounded-surface, bordo, fondo card, senza ombra) per le card in chat e le
// schede della griglia. Chi ci mette DENTRO decide il ritmo (Stack); la forma
// la decide il catalogo.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type CardPadding = 'none' | 'block'

const PAD: Record<CardPadding, string> = {
  none: '',
  block: 'p-4'
}

/** La superficie: una forma sola per le card in chat e le schede della griglia. */
export function Card({ padding = 'block', children, className, testId, ...rest }: {
  /** il respiro interno: block 16 (default) · none (chi lo decide da sé) */
  padding?: CardPadding
  children: ReactNode
  className?: string
  testId?: string
} & React.HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('rounded-surface border border-border bg-card', PAD[padding], className)}
      {...(testId ? { 'data-testid': testId } : {})}
      {...rest}
    >
      {children}
    </div>
  )
}
