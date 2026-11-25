// C1 (fase linguaggio): Row — la RIGA dell'impaginazione (non la riga di
// elenco: quella è ListRow). Figli uno accanto all'altro, con le distanze dei
// token come varianti chiuse e l'allineamento scelto una volta per riga. È
// il pezzo che toglie i `className` di disposizione dalle pagine: chi scrive
// «flex items-center gap-3» fuori da ui/ sta riscrivendo questo.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type RowGap = 'none' | 'tight' | 'item' | 'block' | 'section'
export type RowAlign = 'start' | 'center' | 'baseline' | 'stretch'

const GAP: Record<RowGap, string> = {
  none: '',
  tight: 'gap-2',
  item: 'gap-3',
  block: 'gap-block',
  section: 'gap-section'
}

const ALIGN: Record<RowAlign, string> = {
  start: 'items-start',
  center: 'items-center',
  baseline: 'items-baseline',
  stretch: 'items-stretch'
}

/** La riga: figli uno accanto all'altro, allineati e alla distanza scelta. */
export function Row({ gap = 'item', align = 'center', wrap = false, children, className, testId, ...rest }: {
  /** la distanza fra i figli: tight 8 · item 12 (default) · block 16 · section 32 */
  gap?: RowGap
  /** l'allineamento trasversale dei figli */
  align?: RowAlign
  /** i figli vanno a capo quando non ci stanno */
  wrap?: boolean
  children: ReactNode
  className?: string
  testId?: string
} & React.HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('flex min-w-0', ALIGN[align], GAP[gap], wrap && 'flex-wrap', className)}
      {...(testId ? { 'data-testid': testId } : {})}
      {...rest}
    >
      {children}
    </div>
  )
}
