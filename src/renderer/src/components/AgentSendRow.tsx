// B3 (fase beta.4): il messaggio del bot a UN ALTRO BOT (send_to_agent verso
// un bot creato o a cui si delega) nella chat dell'utente era una bolla piena
// — refusi compresi. Diventa UNA riga sola, «Ha chiesto a Notizie Tech: …»
// (≤ 100 caratteri), che si apre per leggere tutto, come le righe dei tool.
import { Trans } from '@lingui/react/macro'

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

/** La riga apribile del messaggio a un altro bot. */
export function AgentSendRow({ name, content }: { name: string; content: string }) {
  return (
    <details className="rounded-[14px] bg-muted/60 px-3 py-1.5">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">
        <Trans>Ha chiesto a {name}: {askedRowSummary(content)}</Trans>
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
        {content}
      </pre>
    </details>
  )
}
