// K3 (fase conversione-chat): TechDetails — I DETTAGLI TECNICI, chiusi.
// La card parla in parole («Slack vuole inviare un messaggio»); il nome
// tecnico (lo strumento, il server, l'azione, il MOTIVO dell'errore com'è
// arrivato dal daemon, in inglese) sta qui: una riga che si apre e, sotto, il
// blocco di codice. Chi legge decide se guardarlo; l'interfaccia non glielo
// mette davanti. Prima la scriveva a mano la card di approvazione; ora la
// usano anche le card di proposta per il motivo di un errore.
import type { ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { Code } from './code'

export function TechDetails({ testo, etichetta, aperto = false, testId, className }: {
  /** il testo tecnico, com'è (mai tradotto) */
  testo: ReactNode
  /** l'etichetta della riga che si apre: «Dettagli tecnici» se manca */
  etichetta?: ReactNode
  /** aperto (il default è chiuso: guarda chi vuole) */
  aperto?: boolean
  testId?: string
  className?: string
}): ReactNode {
  return (
    <details className={className} open={aperto || undefined} {...(testId ? { 'data-testid': testId } : {})}>
      <summary className="cursor-pointer text-small text-muted-foreground select-none">
        {etichetta ?? <Trans>Dettagli tecnici</Trans>}
      </summary>
      <Code aCapo className="mt-1.5 max-h-40">{testo}</Code>
    </details>
  )
}
