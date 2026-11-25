// C1 (fase linguaggio): BotDot — il puntino di stato del colore di un bot.
// La tinta è la PALETTE DEI PUNTINI (--bot-dot-c1…c7, R5: contrasto ≥ 3:1
// sul fondo della riga in chiaro e in scuro), NON quella della mascotte:
// il colore del bot sta qui, il nome del bot resta nel colore del testo.
import type { BotColor } from '../../../../shared/types'
import { cn } from '../../lib/utils'

/** Il puntino del colore del bot: 8 px, la palette --bot-dot-*. */
export function BotDot({ color, className, testId }: {
  /** il colore del bot (c1–c7): la palette dei puntini, non quella della mascotte */
  color: BotColor
  className?: string
  testId?: string
}): React.ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 shrink-0 rounded-full', className)}
      style={{ background: `var(--bot-dot-${color})` }}
      {...(testId ? { 'data-testid': testId } : {})}
    />
  )
}
