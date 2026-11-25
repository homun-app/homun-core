// C1 (fase linguaggio): ListGroup — il gruppo di righe a filo: il titolo di
// sezione e le righe DIVISE DA UN FILETTO. Prende il posto di SettingsGroup e
// FlatList: NESSUN riquadro grigio attorno alle righe, né nelle pagine né
// nelle Impostazioni — la sezione si riconosce dal titolo, la riga dal segno.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * Il gruppo: un titolo di sezione (text-caption grigio, peso 500) con la sua
 * azione a destra, e sotto le righe a filo — un filetto fra l'una e l'altra,
 * nessuno spazio né riquadro. La distanza fra un gruppo e l'altro la decide
 * chi li elenca (Stack gap-section).
 */
export function ListGroup({ titolo, azione, children, className, testId }: {
  /** il titolo di sezione: un'etichetta corta («Bot che lo usano») */
  titolo?: ReactNode
  /** l'azione del titolo, a destra («Mostra tutto») */
  azione?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div className={cn('flex flex-col gap-section-head', className)} {...(testId ? { 'data-testid': testId } : {})}>
      {(titolo !== undefined || azione !== undefined) && (
        <div className="flex min-h-6 items-center justify-between gap-3">
          {titolo !== undefined && <h3 className="text-caption font-medium text-muted-foreground">{titolo}</h3>}
          {azione !== undefined && <span className="flex shrink-0 items-center gap-2">{azione}</span>}
        </div>
      )}
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  )
}
