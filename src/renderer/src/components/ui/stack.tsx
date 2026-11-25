// C1 (fase linguaggio): Stack — la COLONNA dell'impaginazione. Fuori da
// components/ui non si disegna: le pagine compongono con questo pezzo, e la
// DISTANZA fra i blocchi è una variante chiusa delle token, non una classe
// scritta nella pagina. La misura di default è quella fra i blocchi
// (--spacing-block, 16); 'tight' è la distanza fra le righe di un gruppo (8),
// 'section' fra le sezioni (--spacing-section, 32).
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type StackGap = 'none' | 'tight' | 'block' | 'section'

const GAP: Record<StackGap, string> = {
  none: '',
  tight: 'gap-2',
  block: 'gap-block',
  section: 'gap-section'
}

/** La colonna: figli uno sotto l'altro, alla distanza scelta. */
export function Stack({ gap = 'block', children, className, testId, ...rest }: {
  /** la distanza fra i figli: tight 8 · block 16 (default) · section 32 */
  gap?: StackGap
  children: ReactNode
  className?: string
  testId?: string
} & React.HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div
      className={cn('flex min-w-0 flex-col', GAP[gap], className)}
      {...(testId ? { 'data-testid': testId } : {})}
      {...rest}
    >
      {children}
    </div>
  )
}
