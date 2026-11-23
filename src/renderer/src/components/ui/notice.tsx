// Fase design (DS2): Notice — la riga di sistema COMPATTA della chat: icona ·
// testo grigio text-small · «· N volte» · azione. È il pezzo con cui la chat
// (DS4) smette di scrivere a mano una riga per ogni avviso, ognuna con le sue
// misure; finché non lo adotta, nessuno lo importa.
// È solo la VISTA. Decidere quali avvisi sono LO STESSO e contarli sta in
// lib/notice-rows.ts (groupRepeatedNotices, provata): qui arriva un `repeat`
// e si mostra. Se un avviso successo una volta sola non deve portare il
// conteggio, lo decide chi chiama — non passa repeat (oggi Chat: repeat > 1).
// Il «· N volte» è il messaggio che Chat ha già nei cataloghi, col medesimo
// msgid (variabile compresa: per questo la prop si chiama `repeat`): in
// inglese dice «· N times» senza che i cataloghi cambino.
import type { ReactNode } from 'react'
import { Plural } from '@lingui/react/macro'
import { cn } from '../../lib/utils'

/** Il colore del testo e dell'icona, per tono: il neutral è il grigio delle righe di sistema. */
const TONE = {
  neutral: 'text-muted-foreground',
  warning: 'text-waiting',
  destructive: 'text-destructive'
} as const

export function Notice({ icon, children, repeat, action, tone = 'neutral', testId, className }: {
  /** l'icona lucide davanti al testo: la taglia la decide lo slot (16 px), non lei */
  icon?: ReactNode
  /** il testo dell'avviso: va a capo, non tronca */
  children: ReactNode
  /** quante volte si è ripetuto l'avviso: dopo il testo, «· 4 volte» */
  repeat?: number
  /** l'azione a destra (per esempio il bottone «Riprova») */
  action?: ReactNode
  tone?: 'neutral' | 'warning' | 'destructive'
  testId?: string
  className?: string
}): ReactNode {
  return (
    <div
      data-notice
      data-testid={testId}
      className={cn(
        // min-h-6: una riga di solo testo non è più sottile di 24 px (la sua interlinea è 18)
        'flex min-h-6 w-full items-center gap-row-gap text-small text-muted-foreground',
        TONE[tone],
        className
      )}
    >
      {icon !== undefined && (
        // lo slot è largo 16 e l'svg dentro è 16: un'icona più grande non sposta la riga
        <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{icon}</span>
      )}
      {/* min-w-0: in un flex il testo può restringersi (e andare a capo) invece di allargare la riga */}
      <span className="min-w-0 flex-1">{children}</span>
      {repeat !== undefined && (
        // fermo e su una riga sola: il conteggio non si spezza e non si restringe, cede il testo.
        // Lo spazio davanti sta nel TESTO, come in Chat oggi: separa le due parole anche dove
        // il gap non c'è (il nome accessibile, il testo copiato)
        <span className="shrink-0 whitespace-nowrap">
          {' '}<Plural value={repeat} one="· 1 volta" other="· # volte" />
        </span>
      )}
      {action !== undefined && <span className="flex shrink-0 items-center">{action}</span>}
    </div>
  )
}
