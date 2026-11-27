// K3 (fase conversione-chat): Code — IL CODICE della chat, in monospazio.
// Tre posti, prima tre scritture a mano: la riga che non va a capo e scorre
// dentro se stessa (il comando da approvare, il file da scrivere: `<code>`),
// il blocco che va a capo (il testo per il modello, i dettagli tecnici:
// `<pre>`), il pezzo dentro una frase (la schedule tra parentesi: inline).
// La taglia è quella delle seconde righe (text-small); il fondo decide
// `tone`: su fondo card, dentro una card (la cosa da approvare si distingue
// dal fondo ambra) · su fondo tenue, sulla pagina o dentro i dettagli, col
// testo grigio. I margini non sono suoi: la distanza la decide chi lo mette
// (ChatCard, Stack).
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export function Code({ inline = false, aCapo = false, tone = 'muted', className, testId, children }: {
  /** il pezzo dentro una frase: monospazio e basta, niente riquadro */
  inline?: boolean
  /** il blocco va a capo (e scorre in verticale); altrimenti una riga sola che scorre in orizzontale */
  aCapo?: boolean
  /** su fondo card (dentro una card) · su fondo tenue, col testo grigio (il default) */
  tone?: 'card' | 'muted'
  className?: string
  testId?: string
  children: ReactNode
}): ReactNode {
  const extra = testId ? { 'data-testid': testId } : {}
  if (inline) {
    return (
      <code className={cn('font-mono text-small', tone === 'muted' && 'text-muted-foreground', className)} {...extra}>
        {children}
      </code>
    )
  }
  if (aCapo) {
    return (
      <pre className={cn('scroll-thin overflow-auto whitespace-pre-wrap wrap-anywhere rounded-control p-3 font-mono text-small', tone === 'card' ? 'bg-card' : 'bg-muted text-muted-foreground', className)} {...extra}>
        {children}
      </pre>
    )
  }
  return (
    <code className={cn('block overflow-x-auto whitespace-nowrap rounded-control p-3 font-mono text-small', tone === 'card' ? 'bg-card' : 'bg-muted text-muted-foreground', className)} {...extra}>
      {children}
    </code>
  )
}
