// B3 (fase beta.4): il messaggio del bot a UN ALTRO BOT (send_to_agent verso
// un bot creato o a cui si delega) nella chat dell'utente era una bolla piena
// — refusi compresi. Diventa UNA riga sola, «Ha chiesto a Notizie Tech: …»
// (≤ 100 caratteri), che si apre per leggere tutto, come le righe dei tool.
// D2 (fase deleghe): sotto la riga, lo STATO della delega fermata da un
// limite temporaneo — «In coda per <bot> · parte alle HH:MM» con Annulla,
// «Consegnato» quando parte — finché il risultato non arriva e la riga di
// stato sparisce. Icone lucide, mai emoji.
import { Trans } from '@lingui/react/macro'
import { Clock, Check, X } from 'lucide-react'

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
    <div className="rounded-[14px] bg-muted/60 px-3 py-1.5">
      <details>
        <summary className="cursor-pointer select-none text-xs text-muted-foreground">
          <Trans>Ha chiesto a {name}: {askedRowSummary(content)}</Trans>
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
          {content}
        </pre>
      </details>
      {status?.state === 'queued' && (
        <div data-testid="delegation-status" className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock size={12} aria-hidden />
          <span><Trans>In coda per {name} · parte alle {clock ?? ''}</Trans></span>
          {cancel && (
            <button
              data-testid="delegation-cancel" type="button"
              onClick={cancel}
              className="ml-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X size={11} aria-hidden />
              <Trans>Annulla</Trans>
            </button>
          )}
        </div>
      )}
      {status?.state === 'delivered' && (
        <div data-testid="delegation-status" className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check size={12} aria-hidden />
          <Trans>Consegnato</Trans>
        </div>
      )}
    </div>
  )
}
