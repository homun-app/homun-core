// C1 (fase linguaggio): ProposalCard — UN oggetto per «il bot propone, tu
// clicchi»: la card di proposta in chat (app Composio, server MCP, plugin da
// accendere, plugin da installare). La VISTA sta tutta qui — testata col
// logo, le righe della COSA, il PERCHÉ del bot, l'AVVISO, le AZIONI, lo
// STATO finale («Collegata», «Non riuscito») — mentre ConnectorCard.tsx e
// ConnectorCards13.tsx restano LOGICA: i dati e i clic, sopra questa card.
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * La card di proposta. Gli slot sono delimitati (non classi libere):
 *   testata          logo + titolo (cosa propone il bot)
 *   righe            le righe grigie della COSA (fiducia, dove gira, accesso)
 *   perché           la frase del bot, in corpo
 *   avviso           l'avviso in cima (proposta nata dopo letture esterne) o ambra
 *   configurazione   il modulo quando manca qualcosa (ServerSetupModule)
 *   azioni           i bottoni (Aggiungi/No, Attiva/Non ora…)
 *   stato            la riga dello stato finale o dell'esito
 */
export function ProposalCard({ testata, righe, perché, avviso, configurazione, azioni, stato, className, testId }: {
  /** la riga di testa: il logo (32) e il titolo della proposta */
  testata: ReactNode
  /** le righe grigie della cosa: fiducia · dove gira · accesso · versione */
  righe?: ReactNode
  /** la frase del bot, in corpo */
  perché?: ReactNode
  /** l'avviso: la proposta nata dopo letture esterne (in cima) o l'ambra dei terzi */
  avviso?: ReactNode
  /** il modulo di configurazione quando manca qualcosa */
  configurazione?: ReactNode
  /** le azioni dell'utente */
  azioni?: ReactNode
  /** la riga dello stato (finali compresi: Collegata, Non riuscito) */
  stato?: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2 rounded-surface bg-muted p-4 wrap-anywhere', className)}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {avviso}
      {testata}
      {righe !== undefined && <div className="flex min-w-0 flex-col gap-1">{righe}</div>}
      {perché}
      {configurazione}
      {stato}
      {azioni !== undefined && <div className="mt-2 flex flex-wrap items-center gap-2">{azioni}</div>}
    </div>
  )
}
