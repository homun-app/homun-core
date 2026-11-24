// B3 (fase beta.4): il messaggio del bot a UN ALTRO BOT (send_to_agent verso
// un bot creato o a cui si delega) nella chat dell'utente era una bolla piena
// — refusi compresi. Diventa UNA riga sola, «Ha chiesto a Notizie Tech: …»
// (≤ 100 caratteri), che si apre per leggere tutto, come le righe dei tool.
// D2 (fase deleghe): sotto la riga, lo STATO della delega fermata da un
// limite temporaneo — «In coda per <bot> · parte alle HH:MM» con Annulla,
// «Consegnato» quando parte — finché il risultato non arriva e la riga di
// stato sparisce. Icone lucide, mai emoji.
//
// Fase design (DS4): è una riga di sistema come le altre — la riga che si
// apre è SystemRow (Notice), il testo intero un blocco di codice, e anche lo
// stato della delega è Notice (con la sua azione, il bottone del sistema).
import { Trans } from '@lingui/react/macro'
import { ArrowRight, Check, Clock, X } from 'lucide-react'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import { SystemRow, SystemText } from './DecidedRow'

/** Il tetto della sintesi nella riga (gli interi stanno nel dettaglio). */
export const AGENT_SEND_ROW_CHARS = 100

/**
 * La sintesi del messaggio (PURA): al massimo 100 caratteri, con «…» se
 * tagliata. Il testo intero resta nel dettaglio.
 */
export function askedRowSummary(content: string, max = AGENT_SEND_ROW_CHARS): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}

/** D2: lo stato della delega mostrato sotto la riga (l'ora nel locale dell'utente). */
export interface DelegationStatus {
  state: 'queued' | 'delivered'
  /** l'orario di partenza, solo per 'queued' */
  runAt?: number
}

/** La riga apribile del messaggio a un altro bot, con l'eventuale stato D2. */
export function AgentSendRow({ name, content, status, cancel, clock }: {
  name: string
  content: string
  /** D2: lo stato della delega (undefined = consegnata subito, niente riga) */
  status?: DelegationStatus
  /** D2: l'Annulla della riga «in coda» */
  cancel?: () => void
  /** D2: l'ora già formattata HH:MM (passata dal Chat per il locale) */
  clock?: string
}) {
  return (
    <div>
      <details>
        <SystemRow icon={ArrowRight}>
          <Trans>Ha chiesto a {name}: {askedRowSummary(content)}</Trans>
        </SystemRow>
        <SystemText text={content} />
      </details>
      {status?.state === 'queued' && (
        <Notice
          icon={<Clock className="size-4" />}
          testId="delegation-status"
          className="mt-1"
          action={
            cancel ? (
              <Button variant="ghost" size="sm" data-testid="delegation-cancel" onClick={cancel}>
                <X className="size-4" aria-hidden="true" />
                <Trans>Annulla</Trans>
              </Button>
            ) : undefined
          }
        >
          <Trans>In coda per {name} · parte alle {clock ?? ''}</Trans>
        </Notice>
      )}
      {status?.state === 'delivered' && (
        <Notice icon={<Check className="size-4" />} testId="delegation-status" className="mt-1">
          <Trans>Consegnato</Trans>
        </Notice>
      )}
    </div>
  )
}
