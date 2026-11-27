// K2 (fase conversione-chat): Tag — l'etichetta piccola di stato, accanto a
// un titolo («token scaduto», «in attesa», «eliminata»): testo didascalia su
// un fondo del suo tono, col raggio dei controlli. Prima la si scriveva a
// mano dove serviva (la card di un'app, la memoria, il progresso del box),
// ognuna con le sue classi. Non è un bottone (Button), non è un filtro
// (FilterChips): si legge e basta.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type TagTone = 'muted' | 'waiting' | 'error' | 'ok'

/** Il fondo tenue e il colore del testo, per tono. */
const TONE: Record<TagTone, string> = {
  muted: 'bg-muted text-muted-foreground',
  waiting: 'bg-waiting/15 text-waiting',
  error: 'bg-destructive/15 text-destructive',
  ok: 'bg-chart-2/15 text-chart-2'
}

export function Tag({ tone = 'muted', className, testId, children }: {
  /** il tono: neutro (il default) · attesa · errore · riuscito */
  tone?: TagTone
  className?: string
  testId?: string
  children: ReactNode
}): ReactNode {
  return (
    <span
      data-slot="tag"
      className={cn('inline-flex shrink-0 items-center rounded-control px-1.5 py-0.5 text-caption', TONE[tone], className)}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </span>
  )
}
