// C1 (fase linguaggio): ProposalCard — UN oggetto per «il bot propone, tu
// clicchi»: la card di proposta in chat (app Composio, server MCP, plugin da
// accendere, plugin da installare). La VISTA sta tutta qui — la testata col
// logo, le righe della COSA, il PERCHÉ del bot, l'AVVISO, le AZIONI, lo
// STATO finale («Collegata», «Non riuscito») — mentre ConnectorCard.tsx e
// ConnectorCards13.tsx restano LOGICA: i dati e i clic, sopra questa card.
//
// K2 (fase conversione-chat): sta SOPRA ChatCard, il guscio di ogni card in
// chat (la superficie, l'85% della colonna, la testata con il segno e il
// titolo, la riga delle azioni in fondo): qui restano solo gli slot della
// PROPOSTA. Il ritmo è chiuso: i blocchi a 8 px, le righe grigie a 4, lo
// stato e il modulo a 12 da ciò che li precede, le azioni a 16.
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChatCard, type ChatCardTone } from './chat-card'

/**
 * La card di proposta. Gli slot sono delimitati (non classi libere):
 *   logo · nome · icona   il segno della testata (32): il file, l'iniziale, o un'icona
 *   titolo                cosa propone il bot
 *   sottotitolo           la riga grigia sotto il titolo
 *   nota                  ciò che completa il titolo, contro il bordo destro
 *   righe                 le righe grigie della COSA (fiducia, dove gira, accesso)
 *   perché                la frase del bot, in corpo
 *   avviso                l'avviso in cima (proposta nata dopo letture esterne)
 *   configurazione        il modulo quando manca qualcosa (ServerSetupModule)
 *   stato                 la riga dello stato finale o dell'esito
 *   azioni                i bottoni (Aggiungi/No, Attiva/Non ora…)
 */
export function ProposalCard({ tone, avviso, logo, nome, icona, titolo, sottotitolo, nota, righe, perché, configurazione, stato, azioni, className, testId }: {
  /** il fondo della card: tenue (il default) · attesa · errore */
  tone?: ChatCardTone
  /** l'avviso in cima alla card */
  avviso?: ReactNode
  /** il file del logo (un URL), nella testata ai 32 */
  logo?: string | null
  /** senza file, l'iniziale di questo nome sulla piastrella */
  nome?: string
  /** senza logo né iniziale, il segno: un'icona lucide nella piastrella da 32 */
  icona?: LucideIcon
  /** il titolo della proposta */
  titolo?: ReactNode
  /** la riga grigia sotto il titolo (si tronca) */
  sottotitolo?: ReactNode
  /** ciò che completa il titolo, contro il bordo destro */
  nota?: ReactNode
  /** le righe grigie della cosa: fiducia · dove gira · accesso · versione */
  righe?: ReactNode
  /** la frase del bot, in corpo */
  perché?: ReactNode
  /** il modulo di configurazione quando manca qualcosa */
  configurazione?: ReactNode
  /** la riga dello stato (finali compresi: Collegata, Non riuscito) */
  stato?: ReactNode
  /** le azioni dell'utente */
  azioni?: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <ChatCard
      tone={tone}
      avviso={avviso}
      logo={logo}
      nome={nome}
      icona={icona}
      titolo={titolo}
      sottotitolo={sottotitolo}
      nota={nota}
      azioni={azioni}
      className={className}
      testId={testId}
    >
      {righe !== undefined && <div className="flex min-w-0 flex-col gap-1">{righe}</div>}
      {perché}
      {configurazione !== undefined && <div className="mt-1 flex min-w-0 flex-col gap-2">{configurazione}</div>}
      {stato !== undefined && <div className="mt-1">{stato}</div>}
    </ChatCard>
  )
}
