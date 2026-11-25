// C1 (fase linguaggio): Grid — la griglia dell'impaginazione (le card della
// Libreria, i riquadri a colonne). Le colonne sono una variante chiusa, la
// distanza quella dei token: la pagina non scrive più la sua griglia.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type GridCols = 2 | 3 | 4 | 6
export type GridGap = 'tight' | 'item' | 'block' | 'section'

const COLS: Record<GridCols, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  6: 'grid-cols-6'
}

const GAP: Record<GridGap, string> = {
  tight: 'gap-2',
  item: 'gap-3',
  block: 'gap-block',
  section: 'gap-section'
}

/** La griglia: figli in colonne uguali, alla distanza scelta. */
export function Grid({ cols = 2, gap = 'block', children, className, testId, ...rest }: {
  /** il numero di colonne: 2 (default), 3, 4, 6 */
  cols?: GridCols
  /** la distanza fra le celle: tight 8 · item 12 · block 16 (default) · section 32 */
  gap?: GridGap
  children: ReactNode
  className?: string
  testId?: string
} & React.HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('grid min-w-0', COLS[cols], GAP[gap], className)}
      {...(testId ? { 'data-testid': testId } : {})}
      {...rest}
    >
      {children}
    </div>
  )
}
