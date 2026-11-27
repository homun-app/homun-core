// K2 (fase conversione-chat): ChatCard — IL GUSCIO DI OGNI CARD IN CHAT.
// Prima (K1) ogni card si disegnava da sé il guscio: la superficie da
// CardShell (DecidedRow.tsx) e poi, card per card, la testata, le righe e la
// riga delle azioni, ciascuna con le sue misure. Ora il guscio sta QUI, una
// volta sola: la superficie (il raggio di superficie, il respiro di 16, larga
// al massimo l'85% della colonna — il testo lungo va a capo DENTRO), il tono
// del fondo, la TESTATA (il segno da 32 — il file del logo, l'iniziale o
// un'icona — · il titolo · ciò che completa il titolo, contro il bordo
// destro) e la RIGA DELLE AZIONI, in fondo. La card porta solo il corpo e i
// clic: dentro, i blocchi stanno a 8 px l'uno dall'altro (Stack, Text).
// È il guscio che la sonda di K6 misura: due card che differiscono (margine
// interno, raggio, testata, azioni) sono una differenza.
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { LOGO_CLASS } from '../../lib/app-logos'
import { AppLogo } from './app-logo'
import { Icon } from './icon'
import { Text } from './text'

export type ChatCardTone = 'muted' | 'waiting' | 'error'

/** Il fondo, per tono: tenue (il default) · l'attesa (ambra) · l'errore (rosso). */
const TONE: Record<ChatCardTone, string> = {
  muted: 'bg-muted',
  waiting: 'bg-waiting/10',
  error: 'bg-destructive/10'
}

/**
 * K3 (fase conversione-chat): la SUPERFICIE da sola — la stessa di ChatCard
 * (raggio di superficie, respiro 16, l'85% della colonna, il testo che va a
 * capo DENTRO, il fondo del tono) SENZA testata, ritmo né azioni. La usano
 * solo i gusci di prima ancora non convertiti (K4, K5: CardBlock e i suoi
 * fratelli in DecidedRow.tsx), così una fonte sola decide la superficie di
 * ogni card finché l'ultima non passa a ChatCard.
 */
export function ChatSurface({ tone = 'muted', className, testId, children }: {
  /** il fondo: tenue (il default) · attesa · errore */
  tone?: ChatCardTone
  className?: string
  testId?: string
  children: ReactNode
}): ReactNode {
  return (
    <div
      className={cn('max-w-[85%] min-w-0 rounded-surface p-4 wrap-anywhere', TONE[tone], className)}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </div>
  )
}

/** K3 (fase conversione-chat): i blocchi del corpo di ChatCard, l'uno dall'altro a 8 px; dentro un gruppo, il ritmo lo decide chi lo riempie (Stack, flex). */
export function ChatCard({ tone = 'muted', avviso, logo, nome, icona, titolo, titoloGrande = false, sottotitolo, nota, azioni, className, testId, children }: {
  /** il fondo della card: tenue (il default) · attesa · errore */
  tone?: ChatCardTone
  /** l'avviso in cima alla card (per esempio la proposta nata dopo letture esterne) */
  avviso?: ReactNode
  /** il file del logo (un URL): nella testata, ai 32 delle righe */
  logo?: string | null
  /** senza file del logo, l'iniziale di questo nome sulla piastrella */
  nome?: string
  /** senza logo né iniziale, il segno del collegamento: un'icona lucide nella piastrella da 32 */
  icona?: LucideIcon
  /** il titolo: il testo del corpo in peso medio; va a capo dentro la card */
  titolo?: ReactNode
  /**
   * K3: il titolo GRANDE — la frase che si legge prima di decidere (le card di
   * approvazione: text-title, peso 600). Senza, il titolo è la riga di peso
   * medio di una proposta (il nome della cosa)
   */
  titoloGrande?: boolean
  /** la riga grigia sotto il titolo (si tronca) */
  sottotitolo?: ReactNode
  /** ciò che completa il titolo, contro il bordo destro: un'etichetta (Tag), una didascalia */
  nota?: ReactNode
  /** la riga delle azioni: in fondo, i bottoni in fila */
  azioni?: ReactNode
  className?: string
  testId?: string
  /** il corpo della card */
  children?: ReactNode
}): ReactNode {
  const haTestata = titolo !== undefined || Boolean(logo) || nome !== undefined || icona !== undefined
  return (
    <ChatSurface
      tone={tone}
      className={cn('flex flex-col gap-2', className)}
      testId={testId}
    >
      {avviso}
      {haTestata && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {logo ? (
            <img src={logo} alt="" className={cn(LOGO_CLASS, 'size-8')} />
          ) : nome !== undefined ? (
            <AppLogo logo={null} name={nome} className="size-8 text-reading" />
          ) : icona !== undefined ? (
            <span className="grid size-8 shrink-0 place-items-center text-muted-foreground"><Icon icon={icona} /></span>
          ) : null}
          {titolo !== undefined && (
            <span className="min-w-0 flex-1">
              {titoloGrande ? <Text size="title" weight="semibold" className="wrap-anywhere">{titolo}</Text> : <Text weight="medium">{titolo}</Text>}
              {sottotitolo !== undefined && <Text size="small" tone="muted" truncate>{sottotitolo}</Text>}
            </span>
          )}
          {nota !== undefined && <span className="shrink-0">{nota}</span>}
        </div>
      )}
      {children}
      {azioni !== undefined && <div className="mt-2 flex flex-wrap items-center gap-2">{azioni}</div>}
    </ChatSurface>
  )
}

/**
 * K3 (fase conversione-chat): il blocco DENTRO una card (l'incavo): il
 * comando da approvare, gli argomenti di un'azione, i dettagli di una
 * routine — su fondo card, col raggio di controllo (8: dentro una superficie
 * da 14) e il respiro di 12. Le righe dentro si scrivono con Text; il ritmo
 * lo decide chi lo riempie (flex-col e le distanze dei token).
 */
export function CardBlock({ className, testId, children }: {
  className?: string
  testId?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className={cn('rounded-control bg-card p-3', className)} {...(testId ? { 'data-testid': testId } : {})}>
      {children}
    </div>
  )
}
